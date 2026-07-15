import { pgTable, serial, integer, text, boolean, timestamp, index } from "drizzle-orm/pg-core";

// One row per completed background (or on-demand) Procas refresh cycle, so
// billers can review a short rolling history of outcomes rather than only the
// most recent snapshot. The table is pruned after each insert to a small cap,
// so it never grows unbounded.
export const procasSchedulerRunsTable = pgTable(
  "procas_scheduler_runs",
  {
    id: serial("id").primaryKey(),
    ranAt: timestamp("ran_at", { mode: "date" }).notNull().defaultNow(),
    synced: integer("synced").notNull().default(0),
    failed: integer("failed").notNull().default(0),
    skipped: boolean("skipped").notNull().default(false),
    error: text("error"),
  },
  (table) => [index("procas_scheduler_runs_ran_at_idx").on(table.ranAt)],
);

export type ProcasSchedulerRunRow = typeof procasSchedulerRunsTable.$inferSelect;
export type InsertProcasSchedulerRun = typeof procasSchedulerRunsTable.$inferInsert;
