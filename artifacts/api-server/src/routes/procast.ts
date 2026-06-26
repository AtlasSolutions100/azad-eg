import { Router, type IRouter } from "express";
import {
  GetProcastStatusResponse,
  ConnectProcastBody,
  ConnectProcastResponse,
  DisconnectProcastResponse,
  GetProcastSchedulerResponse,
  UpdateProcastSchedulerBody,
  UpdateProcastSchedulerResponse,
} from "@workspace/api-zod";
import {
  getProcastConnection,
  saveProcastConnection,
  pingProcast,
} from "../lib/procast";
import {
  getSchedulerState,
  setSchedulerInterval,
  runAndRecordCycle,
  clampInterval,
  MIN_INTERVAL_MS,
  MAX_INTERVAL_MS,
  type ProcastSchedulerState,
} from "../lib/procastScheduler";
import { recordAudit } from "../lib/audit";

const router: IRouter = Router();

async function schedulerPayload(state: ProcastSchedulerState) {
  const conn = await getProcastConnection();
  return {
    connected: !!conn?.connected,
    intervalMs: state.intervalMs,
    running: state.running,
    lastRunAt: state.lastRunAt ? state.lastRunAt.toISOString() : null,
    lastSynced: state.lastSynced,
    lastFailed: state.lastFailed,
    lastSkipped: state.lastSkipped,
    lastError: state.lastError,
  };
}

function statusPayload(conn: Awaited<ReturnType<typeof getProcastConnection>>) {
  const connected = !!conn?.connected;
  return {
    connected,
    mode: connected ? ("live" as const) : ("upload" as const),
    baseUrl: conn?.baseUrl ?? null,
    lastSyncAt: conn?.lastSyncAt ? conn.lastSyncAt.toISOString() : null,
    message: connected
      ? "Timesheet data is pulled live from the Procast API."
      : "Procast is not connected. Import timesheet data via CSV/Excel upload.",
  };
}

// Returns the real, persisted Procast connection state. Falls back to upload
// mode whenever no live connection has been established.
router.get("/procast/status", async (_req, res): Promise<void> => {
  const conn = await getProcastConnection();
  res.json(GetProcastStatusResponse.parse(statusPayload(conn)));
});

// Starts the real Procast connection flow: validates the supplied credentials by
// making an authenticated probe request, and persists them only on success.
router.post("/procast/connect", async (req, res): Promise<void> => {
  const parsed = ConnectProcastBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { baseUrl, apiKey } = parsed.data;

  const ping = await pingProcast({ baseUrl, apiKey });
  if (!ping.ok) {
    res.status(502).json({ error: ping.error ?? "Could not connect to Procast." });
    return;
  }

  const conn = await saveProcastConnection({
    connected: true,
    baseUrl: baseUrl.trim().replace(/\/+$/, ""),
    apiKey,
    lastSyncAt: null,
  });
  await recordAudit({
    action: "connected Procast",
    entityType: "integration",
    description: `Live Procast connection established (${conn.baseUrl})`,
  });
  res.json(ConnectProcastResponse.parse(statusPayload(conn)));
});

// Tears down the live connection and returns to upload mode.
router.post("/procast/disconnect", async (_req, res): Promise<void> => {
  const conn = await saveProcastConnection({
    connected: false,
    baseUrl: null,
    apiKey: null,
    lastSyncAt: null,
  });
  await recordAudit({
    action: "disconnected Procast",
    entityType: "integration",
    description: "Live Procast connection removed; reverted to upload mode",
  });
  res.json(DisconnectProcastResponse.parse(statusPayload(conn)));
});

// Reports the background refresh schedule (effective interval) and the outcome
// of the most recent automatic or on-demand cycle, so billers can see whether
// the live feed is working without digging through logs.
router.get("/procast/scheduler", async (_req, res): Promise<void> => {
  const state = await getSchedulerState();
  res.json(GetProcastSchedulerResponse.parse(await schedulerPayload(state)));
});

// Updates the configurable refresh interval. The value is clamped to a safe
// range server-side; out-of-range requests are rejected so the UI can warn.
router.put("/procast/scheduler", async (req, res): Promise<void> => {
  const parsed = UpdateProcastSchedulerBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { intervalMs } = parsed.data;
  if (!Number.isFinite(intervalMs) || clampInterval(intervalMs) !== intervalMs) {
    res.status(400).json({
      error: `Refresh interval must be between ${MIN_INTERVAL_MS / 60000} minutes and ${
        MAX_INTERVAL_MS / 3600000
      } hours.`,
    });
    return;
  }

  await setSchedulerInterval(intervalMs);
  const state = await getSchedulerState();
  await recordAudit({
    action: "updated Procast refresh interval",
    entityType: "integration",
    description: `Automatic Procast refresh interval set to ${Math.round(
      state.intervalMs / 60000,
    )} minute(s)`,
  });
  res.json(UpdateProcastSchedulerResponse.parse(await schedulerPayload(state)));
});

// Runs a full refresh cycle across every open invoice immediately, on demand.
router.post("/procast/refresh", async (_req, res): Promise<void> => {
  const state = await runAndRecordCycle();
  await recordAudit({
    action: "triggered Procast refresh",
    entityType: "integration",
    description: state.lastSkipped
      ? "On-demand Procast refresh skipped (not connected)"
      : `On-demand Procast refresh: ${state.lastSynced} synced, ${state.lastFailed} failed`,
  });
  res.json(GetProcastSchedulerResponse.parse(await schedulerPayload(state)));
});

export default router;
