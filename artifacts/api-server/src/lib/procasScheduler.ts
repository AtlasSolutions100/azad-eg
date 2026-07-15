import { db, pool, invoicesTable, procasSchedulerTable, type ProcasSchedulerRow } from "@workspace/db";
import { inArray, eq } from "drizzle-orm";
import { getProcasConnection, credsFromConnection } from "./procas";
import { syncInvoiceFromProcas, syncReferenceFromProcas } from "./procasSync";
import { logger } from "./logger";

// A fixed 64-bit key identifying the Procas sync cycle advisory lock. Any
// instance that wants to run a cycle must hold this lock; Postgres guarantees
// only one session holds it at a time, so concurrent autoscale instances are
// serialized to a single runner. The value is arbitrary but must be stable
// across all instances.
const SYNC_LOCK_KEY = 0x70726373; // "prcs"

// Invoices that are still being worked on — these are the ones a live Procas
// feed should keep refreshed. Approved/exported invoices are finalized and must
// not be mutated by a background pull.
const OPEN_STATUSES = ["draft", "in_review"];

const DEFAULT_INTERVAL_MS = 15 * 60 * 1000;
// Guard rails for the user-configurable interval: at least 1 minute (so the
// app can't hammer Procas) and at most 24 hours.
export const MIN_INTERVAL_MS = 60 * 1000;
export const MAX_INTERVAL_MS = 24 * 60 * 60 * 1000;

const SCHEDULER_ID = 1;

let timer: NodeJS.Timeout | null = null;
let running = false;

// Interval baked into the env var / default. Used only when the user hasn't
// configured an interval from the UI.
function envIntervalMs(): number {
  const raw = process.env["PROCAS_SYNC_INTERVAL_MS"];
  if (!raw) return DEFAULT_INTERVAL_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_INTERVAL_MS;
}

export function clampInterval(ms: number): number {
  return Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, Math.round(ms)));
}

// Reads (creating on first use) the single-row scheduler state.
async function getSchedulerRow(): Promise<ProcasSchedulerRow> {
  const [existing] = await db
    .select()
    .from(procasSchedulerTable)
    .where(eq(procasSchedulerTable.id, SCHEDULER_ID));
  if (existing) return existing;
  const [created] = await db
    .insert(procasSchedulerTable)
    .values({ id: SCHEDULER_ID })
    .onConflictDoNothing()
    .returning();
  if (created) return created;
  // A concurrent caller created it first; read it back.
  const [row] = await db
    .select()
    .from(procasSchedulerTable)
    .where(eq(procasSchedulerTable.id, SCHEDULER_ID));
  return row;
}

// The interval actually in effect: a UI-configured value wins over the env var
// / default. Always clamped to the safe range.
export async function getEffectiveIntervalMs(): Promise<number> {
  const row = await getSchedulerRow();
  return clampInterval(row.intervalMs ?? envIntervalMs());
}

export interface ProcasSchedulerState {
  intervalMs: number;
  running: boolean;
  lastRunAt: Date | null;
  lastSynced: number;
  lastFailed: number;
  lastSkipped: boolean;
  lastError: string | null;
}

export async function getSchedulerState(): Promise<ProcasSchedulerState> {
  const row = await getSchedulerRow();
  return {
    intervalMs: clampInterval(row.intervalMs ?? envIntervalMs()),
    running,
    lastRunAt: row.lastRunAt,
    lastSynced: row.lastSynced,
    lastFailed: row.lastFailed,
    lastSkipped: row.lastSkipped,
    lastError: row.lastError,
  };
}

// Persists a new interval and restarts the timer so the change takes effect
// immediately. Returns the value actually stored (after clamping).
export async function setSchedulerInterval(ms: number): Promise<number> {
  const clamped = clampInterval(ms);
  await getSchedulerRow();
  await db
    .update(procasSchedulerTable)
    .set({ intervalMs: clamped })
    .where(eq(procasSchedulerTable.id, SCHEDULER_ID));
  if (timer) {
    stopProcasScheduler();
    await startProcasScheduler();
  }
  return clamped;
}

async function recordCycleResult(result: {
  skipped: boolean;
  synced: number;
  failed: number;
  error?: string | null;
}): Promise<void> {
  await getSchedulerRow();
  await db
    .update(procasSchedulerTable)
    .set({
      lastRunAt: new Date(),
      lastSynced: result.synced,
      lastFailed: result.failed,
      lastSkipped: result.skipped,
      lastError: result.error ?? null,
    })
    .where(eq(procasSchedulerTable.id, SCHEDULER_ID));
}

