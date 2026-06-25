import { pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

export const referenceEntriesTable = pgTable("reference_entries", {
  id: serial("id").primaryKey(),
  category: text("category").notNull(),
  key: text("key").notNull(),
  label: text("label").notNull(),
  value: text("value").notNull(),
  unit: text("unit"),
  description: text("description"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export type ReferenceEntryRow = typeof referenceEntriesTable.$inferSelect;
export type InsertReferenceEntry = typeof referenceEntriesTable.$inferInsert;
