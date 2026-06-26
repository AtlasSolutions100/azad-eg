import { pgTable, integer, text, boolean, timestamp } from "drizzle-orm/pg-core";

// Single-row table (id is always 1) holding the background Procast refresh
// scheduler's configuration and the outcome of its most recent cycle. The
// interval is configurable from the UI; when null the app falls back to the
// PROCAST_SYNC_INTERVAL_MS env var (or a built-in default).
export const procastSchedulerTable = pgTable("procast_scheduler", {
  id: integer("id").primaryKey().default(1),
  intervalMs: integer("interval_ms"),
  lastRunAt: timestamp("last_run_at", { mode: "date" }),
  lastSynced: integer("last_synced").notNull().default(0),
  lastFailed: integer("last_failed").notNull().default(0),
  lastSkipped: boolean("last_skipped").notNull().default(false),
  lastError: text("last_error"),
});

export type ProcastSchedulerRow = typeof procastSchedulerTable.$inferSelect;
export type InsertProcastScheduler = typeof procastSchedulerTable.$inferInsert;