// Performs one scheduled refresh pass. Skips entirely when Procas is in upload
// mode (not connected). Each open invoice is pulled independently so one
// failure does not abort the rest of the batch.
export async function runProcasSyncCycle(): Promise<{ skipped: boolean; synced: number; failed: number }> {
  const conn = await getProcasConnection();
  const creds = conn?.connected ? credsFromConnection(conn) : null;
  if (!conn || !creds) {
    return { skipped: true, synced: 0, failed: 0 };
  }

  // Refresh reference data (employees, work plan rates) once per cycle before
  // per-invoice labor pulls so new personnel and rates are in place.
  try {
    await syncReferenceFromProcas(creds);
  } catch (e) {
    logger.warn({ err: e }, "Procas reference data sync failed; continuing with invoice sync");
  }

  const openInvoices = await db
    .select()
    .from(invoicesTable)
    .where(inArray(invoicesTable.status, OPEN_STATUSES));

  let synced = 0;
  let failed = 0;
  for (const invoice of openInvoices) {
    try {
      const result = await syncInvoiceFromProcas(invoice, conn, "procas-scheduled");
      if (result.ok) {
        synced += 1;
      } else if (result.reason === "fetch_failed") {
        failed += 1;
        logger.warn(
          { invoiceId: invoice.id, reason: result.message },
          "Scheduled Procas sync failed for invoice",
        );
      }
      // "no_rows" is a normal no-op (period has no timesheets yet); not counted as failure.
    } catch (e) {
      failed += 1;
      logger.error({ err: e, invoiceId: invoice.id }, "Scheduled Procas sync threw for invoice");
    }
  }
  return { skipped: false, synced, failed };
}

// Runs `fn` only if this instance can acquire the cross-instance advisory lock.
// Returns `{ acquired: false }` without running `fn` when another instance
// already holds the lock (i.e. is mid-cycle). The lock is session-scoped and
// held on a dedicated pooled client so it survives for the whole cycle and is
// always released in `finally`, even on error.
async function withSyncLock<T>(
  fn: () => Promise<T>,
): Promise<{ acquired: true; value: T } | { acquired: false }> {
  const client = await pool.connect();
  let locked = false;
  try {
    const res = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock($1) AS locked",
      [SYNC_LOCK_KEY],
    );
    locked = res.rows[0]?.locked === true;
    if (!locked) {
      return { acquired: false };
    }
    const value = await fn();
    return { acquired: true, value };
  } finally {
    if (locked) {
      try {
        await client.query("SELECT pg_advisory_unlock($1)", [SYNC_LOCK_KEY]);
      } catch (e) {
        logger.error({ err: e }, "Failed to release Procas sync advisory lock");
      }
    }
    client.release();
  }
}

// Runs a cycle and persists its outcome to the scheduler state, so the UI can
// surface the result of the most recent automatic (or on-demand) pass. Guards
// against overlapping runs within this instance the same way the timer tick
// does, and against concurrent runs across autoscale instances via a Postgres
// advisory lock: if another instance is already mid-cycle, this call skips
// cleanly and leaves the persisted state untouched.
export async function runAndRecordCycle(): Promise<ProcasSchedulerState> {
  if (running) {
    return getSchedulerState();
  }
  running = true;
  try {
    const outcome = await withSyncLock(() => runProcasSyncCycle());
    if (!outcome.acquired) {
      // Another instance is already running this cycle; skip cleanly.
      logger.debug("Procas sync cycle skipped (another instance holds the lock)");
      return getSchedulerState();
    }
    const result = outcome.value;
    await recordCycleResult(result);
    if (!result.skipped) {
      logger.info(
        { synced: result.synced, failed: result.failed },
        "Procas sync cycle complete",
      );
    }
  } catch (e) {
    await recordCycleResult({
      skipped: false,
      synced: 0,
      failed: 0,
      error: e instanceof Error ? e.message : "Procas sync cycle failed",
    });
    logger.error({ err: e }, "Procas sync cycle failed");
  } finally {
    running = false;
  }
  return getSchedulerState();
}

// Exported for tests so the overlapping-run guard can be exercised directly.
export async function tick(): Promise<void> {
  await runAndRecordCycle();
}

// Starts the background refresh loop. Idempotent: calling it again is a no-op
// while a timer is already active.
export async function startProcasScheduler(): Promise<void> {
  if (timer) return;
  const ms = await getEffectiveIntervalMs();
  timer = setInterval(() => {
    void tick();
  }, ms);
  // Don't keep the event loop alive solely for this timer.
  if (typeof timer.unref === "function") timer.unref();
  logger.info({ intervalMs: ms }, "Procas scheduler started");
}

export function stopProcasScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
