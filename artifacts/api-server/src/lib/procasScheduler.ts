import {
  db,
  pool,
  invoicesTable,
  procasSchedulerTable,
  procasSchedulerRunsTable,
  type ProcasSchedulerRow,
  type ProcasSchedulerRunRow,
  type PoolClient,
} from "@workspace/db";
import { inArray, eq, desc, notInArray, sql } from "drizzle-orm";
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

// How many cycle-result writes have failed in a row on this instance. When the
// database is unhealthy enough that even recording the outcome fails, the
// persisted "last run" state silently goes stale — this counter lets the
// status endpoint surface that instead of showing an old timestamp with no
// warning. Reset to zero the moment a write succeeds.
let consecutivePersistFailures = 0;

// After this many back-to-back persistence failures, the scheduler status is
// flagged stale so the UI can warn admins.
export const PERSIST_FAILURE_WARN_THRESHOLD = 3;

// Age-based staleness: if the persisted lastRunAt is older than this many
// scheduler intervals while the loop is running and Procas is connected, the
// status is flagged stale. Unlike the in-memory persist-failure counter, this
// works across restarts and multiple autoscale instances because it compares
// against the timestamp stored in the database.
export const STALE_INTERVAL_MULTIPLIER = 3;

// When this instance's scheduler loop started. Used as a startup grace period
// so a freshly booted instance doesn't flag an old lastRunAt as stale before
// it has had a chance to run its first few cycles.
let schedulerStartedAt: Date | null = null;

// Exported for tests.
export function setSchedulerStartedAtForTest(d: Date | null): void {
  schedulerStartedAt = d;
}

// Exported for tests.
export function resetPersistFailuresForTest(): void {
  consecutivePersistFailures = 0;
}

// Why a scheduler tick was skipped without running a cycle: the pool was too
// busy to hand out the lock connection in time, or another instance already
// held the cross-instance sync lock.
export type SkipReason = "db_busy" | "lock_held";

// After this many back-to-back skipped ticks, the UI shows a warning that
// automatic refreshes keep getting skipped and invoice data may be stale.
export const SKIP_WARN_THRESHOLD = 3;

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
  // Consecutive scheduler ticks skipped without running a cycle (persisted).
  consecutiveSkips: number;
  // Why the most recent skip happened, if any ("db_busy" | "lock_held").
  lastSkipReason: SkipReason | null;
  // True once consecutiveSkips reaches SKIP_WARN_THRESHOLD — automatic
  // refreshes keep getting skipped and invoice data may be going stale.
  skipWarning: boolean;
  // Consecutive failures to persist a cycle outcome (in-memory, per instance).
  persistFailures: number;
  // True when the persisted last-run info shown in the UI can no longer be
  // trusted as fresh — either persistFailures reached the warn threshold on
  // this instance, or the persisted lastRunAt is much older than the
  // configured interval (which survives restarts and other instances).
  resultsStale: boolean;
  // Why resultsStale is true (null when it is false). "persist_failures"
  // takes precedence when both conditions hold.
  staleReason: "persist_failures" | "last_run_age" | null;
}

// Checks whether the persisted lastRunAt is suspiciously old given the
// configured interval. Only meaningful while the scheduler loop is active,
// after a startup grace period (so a freshly booted instance doesn't flag an
// old timestamp before its first cycles), and when Procas is actually
// connected (disconnected mode still records skipped runs, but we don't want
// to alarm admins over a feature that is intentionally idle).
async function isLastRunStale(lastRunAt: Date | null, intervalMs: number): Promise<boolean> {
  // schedulerStartedAt is only non-null while the loop is active (set in
  // start, cleared in stop), so this also gates on the scheduler running.
  if (!schedulerStartedAt) return false;
  const now = Date.now();
  const thresholdMs = intervalMs * STALE_INTERVAL_MULTIPLIER;
  // Startup grace: this instance must have been running long enough that at
  // least a few cycles should have happened since it booted.
  if (now - schedulerStartedAt.getTime() < thresholdMs) return false;
  if (lastRunAt && now - lastRunAt.getTime() < thresholdMs) return false;
  // Only check the connection last — it's the most expensive test.
  try {
    const conn = await getProcasConnection();
    return !!conn?.connected;
  } catch {
    // Can't determine the connection state; don't raise a possibly-false alarm.
    return false;
  }
}

