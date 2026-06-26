import { db, invoicesTable, employeesTable, lineItemsTable, type LineItemRow, type ProcasConnectionRow } from "@workspace/db";
import { eq } from "drizzle-orm";
import { fetchTimesheetsFromProcas, markProcasSynced } from "./procas";
import { parseTimeRecords } from "./timeimport";
import { linesToLineItems, clearAutoImportedLineItems } from "./lineMapping";
import { recomputeCarryOverWithAudit } from "./carryover";
import { recordAudit } from "./audit";

type InvoiceRow = typeof invoicesTable.$inferSelect;

export type ProcasSyncResult =
  | { ok: true; importedCount: number; replacedCount: number; warnings: string[]; lineItems: LineItemRow[] }
  | { ok: false; reason: "fetch_failed" | "no_rows"; message: string; warnings: string[] };

// Pulls timesheet records for a single invoice's billing period from the live
// Procas API and imports them as line items. Shared by the manual
// "Sync from Procas" endpoint and the scheduled background refresh so both
// behave identically (fetch → parse → map → insert → stamp last-synced → audit).
export async function syncInvoiceFromProcas(
  invoice: InvoiceRow,
  conn: Pick<ProcasConnectionRow, "baseUrl" | "apiKey">,
  source: "procas" | "procas-scheduled" = "procas",
): Promise<ProcasSyncResult> {
  if (!conn.baseUrl || !conn.apiKey) {
    return { ok: false, reason: "fetch_failed", message: "Procas credentials are missing.", warnings: [] };
  }

  let records: Array<Record<string, unknown>>;
  try {
    records = await fetchTimesheetsFromProcas(
      { baseUrl: conn.baseUrl, apiKey: conn.apiKey },
      { start: invoice.periodStart, end: invoice.periodEnd },
    );
  } catch (e) {
    return {
      ok: false,
      reason: "fetch_failed",
      message: e instanceof Error ? e.message : "Failed to pull from Procas.",
      warnings: [],
    };
  }

  const parsed = parseTimeRecords(records);
  if (parsed.lines.length === 0) {
    return { ok: false, reason: "no_rows", message: "No valid timesheet rows returned by Procas.", warnings: parsed.warnings };
  }

  const employees = await db.select().from(employeesTable);
  const { toInsert, warnings: mapWarnings } = linesToLineItems(parsed.lines, invoice.id, employees, "procas");
  const warnings = [...parsed.warnings, ...mapWarnings];

  // Replace any previously auto-imported rows so re-syncing the same period
  // does not duplicate labor; hand-entered rows are preserved.
  const replacedCount = await clearAutoImportedLineItems(invoice.id);
  if (replacedCount > 0) {
    warnings.unshift(`Replaced ${replacedCount} previously imported line item(s) for this period.`);
  }

  const inserted = await db.insert(lineItemsTable).values(toInsert).returning();
  // New labor changes this invoice's total-to-date; refresh downstream carry-over.
  await recomputeCarryOverWithAudit(invoice.workPlanId, {
    invoiceId: invoice.id,
    invoiceNumber: invoice.invoiceNumber,
    reason: source === "procas-scheduled" ? "a scheduled Procas sync of" : "a Procas sync of",
  });
  await markProcasSynced(new Date());
  await recordAudit({
    action: source === "procas-scheduled" ? "auto-synced from Procas" : "synced from Procas",
    entityType: "invoice",
    entityId: invoice.id,
    description:
      source === "procas-scheduled"
        ? `${inserted.length} line items pulled by scheduled Procas refresh${replacedCount > 0 ? ` (replaced ${replacedCount})` : ""}`
        : `${inserted.length} line items pulled live from Procas${replacedCount > 0 ? ` (replaced ${replacedCount})` : ""}`,
  });

  return { ok: true, importedCount: inserted.length, replacedCount, warnings, lineItems: inserted };
}

export async function getInvoiceById(id: number): Promise<InvoiceRow | null> {
  const [row] = await db.select().from(invoicesTable).where(eq(invoicesTable.id, id));
  return row ?? null;
}
