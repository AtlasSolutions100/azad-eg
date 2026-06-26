import { pgTable, serial, text, integer, doublePrecision } from "drizzle-orm/pg-core";

export const lineItemsTable = pgTable("line_items", {
  id: serial("id").primaryKey(),
  invoiceId: integer("invoice_id").notNull(),
  employeeId: integer("employee_id"),
  employeeName: text("employee_name").notNull(),
  classification: text("classification").notNull(),
  category: text("category").notNull().default("regular"),
  location: text("location").notNull().default("home"),
  hours: doublePrecision("hours").notNull(),
  rate: doublePrecision("rate").notNull(),
  amount: doublePrecision("amount").notNull(),
  taskNo: text("task_no"),
  notes: text("notes"),
  // How this row entered the invoice: "manual" for hand-entered rows, or the
  // import source ("timesheet"/"procas") for auto-imported rows. Re-importing
  // a period replaces prior auto-imported rows but leaves "manual" rows intact.
  source: text("source").notNull().default("manual"),
});

export type LineItemRow = typeof lineItemsTable.$inferSelect;
export type InsertLineItem = typeof lineItemsTable.$inferInsert;
