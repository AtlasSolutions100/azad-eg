import { pgTable, serial, text } from "drizzle-orm/pg-core";

export const columnDefinitionsTable = pgTable("column_definitions", {
  id: serial("id").primaryKey(),
  sheet: text("sheet").notNull(),
  column: text("column"),
  field: text("field").notNull(),
  source: text("source").notNull(),
  formula: text("formula"),
  description: text("description").notNull(),
});

export type ColumnDefinitionRow = typeof columnDefinitionsTable.$inferSelect;
export type InsertColumnDefinition = typeof columnDefinitionsTable.$inferInsert;
