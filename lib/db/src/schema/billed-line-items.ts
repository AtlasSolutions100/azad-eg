import { pgTable, serial, text, integer, doublePrecision } from "drizzle-orm/pg-core";
import { packagesTable } from "./packages";

/**
 * Billed Line Items — the rows of the Cover/Invoice "Billed Line Items"
 * table on the client-facing BART/AECOM invoice. Each row is keyed by
 * Work Scope No. + PO No. + Line # + BART Project No. and carries the PO
 * Amount, Previous Invoiced (carried forward from the last approved
 * invoice for the same work plan) and Current Invoiced amount. Total
 * Invoiced and Remaining Balance are computed (previous + current, PO
 * amount − total) both in the API rollup and as live formulas in the
 * exported workbook.
 */
export const billedLineItemsTable = pgTable("billed_line_items", {
  id: serial("id").primaryKey(),
  packageId: integer("package_id")
    .notNull()
    .references(() => packagesTable.id, { onDelete: "cascade" }),
  workScopeNo: text("work_scope_no").notNull(),
  poNo: text("po_no"),
  lineNo: integer("line_no"),
  bartProjectNo: text("bart_project_no"),
  poAmount: doublePrecision("po_amount").notNull().default(0),
  previousInvoiced: doublePrecision("previous_invoiced").notNull().default(0),
  currentInvoiced: doublePrecision("current_invoiced").notNull().default(0),
  sortOrder: integer("sort_order").notNull().default(0),
  // Where the row came from: "carry_forward" when auto-seeded from the last
  // approved invoice for the work plan, "manual" once hand-entered/edited.
  source: text("source").notNull().default("manual"),
});

export type BilledLineItemRow = typeof billedLineItemsTable.$inferSelect;
export type InsertBilledLineItem = typeof billedLineItemsTable.$inferInsert;
