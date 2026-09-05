import { setTimeout as delay } from "node:timers/promises";
import { Client, Message } from "azure-iot-device";
import { Mqtt } from "azure-iot-device-mqtt";
import { setCharging, tick, Battery } from "./battery";

const connection = process.env.IOT_DEVICE_CONNECTION;
if (!connection) {
  console.error("Set the IOT_DEVICE_CONNECTION environment variable.");
  process.exit(1);
}

const client = Client.fromConnectionString(connection, Mqtt);
const cancellation = new AbortController();
let battery: Battery = { batteryLevel: 62, charging: false };

async function report() {
  const snapshot = battery;
  const message = new Message(JSON.stringify(snapshot));
  message.contentType = "application/json";
  message.contentEncoding = "utf-8";
  await client.sendEvent(message);
  console.log(new Date().toISOString(), snapshot);
}

client.on("error", () => console.error("Device connection failed."));
client.onDeviceMethod("setCharging", async (request, response) => {
  try {
    if (typeof request.payload?.charging !== "boolean") {
      await response.send(400, { error: "charging must be boolean" });
      return;
    }
    battery = setCharging(battery, request.payload.charging);
    await response.send(200, battery);
    await report();
  } catch {
    console.error("Command or telemetry failed.");
  }
});

process.once("SIGINT", () => cancellation.abort());
process.once("SIGTERM", () => cancellation.abort());

async function main() {
  try {
    await client.open();
    await report();
    await Promise.all([simulate(), heartbeat()]);
  } catch (error) {
    if (!cancellation.signal.aborted) throw error;
  } finally {
    await client.close();
  }
}

async function simulate() {
  while (!cancellation.signal.aborted) {
    await delay(10_000, undefined, { signal: cancellation.signal });
    battery = tick(battery);
  }
}

async function heartbeat() {
  while (!cancellation.signal.aborted) {
    await delay(5_000, undefined, { signal: cancellation.signal });
    await report().catch(() => console.error("Telemetry failed."));
  }
}

main().catch(() => {
  console.error("Simulator failed.");
  process.exitCode = 1;
});
