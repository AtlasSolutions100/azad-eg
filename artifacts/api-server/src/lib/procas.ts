import { db, procasConnectionTable, type ProcasConnectionRow } from "@workspace/db";
import { eq } from "drizzle-orm";
import { encryptSecret, decryptSecret, isSealedWithCurrentKey } from "./crypto";

const CONNECTION_ID = 1;
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_PAGES = 50;

// The Procas Web API is a read-only OData feed served from a copy of the
// accounting database refreshed daily at 6 AM Eastern. The base URL is fixed;
// only the company code varies per customer. PROCAS_BASE_URL can override the
// host for testing against a mock server.
const DEFAULT_BASE = "https://data.procas.com/ProcasData/v1";

export function procasBaseUrl(): string {
  return (process.env.PROCAS_BASE_URL ?? DEFAULT_BASE).replace(/\/+$/, "");
}

export interface ProcasCreds {
  companyCode: string;
  username: string;
  password: string;
}

// The ONLY tables this integration is allowed to read, each with the exact
// columns requested via $select. This is the approved minimal data set:
// nothing outside this list is ever requested from Procas. Personnel is
// deliberately restricted to name/labor-category/title/active — the table
// also contains bank, tax-ID, birth-date and address PII that must never
// be pulled.
export const APPROVED_TABLES = {
  GLDetail: [
    "TransDate", "Project", "ProjectDesc", "LCItem", "LCItemDesc",
    "Organization", "OrganizationDesc", "PayCode", "PayCodeDesc",
    "GLQty", "GLUnitPrice", "Account", "GLTransNumber",
  ],
  Timesheet: [
    "Personnel", "PersonnelName", "Project", "ProjectDesc", "LCItem", "LCItemDesc",
    "PayCode", "PayCodeDesc", "WorkDate", "HoursWorked", "Status",
    "TimePeriodBeginningDate", "TimePeriodEndingDate",
  ],
  Personnel: [
    "Personnel", "PersonnelName", "PersonnelLaborCategory", "PersonnelLaborCategoryDesc",
    "PersonnelJobTitle", "IsActivePersonnel",
  ],
  PayRateInfo: [
    "Personnel", "PersonnelDesc", "EffectiveDate", "PayRate", "IsActivePayRateInfo",
  ],
  Project: [
    "Project", "ProjectDesc", "Client", "ClientDesc", "ContractNumber",
    "ObligatedAmount", "EstimatedTotal", "StartingDate", "EndingDate",
    "ActiveForBilling", "IsClosed",
  ],
  Item: ["LCItem", "LCItemDesc", "DefaultBillingRate", "IsActiveLCItem", "IsLaborCategory"],
  BillingItem: [
    "Project", "LCItem", "BillingItemDesc", "BillingRate",
    "BillingDateBeginning", "BillingDateEnding",
  ],
  BillingAccount: [
    "Project", "BillingAccountDesc", "FringePercent", "OverheadPercent",
    "GAPercent", "FeePercent", "FacilitiesPercent",
    "BillingDateBeginning", "BillingDateEnding",
  ],
  BillingHistory: [
    "Project", "InvoiceNumber", "InvoiceDate", "TotalBillingAmount", "IsVoided",
    "CurrentPeriodBegDate", "CurrentPeriodEndDate",
  ],
} as const;

export type ProcasTable = keyof typeof APPROVED_TABLES;

