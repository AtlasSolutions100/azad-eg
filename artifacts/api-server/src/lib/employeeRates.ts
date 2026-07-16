import { db, employeeRateChangesTable, type EmployeeRateChange, type Employee } from "@workspace/db";
import { eq, inArray } from "drizzle-orm";

/**
 * Effective-dated billing rates. The base rates on the employees row apply
 * before the earliest rate change; from a change's effectiveDate (inclusive)
 * onward, that change's rates apply until a later change supersedes it.
 *
 * This is what lets a mid-period rate change land as two Labor Attachment
 * rows in the export: entries in weeks starting on/after the effective date
 * pick up the new rate, and the workbook builder splits hours per rate.
 */

type BaseRates = Pick<Employee, "homeRate" | "fieldRate">;

/** The change in force on `dateISO` (YYYY-MM-DD), or null for base rates. */
export function rateChangeInForce(
  changes: EmployeeRateChange[],
  dateISO: string,
): EmployeeRateChange | null {
  let best: EmployeeRateChange | null = null;
  for (const c of changes) {
    if (c.effectiveDate > dateISO) continue;
    if (!best || c.effectiveDate > best.effectiveDate || (c.effectiveDate === best.effectiveDate && c.id > best.id)) {
      best = c;
    }
  }
  return best;
}

/** Billing rate for a location ("home"/"field") effective on `dateISO`. */
export function effectiveRate(
  emp: BaseRates,
  changes: EmployeeRateChange[],
  location: string,
  dateISO: string,
): number {
  const change = rateChangeInForce(changes, dateISO);
  const home = change ? change.homeRate : emp.homeRate;
  const field = change ? change.fieldRate ?? change.homeRate : emp.fieldRate ?? emp.homeRate;
  return location === "field" ? field : home;
}

/** Loads rate changes for a set of employees, keyed by employeeId. */
export async function loadRateChanges(
  employeeIds: number[],
): Promise<Map<number, EmployeeRateChange[]>> {
  const map = new Map<number, EmployeeRateChange[]>();
  if (employeeIds.length === 0) return map;
  const unique = [...new Set(employeeIds)];
  const rows =
    unique.length === 1
      ? await db
          .select()
          .from(employeeRateChangesTable)
          .where(eq(employeeRateChangesTable.employeeId, unique[0]))
      : await db
          .select()
          .from(employeeRateChangesTable)
          .where(inArray(employeeRateChangesTable.employeeId, unique));
  for (const r of rows) {
    const list = map.get(r.employeeId);
    if (list) list.push(r);
    else map.set(r.employeeId, [r]);
  }
  return map;
}
