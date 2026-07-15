import { pgTable, integer, text, boolean, timestamp } from "drizzle-orm/pg-core";

// Single-row table (id is always 1) holding the live Procas Web API connection.
// The Procas API is an OData feed at https://data.procas.com/ProcasData/v1/{COMPANY_CODE}
// using Basic authentication with the user's PROCAS username/password.
// When `connected` is true the app pulls invoicing data directly from Procas;
// otherwise it falls back to manual CSV/Excel upload.
export const procasConnectionTable = pgTable("procas_connection", {
  id: integer("id").primaryKey().default(1),
  connected: boolean("connected").notNull().default(false),
  companyCode: text("company_code"),
  username: text("username"),
  // AES-256-GCM ciphertext, never plaintext (see api-server lib/crypto.ts).
  password: text("password"),
  lastSyncAt: timestamp("last_sync_at", { mode: "date" }),
});

export type ProcasConnectionRow = typeof procasConnectionTable.$inferSelect;
export type InsertProcasConnection = typeof procasConnectionTable.$inferInsert;
