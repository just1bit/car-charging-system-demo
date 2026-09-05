import { test } from "node:test";
import { strict as assert } from "node:assert";
import { setCharging, tick } from "./battery";
test("charging increases battery and stops at full", () => {
  assert.deepEqual(tick({ batteryLevel: 99, charging: true }), {
    batteryLevel: 100,
    charging: false,
  });
  assert.deepEqual(tick({ batteryLevel: 100, charging: false }), {
    batteryLevel: 100,
    charging: false,
  });
});
test("start and stop commands are idempotent", () => {
  const original = { batteryLevel: 62, charging: false };
  const started = setCharging(original, true);
  assert.deepEqual(setCharging(started, true), started);
  assert.deepEqual(setCharging(setCharging(started, false), false), original);
  assert.deepEqual(tick(original), original);
});
test("a full battery cannot start charging", () => {
  assert.deepEqual(setCharging({ batteryLevel: 100, charging: false }, true), {
    batteryLevel: 100,
    charging: false,
  });
});
