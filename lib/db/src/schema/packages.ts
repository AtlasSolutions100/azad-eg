import { pgTable, serial, text, integer, doublePrecision, date, timestamp, unique } from "drizzle-orm/pg-core";
import { employeesTable } from "./employees";
import { workPlansTable } from "./work-plans";

/**
 * A Package is the central unit of the new model: one employee + one job number
 * (work plan) + one pay period. It groups multiple weekly timesheets and tracks
 * the state of the 5 documents it produces (Invoice, SubCalc, Progress Report,
 * Labor Attachment, Timesheets).
 */
export const packagesTable = pgTable(
  "packages",
  {
  id: serial("id").primaryKey(),
  employeeId: integer("employee_id").notNull().references(() => employeesTable.id),
  workPlanId: integer("work_plan_id").notNull().references(() => workPlansTable.id),
  payPeriodStart: date("pay_period_start", { mode: "string" }).notNull(),
  payPeriodEnd: date("pay_period_end", { mode: "string" }).notNull(),
  invoiceNumber: text("invoice_number"),
  invoiceDate: date("invoice_date", { mode: "string" }),
  previouslyBilled: doublePrecision("previously_billed").notNull().default(0),
  // Where the previouslyBilled value came from: "procas" when defaulted from
  // Procas BillingHistory, "manual" once a user edits it, null when neither.
  previouslyBilledSource: text("previously_billed_source"),
  otherDirectCosts: doublePrecision("other_direct_costs").notNull().default(0),
  signatureId: integer("signature_id"),
  preparedBy: text("prepared_by"),
  approvedBy: text("approved_by"),
  // Package lifecycle: draft | in_review | approved | exported
  status: text("status").notNull().default("draft"),
  // Per-document status: not_started | in_progress | ready
  invoiceDocStatus: text("invoice_doc_status").notNull().default("not_started"),
  subCalcDocStatus: text("sub_calc_doc_status").notNull().default("not_started"),
  progressReportDocStatus: text("progress_report_doc_status").notNull().default("not_started"),
  laborAttachmentDocStatus: text("labor_attachment_doc_status").notNull().default("not_started"),
  timesheetsDocStatus: text("timesheets_doc_status").notNull().default("not_started"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
  },
  (table) => ({
    packageIdentity: unique("packages_identity_unique").on(
      table.employeeId,
      table.workPlanId,
      table.payPeriodStart,
      table.payPeriodEnd,
    ),
  }),
);

export type PackageRow = typeof packagesTable.$inferSelect;
export type InsertPackage = typeof packagesTable.$inferInsert;
