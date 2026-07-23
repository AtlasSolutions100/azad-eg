import { pgTable, serial, text, doublePrecision, timestamp } from "drizzle-orm/pg-core";

export const workPlansTable = pgTable("work_plans", {
  id: serial("id").primaryKey(),
  code: text("code").notNull(),
  title: text("title").notNull(),
  client: text("client").notNull(),
  jobNumber: text("job_number").notNull(),
  agreementNo: text("agreement_no"),
  poNumber: text("po_number"),
  wspProjectNo: text("wsp_project_no"),
  totalBudget: doublePrecision("total_budget").notNull(),
  // Per-category decomposition of the budget and previously-billed amounts,
  // mirroring the reference Sub Calc rows (labor / overhead / fixed fee /
  // FCCM). Null means "not decomposed" — the export back-solves from totals.
  budgetLabor: doublePrecision("budget_labor"),
  budgetOverhead: doublePrecision("budget_overhead"),
  budgetFixedFee: doublePrecision("budget_fixed_fee"),
  budgetFccm: doublePrecision("budget_fccm"),
  prevBilledLabor: doublePrecision("prev_billed_labor"),
  prevBilledOverhead: doublePrecision("prev_billed_overhead"),
  prevBilledFixedFee: doublePrecision("prev_billed_fixed_fee"),
  prevBilledFccm: doublePrecision("prev_billed_fccm"),
  fringeRate: doublePrecision("fringe_rate").notNull().default(120.58),
  overheadRate: doublePrecision("overhead_rate"),
  fixedFeeRate: doublePrecision("fixed_fee_rate").notNull().default(8),
  fccmRate: doublePrecision("fccm_rate"),
  // Cover-page header fields for the client-facing invoice (BART/AECOM).
  supplierId: text("supplier_id"),
  clientProjectNo: text("client_project_no"),
  sendToCompany: text("send_to_company"),
  sendToAddress1: text("send_to_address1"),
  sendToAddress2: text("send_to_address2"),
  contactPerson: text("contact_person"),
  bartProjectNumbers: text("bart_project_numbers"),
  terms: text("terms"),
  // Procas project code (or prefix) this work plan maps to, e.g. "10007".
  // Used to pull labor hours from the Procas OData feed; null = not mapped.
  procasProject: text("procas_project"),
  billingCycle: text("billing_cycle").notNull().default("whole_month"),
  status: text("status").notNull().default("active"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type WorkPlan = typeof workPlansTable.$inferSelect;
export type InsertWorkPlan = typeof workPlansTable.$inferInsert;
