import { db, invoicesTable, employeesTable, lineItemsTable, type LineItemRow, type ProcastConnectionRow } from "@workspace/db";
import { eq } from "drizzle-orm";
import { fetchProcastTimesheets, markProcastSynced } from "./procast";
import { parseTimeRecords } from "./timeimport";
import { linesToLineItems, clearAutoImportedLineItems } from "./lineMapping";
import { recomputeCarryOver } from "./carryover";
import { recordAudit } from "./audit";

type InvoiceRow = typeof invoicesTable.$inferSelect;

export type ProcastSyncResult =
  | { ok: true; importedCount: number; replacedCount: number; warnings: string[]; lineItems: LineItemRow[] }
  | { ok: false; reason: "fetch_failed" | "no_rows"; message: string; warnings: string[] };

// Pulls timesheet records for a single invoice's billing period from the live
// Procast API and imports them as line items. Shared by the manual
// "Sync from Procast" endpoint and the scheduled background refresh so both
// behave identically (fetch → parse → map → insert → stamp last-synced → audit).
export async function syncInvoiceFromProcast(
  invoice: InvoiceRow,
  conn: Pick<ProcastConnectionRow, "baseUrl" | "apiKey">,
  source: "procast" | "procast-scheduled" = "procast",
): Promise<ProcastSyncResult> {
  if (!conn.baseUrl || !conn.apiKey) {
    return { ok: false, reason: "fetch_failed", message: "Procast credentials are missing.", warnings: [] };
  }

  let records: Array<Record<string, unknown>>;
  try {
    records = await fetchProcastTimesheets(
      { baseUrl: conn.baseUrl, apiKey: conn.apiKey },
      { start: invoice.periodStart, end: invoice.periodEnd },
    );
  } catch (e) {
    return {
      ok: false,
      reason: "fetch_failed",
      message: e instanceof Error ? e.message : "Failed to pull from Procast.",
      warnings: [],
    };
  }

  const parsed = parseTimeRecords(records);
  if (parsed.lines.length === 0) {
    return { ok: false, reason: "no_rows", message: "No valid timesheet rows returned by Procast.", warnings: parsed.warnings };
  }

  const employees = await db.select().from(employeesTable);
  const { toInsert, warnings: mapWarnings } = linesToLineItems(parsed.lines, invoice.id, employees, "procast");
  const warnings = [...parsed.warnings, ...mapWarnings];

  // Replace any previously auto-imported rows so re-syncing the same period
  // does not duplicate labor; hand-entered rows are preserved.
  const replacedCount = await clearAutoImportedLineItems(invoice.id);
  if (replacedCount > 0) {
    warnings.unshift(`Replaced ${replacedCount} previously imported line item(s) for this period.`);
  }

  const inserted = await db.insert(lineItemsTable).values(toInsert).returning();
  // New labor changes this invoice's total-to-date; refresh downstream carry-over.
  await recomputeCarryOver(invoice.workPlanId);
  await markProcastSynced(new Date());
  await recordAudit({
    action: source === "procast-scheduled" ? "auto-synced from Procast" : "synced from Procast",
    entityType: "invoice",
    entityId: invoice.id,
    description:
      source === "procast-scheduled"
        ? `${inserted.length} line items pulled by scheduled Procast refresh${replacedCount > 0 ? ` (replaced ${replacedCount})` : ""}`
        : `${inserted.length} line items pulled live from Procast${replacedCount > 0 ? ` (replaced ${replacedCount})` : ""}`,
  });

  return { ok: true, importedCount: inserted.length, replacedCount, warnings, lineItems: inserted };
}

export async function getInvoiceById(id: number): Promise<InvoiceRow | null> {
  const [row] = await db.select().from(invoicesTable).where(eq(invoicesTable.id, id));
  return row ?? null;
}
