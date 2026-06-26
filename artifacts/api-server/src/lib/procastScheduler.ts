import { db, invoicesTable, procastSchedulerTable, type ProcastSchedulerRow } from "@workspace/db";
import { inArray, eq } from "drizzle-orm";
import { getProcastConnection } from "./procast";
import { syncInvoiceFromProcast } from "./procastSync";
import { logger } from "./logger";

// Invoices that are still being worked on — these are the ones a live Procast
// feed should keep refreshed. Approved/exported invoices are finalized and must
// not be mutated by a background pull.
const OPEN_STATUSES = ["draft", "in_review"];

const DEFAULT_INTERVAL_MS = 15 * 60 * 1000;
// Guard rails for the user-configurable interval: at least 1 minute (so the
// app can't hammer Procast) and at most 24 hours.
export const MIN_INTERVAL_MS = 60 * 1000;
export const MAX_INTERVAL_MS = 24 * 60 * 60 * 1000;

const SCHEDULER_ID = 1;

let timer: NodeJS.Timeout | null = null;
let running = false;

// Interval baked into the env var / default. Used only when the user hasn't
// configured an interval from the UI.
function envIntervalMs(): number {
  const raw = process.env["PROCAST_SYNC_INTERVAL_MS"];
  if (!raw) return DEFAULT_INTERVAL_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_INTERVAL_MS;
}

export function clampInterval(ms: number): number {
  return Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, Math.round(ms)));
}

// Reads (creating on first use) the single-row scheduler state.
async function getSchedulerRow(): Promise<ProcastSchedulerRow> {
  const [existing] = await db
    .select()
    .from(procastSchedulerTable)
    .where(eq(procastSchedulerTable.id, SCHEDULER_ID));
  if (existing) return existing;
  const [created] = await db
    .insert(procastSchedulerTable)
    .values({ id: SCHEDULER_ID })
    .onConflictDoNothing()
    .returning();
  if (created) return created;
  // A concurrent caller created it first; read it back.
  const [row] = await db
    .select()
    .from(procastSchedulerTable)
    .where(eq(procastSchedulerTable.id, SCHEDULER_ID));
  return row;
}

// The interval actually in effect: a UI-configured value wins over the env var
// / default. Always clamped to the safe range.
export async function getEffectiveIntervalMs(): Promise<number> {
  const row = await getSchedulerRow();
  return clampInterval(row.intervalMs ?? envIntervalMs());
}

export interface ProcastSchedulerState {
  intervalMs: number;
  running: boolean;
  lastRunAt: Date | null;
  lastSynced: number;
  lastFailed: number;
  lastSkipped: boolean;
  lastError: string | null;
}

export async function getSchedulerState(): Promise<ProcastSchedulerState> {
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
    .update(procastSchedulerTable)
    .set({ intervalMs: clamped })
    .where(eq(procastSchedulerTable.id, SCHEDULER_ID));
  if (timer) {
    stopProcastScheduler();
    await startProcastScheduler();
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
    .update(procastSchedulerTable)
    .set({
      lastRunAt: new Date(),
      lastSynced: result.synced,
      lastFailed: result.failed,
      lastSkipped: result.skipped,
      lastError: result.error ?? null,
    })
    .where(eq(procastSchedulerTable.id, SCHEDULER_ID));
}

// Performs one scheduled refresh pass. Skips entirely when Procast is in upload
// mode (not connected). Each open invoice is pulled independently so one
// failure does not abort the rest of the batch.
export async function runProcastSyncCycle(): Promise<{ skipped: boolean; synced: number; failed: number }> {
  const conn = await getProcastConnection();
  if (!conn || !conn.connected || !conn.baseUrl || !conn.apiKey) {
    return { skipped: true, synced: 0, failed: 0 };
  }

  const openInvoices = await db
    .select()
    .from(invoicesTable)
    .where(inArray(invoicesTable.status, OPEN_STATUSES));

  let synced = 0;
  let failed = 0;
  for (const invoice of openInvoices) {
    try {
      const result = await syncInvoiceFromProcast(invoice, conn, "procast-scheduled");
      if (result.ok) {
        synced += 1;
      } else if (result.reason === "fetch_failed") {
        failed += 1;
        logger.warn(
          { invoiceId: invoice.id, reason: result.message },
          "Scheduled Procast sync failed for invoice",
        );
      }
      // "no_rows" is a normal no-op (period has no timesheets yet); not counted as failure.
    } catch (e) {
      failed += 1;
      logger.error({ err: e, invoiceId: invoice.id }, "Scheduled Procast sync threw for invoice");
    }
  }
  return { skipped: false, synced, failed };
}

// Runs a cycle and persists its outcome to the scheduler state, so the UI can
// surface the result of the most recent automatic (or on-demand) pass. Guards
// against overlapping runs the same way the timer tick does.
export async function runAndRecordCycle(): Promise<ProcastSchedulerState> {
  if (running) {
    return getSchedulerState();
  }
  running = true;
  try {
    const result = await runProcastSyncCycle();
    await recordCycleResult(result);
    if (!result.skipped) {
      logger.info(
        { synced: result.synced, failed: result.failed },
        "Procast sync cycle complete",
      );
    }
  } catch (e) {
    await recordCycleResult({
      skipped: false,
      synced: 0,
      failed: 0,
      error: e instanceof Error ? e.message : "Procast sync cycle failed",
    });
    logger.error({ err: e }, "Procast sync cycle failed");
  } finally {
    running = false;
  }
  return getSchedulerState();
}

async function tick(): Promise<void> {
  await runAndRecordCycle();
}

// Starts the background refresh loop. Idempotent: calling it again is a no-op
// while a timer is already active.
export async function startProcastScheduler(): Promise<void> {
  if (timer) return;
  const ms = await getEffectiveIntervalMs();
  timer = setInterval(() => {
    void tick();
  }, ms);
  // Don't keep the event loop alive solely for this timer.
  if (typeof timer.unref === "function") timer.unref();
  logger.info({ intervalMs: ms }, "Procast scheduler started");
}

export function stopProcastScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
