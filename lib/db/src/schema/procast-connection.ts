import { pgTable, integer, text, boolean, timestamp } from "drizzle-orm/pg-core";

// Single-row table (id is always 1) holding the live Procast API connection.
// When `connected` is true the app pulls timesheets directly from Procast;
// otherwise it falls back to manual CSV/Excel upload.
export const procastConnectionTable = pgTable("procast_connection", {
  id: integer("id").primaryKey().default(1),
  connected: boolean("connected").notNull().default(false),
  baseUrl: text("base_url"),
  apiKey: text("api_key"),
  lastSyncAt: timestamp("last_sync_at", { mode: "date" }),
});

export type ProcastConnectionRow = typeof procastConnectionTable.$inferSelect;
export type InsertProcastConnection = typeof procastConnectionTable.$inferInsert;
