import { TableClient } from "@azure/data-tables";

export type BatteryReading = {
  batteryLevel: number;
  charging: boolean;
  updatedAt: string;
};

export function statusCode(error: unknown): number | undefined {
  return (error as { statusCode?: number } | null)?.statusCode;
}

function isConflict(error: unknown): boolean {
  return statusCode(error) === 409 || statusCode(error) === 412;
}

// Retry only optimistic-concurrency conflicts. maxRetries counts attempts after the first operation.
export async function retryOnConflict<T>(
  operation: () => Promise<T>,
  maxRetries: number,
): Promise<T> {
  if (!Number.isInteger(maxRetries) || maxRetries < 0)
    throw new RangeError("Invalid maxRetries.");

  let retries = 0;
  while (true) {
    try {
      return await operation();
    } catch (error) {
      if (!isConflict(error)) throw error;
      if (retries >= maxRetries) throw error;
      retries++;
    }
  }
}

// Each car uses one row in CarState table.
export async function saveLatestReading(
  storage: TableClient,
  deviceId: string,
  reading: BatteryReading,
  maxRetries = 3,
): Promise<void> {
  const entity = { partitionKey: "car", rowKey: deviceId, ...reading };

  try {
    await retryOnConflict(async () => {
      try {
        const previous = await storage.getEntity<BatteryReading>("car", deviceId);
        if (Date.parse(previous.updatedAt) >= Date.parse(reading.updatedAt))
          return;

        // Update only the version we read. On a conflict, re-read before trying again.
        await storage.updateEntity(entity, "Replace", { etag: previous.etag });
        return;
      } catch (error) {
        if (statusCode(error) !== 404) throw error;
      }

      // Another request may have created the row after our 404, so retry on 409.
      await storage.createEntity(entity);
    }, maxRetries);
  } catch (error) {
    if (isConflict(error))
      throw new Error("Telemetry write conflicted repeatedly", { cause: error });
    throw error;
  }
}
