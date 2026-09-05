import { TableClient } from "@azure/data-tables";
import { statusCode } from "./storage";

export type ChargingSchedule = {
  enabled: boolean;
  time: string;
  lastTriggeredDate?: string;
};

export function parseSchedule(value: unknown): ChargingSchedule | null {
  if (!value || typeof value !== "object") return null;
  const body = value as Record<string, unknown>;
  if (
    typeof body.enabled !== "boolean" ||
    typeof body.time !== "string" ||
    !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(body.time)
  ) return null;
  return { enabled: body.enabled, time: body.time };
}

export async function loadSchedule(
  storage: TableClient,
  deviceId: string,
): Promise<ChargingSchedule> {
  try {
    const row = await storage.getEntity<ChargingSchedule>("schedule", deviceId);
    return {
      enabled: row.enabled,
      time: row.time,
      lastTriggeredDate: row.lastTriggeredDate,
    };
  } catch (error) {
    if (statusCode(error) === 404) return { enabled: false, time: "02:00" };
    throw error;
  }
}

export async function saveSchedule(
  storage: TableClient,
  deviceId: string,
  schedule: ChargingSchedule,
): Promise<void> {
  await storage.upsertEntity(
    { partitionKey: "schedule", rowKey: deviceId, ...schedule },
    "Replace",
  );
}

export function dueDate(schedule: ChargingSchedule, now: Date): string | null {
  const date = now.toISOString().slice(0, 10);
  const time = now.toISOString().slice(11, 16);
  return schedule.enabled && schedule.time === time &&
    schedule.lastTriggeredDate !== date ? date : null;
}
