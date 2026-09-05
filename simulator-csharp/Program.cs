using System.Text.Json;
using System.Threading.Channels;
using CarSimulator;
using Microsoft.Azure.Devices.Client;

var connectionString = Environment.GetEnvironmentVariable("IOT_DEVICE_CONNECTION")?.Trim();
if (string.IsNullOrWhiteSpace(connectionString))
{
    Console.Error.WriteLine("Set the IOT_DEVICE_CONNECTION environment variable.");
    return 1;
}

using var cancellation = new CancellationTokenSource();
Console.CancelKeyPress += (_, e) => { e.Cancel = true; cancellation.Cancel(); };
using var client = DeviceClient.CreateFromConnectionString(connectionString, TransportType.Mqtt);
var battery = new Battery();
var batteryLock = new object();
// Keep only the newest snapshot when telemetry sending falls behind.
var updates = Channel.CreateBounded<Battery>(new BoundedChannelOptions(1)
{
    FullMode = BoundedChannelFullMode.DropOldest,
    SingleReader = true
});

Battery UpdateBattery(Func<Battery, Battery> update)
{
    lock (batteryLock)
    {
        battery = update(battery);
        updates.Writer.TryWrite(battery);
        return battery;
    }
}

Task<MethodResponse> HandleSetChargingAsync(MethodRequest request, object? _)
{
    if (!Protocol.TryReadCharging(request.Data, out var charging))
        return Task.FromResult(new MethodResponse(
            JsonSerializer.SerializeToUtf8Bytes(new { error = "charging must be boolean" }), 400));

    var snapshot = UpdateBattery(current => current.SetCharging(charging));
    return Task.FromResult(new MethodResponse(JsonSerializer.SerializeToUtf8Bytes(snapshot), 200));
}

await client.SetMethodHandlerAsync("setCharging", HandleSetChargingAsync, null);

async Task SimulateAsync()
{
    while (!cancellation.IsCancellationRequested)
    {
        await Task.Delay(TimeSpan.FromSeconds(10), cancellation.Token);
        lock (batteryLock) { battery = battery.Tick(); }
    }
}

async Task HeartbeatAsync()
{
    while (!cancellation.IsCancellationRequested)
    {
        await Task.Delay(TimeSpan.FromSeconds(5), cancellation.Token);
        UpdateBattery(current => current);
    }
}

async Task ReportAsync()
{
    await foreach (var snapshot in updates.Reader.ReadAllAsync(cancellation.Token))
    {
        using var message = new Message(JsonSerializer.SerializeToUtf8Bytes(snapshot))
        {
            ContentType = "application/json",
            ContentEncoding = "utf-8"
        };
        try
        {
            await client.SendEventAsync(message, cancellation.Token);
            Console.WriteLine($"{DateTimeOffset.UtcNow:O} {JsonSerializer.Serialize(snapshot)}");
        }
        catch (OperationCanceledException) when (cancellation.IsCancellationRequested) { return; }
        catch (Exception) { Console.Error.WriteLine("Telemetry failed."); }
    }
}

try
{
    await client.OpenAsync(cancellation.Token);
    updates.Writer.TryWrite(battery);
    await Task.WhenAll(SimulateAsync(), HeartbeatAsync(), ReportAsync());
}
catch (OperationCanceledException) when (cancellation.IsCancellationRequested) { }
catch (Exception)
{
    Console.Error.WriteLine("Simulator failed.");
    return 1;
}
finally { await client.CloseAsync(); }
return 0;
