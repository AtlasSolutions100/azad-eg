import { pgTable, serial, integer, text, doublePrecision, timestamp } from "drizzle-orm/pg-core";
import { employeesTable } from "./employees";

/**
 * Effective-dated billing-rate changes for an employee. The base rates on the
 * employees row apply before the earliest change; from each change's
 * effectiveDate (YYYY-MM-DD, inclusive) onward the change's rates apply until
 * a later change supersedes it. A mid-period change makes timesheet entries
 * in weeks on/after the date carry the new rate, which the master-workbook
 * export renders as two Labor Attachment rows (old-rate hours / new-rate
 * hours), matching the reference workbook.
 */
export const employeeRateChangesTable = pgTable("employee_rate_changes", {
  id: serial("id").primaryKey(),
  employeeId: integer("employee_id")
    .notNull()
    .references(() => employeesTable.id, { onDelete: "cascade" }),
  effectiveDate: text("effective_date").notNull(),
  homeRate: doublePrecision("home_rate").notNull(),
  fieldRate: doublePrecision("field_rate"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type EmployeeRateChange = typeof employeeRateChangesTable.$inferSelect;
export type InsertEmployeeRateChange = typeof employeeRateChangesTable.$inferInsert;
