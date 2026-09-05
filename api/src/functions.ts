import { app } from "@azure/functions";
import {
  checkChargingSchedule,
  getCar,
  getChargingSchedule,
  setCharging,
  setChargingSchedule,
  receiveTelemetry,
} from "./handlers";
import "./web";

app.http("getCar", {
  methods: ["GET"],
  route: "car",
  authLevel: "anonymous",
  handler: getCar,
});

app.http("setCharging", {
  methods: ["PUT"],
  route: "car/charging",
  authLevel: "anonymous",
  handler: setCharging,
});

app.http("getChargingSchedule", {
  methods: ["GET"],
  route: "car/charging-schedule",
  authLevel: "anonymous",
  handler: getChargingSchedule,
});

app.http("setChargingSchedule", {
  methods: ["PUT"],
  route: "car/charging-schedule",
  authLevel: "anonymous",
  handler: setChargingSchedule,
});

app.timer("checkChargingSchedule", {
  schedule: "0 * * * * *",
  runOnStartup: false,
  handler: checkChargingSchedule,
});

// Az IoT Hub's built-in endpoint is Event Hubs compatible
app.eventHub("receiveTelemetry", {
  connection: "IOT_EVENTHUB_CONNECTION",
  eventHubName: "%IOT_EVENTHUB_NAME%",
  consumerGroup: "battery-api",
  cardinality: "one",
  handler: receiveTelemetry,
});
