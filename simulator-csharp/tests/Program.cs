using System.Text;
using System.Text.Json;
using CarSimulator;

// Small executable checks
void Check(bool condition, string description)
{
    if (!condition) throw new Exception(description);
    Console.WriteLine($"PASS {description}");
}
var initial = new Battery();
Check(initial == new Battery(62, false), "same initial state as TypeScript");
Check(initial.Tick() == initial, "parked battery does not discharge");
var started = initial.SetCharging(true);
Check(started.SetCharging(true) == started, "repeated start is idempotent");
Check(started.SetCharging(false).SetCharging(false) == initial, "repeated stop is idempotent");
Check(started.Tick() == new Battery(63, true), "charging increases by one percent");
Check(new Battery(99, true).Tick() == new Battery(100, false), "full battery stops charging");
Check(new Battery(100, false).SetCharging(true) == new Battery(100, false), "full battery cannot start");
using var json = JsonDocument.Parse(JsonSerializer.SerializeToUtf8Bytes(initial));
Check(json.RootElement.EnumerateObject().Count() == 2 &&
      json.RootElement.GetProperty("batteryLevel").GetDouble() == 62 &&
      !json.RootElement.GetProperty("charging").GetBoolean(), "exact camelCase telemetry contract");
foreach (var payload in new[] { "{", "null", "[]", "{}", "{\"charging\":\"true\"}", "{\"Charging\":true}", "{\"charging\":1}" })
    Check(!Protocol.TryReadCharging(Encoding.UTF8.GetBytes(payload), out _), $"reject invalid command {payload}");
foreach (var charging in new[] { true, false })
    Check(Protocol.TryReadCharging(JsonSerializer.SerializeToUtf8Bytes(new { charging }), out var parsed) && parsed == charging,
        $"accept boolean command {charging}");
