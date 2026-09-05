export type Battery = { batteryLevel: number; charging: boolean };
export function setCharging(battery: Battery, charging: boolean): Battery {
  return { ...battery, charging: charging && battery.batteryLevel < 100 };
}

export function tick(battery: Battery): Battery {
  const batteryLevel = Math.min(
    100,
    battery.batteryLevel + (battery.charging ? 1 : 0),
  );
  return { batteryLevel, charging: battery.charging && batteryLevel < 100 };
}
