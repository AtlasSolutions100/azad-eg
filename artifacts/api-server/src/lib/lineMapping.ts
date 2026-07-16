import { db, lineItemsTable, employeesTable, type EmployeeRateChange } from "@workspace/db";
import { and, eq, ne } from "drizzle-orm";
import type { ParsedLine } from "./timeimport";
import { normalizeEmployeeName } from "./employeeResolve";
import { effectiveRate } from "./employeeRates";

export type EmployeeRow = typeof employeesTable.$inferSelect;

// Shared mapping of parsed timesheet lines (from file upload OR live Procas pull)
// into invoice line-item rows: matches employees to apply billable rates and
// classifications, and accumulates warnings for rows that need manual attention.
// When `rateChanges`/`effectiveDate` are provided, rate fallbacks honor
// effective-dated rate changes as of that date (typically the period start).
export function linesToLineItems(
  lines: ParsedLine[],
  invoiceId: number,
  employees: EmployeeRow[],
  source: string,
  rateChanges?: Map<number, EmployeeRateChange[]>,
  effectiveDate?: string,
): { toInsert: Array<typeof lineItemsTable.$inferInsert>; warnings: string[] } {
  // Names shared by multiple employees are ambiguous — never guess, or hours
  // could be linked to the wrong person (wrong rate/classification).
  const empByName = new Map<string, EmployeeRow>();
  const ambiguousNames = new Set<string>();
  for (const e of employees) {
    const key = normalizeEmployeeName(e.name);
    if (empByName.has(key)) {
      empByName.delete(key);
      ambiguousNames.add(key);
    } else if (!ambiguousNames.has(key)) {
      empByName.set(key, e);
    }
  }
  const warnings: string[] = [];
  const warnedAmbiguous = new Set<string>();
  const toInsert = lines.map((line) => {
    const key = normalizeEmployeeName(line.employeeName);
    const emp = empByName.get(key);
    if (ambiguousNames.has(key) && !warnedAmbiguous.has(key)) {
      warnedAmbiguous.add(key);
      warnings.push(
        `${line.employeeName}: multiple employees share this name — rows were left unlinked; please link the correct employee manually.`,
      );
    }
    let rate = line.rate;
    let classification = line.classification;
    if (rate <= 0 && emp) {
      rate = effectiveDate
        ? effectiveRate(emp, rateChanges?.get(emp.id) ?? [], line.location, effectiveDate)
        : line.location === "field"
          ? emp.fieldRate ?? emp.homeRate
          : emp.homeRate;
    }
    if (!classification && emp) classification = emp.classification;
    if (rate <= 0) warnings.push(`${line.employeeName}: no rate available, set to 0 — please correct manually.`);
    return {
      invoiceId,
      employeeId: emp?.id ?? null,
      employeeName: line.employeeName,
      classification: classification || "Unspecified",
      category: line.category,
      location: line.location,
      hours: line.hours,
      rate,
      amount: line.hours * rate,
      taskNo: line.taskNo ?? emp?.defaultTaskNo ?? null,
      notes: line.notes ?? null,
      source,
    };
  });
  return { toInsert, warnings };
}

// Re-importing a period must not stack duplicate labor rows on top of a prior
// import. Remove any previously auto-imported rows (source !== "manual") for the
// invoice before inserting the fresh pull; hand-entered "manual" rows are kept.
export async function clearAutoImportedLineItems(invoiceId: number): Promise<number> {
  const removed = await db
    .delete(lineItemsTable)
    .where(and(eq(lineItemsTable.invoiceId, invoiceId), ne(lineItemsTable.source, "manual")))
    .returning();
  return removed.length;
}
