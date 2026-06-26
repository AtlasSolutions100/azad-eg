import { pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

export const billingRuleSheetsTable = pgTable("billing_rule_sheets", {
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
  notes: text("notes"),
  fileUrl: text("file_url").notNull(),
  fileName: text("file_name").notNull(),
  contentType: text("content_type"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type BillingRuleSheetRow = typeof billingRuleSheetsTable.$inferSelect;
export type InsertBillingRuleSheet = typeof billingRuleSheetsTable.$inferInsert;
