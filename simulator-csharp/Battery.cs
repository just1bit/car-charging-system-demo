using System.Text.Json;
using System.Text.Json.Serialization;

namespace CarSimulator;

public record Battery(
    [property: JsonPropertyName("batteryLevel")] double BatteryLevel = 62,
    [property: JsonPropertyName("charging")] bool Charging = false)
{
    public Battery SetCharging(bool charging) =>
        this with { Charging = charging && BatteryLevel < 100 };

    public Battery Tick()
    {
        var level = Math.Min(100, BatteryLevel + (Charging ? 1 : 0));
        return new Battery(level, Charging && level < 100);
    }
}

public static class Protocol
{
    public static bool TryReadCharging(byte[] payload, out bool charging)
    {
        charging = false;
        try
        {
            using var document = JsonDocument.Parse(payload);
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object ||
                !root.TryGetProperty("charging", out var value) ||
                value.ValueKind is not (JsonValueKind.True or JsonValueKind.False)) return false;
            charging = value.GetBoolean();
            return true;
        }
        catch (JsonException) { return false; }
    }
}
