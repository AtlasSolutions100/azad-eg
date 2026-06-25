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
  fringeRate: doublePrecision("fringe_rate").notNull().default(120.58),
  overheadRate: doublePrecision("overhead_rate"),
  fixedFeeRate: doublePrecision("fixed_fee_rate").notNull().default(8),
  fccmRate: doublePrecision("fccm_rate"),
  billingCycle: text("billing_cycle").notNull().default("whole_month"),
  status: text("status").notNull().default("active"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type WorkPlan = typeof workPlansTable.$inferSelect;
export type InsertWorkPlan = typeof workPlansTable.$inferInsert;
