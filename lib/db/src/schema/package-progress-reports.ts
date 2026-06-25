import { pgTable, serial, text, integer, doublePrecision, date, timestamp } from "drizzle-orm/pg-core";
import { packagesTable } from "./packages";

/**
 * Progress Report narrative for a Package. Supports dual input: the rich-text
 * narrative fields below, and an optional uploaded narrative file (Excel/Word/
 * PDF) referenced by uploadedFileUrl.
 */
export const packageProgressReportsTable = pgTable("package_progress_reports", {
  id: serial("id").primaryKey(),
  packageId: integer("package_id").notNull().unique().references(() => packagesTable.id, { onDelete: "cascade" }),
  percentComplete: doublePrecision("percent_complete").notNull().default(0),
  summary: text("summary").notNull().default(""),
  workPerformed: text("work_performed"),
  concerns: text("concerns"),
  correctiveAction: text("corrective_action"),
  scheduleComment: text("schedule_comment"),
  costForecast: text("cost_forecast"),
  preparedBy: text("prepared_by"),
  reportDate: date("report_date", { mode: "string" }),
  uploadedFileUrl: text("uploaded_file_url"),
  uploadedFileName: text("uploaded_file_name"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export type PackageProgressReportRow = typeof packageProgressReportsTable.$inferSelect;
export type InsertPackageProgressReport = typeof packageProgressReportsTable.$inferInsert;
