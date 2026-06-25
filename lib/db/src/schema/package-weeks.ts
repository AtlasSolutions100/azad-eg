import { pgTable, serial, text, integer, date, timestamp } from "drizzle-orm/pg-core";
import { packagesTable } from "./packages";

/**
 * A weekly timesheet belonging to a Package's pay period. A pay period can hold
 * multiple weeks; weeks are grouped inside the pay-period tile, not surfaced as
 * separate top-level records.
 */
export const packageWeeksTable = pgTable("package_weeks", {
  id: serial("id").primaryKey(),
  packageId: integer("package_id").notNull().references(() => packagesTable.id, { onDelete: "cascade" }),
  label: text("label").notNull(),
  weekStart: date("week_start", { mode: "string" }).notNull(),
  weekEnd: date("week_end", { mode: "string" }).notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type PackageWeekRow = typeof packageWeeksTable.$inferSelect;
export type InsertPackageWeek = typeof packageWeeksTable.$inferInsert;
