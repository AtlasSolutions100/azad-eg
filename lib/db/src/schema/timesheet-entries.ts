import { pgTable, serial, text, integer, doublePrecision, timestamp } from "drizzle-orm/pg-core";
import { packagesTable } from "./packages";
import { packageWeeksTable } from "./package-weeks";

/**
 * One line of work within a weekly timesheet: an employee/classification, a
 * category (regular/ot/dt/night/holiday/pto), a location (home/field), and a
 * daily hour breakdown (Mon–Sun). These rows feed the Labor Attachment and, in
 * turn, the SubCalc and Invoice. packageId is denormalized for fast rollups.
 */
export const timesheetEntriesTable = pgTable("timesheet_entries", {
  id: serial("id").primaryKey(),
  packageId: integer("package_id").notNull().references(() => packagesTable.id, { onDelete: "cascade" }),
  weekId: integer("week_id").notNull().references(() => packageWeeksTable.id, { onDelete: "cascade" }),
  employeeId: integer("employee_id"),
  employeeName: text("employee_name").notNull(),
  classification: text("classification").notNull(),
  category: text("category").notNull().default("regular"),
  location: text("location").notNull().default("home"),
  hoursMon: doublePrecision("hours_mon").notNull().default(0),
  hoursTue: doublePrecision("hours_tue").notNull().default(0),
  hoursWed: doublePrecision("hours_wed").notNull().default(0),
  hoursThu: doublePrecision("hours_thu").notNull().default(0),
  hoursFri: doublePrecision("hours_fri").notNull().default(0),
  hoursSat: doublePrecision("hours_sat").notNull().default(0),
  hoursSun: doublePrecision("hours_sun").notNull().default(0),
  rate: doublePrecision("rate").notNull().default(0),
  taskNo: text("task_no"),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type TimesheetEntryRow = typeof timesheetEntriesTable.$inferSelect;
export type InsertTimesheetEntry = typeof timesheetEntriesTable.$inferInsert;
