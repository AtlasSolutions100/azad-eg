import { pgTable, serial, text, doublePrecision, boolean, timestamp } from "drizzle-orm/pg-core";

export const employeesTable = pgTable("employees", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  classification: text("classification").notNull(),
  homeRate: doublePrecision("home_rate").notNull(),
  fieldRate: doublePrecision("field_rate"),
  defaultTaskNo: text("default_task_no"),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type Employee = typeof employeesTable.$inferSelect;
export type InsertEmployee = typeof employeesTable.$inferInsert;