export async function getSchedulerState(): Promise<ProcasSchedulerState> {
  const row = await getSchedulerRow();
  const intervalMs = clampInterval(row.intervalMs ?? envIntervalMs());
  const persistStale = consecutivePersistFailures >= PERSIST_FAILURE_WARN_THRESHOLD;
  const ageStale = persistStale ? false : await isLastRunStale(row.lastRunAt, intervalMs);
  return {
    intervalMs,
    running,
    lastRunAt: row.lastRunAt,
    lastSynced: row.lastSynced,
    lastFailed: row.lastFailed,
    lastSkipped: row.lastSkipped,
    lastError: row.lastError,
    consecutiveSkips: row.consecutiveSkips,
    lastSkipReason:
      row.lastSkipReason === "db_busy" || row.lastSkipReason === "lock_held"
        ? row.lastSkipReason
        : null,
    skipWarning: row.consecutiveSkips >= SKIP_WARN_THRESHOLD,
    persistFailures: consecutivePersistFailures,
    resultsStale: persistStale || ageStale,
    staleReason: persistStale ? "persist_failures" : ageStale ? "last_run_age" : null,
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

// Cap on retained history rows. Keeps comfortably more than the UI shows (~10)
// so the popover always has a full list even right after pruning.
export const MAX_RUN_HISTORY = 50;

async function recordCycleResult(result: {
  skipped: boolean;
  synced: number;
  failed: number;
  error?: string | null;
}): Promise<void> {
  await getSchedulerRow();
  const ranAt = new Date();
  await db
    .update(procasSchedulerTable)
    .set({
      lastRunAt: ranAt,
      lastSynced: result.synced,
      lastFailed: result.failed,
      lastSkipped: result.skipped,
      lastError: result.error ?? null,
      // A cycle actually ran (the lock was acquired), so the skip streak ends
      // here regardless of the cycle's outcome.
      consecutiveSkips: 0,
      lastSkipReason: null,
    })
    .where(eq(procasSchedulerTable.id, SCHEDULER_ID));
  // Append this cycle to the rolling history, then prune anything beyond the
  // newest MAX_RUN_HISTORY rows so the table stays bounded.
  await appendRunHistory({
    ranAt,
    synced: result.synced,
    failed: result.failed,
    skipped: result.skipped,
    skipReason: null,
    error: result.error ?? null,
  });
}

// Inserts one row into the rolling run history and prunes anything beyond the
// newest MAX_RUN_HISTORY rows so the table stays bounded.
async function appendRunHistory(row: {
  ranAt: Date;
  synced: number;
  failed: number;
  skipped: boolean;
  skipReason: SkipReason | null;
  error: string | null;
}): Promise<void> {
  await db.insert(procasSchedulerRunsTable).values(row);
  const keep = db
    .select({ id: procasSchedulerRunsTable.id })
    .from(procasSchedulerRunsTable)
    .orderBy(desc(procasSchedulerRunsTable.ranAt), desc(procasSchedulerRunsTable.id))
    .limit(MAX_RUN_HISTORY);
  await db
    .delete(procasSchedulerRunsTable)
    .where(notInArray(procasSchedulerRunsTable.id, sql`(${keep})`));
}

// The most recent cycle outcomes, newest first, for the history panel.
export async function getRecentRuns(limit = 10): Promise<ProcasSchedulerRunRow[]> {
  return db
    .select()
    .from(procasSchedulerRunsTable)
    .orderBy(desc(procasSchedulerRunsTable.ranAt), desc(procasSchedulerRunsTable.id))
    .limit(Math.min(Math.max(1, Math.round(limit)), MAX_RUN_HISTORY));
}

// Persists a cycle outcome without letting a failed write escape. If the
// database is unhealthy enough that even recording the result fails, log it
// and move on — the refresh loop must keep running for the next tick.
async function safeRecordCycleResult(result: {
  skipped: boolean;
  synced: number;
  failed: number;
  error?: string | null;
}): Promise<void> {
  try {
    await recordCycleResult(result);
    consecutivePersistFailures = 0;
  } catch (e) {
    consecutivePersistFailures += 1;
    logger.error(
      { err: e, consecutivePersistFailures },
      "Failed to persist Procas sync cycle result",
    );
    if (consecutivePersistFailures >= PERSIST_FAILURE_WARN_THRESHOLD) {
      logger.warn(
        { consecutivePersistFailures },
        "Procas scheduler results have not been saved for multiple runs; the last-run status shown in the UI is stale",
      );
    }
  }
}

// Bumps the persisted skip streak after a tick that could not run a cycle,
// remembering why so the UI can tell "database busy" apart from "another
// instance is running". Never lets a failed write escape — if the database is
// busy enough to cause the skip, the bookkeeping write may fail too.
async function safeRecordSkippedTick(reason: SkipReason): Promise<void> {
  try {
    await getSchedulerRow();
    await db
      .update(procasSchedulerTable)
      .set({
        consecutiveSkips: sql`${procasSchedulerTable.consecutiveSkips} + 1`,
        lastSkipReason: reason,
      })
      .where(eq(procasSchedulerTable.id, SCHEDULER_ID));
    // Also append the skip to the run history so billers reviewing the recent
    // refresh list see why a tick left a gap instead of silently nothing.
    await appendRunHistory({
      ranAt: new Date(),
      synced: 0,
      failed: 0,
      skipped: true,
      skipReason: reason,
      error: null,
    });
  } catch (e) {
    logger.error({ err: e, reason }, "Failed to record skipped Procas sync tick");
  }
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

// Upper bound on how long a tick may wait to check out the dedicated
// advisory-lock connection. If the pool is exhausted (many autoscale
// instances, a traffic spike), `pool.connect()` can otherwise hang
// indefinitely and the refresh loop silently stalls. Overridable via env for
// tests and unusual deployments.
export const DEFAULT_LOCK_CONNECT_TIMEOUT_MS = 10_000;

export function lockConnectTimeoutMs(): number {
  const raw = process.env["PROCAS_LOCK_CONNECT_TIMEOUT_MS"];
  if (!raw) return DEFAULT_LOCK_CONNECT_TIMEOUT_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_LOCK_CONNECT_TIMEOUT_MS;
}

// Checks out a pooled client with a bounded wait. Returns `null` when the
// checkout does not complete within `timeoutMs`. If the checkout completes
// late (after we gave up), the client is released straight back to the pool
// so it is not leaked.
async function connectWithTimeout(timeoutMs: number): Promise<PoolClient | null> {
  const connectPromise: Promise<PoolClient> = pool.connect();
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
    if (typeof timer.unref === "function") timer.unref();
  });
  try {
    const client = await Promise.race([connectPromise, timedOut]);
    if (client) return client;
    // Timed out: if the checkout eventually succeeds, hand the client back.
    connectPromise
      .then((late) => late.release())
      .catch(() => {
        // Checkout failed after the timeout; nothing to release.
      });
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// Runs `fn` only if this instance can acquire the cross-instance advisory lock.
// Returns `{ acquired: false }` without running `fn` when another instance
// already holds the lock (i.e. is mid-cycle), or when the pool is so busy that
// the lock connection cannot be checked out within a bounded timeout — in that
// case the tick logs a warning and skips cleanly instead of hanging. The lock
// is session-scoped and held on a dedicated pooled client so it survives for
// the whole cycle and is always released in `finally`, even on error.
async function withSyncLock<T>(
  fn: () => Promise<T>,
): Promise<{ acquired: true; value: T } | { acquired: false; reason: SkipReason }> {
  const timeoutMs = lockConnectTimeoutMs();
  const client = await connectWithTimeout(timeoutMs);
  if (!client) {
    logger.warn(
      { timeoutMs },
      "Procas sync skipped: timed out waiting for a database connection to acquire the sync lock",
    );
    return { acquired: false, reason: "db_busy" };
  }
  let locked = false;
  try {
    const res = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock($1) AS locked",
      [SYNC_LOCK_KEY],
    );
    locked = res.rows[0]?.locked === true;
    if (!locked) {
      return { acquired: false, reason: "lock_held" };
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
      // The cycle could not run — either the pool was too busy to hand out
      // the lock connection or another instance is mid-cycle. Record the skip
      // so repeated streaks surface in the UI instead of only in logs.
      logger.debug({ reason: outcome.reason }, "Procas sync cycle skipped");
      await safeRecordSkippedTick(outcome.reason);
      return getSchedulerState();
    }
    const result = outcome.value;
    await safeRecordCycleResult(result);
    if (!result.skipped) {
      logger.info(
        { synced: result.synced, failed: result.failed },
        "Procas sync cycle complete",
      );
    }
  } catch (e) {
    await safeRecordCycleResult({
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
  try {
    await runAndRecordCycle();
  } catch (e) {
    // Last line of defense: nothing may escape the scheduled timer callback,
    // or every interval fires an unhandled promise rejection.
    logger.error({ err: e }, "Procas scheduler tick failed");
  }
}

// Starts the background refresh loop. Idempotent: calling it again is a no-op
// while a timer is already active.
export async function startProcasScheduler(): Promise<void> {
  if (timer) return;
  const ms = await getEffectiveIntervalMs();
  schedulerStartedAt = new Date();
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
  schedulerStartedAt = null;
}
