import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./style.css";

type Battery = { batteryLevel: number; charging: boolean; updatedAt: string };
type ChargingSchedule = { enabled: boolean; time: string };
type Command = "start" | "stop";
const hhmm = (hours: number, minutes: number) => `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;

function utcToLocal(time: string) {
  const [hours, minutes] = time.split(":").map(Number);
  const date = new Date();
  date.setUTCHours(hours, minutes, 0, 0);
  return hhmm(date.getHours(), date.getMinutes());
}

function localToUtc(time: string) {
  const [hours, minutes] = time.split(":").map(Number);
  const date = new Date();
  date.setHours(hours, minutes, 0, 0);
  return hhmm(date.getUTCHours(), date.getUTCMinutes());
}

async function api<T>(path: string, options?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api/${path}`, {
      ...options,
      signal: AbortSignal.timeout(20000),
    });
  } catch (error) {
    if (error instanceof Error &&
        (error.name === "TimeoutError" || error.name === "AbortError")) {
      throw new Error(options?.method === "PUT"
        ? "Request timed out. Command may still in progress."
        : "Battery request timed out. Retrying automatically.");
    }
    throw new Error("Unable to reach the battery service. Please try again shortly.");
  }
  const body = await response.json().catch(() => {
    throw new Error(
      "Unable to reach the battery service. Please try again shortly.",
    );
  });
  if (!response.ok) throw new Error(body.error ?? "Unable to reach your car.");
  return body;
}
function App() {
  const [battery, setBattery] = useState<Battery | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [noticeError, setNoticeError] = useState(false);
  const [pendingCommand, setPendingCommand] = useState<Command | null>(null);
  const [schedule, setSchedule] = useState<ChargingSchedule | null>(null);
  const [scheduleStatus, setScheduleStatus] = useState("");
  const [now, setNow] = useState(Date.now());
  const lastCommand = useRef<Command | null>(null);
  const confirmationTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function clearConfirmationTimer() {
    if (confirmationTimer.current) {
      clearTimeout(confirmationTimer.current);
      confirmationTimer.current = null;
    }
  }

  function applyReading(result: Battery): boolean {
    setBattery(result);
    setError("");
    const command = lastCommand.current;
    if (
      command &&
      ((command === "start" && result.charging) ||
        (command === "stop" && !result.charging))
    ) {
      setNotice(
        command === "start"
          ? "Charging started successfully."
          : "Charging stopped successfully.",
      );
      setNoticeError(false);
      lastCommand.current = null;
      setPendingCommand(null);
      clearConfirmationTimer();
      return true;
    }
    return false;
  }

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        const result = await api<Battery>("car");
        if (active) {
          applyReading(result);
        }
      } catch (e) {
        if (active) setError((e as Error).message);
      }
      if (active) {
        setNow(Date.now());
        timer = setTimeout(refresh, 1000);
      }
    }
    void refresh();
    void api<ChargingSchedule>("car/charging-schedule")
      .then((result) => {
        if (!active) return;
        setSchedule({ ...result, time: utcToLocal(result.time) });
      })
      .catch((e) => active && setScheduleStatus((e as Error).message));
    return () => {
      active = false;
      clearTimeout(timer);
      clearConfirmationTimer();
    };
  }, []);
  const stale = Boolean(battery && now - Date.parse(battery.updatedAt) > 15000);
  const state = stale
    ? "offline"
    : !battery
    ? "unknown"
    : battery.batteryLevel >= 100
      ? "full"
      : battery.charging
        ? "charging"
        : "idle";
  const canStart = Boolean(
    battery && !stale && !battery.charging && battery.batteryLevel < 100,
  );
  const canStop = Boolean(battery?.charging && !stale);

  async function charge(charging: boolean) {
    const command = charging ? "start" : "stop";
    setPendingCommand(command);
    setNotice("");
    setNoticeError(false);
    try {
      await api<{ acknowledged: boolean }>("car/charging", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ charging }),
      });
      lastCommand.current = command;
      void api<Battery>("car")
        .then((result) => applyReading(result))
        .catch((e) => setError((e as Error).message));
      clearConfirmationTimer();
      confirmationTimer.current = setTimeout(() => {
        if (lastCommand.current !== command) return;
        lastCommand.current = null;
        setPendingCommand(null);
        setNotice(
          "Command was accepted. Waiting for your car to report state.",
        );
        setNoticeError(true);
        confirmationTimer.current = null;
      }, 10000);
    } catch (e) {
      lastCommand.current = null;
      clearConfirmationTimer();
      setPendingCommand(null);
      setNotice((e as Error).message);
      setNoticeError(true);
    }
  }

  async function saveChargingSchedule() {
    if (!schedule) return;
    setScheduleStatus("Saving…");
    try {
      await api<ChargingSchedule>("car/charging-schedule", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...schedule, time: localToUtc(schedule.time) }),
      });
      setScheduleStatus(schedule.enabled ? "Schedule saved." : "Schedule disabled.");
    } catch (e) {
      setScheduleStatus((e as Error).message);
    }
  }
  const statusTitle =
    state === "offline"
      ? "Unknown"
      : state === "charging"
      ? "Charging now"
      : state === "full"
        ? "Fully charged"
        : state === "idle"
          ? "Not charging"
          : "Waiting for battery data";
  const statusDescription =
    state === "offline"
      ? "Showing last known battery level. Your car is offline."
      : state === "charging"
      ? "Power is flowing to the battery."
      : state === "full"
        ? "Charging stopped automatically at 100%."
        : state === "idle"
          ? "Charging is currently stopped."
          : "The first battery reading has not arrived yet.";
  const startLabel =
    pendingCommand === "start"
      ? "Starting…"
      : state === "offline"
        ? "Start charging"
      : state === "charging"
        ? "Already charging"
        : state === "full"
          ? "Fully charged"
          : battery
            ? "Start charging"
            : "Waiting for car";
  const stopLabel =
    pendingCommand === "stop"
      ? "Stopping…"
      : state === "offline"
        ? "Stop charging"
      : state === "charging"
        ? "Stop charging"
        : battery
          ? "Not charging"
          : "Waiting for car";

  return (
    <main>
      <header>
        <span className="brand">CHARGING</span>
        <span className="small">My car</span>
      </header>
      <section aria-labelledby="title">
        <div className="heading">
          <h1 id="title">Battery</h1>
          <span
            className={`status ${battery && !stale ? "online" : ""} ${stale ? "stale" : ""}`}
          >
            {!battery ? "No battery data" : stale ? "Car offline" : "Live status"}
          </span>
        </div>
        <p className="percentage">
          {battery ? Math.round(battery.batteryLevel) : "—"}
          <span>%</span>
        </p>
        <div
          className="meter"
          role="progressbar"
          aria-label="Battery level"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={battery?.batteryLevel}
        >
          <div style={{ width: `${battery?.batteryLevel ?? 0}%` }} />
        </div>
        <div
          className={`charge-state charge-state--${state}`}
          aria-live="polite"
          aria-label={`Charging status: ${statusTitle}`}
        >
          <span className="charge-state__dot" aria-hidden="true" />
          <div className="charge-state__copy">
            <strong>{statusTitle}</strong>
            <span>{statusDescription}</span>
          </div>
        </div>
        <div className="details">
          <span>
            {battery
              ? `Updated ${new Date(battery.updatedAt).toLocaleTimeString()}`
              : "No battery reading yet"}
          </span>
        </div>
        <div className="actions">
          <button
            disabled={pendingCommand !== null || !canStart}
            onClick={() => void charge(true)}
          >
            {startLabel}
          </button>
          <button
            className="secondary"
            disabled={pendingCommand !== null || !canStop}
            onClick={() => void charge(false)}
          >
            {stopLabel}
          </button>
        </div>
        <div
          className={`feedback${noticeError ? " feedback-error" : ""}`}
          aria-live="polite"
          role={noticeError ? "alert" : "status"}
        >
          {pendingCommand
            ? `Waiting for your car to ${pendingCommand} charging…`
            : notice}
        </div>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {battery && stale && (
          <p className="error" role="status">
            Showing last known state. Your car is offline.
          </p>
        )}
        <div className="schedule">
          <h2>Charging schedule</h2>
          {schedule ? (
            <>
              <label>
                <input
                  type="checkbox"
                  checked={schedule.enabled}
                  onChange={(event) =>
                    setSchedule({ ...schedule, enabled: event.target.checked })
                  }
                />
                Start daily at
              </label>
              <input
                type="time"
                value={schedule.time}
                disabled={!schedule.enabled}
                onChange={(event) =>
                  setSchedule({ ...schedule, time: event.target.value })
                }
              />
              <span className="small">Local Time</span>
              <button
                className="secondary"
                disabled={scheduleStatus === "Saving…"}
                onClick={() => void saveChargingSchedule()}
              >
                Save
              </button>
            </>
          ) : <span className="small">Loading…</span>}
          <span className="small" aria-live="polite">{scheduleStatus}</span>
        </div>
      </section>
      <footer>Battery updates automatically.</footer>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
