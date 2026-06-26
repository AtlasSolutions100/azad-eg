import { db, lineItemsTable, employeesTable } from "@workspace/db";
import { and, eq, ne } from "drizzle-orm";
import type { ParsedLine } from "./timeimport";

export type EmployeeRow = typeof employeesTable.$inferSelect;

// Shared mapping of parsed timesheet lines (from file upload OR live Procast pull)
// into invoice line-item rows: matches employees to apply billable rates and
// classifications, and accumulates warnings for rows that need manual attention.
export function linesToLineItems(
  lines: ParsedLine[],
  invoiceId: number,
  employees: EmployeeRow[],
  source: string,
): { toInsert: Array<typeof lineItemsTable.$inferInsert>; warnings: string[] } {
  const empByName = new Map(employees.map((e) => [e.name.toLowerCase().trim(), e]));
  const warnings: string[] = [];
  const toInsert = lines.map((line) => {
    const emp = empByName.get(line.employeeName.toLowerCase().trim());
    let rate = line.rate;
    let classification = line.classification;
    if (rate <= 0 && emp) {
      rate = line.location === "field" ? emp.fieldRate ?? emp.homeRate : emp.homeRate;
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
