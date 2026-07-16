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
    // Why the tick was skipped, when it was: "db_busy" / "lock_held" for ticks
    // that never ran a cycle, or null for skips due to Procas being
    // disconnected (and for all non-skipped rows).
    skipReason: text("skip_reason"),
    // How many consecutive skipped ticks this row represents. Back-to-back
    // scheduler skips with the same reason are collapsed into one row (this
    // counter bumps and ranAt advances) so a long busy stretch cannot push
    // real completed cycles out of the bounded history.
    skipCount: integer("skip_count").notNull().default(1),
    error: text("error"),
  },
  (table) => [index("procas_scheduler_runs_ran_at_idx").on(table.ranAt)],
);

export type ProcasSchedulerRunRow = typeof procasSchedulerRunsTable.$inferSelect;
export type InsertProcasSchedulerRun = typeof procasSchedulerRunsTable.$inferInsert;
