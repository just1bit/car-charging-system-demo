import { test } from "node:test";
import { strict as assert } from "node:assert";
import { HttpRequest, InvocationContext } from "@azure/functions";
import { TableClient } from "@azure/data-tables";
import { Client } from "azure-iothub";
import {
  getCar,
  getChargingSchedule,
  setCharging,
  setChargingSchedule,
  receiveTelemetry,
} from "./handlers";

process.env.CAR_DEVICE_ID = "car-001";
process.env.AzureWebJobsStorage = "test-placeholder";
process.env.IOT_SERVICE_CONNECTION = "test-placeholder";
const context = () =>
  new InvocationContext({ functionName: "test", logHandler: () => {} });
const request = (body: string) =>
  new HttpRequest({
    url: "http://localhost/api/car/charging",
    method: "PUT",
    body: { string: body },
  });
const eventContext = (deviceId = "car-001") =>
  new InvocationContext({
    functionName: "receiveTelemetry",
    logHandler: () => {},
    triggerMetadata: {
      systemProperties: { "iothub-connection-device-id": deviceId },
      enqueuedTimeUtc: "2026-09-05T00:00:00Z",
    },
  });

test("REST rejects malformed JSON and wrong charging types before connecting", async () => {
  const malformed = await setCharging(request("{"), context());
  assert.equal(malformed.status, 400);
  assert.deepEqual(malformed.jsonBody, {
    code: "INVALID_JSON",
    error: "Request body must be valid JSON.",
  });

  for (const body of ["null", "{}", '{"charging":"true"}']) {
    const response = await setCharging(request(body), context());
    assert.equal(response.status, 400);
    assert.equal(response.jsonBody && (response.jsonBody as { code: string }).code,
      "INVALID_CHARGING_REQUEST");
  }
});
test("REST sends exact command and closes the service client", async (t) => {
  let closed = false;
  t.mock.method(
    Client,
    "fromConnectionString",
    () =>
      ({
        invokeDeviceMethod: async (
          id: string,
          method: { methodName: string; payload: unknown },
        ) => {
          assert.equal(id, "car-001");
          assert.equal(method.methodName, "setCharging");
          assert.deepEqual(method.payload, { charging: true });
          return { result: { status: 200 } };
        },
        close: async () => {
          closed = true;
        },
      }) as unknown as Client,
  );
  const response = await setCharging(request('{"charging":true}'), context());
  assert.equal(response.status, 200);
  assert.equal(closed, true);
});
test("REST reports device timeouts as unavailable", async (t) => {
  t.mock.method(
    Client,
    "fromConnectionString",
    () =>
      ({
        invokeDeviceMethod: async () => {
          throw new Error("Timeout");
        },
        close: async () => {},
      }) as unknown as Client,
  );
  const response = await setCharging(request('{"charging":false}'), context());
  assert.equal(response.status, 503);
  assert.deepEqual(response.jsonBody, {
    code: "DEVICE_UNAVAILABLE",
    error: "Unable to contact the car. The command may still have been applied.",
  });
});
test("GET returns waiting rather than a fabricated battery before first reading", async (t) => {
  t.mock.method(
    TableClient,
    "fromConnectionString",
    () =>
      ({
        getEntity: async () => {
          throw { statusCode: 404 };
        },
      }) as unknown as TableClient,
  );
  const response = await getCar(request(""), context());
  assert.equal(response.status, 404);
  assert.deepEqual(response.jsonBody, {
    code: "BATTERY_NOT_READY",
    error: "Battery data is not available yet.",
  });
});
test("telemetry ignores foreign identity and invalid battery values", async (t) => {
  const stub = t.mock.method(TableClient, "fromConnectionString", () => {
    throw new Error("Storage must not be touched");
  });
  await receiveTelemetry(
    { batteryLevel: 62, charging: true },
    eventContext("other-car"),
  );
  for (const message of [
    "{",
    null,
    { batteryLevel: -1, charging: true },
    { batteryLevel: NaN, charging: false },
    { batteryLevel: Infinity, charging: false },
    { batteryLevel: 101, charging: false },
    { batteryLevel: 50, charging: "yes" },
  ]) {
    await receiveTelemetry(message, eventContext());
  }
  assert.equal(stub.mock.callCount(), 0);
});
test("telemetry stores server timestamp and rejects replayed state", async (t) => {
  let saved: Record<string, unknown> | undefined;
  let writes = 0;
  t.mock.method(
    TableClient,
    "fromConnectionString",
    () =>
      ({
        getEntity: async () => {
          if (!saved) throw { statusCode: 404 };
          return saved;
        },
        createEntity: async (row: Record<string, unknown>) => {
          saved = row;
          writes++;
        },
      }) as unknown as TableClient,
  );
  await receiveTelemetry(
    { batteryLevel: 62, charging: true, updatedAt: "2099-01-01" },
    eventContext(),
  );
  assert.equal(saved?.updatedAt, "2026-09-05T00:00:00.000Z");
  await receiveTelemetry(
    { batteryLevel: 10, charging: false },
    eventContext(),
  );
  assert.equal(writes, 1);
  assert.equal(saved?.batteryLevel, 62);
});

