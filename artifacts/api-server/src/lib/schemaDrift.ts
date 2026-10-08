import { getTableColumns, getTableName, is, sql } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import * as workspaceDb from "@workspace/db";
import { logger } from "./logger";

/**
 * Compares the columns the code expects (the drizzle table definitions) with
 * the columns the connected database actually has.
 *
 * Deploying a schema change is two steps — pull the code, then `db push` — and
 * the second one is easy to skip. When it is, the first request to touch the
 * new column throws a Postgres 42703 ("column does not exist") deep inside a
 * route, and Express's default handler turns that into a raw HTML 500. That is
 * the "Could not create package — HTTP 500 <!DOCTYPE html>…" Julie got the
 * morning `packages.previous_hours` shipped: the code was live, the column was
 * not. This check runs at startup so the gap is logged in one plain sentence
 * the moment the server boots, and `describeDrift` lets the error handler say
 * the same thing to the browser.
 */
export interface SchemaDrift {
  table: string;
  missing: string[];
}

export const DB_PUSH_COMMAND = "pnpm --filter @workspace/db run push";

/** Every drizzle table the workspace exports, keyed by its database name. */
function expectedColumns(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const value of Object.values(workspaceDb)) {
    if (!is(value, PgTable)) continue;
    const cols = Object.values(getTableColumns(value)).map((c) => c.name);
    out.set(getTableName(value), cols);
  }
  return out;
}

export async function detectSchemaDrift(): Promise<SchemaDrift[]> {
  const rows = await workspaceDb.db.execute<{ table_name: string; column_name: string }>(sql`
    select table_name, column_name
    from information_schema.columns
    where table_schema = current_schema()
  `);
  const actual = new Map<string, Set<string>>();
  for (const r of rows.rows) {
    if (!actual.has(r.table_name)) actual.set(r.table_name, new Set());
    actual.get(r.table_name)!.add(r.column_name);
  }
  const drift: SchemaDrift[] = [];
  for (const [table, cols] of expectedColumns()) {
    const have = actual.get(table) ?? new Set<string>();
    const missing = cols.filter((c) => !have.has(c));
    if (missing.length > 0) drift.push({ table, missing });
  }
  return drift;
}

/** One sentence a biller or an operator can act on. */
export function describeDrift(drift: SchemaDrift[]): string {
  const list = drift.map((d) => d.missing.map((c) => `${d.table}.${c}`).join(", ")).join(", ");
  return (
    `The database is missing columns the code expects (${list}). ` +
    `The schema step of the deploy was skipped — on the deployment run \`${DB_PUSH_COMMAND}\`, ` +
    `then restart the server.`
  );
}

/**
 * Columns that are safe to create at startup: nullable, no default, no
 * constraint, and declared identically in the drizzle schema, so a later
 * `db push` finds nothing to do.
 *
 * The schema step of a deploy has been skipped before, and it took the package
 * screen down for a morning. A column that only ever ADDS room for a value
 * does not need a person to remember a second command.
 */
const ADDITIVE_COLUMNS: ReadonlyArray<{ table: string; column: string; type: string }> = [
  { table: "work_plans", column: "procas_budget", type: "double precision" },
  { table: "work_plans", column: "budget_history", type: "text" },
];

/** Creates any missing additive columns. Never throws; returns what it added. */
export async function ensureAdditiveColumns(): Promise<string[]> {
  const added: string[] = [];
  for (const c of ADDITIVE_COLUMNS) {
    try {
      const found = await workspaceDb.db.execute(sql`
        select 1 from information_schema.columns
        where table_schema = current_schema() and table_name = ${c.table} and column_name = ${c.column}
      `);
      if (found.rows.length > 0) continue;
      await workspaceDb.db.execute(
        sql.raw(`alter table "${c.table}" add column if not exists "${c.column}" ${c.type}`),
      );
      added.push(`${c.table}.${c.column}`);
    } catch (err) {
      logger.warn({ err, column: `${c.table}.${c.column}` }, "Could not add a missing column at startup");
    }
  }
  if (added.length > 0) logger.info({ added }, "Added missing database columns at startup");
  return added;
}

let lastKnownDrift: SchemaDrift[] = [];

/** The drift found at startup, for the error handler to quote. */
export function knownSchemaDrift(): SchemaDrift[] {
  return lastKnownDrift;
}

/**
 * Runs at boot. Never throws: a database that is unreachable at startup is
 * reported elsewhere, and a server that refused to start would hide the
 * message behind Replit's own error page.
 */
export async function checkSchemaAtStartup(): Promise<void> {
  try {
    lastKnownDrift = await detectSchemaDrift();
    if (lastKnownDrift.length > 0) {
      logger.error({ drift: lastKnownDrift }, describeDrift(lastKnownDrift));
    }
  } catch (err) {
    logger.warn({ err }, "Could not check the database schema against the code");
  }
}
