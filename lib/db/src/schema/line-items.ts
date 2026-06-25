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
});

export type LineItemRow = typeof lineItemsTable.$inferSelect;
export type InsertLineItem = typeof lineItemsTable.$inferInsert;