test("GET exposes only the battery contract, not storage metadata", async (t) => {
  const reading = {
    batteryLevel: 62,
    charging: false,
    updatedAt: "2026-09-05T00:00:00.000Z",
  };
  t.mock.method(
    TableClient,
    "fromConnectionString",
    () =>
      ({
        getEntity: async () => ({
          ...reading,
          partitionKey: "car",
          rowKey: "car-001",
          etag: "private",
        }),
      }) as unknown as TableClient,
  );
  const response = await getCar(request(""), context());
  assert.equal(response.status, 200);
  assert.deepEqual(response.jsonBody, reading);
});

test("device rejection returns 409 and still closes the client", async (t) => {
  let closed = false;
  t.mock.method(
    Client,
    "fromConnectionString",
    () =>
      ({
        invokeDeviceMethod: async () => ({ result: { status: 400 } }),
        close: async () => {
          closed = true;
        },
      }) as unknown as Client,
  );
  const response = await setCharging(request('{"charging":true}'), context());
  assert.equal(response.status, 409);
  assert.deepEqual(response.jsonBody, {
    code: "COMMAND_REJECTED",
    error: "The car rejected the charging command.",
  });
  assert.equal(closed, true);
});

test("device service failures return 503", async (t) => {
  t.mock.method(
    Client,
    "fromConnectionString",
    () =>
      ({
        invokeDeviceMethod: async () => ({ result: { status: 500 } }),
        close: async () => {},
      }) as unknown as Client,
  );
  const response = await setCharging(request('{"charging":true}'), context());
  assert.equal(response.status, 503);
  assert.deepEqual(response.jsonBody, {
    code: "DEVICE_UNAVAILABLE",
    error: "Unable to contact the car service. The command may still have been applied.",
  });
});

test("missing configuration is a server error, not a device-offline error", async () => {
  const previous = process.env.IOT_SERVICE_CONNECTION;
  delete process.env.IOT_SERVICE_CONNECTION;
  try {
    const response = await setCharging(request('{"charging":true}'), context());
    assert.equal(response.status, 500);
    assert.deepEqual(response.jsonBody, {
      code: "SERVICE_NOT_CONFIGURED",
      error: "Charging control is temporarily unavailable.",
    });
  } finally {
    process.env.IOT_SERVICE_CONNECTION = previous;
  }
});

test("missing identity and invalid enqueue time fail visibly", async () => {
  await assert.rejects(
    receiveTelemetry({ batteryLevel: 62, charging: false }, context()),
    /Telemetry processing failed/,
  );
  const invalid = eventContext();
  invalid.triggerMetadata!.enqueuedTimeUtc = "not-a-date";
  await assert.rejects(
    receiveTelemetry({ batteryLevel: 62, charging: false }, invalid),
    /Telemetry processing failed/,
  );
});

test("schedule API returns defaults and saves a valid UTC time", async (t) => {
  let saved: Record<string, unknown> | undefined;
  t.mock.method(
    TableClient,
    "fromConnectionString",
    () => ({
      getEntity: async () => { throw { statusCode: 404 }; },
      upsertEntity: async (entity: Record<string, unknown>) => { saved = entity; },
    }) as unknown as TableClient,
  );
  assert.deepEqual((await getChargingSchedule(request(""), context())).jsonBody, {
    enabled: false,
    time: "02:00",
  });
  const response = await setChargingSchedule(
    request('{"enabled":true,"time":"02:00"}'),
    context(),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(saved, {
    partitionKey: "schedule",
    rowKey: "car-001",
    enabled: true,
    time: "02:00",
  });

  const invalid = await setChargingSchedule(
    request('{"enabled":true,"time":"2:00"}'),
    context(),
  );
  assert.equal(invalid.status, 400);
  assert.deepEqual(invalid.jsonBody, {
    code: "INVALID_SCHEDULE",
    error: "Schedule must include a boolean enabled value and a time in HH:mm format.",
  });
});
