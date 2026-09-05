import { test } from "node:test";
import { strict as assert } from "node:assert";
import { dueDate, parseSchedule } from "./schedule";

test("accepts a daily UTC schedule and rejects invalid times", () => {
  assert.deepEqual(parseSchedule({ enabled: true, time: "02:00" }), {
    enabled: true,
    time: "02:00",
  });
  for (const value of [
    null,
    {},
    { enabled: "yes", time: "02:00" },
    { enabled: true, time: "2:00" },
    { enabled: true, time: "24:00" },
  ]) assert.equal(parseSchedule(value), null);
});

test("runs once on the matching UTC minute each day", () => {
  const now = new Date("2026-09-08T02:00:30Z");
  assert.equal(dueDate({ enabled: true, time: "02:00" }, now), "2026-09-08");
  assert.equal(dueDate({ enabled: false, time: "02:00" }, now), null);
  assert.equal(dueDate({ enabled: true, time: "03:00" }, now), null);
  assert.equal(dueDate({
    enabled: true,
    time: "02:00",
    lastTriggeredDate: "2026-09-08",
  }, now), null);
});
