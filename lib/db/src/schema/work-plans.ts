import { pgTable, serial, text, doublePrecision, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const workPlansTable = pgTable("work_plans", {
  id: serial("id").primaryKey(),
  code: text("code").notNull(),
  title: text("title").notNull(),
  // Short human-friendly label the biller assigns (e.g. "BART On-Call" or
  // "WSP De'Andre") so the work-plan picker reads cleanly instead of showing a
  // long "6M8142-B50 - <full title>". Null = fall back to code/title.
  nickname: text("nickname"),
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
  // Max billable rate per hour. When set, any employee whose billing rate
  // exceeds this cap is billed at the cap (a contract's "Bill Rate Override" /
  // Max Rate Cap, e.g. $115/hr). Null = no cap.
  maxBillRate: doublePrecision("max_bill_rate"),
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
  // "whole_month" (1st → last day) or "last_friday" (BART's Sat→Fri cycle —
  // see lib/billingPeriod.ts). Which one a work plan uses is a fact about the
  // contract, recorded per project in the invoice register; the default is the
  // calendar month, and the Procas import applies the register over it.
  billingCycle: text("billing_cycle").notNull().default("whole_month"),
  status: text("status").notNull().default("active"),
  // "manual" = created/edited by a biller (Procas import never touches its
  // display fields); "procas" = imported from the Procas project library and
  // kept in sync with it. Manual edits flip it back to "manual".
  source: text("source").notNull().default("manual"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  // One imported work plan per Procas project — makes the library import
  // idempotent even under concurrent runs (scheduler vs manual refresh).
  // Manually created plans may still share a Procas prefix freely.
  uniqueIndex("work_plans_procas_import_unique")
    .on(t.procasProject)
    .where(sql`${t.source} = 'procas' and ${t.procasProject} is not null`),
]);

export type WorkPlan = typeof workPlansTable.$inferSelect;
export type InsertWorkPlan = typeof workPlansTable.$inferInsert;
