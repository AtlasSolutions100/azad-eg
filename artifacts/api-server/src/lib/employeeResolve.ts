import { db, employeesTable, timesheetEntriesTable } from "@workspace/db";
import { and, eq, isNull } from "drizzle-orm";
import { logger } from "./logger";

export function normalizeEmployeeName(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * Resolves an employee name to an employee ID. Returns the ID only when
 * exactly one employee matches the normalized name; returns null when no
 * employee matches OR when multiple employees share the name (ambiguous —
 * guessing could attribute hours to the wrong person).
 */
export async function resolveEmployeeIdByName(name: string): Promise<number | null> {
  const normalized = normalizeEmployeeName(name);
  if (!normalized) return null;
  const employees = await db
    .select({ id: employeesTable.id, name: employeesTable.name })
    .from(employeesTable);
  const matches = employees.filter((e) => normalizeEmployeeName(e.name) === normalized);
  return matches.length === 1 ? matches[0].id : null;
}

/**
 * One-time backfill: sets employeeId on legacy timesheet entries that were
 * created without one, by matching the stored employeeName against the
 * employees table. Ambiguous names (shared by multiple employees) are skipped
 * so two different people are never silently merged under one ID.
 *
 * Returns the number of rows updated. Safe to run repeatedly (idempotent).
 */
export async function backfillTimesheetEmployeeIds(): Promise<number> {
  const [employees, orphanRows] = await Promise.all([
    db.select({ id: employeesTable.id, name: employeesTable.name }).from(employeesTable),
    db
      .select({ id: timesheetEntriesTable.id, employeeName: timesheetEntriesTable.employeeName })
      .from(timesheetEntriesTable)
      .where(isNull(timesheetEntriesTable.employeeId)),
  ]);
  if (orphanRows.length === 0) return 0;

  // Build name -> employeeId map, dropping ambiguous names entirely.
  const byName = new Map<string, number | null>();
  for (const e of employees) {
    const key = normalizeEmployeeName(e.name);
    byName.set(key, byName.has(key) ? null : e.id);
  }

  let updated = 0;
  let ambiguous = 0;
  for (const row of orphanRows) {
    const key = normalizeEmployeeName(row.employeeName);
    const empId = byName.get(key);
    if (empId == null) {
      if (byName.has(key)) ambiguous++;
      continue;
    }
    await db
      .update(timesheetEntriesTable)
      .set({ employeeId: empId })
      .where(and(eq(timesheetEntriesTable.id, row.id), isNull(timesheetEntriesTable.employeeId)));
    updated++;
  }
  if (ambiguous > 0) {
    logger.warn(
      { ambiguous },
      "Timesheet employeeId backfill skipped rows whose names match multiple employees",
    );
  }
  return updated;
}
