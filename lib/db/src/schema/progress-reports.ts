import { pgTable, serial, text, integer, doublePrecision, date } from "drizzle-orm/pg-core";

export const progressReportsTable = pgTable("progress_reports", {
  id: serial("id").primaryKey(),
  invoiceId: integer("invoice_id").notNull().unique(),
  percentComplete: doublePrecision("percent_complete").notNull().default(0),
  summary: text("summary").notNull().default(""),
  workCompleted: text("work_completed"),
  workPlanned: text("work_planned"),
  issues: text("issues"),
  scheduleStatus: text("schedule_status"),
  budgetStatus: text("budget_status"),
  preparedBy: text("prepared_by"),
  reportDate: date("report_date", { mode: "string" }).notNull(),
});

export type ProgressReportRow = typeof progressReportsTable.$inferSelect;
export type InsertProgressReport = typeof progressReportsTable.$inferInsert;
