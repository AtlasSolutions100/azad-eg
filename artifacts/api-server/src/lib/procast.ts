import { db, procastConnectionTable, type ProcastConnectionRow } from "@workspace/db";
import { eq } from "drizzle-orm";

const CONNECTION_ID = 1;
const REQUEST_TIMEOUT_MS = 10_000;

export interface ProcastCreds {
  baseUrl: string;
  apiKey: string;
}

function normalizeBase(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "");
}

function authHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    Accept: "application/json",
  };
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

export interface ProcastPingResult {
  ok: boolean;
  status?: number;
  error?: string;
}

// Performs a real authenticated request against the Procast API to confirm the
// base URL is reachable and the API key is accepted. The `/health` endpoint is
// used as a lightweight probe; a 401/403 means the key was rejected.
export async function pingProcast(creds: ProcastCreds): Promise<ProcastPingResult> {
  const base = normalizeBase(creds.baseUrl);
  if (!/^https?:\/\//i.test(base)) {
    return { ok: false, error: "Base URL must start with http:// or https://" };
  }
  try {
    const res = await fetchWithTimeout(`${base}/health`, {
      method: "GET",
      headers: authHeaders(creds.apiKey),
    });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, status: res.status, error: "Procast rejected the API key (unauthorized)." };
    }
    if (!res.ok) {
      return { ok: false, status: res.status, error: `Procast responded with HTTP ${res.status}.` };
    }
    return { ok: true, status: res.status };
  } catch (e) {
    const reason = e instanceof Error && e.name === "AbortError" ? "timed out" : "could not be reached";
    return { ok: false, error: `Procast API ${reason}. Check the base URL and your network.` };
  }
}

export interface ProcastTimesheetQuery {
  start?: string;
  end?: string;
}

// Pulls raw timesheet records for a date range from the live Procast API.
// Procast deployments vary in their envelope shape, so we accept a bare array
// or a common wrapper key and let the importer fuzzy-map the columns.
export async function fetchProcastTimesheets(
  creds: ProcastCreds,
  query: ProcastTimesheetQuery,
): Promise<Array<Record<string, unknown>>> {
  const base = normalizeBase(creds.baseUrl);
  const params = new URLSearchParams();
  if (query.start) params.set("start", query.start);
  if (query.end) params.set("end", query.end);
  const qs = params.toString();
  const url = `${base}/timesheets${qs ? `?${qs}` : ""}`;

  let res: Response;
  try {
    res = await fetchWithTimeout(url, { method: "GET", headers: authHeaders(creds.apiKey) });
  } catch (e) {
    const reason = e instanceof Error && e.name === "AbortError" ? "timed out" : "could not be reached";
    throw new Error(`Procast API ${reason} while fetching timesheets.`);
  }
  if (res.status === 401 || res.status === 403) {
    throw new Error("Procast rejected the API key (unauthorized). Reconnect with a valid key.");
  }
  if (!res.ok) {
    throw new Error(`Procast API returned HTTP ${res.status} while fetching timesheets.`);
  }

  const body: unknown = await res.json();
  const records = extractRecords(body);
  if (!records) {
    throw new Error("Procast API returned an unexpected response shape (no timesheet records found).");
  }
  return records;
}

function extractRecords(body: unknown): Array<Record<string, unknown>> | null {
  if (Array.isArray(body)) return body as Array<Record<string, unknown>>;
  if (body && typeof body === "object") {
    for (const key of ["timesheets", "entries", "data", "results", "records"]) {
      const val = (body as Record<string, unknown>)[key];
      if (Array.isArray(val)) return val as Array<Record<string, unknown>>;
    }
  }
  return null;
}

// --- Persisted connection state (single row) ---

export async function getProcastConnection(): Promise<ProcastConnectionRow | null> {
  const [row] = await db
    .select()
    .from(procastConnectionTable)
    .where(eq(procastConnectionTable.id, CONNECTION_ID));
  return row ?? null;
}

export async function saveProcastConnection(
  values: { connected: boolean; baseUrl: string | null; apiKey: string | null; lastSyncAt?: Date | null },
): Promise<ProcastConnectionRow> {
  const [row] = await db
    .insert(procastConnectionTable)
    .values({ id: CONNECTION_ID, ...values })
    .onConflictDoUpdate({ target: procastConnectionTable.id, set: values })
    .returning();
  return row;
}

export async function markProcastSynced(at: Date): Promise<void> {
  await db
    .update(procastConnectionTable)
    .set({ lastSyncAt: at })
    .where(eq(procastConnectionTable.id, CONNECTION_ID));
}
