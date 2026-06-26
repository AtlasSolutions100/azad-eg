import { db, invoicesTable } from "@workspace/db";
import { inArray } from "drizzle-orm";
import { getProcastConnection } from "./procast";
import { syncInvoiceFromProcast } from "./procastSync";
import { logger } from "./logger";

// Invoices that are still being worked on — these are the ones a live Procast
// feed should keep refreshed. Approved/exported invoices are finalized and must
// not be mutated by a background pull.
const OPEN_STATUSES = ["draft", "in_review"];

const DEFAULT_INTERVAL_MS = 15 * 60 * 1000;

let timer: NodeJS.Timeout | null = null;
let running = false;

function intervalMs(): number {
  const raw = process.env["PROCAST_SYNC_INTERVAL_MS"];
  if (!raw) return DEFAULT_INTERVAL_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_INTERVAL_MS;
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

async function tick(): Promise<void> {
  if (running) return; // avoid overlapping runs if a cycle outlasts the interval
  running = true;
  try {
    const result = await runProcastSyncCycle();
    if (!result.skipped) {
      logger.info({ synced: result.synced, failed: result.failed }, "Scheduled Procast sync cycle complete");
    }
  } catch (e) {
    logger.error({ err: e }, "Scheduled Procast sync cycle failed");
  } finally {
    running = false;
  }
}

// Starts the background refresh loop. Idempotent: calling it again is a no-op
// while a timer is already active.
export function startProcastScheduler(): void {
  if (timer) return;
  const ms = intervalMs();
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
