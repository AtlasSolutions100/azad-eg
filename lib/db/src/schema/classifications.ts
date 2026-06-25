import { pgTable, serial, text, doublePrecision, date } from "drizzle-orm/pg-core";

export const classificationsTable = pgTable("classifications", {
  id: serial("id").primaryKey(),
  code: text("code").notNull(),
  description: text("description").notNull(),
  regularRate: doublePrecision("regular_rate").notNull(),
  otRate: doublePrecision("ot_rate"),
  dtRate: doublePrecision("dt_rate"),
  location: text("location").notNull().default("both"),
  effectiveDate: date("effective_date", { mode: "string" }),
});

export type Classification = typeof classificationsTable.$inferSelect;
export type InsertClassification = typeof classificationsTable.$inferInsert;
