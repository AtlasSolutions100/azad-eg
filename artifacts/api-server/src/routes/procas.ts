import { Router, type IRouter } from "express";
import {
  GetProcasStatusResponse,
  ConnectProcasBody,
  ConnectProcasResponse,
  DisconnectProcasResponse,
  GetProcasSchedulerResponse,
  GetProcasSchedulerRunsResponse,
  UpdateProcasSchedulerBody,
  UpdateProcasSchedulerResponse,
} from "@workspace/api-zod";
import {
  getProcasConnection,
  saveProcasConnection,
  pingProcas,
} from "../lib/procas";
import {
  getSchedulerState,
  setSchedulerInterval,
  runAndRecordCycle,
  getRecentRuns,
  clampInterval,
  MIN_INTERVAL_MS,
  MAX_INTERVAL_MS,
  type ProcasSchedulerState,
} from "../lib/procasScheduler";
import { recordAudit } from "../lib/audit";

const router: IRouter = Router();

async function schedulerPayload(state: ProcasSchedulerState) {
  const conn = await getProcasConnection();
  return {
    connected: !!conn?.connected,
    intervalMs: state.intervalMs,
    running: state.running,
    lastRunAt: state.lastRunAt ? state.lastRunAt.toISOString() : null,
    lastSynced: state.lastSynced,
    lastFailed: state.lastFailed,
    lastSkipped: state.lastSkipped,
    lastError: state.lastError,
    persistFailures: state.persistFailures,
    resultsStale: state.resultsStale,
  };
}

function statusPayload(conn: Awaited<ReturnType<typeof getProcasConnection>>) {
  const connected = !!conn?.connected;
  return {
    connected,
    mode: connected ? ("live" as const) : ("upload" as const),
    companyCode: conn?.companyCode ?? null,
    username: conn?.username ?? null,
    lastSyncAt: conn?.lastSyncAt ? conn.lastSyncAt.toISOString() : null,
    message: connected
      ? "Live pull active — Procas serves a copy of your data refreshed daily at 6 AM Eastern."
      : "Procas is not connected. Import timesheet data via CSV/Excel upload.",
  };
}

// Returns the real, persisted Procas connection state. Falls back to upload
// mode whenever no live connection has been established.
router.get("/procas/status", async (_req, res): Promise<void> => {
  const conn = await getProcasConnection();
  res.json(GetProcasStatusResponse.parse(statusPayload(conn)));
});

// Starts the real Procas connection flow: validates the supplied credentials by
// making an authenticated probe request, and persists them only on success.
router.post("/procas/connect", async (req, res): Promise<void> => {
  const parsed = ConnectProcasBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { companyCode, username, password } = parsed.data;

  const ping = await pingProcas({ companyCode, username, password });
  if (!ping.ok) {
    res.status(502).json({ error: ping.error ?? "Could not connect to Procas." });
    return;
  }

  const conn = await saveProcasConnection({
    connected: true,
    companyCode: companyCode.trim(),
    username: username.trim(),
    password,
    lastSyncAt: null,
  });
  await recordAudit({
    action: "connected Procas",
    entityType: "integration",
    description: `Live Procas OData connection established (company ${conn.companyCode})`,
  });
  res.json(ConnectProcasResponse.parse(statusPayload(conn)));
});

// Tears down the live connection and returns to upload mode.
router.post("/procas/disconnect", async (_req, res): Promise<void> => {
  const conn = await saveProcasConnection({
    connected: false,
    companyCode: null,
    username: null,
    password: null,
    lastSyncAt: null,
  });
  await recordAudit({
    action: "disconnected Procas",
    entityType: "integration",
    description: "Live Procas connection removed; reverted to upload mode",
  });
  res.json(DisconnectProcasResponse.parse(statusPayload(conn)));
});

// Reports the background refresh schedule (effective interval) and the outcome
// of the most recent automatic or on-demand cycle, so billers can see whether
// the live feed is working without digging through logs.
router.get("/procas/scheduler", async (_req, res): Promise<void> => {
  const state = await getSchedulerState();
  res.json(GetProcasSchedulerResponse.parse(await schedulerPayload(state)));
});

// Returns the rolling history of recent refresh cycles (newest first) so
// billers can see whether automatic refreshes have been succeeding over time,
// not just the most recent outcome.
router.get("/procas/scheduler/runs", async (_req, res): Promise<void> => {
  const runs = await getRecentRuns(10);
  res.json(
    GetProcasSchedulerRunsResponse.parse(
      runs.map((run) => ({
        id: run.id,
        ranAt: run.ranAt.toISOString(),
        synced: run.synced,
        failed: run.failed,
        skipped: run.skipped,
        error: run.error,
      })),
    ),
  );
});

// Updates the configurable refresh interval. The value is clamped to a safe
// range server-side; out-of-range requests are rejected so the UI can warn.
router.put("/procas/scheduler", async (req, res): Promise<void> => {
  const parsed = UpdateProcasSchedulerBody.safeParse(req.body);
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
    action: "updated Procas refresh interval",
    entityType: "integration",
    description: `Automatic Procas refresh interval set to ${Math.round(
      state.intervalMs / 60000,
    )} minute(s)`,
  });
  res.json(UpdateProcasSchedulerResponse.parse(await schedulerPayload(state)));
});

// Runs a full refresh cycle across every open invoice immediately, on demand.
router.post("/procas/refresh", async (_req, res): Promise<void> => {
  const state = await runAndRecordCycle();
  await recordAudit({
    action: "triggered Procas refresh",
    entityType: "integration",
    description: state.lastSkipped
      ? "On-demand Procas refresh skipped (not connected)"
      : `On-demand Procas refresh: ${state.lastSynced} synced, ${state.lastFailed} failed`,
  });
  res.json(GetProcasSchedulerResponse.parse(await schedulerPayload(state)));
});

export default router;
