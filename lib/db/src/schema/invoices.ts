import { pgTable, serial, text, integer, doublePrecision, date, timestamp } from "drizzle-orm/pg-core";

export const invoicesTable = pgTable("invoices", {
  id: serial("id").primaryKey(),
  workPlanId: integer("work_plan_id").notNull(),
  invoiceNumber: text("invoice_number").notNull(),
  invoiceDate: date("invoice_date", { mode: "string" }).notNull(),
  periodStart: date("period_start", { mode: "string" }).notNull(),
  periodEnd: date("period_end", { mode: "string" }).notNull(),
  status: text("status").notNull().default("draft"),
  previouslyBilled: doublePrecision("previously_billed").notNull().default(0),
  otherDirectCosts: doublePrecision("other_direct_costs").notNull().default(0),
  preparedBy: text("prepared_by"),
  approvedBy: text("approved_by"),
  signatureId: integer("signature_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export type InvoiceRow = typeof invoicesTable.$inferSelect;
export type InsertInvoice = typeof invoicesTable.$inferInsert;