function authHeaders(creds: ProcasCreds): Record<string, string> {
  const token = Buffer.from(`${creds.username}:${creds.password}`).toString("base64");
  return { Authorization: `Basic ${token}`, Accept: "application/json" };
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export interface ProcasPingResult {
  ok: boolean;
  status?: number;
  error?: string;
}

// Confirms the company code / username / password by making a real
// authenticated OData request against a small approved table.
// 401/403 means the credentials were rejected; 404 usually means the
// company code is wrong.
export async function pingProcas(creds: ProcasCreds): Promise<ProcasPingResult> {
  const code = creds.companyCode.trim();
  if (!/^[A-Za-z0-9_-]+$/.test(code)) {
    return { ok: false, error: "Company code may only contain letters, numbers, dashes or underscores." };
  }
  const url = `${procasBaseUrl()}/${encodeURIComponent(code)}/Item?$top=1&$select=LCItem`;
  try {
    const res = await fetchWithTimeout(url, { method: "GET", headers: authHeaders(creds) });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, status: res.status, error: "Procas rejected the username or password (unauthorized)." };
    }
    if (res.status === 404) {
      return { ok: false, status: res.status, error: "Procas could not find that company code. Double-check it (it is case-sensitive)." };
    }
    if (!res.ok) {
      return { ok: false, status: res.status, error: `Procas responded with HTTP ${res.status}.` };
    }
    return { ok: true, status: res.status };
  } catch (e) {
    const reason = e instanceof Error && e.name === "AbortError" ? "timed out" : "could not be reached";
    return { ok: false, error: `The Procas Web API ${reason}. Check your network and try again.` };
  }
}

export interface ODataQuery {
  filter?: string;
  top?: number;
  orderby?: string;
}

// Fetches all rows of one approved table, following @odata.nextLink
// pagination. The table name and $select column list are hard-locked to the
// approved whitelist above, so no non-approved table or field can ever be
// requested — even by a coding mistake elsewhere.
export async function fetchProcasTable(
  creds: ProcasCreds,
  table: ProcasTable,
  query: ODataQuery = {},
): Promise<Array<Record<string, unknown>>> {
  const columns = APPROVED_TABLES[table];
  if (!columns) throw new Error(`Table "${table}" is not in the approved Procas data set.`);

  const params = new URLSearchParams();
  params.set("$select", columns.join(","));
  if (query.filter) params.set("$filter", query.filter);
  if (query.top) params.set("$top", String(query.top));
  if (query.orderby) params.set("$orderby", query.orderby);

  let url: string | null =
    `${procasBaseUrl()}/${encodeURIComponent(creds.companyCode.trim())}/${table}?${params.toString()}`;
  const rows: Array<Record<string, unknown>> = [];
  let pages = 0;

  while (url && pages < MAX_PAGES) {
    pages += 1;
    let res: Response;
    try {
      res = await fetchWithTimeout(url, { method: "GET", headers: authHeaders(creds) });
    } catch (e) {
      const reason = e instanceof Error && e.name === "AbortError" ? "timed out" : "could not be reached";
      throw new Error(`The Procas Web API ${reason} while fetching ${table}.`);
    }
    if (res.status === 401 || res.status === 403) {
      throw new Error("Procas rejected the stored credentials (unauthorized). Reconnect with a valid username and password.");
    }
    if (!res.ok) {
      throw new Error(`Procas returned HTTP ${res.status} while fetching ${table}.`);
    }
    const body: unknown = await res.json();
    const page = extractODataRows(body);
    if (!page) throw new Error(`Procas returned an unexpected response shape for ${table}.`);
    rows.push(...page);
    const nextLink =
      body && typeof body === "object" && typeof (body as Record<string, unknown>)["@odata.nextLink"] === "string"
        ? ((body as Record<string, unknown>)["@odata.nextLink"] as string)
        : null;
    url = nextLink ? validateNextLink(nextLink, url, table) : null;
  }
  // Never silently return partial data: if the page cap was hit while the
  // upstream still had more pages, fail loudly so the sync is marked failed.
  if (url) {
    throw new Error(`Procas returned more than ${MAX_PAGES} pages for ${table}; aborting to avoid a partial sync.`);
  }
  return rows;
}

