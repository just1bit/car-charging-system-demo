import { test } from "node:test";
import { strict as assert } from "node:assert";
import { TableClient } from "@azure/data-tables";
import { BatteryReading, saveLatestReading } from "./storage";

const reading: BatteryReading = {
  batteryLevel: 63,
  charging: true,
  updatedAt: "2026-09-05T00:00:30.000Z",
};
const older = {
  ...reading,
  updatedAt: "2026-09-05T00:00:00.000Z",
  etag: "version-1",
};

// Only the SDK boundary is replaced. All conflict/replay decisions use the real code.
test("updates a newer reading with the ETag from the preceding read", async () => {
  let written = false;
  const storage = {
    getEntity: async () => older,
    updateEntity: async (
      entity: unknown,
      mode: string,
      options: { etag: string },
    ) => {
      assert.deepEqual(entity, {
        partitionKey: "car",
        rowKey: "car-001",
        ...reading,
      });
      assert.equal(mode, "Replace");
      assert.equal(options.etag, "version-1");
      written = true;
    },
  } as unknown as TableClient;
  await saveLatestReading(storage, "car-001", reading);
  assert.equal(written, true);
});

test("re-reads after an ETag conflict and keeps a newer competing update", async () => {
  let reads = 0;
  let writes = 0;
  const storage = {
    getEntity: async () =>
      ++reads === 1
        ? older
        : { ...reading, updatedAt: "2026-09-05T00:01:00.000Z" },
    updateEntity: async () => {
      writes++;
      throw { statusCode: 412 };
    },
  } as unknown as TableClient;
  await saveLatestReading(storage, "car-001", reading);
  assert.equal(reads, 2);
  assert.equal(writes, 1);
});

test("retries a first-row creation race rather than overwriting the winner", async () => {
  let reads = 0;
  let creates = 0;
  const storage = {
    getEntity: async () => {
      if (++reads === 1) throw { statusCode: 404 };
      return reading;
    },
    createEntity: async () => {
      creates++;
      throw { statusCode: 409 };
    },
  } as unknown as TableClient;
  await saveLatestReading(storage, "car-001", reading);
  assert.equal(reads, 2);
  assert.equal(creates, 1);
});

test("does not overwrite a later or duplicate reading", async () => {
  for (const updatedAt of [reading.updatedAt, "2026-09-05T00:01:00.000Z"]) {
    const storage = {
      getEntity: async () => ({ ...reading, updatedAt }),
    } as unknown as TableClient;
    await saveLatestReading(storage, "car-001", reading);
  }
});

test("stops after three write conflicts", async () => {
  let writes = 0;
  const storage = {
    getEntity: async () => older,
    updateEntity: async () => {
      writes++;
      throw { statusCode: 412 };
    },
  } as unknown as TableClient;
  await assert.rejects(
    saveLatestReading(storage, "car-001", reading, 2),
    /conflicted repeatedly/,
  );
  assert.equal(writes, 3);
});

test("propagates storage failures instead of treating them as missing rows", async () => {
  const failure = new Error("Storage unavailable");
  const storage = {
    getEntity: async () => {
      throw failure;
    },
  } as unknown as TableClient;
  await assert.rejects(saveLatestReading(storage, "car-001", reading), failure);
});
