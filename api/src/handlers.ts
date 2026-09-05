import {
  HttpRequest,
  HttpResponseInit,
  InvocationContext,
} from "@azure/functions";
import { TableClient } from "@azure/data-tables";
import { Client } from "azure-iothub";
import { BatteryReading, saveLatestReading, statusCode } from "./storage";
import {
  dueDate,
  loadSchedule,
  parseSchedule,
  saveSchedule,
} from "./schedule";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing setting: ${name}`);
  return value;
}

function table(): TableClient {
  return TableClient.fromConnectionString(
    required("AzureWebJobsStorage"),
    "CarState",
  );
}

function json(status: number, body: unknown): HttpResponseInit {
  return { status, jsonBody: body, headers: { "Cache-Control": "no-store" } };
}

function errorJson(
  status: number,
  code: string,
  message: string,
): HttpResponseInit {
  return json(status, { code, error: message });
}

function logFailure(context: InvocationContext, operation: string): void {
  // SDK error messages can contain credentials or request data.
  context.error(`${operation} failed.`);
}

export async function getCar(
  _request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  try {
    const row = await table().getEntity<BatteryReading>(
      "car",
      required("CAR_DEVICE_ID"),
    );
    return json(200, {
      batteryLevel: row.batteryLevel,
      charging: row.charging,
      updatedAt: row.updatedAt,
    });
  } catch (error) {
    if (statusCode(error) === 404) {
      return errorJson(
        404,
        "BATTERY_NOT_READY",
        "Battery data is not available yet.",
      );
    }
    logFailure(context, "Loading battery information");
    return errorJson(
      500,
      "BATTERY_READ_FAILED",
      "Unable to load battery information right now.",
    );
  }
}

export async function setCharging(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return errorJson(400, "INVALID_JSON", "Request body must be valid JSON.");
  }

  if (
    !body || typeof body !== "object" || !("charging" in body) || typeof body.charging !== "boolean"
  ) {
    return errorJson(
      400,
      "INVALID_CHARGING_REQUEST",
      "Request body must include a boolean charging value.",
    );
  }

  let client: Client;
  let deviceId: string;
  try {
    deviceId = required("CAR_DEVICE_ID");
    client = Client.fromConnectionString(required("IOT_SERVICE_CONNECTION"));
  } catch {
    logFailure(context, "Preparing charging command");
    return errorJson(
      500,
      "SERVICE_NOT_CONFIGURED",
      "Charging control is temporarily unavailable.",
    );
  }

  try {
    const { result } = await client.invokeDeviceMethod(deviceId, {
      methodName: "setCharging",
      payload: { charging: body.charging },
      responseTimeoutInSeconds: 10,
      connectTimeoutInSeconds: 5,
    });
    if (result.status !== 200) {
      context.warn(`Charging command returned device status ${result.status}.`);
      return (result.status === 400 || result.status === 409)
        ? errorJson(
            409,
            "COMMAND_REJECTED",
            "The car rejected the charging command.",
          )
        : errorJson(
            503,
            "DEVICE_UNAVAILABLE",
            "Unable to contact the car service. The command may still have been applied.",
          );
    }
    context.log("Charging command acknowledged.");
    return json(200, { acknowledged: true });
  } catch {
    logFailure(context, "Sending charging command");
    return errorJson(
      503,
      "DEVICE_UNAVAILABLE",
      "Unable to contact the car. The command may still have been applied.",
    );
  } finally {
    await client.close().catch(() =>
      logFailure(context, "Closing charging service client"),
    );
  }
}

export async function getChargingSchedule(
  _request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  try {
    const { enabled, time } = await loadSchedule(
      table(),
      required("CAR_DEVICE_ID"),
    );
    return json(200, { enabled, time });
  } catch {
    logFailure(context, "Loading charging schedule");
    return errorJson(
      500,
      "SCHEDULE_READ_FAILED",
      "Unable to load the charging schedule right now.",
    );
  }
}

export async function setChargingSchedule(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorJson(
      400,
      "INVALID_JSON",
      "Request body must be valid JSON.",
    );
  }
  const schedule = parseSchedule(body);
  if (!schedule)
    return errorJson(
      400,
      "INVALID_SCHEDULE",
      "Schedule must include a boolean enabled value and a time in HH:mm format.",
    );

  try {
    await saveSchedule(table(), required("CAR_DEVICE_ID"), schedule);
    context.log("Charging schedule saved.");
    return json(200, schedule);
  } catch {
    logFailure(context, "Saving charging schedule");
    return errorJson(
      500,
      "SCHEDULE_WRITE_FAILED",
      "Unable to save the charging schedule right now.",
    );
  }
}

export async function checkChargingSchedule(
  _timer: unknown,
  context: InvocationContext,
): Promise<void> {
  let client: Client | undefined;
  try {
    const storage = table();
    const deviceId = required("CAR_DEVICE_ID");
    const schedule = await loadSchedule(storage, deviceId);
    const date = dueDate(schedule, new Date());
    if (!date) return;

    client = Client.fromConnectionString(
      required("IOT_SERVICE_CONNECTION"),
    );
    const { result } = await client.invokeDeviceMethod(deviceId, {
      methodName: "setCharging",
      payload: { charging: true },
      responseTimeoutInSeconds: 10,
      connectTimeoutInSeconds: 5,
    });
    if (result.status !== 200) {
      context.warn(`Scheduled charging command returned device status ${result.status}.`);
      throw new Error("Scheduled charging command was rejected");
    }
    await saveSchedule(storage, deviceId, {
      ...schedule,
      lastTriggeredDate: date,
    });
    context.log("Charging schedule triggered.");
  } catch {
    logFailure(context, "Checking charging schedule");
    throw new Error("Charging schedule check failed");
  } finally {
    if (client) {
      await client.close().catch(() =>
        logFailure(context, "Closing schedule service client"),
      );
    }
  }
}

function parseBattery(
  message: unknown,
): Pick<BatteryReading, "batteryLevel" | "charging"> | null {
  let data: unknown;
  try {
    data = typeof message === "string" ? JSON.parse(message) : message;
  } catch {
    return null;
  }
  if (
    !data ||
    typeof data !== "object" ||
    !("batteryLevel" in data) ||
    !("charging" in data) ||
    typeof data.batteryLevel !== "number" ||
    !(data.batteryLevel >= 0 && data.batteryLevel <= 100) ||
    typeof data.charging !== "boolean"
  )
    return null;
  return { batteryLevel: data.batteryLevel, charging: data.charging };
}

export async function receiveTelemetry(
  message: unknown,
  context: InvocationContext,
): Promise<void> {
  try {
    const metadata = context.triggerMetadata;
    const properties = metadata?.systemProperties as
      Record<string, unknown> | undefined;
    const deviceId = required("CAR_DEVICE_ID");

    // Identity comes from Az IoT Hub, never from the device-supplied JSON body.
    if (!properties?.["iothub-connection-device-id"]) {
      throw new Error("Missing IoT Hub device identity metadata");
    }
    if (properties["iothub-connection-device-id"] !== deviceId) return;

    const battery = parseBattery(message);
    if (!battery) {
      context.warn("Ignored invalid battery reading.");
      return;
    }

    const enqueued = metadata?.enqueuedTimeUtc;
    const time = typeof enqueued === "string" ? Date.parse(enqueued) : NaN;
    if (!Number.isFinite(time))
      throw new Error("Missing or invalid IoT Hub enqueue time");

    await saveLatestReading(table(), deviceId, {
      ...battery,
      updatedAt: new Date(time).toISOString(),
    });
  } catch {
    logFailure(context, "Processing telemetry");
    throw new Error("Telemetry processing failed");
  }
}