// A pagination link from the upstream response is untrusted data. It must
// stay on the same origin and the same company/table path as the request we
// issued, otherwise a compromised or misbehaving upstream could redirect
// subsequent page fetches (carrying Basic auth) to an arbitrary URL.
function validateNextLink(nextLink: string, currentUrl: string, table: string): string {
  let next: URL;
  let current: URL;
  try {
    current = new URL(currentUrl);
    next = new URL(nextLink, current);
  } catch {
    throw new Error(`Procas returned a malformed pagination link for ${table}.`);
  }
  if (next.origin !== current.origin || next.pathname !== current.pathname) {
    throw new Error(`Procas returned an unexpected pagination link for ${table}; refusing to follow it.`);
  }
  return next.toString();
}

function extractODataRows(body: unknown): Array<Record<string, unknown>> | null {
  if (Array.isArray(body)) return body as Array<Record<string, unknown>>;
  if (body && typeof body === "object") {
    const val = (body as Record<string, unknown>).value;
    if (Array.isArray(val)) return val as Array<Record<string, unknown>>;
  }
  return null;
}

// Escapes a value for use inside an OData string literal filter.
export function odataString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

// --- Persisted connection state (single row) ---

// The password column holds AES-256-GCM ciphertext, never plaintext. We
// decrypt on read and encrypt on write so callers work with the bare
// password while it stays protected at rest.
export async function getProcasConnection(): Promise<ProcasConnectionRow | null> {
  const [row] = await db
    .select()
    .from(procasConnectionTable)
    .where(eq(procasConnectionTable.id, CONNECTION_ID));
  if (!row) return null;
  if (row.password && !isSealedWithCurrentKey(row.password)) {
    // The stored credential predates the current master key (plaintext,
    // legacy salt, or a rotated-out PROCAS_ENC_KEY). Re-seal it under the
    // current key so old keys can eventually be retired.
    const plaintext = decryptSecret(row.password);
    await db
      .update(procasConnectionTable)
      .set({ password: encryptSecret(plaintext) })
      .where(eq(procasConnectionTable.id, CONNECTION_ID));
    return { ...row, password: plaintext };
  }
  return { ...row, password: row.password ? decryptSecret(row.password) : row.password };
}

// One-shot rotation routine, run at server startup. If the stored Procas
// credential is not sealed under the current master key (e.g. after
// PROCAS_ENC_KEY was rotated with the previous value kept in
// PROCAS_ENC_KEY_OLD), decrypt it with the available fallback keys and
// re-encrypt it under the current key. Returns whether a re-seal happened.
export async function reencryptProcasConnectionIfNeeded(): Promise<boolean> {
  const [row] = await db
    .select()
    .from(procasConnectionTable)
    .where(eq(procasConnectionTable.id, CONNECTION_ID));
  if (!row?.password || isSealedWithCurrentKey(row.password)) return false;
  const plaintext = decryptSecret(row.password);
  await db
    .update(procasConnectionTable)
    .set({ password: encryptSecret(plaintext) })
    .where(eq(procasConnectionTable.id, CONNECTION_ID));
  return true;
}

export function credsFromConnection(
  conn: Pick<ProcasConnectionRow, "companyCode" | "username" | "password">,
): ProcasCreds | null {
  if (!conn.companyCode || !conn.username || !conn.password) return null;
  return { companyCode: conn.companyCode, username: conn.username, password: conn.password };
}

export async function saveProcasConnection(values: {
  connected: boolean;
  companyCode: string | null;
  username: string | null;
  password: string | null;
  lastSyncAt?: Date | null;
}): Promise<ProcasConnectionRow> {
  const stored = { ...values, password: values.password ? encryptSecret(values.password) : values.password };
  const [row] = await db
    .insert(procasConnectionTable)
    .values({ id: CONNECTION_ID, ...stored })
    .onConflictDoUpdate({ target: procasConnectionTable.id, set: stored })
    .returning();
  // Return the plaintext password to the caller; only the persisted copy is encrypted.
  return { ...row, password: values.password };
}

export async function markProcasSynced(at: Date): Promise<void> {
  await db
    .update(procasConnectionTable)
    .set({ lastSyncAt: at })
    .where(eq(procasConnectionTable.id, CONNECTION_ID));
}
