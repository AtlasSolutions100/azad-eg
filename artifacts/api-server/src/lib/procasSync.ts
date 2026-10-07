import {
  db,
  invoicesTable,
  employeesTable,
  workPlansTable,
  lineItemsTable,
  type LineItemRow,
  type ProcasConnectionRow,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import {
  fetchProcasTable,
  credsFromConnection,
  markProcasSynced,
  odataString,
  projectScopeFilter,
  type ProcasCreds,
} from "./procas";
import { knownBillingCycle } from "./invoiceRegister";
import { knownHeader, type Burden } from "./knownInvoiceHeaders";
import type { ParsedLine } from "./timeimport";
import { linesToLineItems, clearAutoImportedLineItems } from "./lineMapping";
import { loadRateChanges } from "./employeeRates";
import { recomputeCarryOverWithAudit } from "./carryover";
import { recordAudit } from "./audit";
import { logger } from "./logger";

type InvoiceRow = typeof invoicesTable.$inferSelect;

export type ProcasSyncResult =
  | { ok: true; importedCount: number; replacedCount: number; warnings: string[]; lineItems: LineItemRow[] }
  | { ok: false; reason: "fetch_failed" | "no_rows"; message: string; warnings: string[] };

function toNum(v: unknown): number {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  if (typeof v === "string") {
    const n = parseFloat(v.replace(/[^0-9.-]/g, ""));
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function toStr(v: unknown): string {
  return v == null ? "" : String(v).trim();
}

// Procas returns indirect percentages as FRACTIONS (0.08 = 8%, 1.2058 =
// 120.58%, 0.0039 = 0.39%); the schema and billing layer store whole-number
// percents. Scale by 100 and round to kill binary-float noise (0.555*100 would
// otherwise be 55.50000000000001).
function procasPctToPercent(v: unknown): number {
  return Math.round(toNum(v) * 100 * 1e6) / 1e6;
}

function normalizeCategory(payCodeDesc: string): ParsedLine["category"] {
  const v = payCodeDesc.toLowerCase();
  if (v.includes("double") || v.includes("dbl")) return "dt";
  if (v.includes("over") || /\bot\b/.test(v)) return "ot";
  if (v.includes("holiday")) return "holiday";
  if (v.includes("pto") || v.includes("vacation") || v.includes("sick") || v.includes("leave")) return "pto";
  return "regular";
}

// OData datetime bounds for a date-only period (Procas date fields are
// DateTimeOffset). Inputs are validated as strict ISO dates before being
// placed into a $filter expression so untrusted strings can never alter
// filter semantics (OData injection).
function assertIsoDate(date: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m || Number.isNaN(new Date(`${date}T00:00:00Z`).getTime())) {
    throw new Error(`Invalid date "${date}" — expected YYYY-MM-DD.`);
  }
  return date;
}
function dayStart(date: string): string {
  return `${assertIsoDate(date)}T00:00:00Z`;
}
function dayEnd(date: string): string {
  return `${assertIsoDate(date)}T23:59:59Z`;
}

// Picks the billing rate effective for the given period start from BillingItem
// rows (which carry BillingDateBeginning/Ending ranges) keyed by labor category.
function buildRateLookup(
  billingItems: Array<Record<string, unknown>>,
  periodStart: string,
): Map<string, number> {
  const at = new Date(dayStart(periodStart)).getTime();
  // Deterministic choice regardless of response order: among in-range rows the
  // one with the latest BillingDateBeginning wins; out-of-range rows are only a
  // fallback when no in-range rate exists (latest beginning wins there too).
  const best = new Map<string, { rate: number; inRange: boolean; beginAt: number }>();
  for (const row of billingItems) {
    const lcItem = toStr(row.LCItem);
    const rate = toNum(row.BillingRate);
    if (!lcItem || rate <= 0) continue;
    const beg = toStr(row.BillingDateBeginning);
    const end = toStr(row.BillingDateEnding);
    const beginAt = beg ? new Date(beg).getTime() : Number.NEGATIVE_INFINITY;
    const inRange = (!beg || beginAt <= at) && (!end || new Date(end).getTime() >= at);
    const prev = best.get(lcItem);
    if (
      !prev ||
      (inRange && !prev.inRange) ||
      (inRange === prev.inRange && beginAt > prev.beginAt)
    ) {
      best.set(lcItem, { rate, inRange, beginAt });
    }
  }
  const rates = new Map<string, number>();
  for (const [lcItem, { rate }] of best) rates.set(lcItem, rate);
  return rates;
}

// --- Previously Billed from BillingHistory ---

/**
 * True when a billing-history row is for a period that ended before
 * `periodStart` (YYYY-MM-DD). Every row carries the period it bills
 * (CurrentPeriodBegDate / CurrentPeriodEndDate); a row without one is old
 * history and counts as earlier.
 */
export function billedBeforePeriod(row: Record<string, unknown>, periodStart: string): boolean {
  const end = toStr(row.CurrentPeriodEndDate).slice(0, 10);
  return !end || end < periodStart;
}

/**
 * What Procas has invoiced for a project for the periods BEFORE `periodStart`:
 * the "Previously Billed" of the invoice for the period starting then.
 *
 * This used to be the sum of every non-voided row, on the reasoning that the
 * current invoice is not in Procas yet. That holds only until Procas posts it.
 * An August package opened in October — which is exactly how these invoices
 * were being reviewed — had August's own invoice counted as "previous":
 * AECOM showed 1,230,254.44 where the August invoice says 1,202,002.26, out by
 * the whole month's billing. The rows say which period they bill, so only the
 * earlier ones are summed. Checked against the invoices Julie sent for June
 * 2026: AECOM 1,135,877.45 (hers 1,135,877.49), WSP A.03.01 775,362.91
 * (775,362.94), Parsons B.55 167,259.31 (167,259.32), B.40-02 197,846.40
 * (197,846.42).
 *
 * Do not filter on InvoiceDate instead: BART invoices are dated a month or two
 * after the period they bill, and an earlier version that did so dropped the
 * most recent ones. Without `periodStart` every non-voided row is summed.
 */
export async function fetchPreviouslyBilledFromProcas(
  creds: ProcasCreds,
  jobNumber: string,
  periodStart?: string | null,
): Promise<number> {
  const rows = await fetchProcasTable(creds, "BillingHistory", {
    filter: `${projectScopeFilter(jobNumber)} and IsVoided eq false`,
  });
  const earlier = periodStart ? rows.filter((r) => billedBeforePeriod(r, periodStart)) : rows;
  const sum = earlier.reduce((s, r) => s + toNum(r.TotalBillingAmount), 0);
  return Math.round((sum + Number.EPSILON) * 100) / 100;
}

/**
 * Hours booked on a project (and every leaf code beneath it) BEFORE a date.
 *
 * This is the "Hours to Date: Previous" column on the BART sub-calc forms.
 * The exports used to write a hard 0 there with a comment saying we do not
 * carry prior-period hours — but Procas does: work plan 10007 has 6,627 of
 * them. Julie's note on the invoice detail was simply "missing previous hours".
 *
 * Unapproved rows are included deliberately: this is a historical total for a
 * reference column, not the billable hours for the period being invoiced.
 */
export async function fetchPreviousHoursFromProcas(
  creds: ProcasCreds,
  jobNumber: string,
  beforeDate: string,
): Promise<number> {
  const rows = await fetchProcasTable(creds, "Timesheet", {
    filter: `${projectScopeFilter(jobNumber)} and WorkDate lt ${beforeDate}T00:00:00Z`,
  });
  const sum = rows.reduce((s, r) => s + toNum(r.HoursWorked), 0);
  return Math.round((sum + Number.EPSILON) * 100) / 100;
}

// --- Billing Setup accounts ---

type ProcasRow = Record<string, unknown>;

/**
 * The Billing Setup account in force on a date.
 *
 * Procas keeps one account row per date range, and a project collects several
 * over its life: 10007 has six, running from "Overhead 109%, Fee 8%" in 2024
 * to "Overhead 120.58%, Fee 8%, Facilities 0.39%" from November 2025 on. The
 * sync took the FIRST row it met — the oldest — so the AECOM work plan billed
 * 109% overhead and no FCCM while Julie's invoices, and Procas's own billing
 * history, used 120.58% and 0.39%: every invoice total about 5% short.
 *
 * The labor account ("Direct Time …", not the unbillable or subcontract ones)
 * whose range contains the date is the one that applies; failing that, the
 * most recent one that had started by then.
 */
export function effectiveBillingAccount(rows: ProcasRow[], at: Date = new Date()): ProcasRow | undefined {
  if (rows.length === 0) return undefined;
  const day = at.toISOString().slice(0, 10);
  const begins = (r: ProcasRow) => toStr(r.BillingDateBeginning).slice(0, 10) || "0000-01-01";
  const ends = (r: ProcasRow) => toStr(r.BillingDateEnding).slice(0, 10) || "9999-12-31";
  const isLabor = (r: ProcasRow) => {
    const desc = toStr(r.BillingAccountDesc);
    return /direct\s*time/i.test(desc) && !/unbillable|subcontract/i.test(desc);
  };
  const labor = rows.filter(isLabor);
  const pool = labor.length > 0 ? labor : rows;
  const latest = (list: ProcasRow[]) => [...list].sort((a, b) => begins(b).localeCompare(begins(a)))[0];
  const inForce = pool.filter((r) => begins(r) <= day && day <= ends(r));
  if (inForce.length > 0) return latest(inForce);
  const started = pool.filter((r) => begins(r) <= day);
  return latest(started.length > 0 ? started : pool);
}

/** A project's own budget in Procas: the obligated amount, else the estimated total. */
function ownBudget(pr: ProcasRow | undefined): number {
  if (!pr) return 0;
  return toNum(pr.ObligatedAmount) > 0 ? toNum(pr.ObligatedAmount) : toNum(pr.EstimatedTotal);
}

/** Sub-projects of `code` at the shallowest level where `has` finds any. */
function nearestBelow<T>(code: string, rows: T[], codeOf: (r: T) => string, has: (r: T) => boolean): T[] {
  const below = rows.filter((r) => codeOf(r).startsWith(code + ".") && has(r));
  if (below.length === 0) return [];
  const depth = (r: T) => codeOf(r).split(".").length;
  const top = Math.min(...below.map(depth));
  return below.filter((r) => depth(r) === top);
}

/**
 * The budget Procas holds for a work plan.
 *
 * Usually the project's own. But Procas keeps T.Y. Lin's on the sub-project —
 * "10014" carries nothing and "10014.01" carries the 3,552,468.46 — so a work
 * plan on the parent code showed no budget at all, and then one copied off an
 * old invoice. When the project has none of its own, the sub-projects one
 * level down that do are added up.
 */
export function procasBudgetFor(code: string, projects: ProcasRow[]): number {
  const own = ownBudget(projects.find((p) => toStr(p.Project) === code));
  if (own > 0) return own;
  const below = nearestBelow(code, projects, (p) => toStr(p.Project), (p) => ownBudget(p) > 0);
  const sum = below.reduce((s, p) => s + ownBudget(p), 0);
  return Math.round((sum + Number.EPSILON) * 100) / 100;
}

/**
 * The work plan budget after comparing with Procas.
 *
 * The budget follows Procas: when the obligated amount changes there, the new
 * figure replaces the one here. Julie asked for exactly that ("when we get new
 * budget we can make changes") after finding a budget on the T.Y. Lin invoice
 * that matched an old invoice and not Procas.
 *
 * A figure typed on the Work Plan screen still holds — until Procas next
 * changes. `lastProcas` is what Procas said the last time we compared, which
 * is how "Procas moved" is told apart from "somebody typed over it".
 *
 * The first time through there is no such record. A plan the Procas import
 * owns takes Procas's figure: under the old rule its budget was copied once,
 * at import, and never refreshed, so what it holds is far more likely a stale
 * copy than a correction (10014.01 still read 2,596,541.95 after Procas went
 * to 3,552,468.46). A plan a biller has taken over keeps its budget unless it
 * is plainly not typed: zero, or a figure the app itself put there (`appSet`).
 */
export function syncedBudget(o: {
  local: number;
  lastProcas: number | null | undefined;
  procas: number;
  procasOwned?: boolean;
  appSet?: Array<number | null | undefined>;
}): number {
  const near = (a: number, b: number) => Math.abs(a - b) < 0.005;
  if (!(o.procas > 0)) return o.local;
  if (o.lastProcas != null) return near(o.procas, o.lastProcas) ? o.local : o.procas;
  const untouched =
    !!o.procasOwned || !(o.local > 0) || near(o.local, o.procas) || (o.appSet ?? []).some((v) => v != null && near(o.local, v));
  return untouched ? o.procas : o.local;
}

/**
 * The Billing Setup account for a work plan: the project's own, or its single
 * sub-project's when the project has none (10014 / 10014.01 again).
 */
function accountFor(code: string, byProject: Map<string, ProcasRow>): ProcasRow | undefined {
  const own = byProject.get(code);
  if (own) return own;
  const below = nearestBelow(code, [...byProject.keys()], (k) => k, () => true);
  return below.length === 1 ? byProject.get(below[0]) : undefined;
}

/** The account in force today for every project that has one. */
function currentAccountsByProject(billingAccounts: ProcasRow[]): Map<string, ProcasRow> {
  const grouped = new Map<string, ProcasRow[]>();
  for (const ba of billingAccounts) {
    const proj = toStr(ba.Project);
    if (!proj) continue;
    const list = grouped.get(proj);
    if (list) list.push(ba);
    else grouped.set(proj, [ba]);
  }
  const out = new Map<string, ProcasRow>();
  for (const [proj, rows] of grouped) {
    const acct = effectiveBillingAccount(rows);
    if (acct) out.set(proj, acct);
  }
  return out;
}

/**
 * A work plan's burden from its Procas account.
 *
 * An account with no percentages at all is not "no burden": it is a project
 * Procas bills at loaded rates (10013.TO02, 10013.TO03, 10014), where the
 * fringe, fee and FCCM are inside the hourly rate. The invoice still shows the
 * direct rate and the burden as its own lines, so for those the burden is the
 * one on the last invoice Julie sent, when we hold it.
 */
function burdenFromAccount(acct: ProcasRow, ...keys: Array<string | null | undefined>): Burden {
  const burden: Burden = {
    fringeRate: procasPctToPercent(acct.FringePercent),
    overheadRate: procasPctToPercent(acct.OverheadPercent),
    fixedFeeRate: procasPctToPercent(acct.FeePercent),
    fccmRate: procasPctToPercent(acct.FacilitiesPercent),
  };
  const none = !burden.fringeRate && !burden.overheadRate && !burden.fixedFeeRate && !burden.fccmRate;
  return (none && knownHeader(...keys)?.burden) || burden;
}

// --- Billing Setup rates for one Procas project ---

export interface ProcasBillingRates {
  fringeRate: number | null;
  overheadRate: number | null;
  fixedFeeRate: number | null;
  fccmRate: number | null;
  client: string | null;
}

// Pulls the Billing Setup percentages (BillingAccount) plus the client name
// for a single Procas project. Used to pre-fill rates when a package is
// created without a work plan. Null fields mean Procas has no value (> 0).
export async function fetchBillingRatesFromProcas(
  creds: ProcasCreds,
  project: string,
): Promise<ProcasBillingRates | null> {
  const [accounts, projects] = await Promise.all([
    fetchProcasTable(creds, "BillingAccount", { filter: `Project eq ${odataString(project)}` }),
    fetchProcasTable(creds, "Project", { filter: `Project eq ${odataString(project)}` }),
  ]);
  const acct = effectiveBillingAccount(accounts as ProcasRow[]);
  const proj = projects[0];
  if (!acct && !proj) return null;
  // Procas returns percentages as fractions (0.08 = 8%); scale to the
  // whole-number percents the schema/billing layer expect.
  const pct = (v: unknown): number | null => {
    const n = toNum(v);
    return n > 0 ? procasPctToPercent(v) : null;
  };
  return {
    fringeRate: acct ? pct(acct.FringePercent) : null,
    overheadRate: acct ? pct(acct.OverheadPercent) : null,
    fixedFeeRate: acct ? pct(acct.FeePercent) : null,
    fccmRate: acct ? pct(acct.FacilitiesPercent) : null,
    client: proj ? toStr(proj.ClientDesc) || toStr(proj.Client) || null : null,
  };
}

// --- Reference data sync (employees + work plan rates) ---

export interface ReferenceSyncResult {
  employeesCreated: number;
  employeesUpdated: number;
  workPlansUpdated: number;
  warnings: string[];
}

export interface WorkPlanImportResult {
  created: number;
  updated: number;
  total: number;
  /** Procas-owned plans whose billing cycle was set to what the invoice register says. */
  cyclesCorrected: number;
}

// Imports the full Procas project library as work plans so the Workplans tab
// mirrors what Procas has. New projects become work plans (code/title/client/
// status straight from Procas, rates from Billing Setup when present);
// previously imported ones get their Procas-owned fields refreshed. Manually
// created plans are matched by job number / Procas link and left alone here —
// their rates are refreshed by syncReferenceFromProcas.
export async function importWorkPlansFromProcas(creds: ProcasCreds): Promise<WorkPlanImportResult> {
  const [projects, billingAccounts] = await Promise.all([
    fetchProcasTable(creds, "Project"),
    fetchProcasTable(creds, "BillingAccount"),
  ]);
  const acctByProject = currentAccountsByProject(billingAccounts as ProcasRow[]);

  const existing = await db.select().from(workPlansTable);
  // A Procas project is "already represented" when a plan links to it via
  // procasProject, or a manual plan's job number / code matches it. Only
  // rows imported from Procas (source = "procas") get their display fields
  // refreshed — manually created or manually edited plans are never touched.
  const importedByProject = new Map<string, typeof existing[number]>();
  const claimed = new Set<string>();
  for (const wp of existing) {
    const link = wp.procasProject?.trim();
    if (link && wp.source === "procas" && !importedByProject.has(link)) {
      importedByProject.set(link, wp);
    }
    if (link) claimed.add(link);
    claimed.add(wp.jobNumber.trim());
    claimed.add(wp.code.trim());
  }

  let created = 0;
  let updated = 0;
  let total = 0;
  let cyclesCorrected = 0;
  for (const pr of projects) {
    const code = toStr(pr.Project);
    if (!code) continue;
    total += 1;
    const title = toStr(pr.ProjectDesc) || code;
    const client = toStr(pr.ClientDesc) || toStr(pr.Client) || "Unknown client";
    const status = pr.IsClosed === true ? "archived" : "active";
    const budget = procasBudgetFor(code, projects as ProcasRow[]);
    // Procas' ContractNumber is the prime agreement the work is billed under —
    // "6M8213 GEC" on the T.Y. Lin job, whose invoice carries Agreement No.
    // 6M8213 — and 430 of the 532 projects have one. It is the only invoice
    // header field Procas knows; the rest (PO number, supplier ID, remit-to
    // address, client contact) live on the client's own paperwork. Carried over
    // verbatim rather than parsed: guessing which part of a contract string is
    // "the" agreement number would be wrong somewhere, and Julie's own entry
    // always wins over this.
    const contractNumber = toStr(pr.ContractNumber);
    const linked = importedByProject.get(code);
    if (linked) {
      // Refresh the Procas-owned display fields on imported/linked plans.
      const changes: Partial<typeof workPlansTable.$inferInsert> = {};
      if (title !== linked.title) changes.title = title;
      if (client !== linked.client) changes.client = client;
      if (status !== linked.status) changes.status = status;
      // The budget is synced separately, below, for every linked plan.
      // The agreement number: fill a blank, never overwrite.
      if (!String(linked.agreementNo ?? "").trim() && contractNumber) {
        changes.agreementNo = contractNumber;
      }
      // The billing cycle comes from Julie's invoice register (see
      // invoiceRegister.ts): last-Friday for AECOM, Parsons and WSP, the last
      // day of the month for T.Y. Lin, and the calendar-month default for
      // every work plan the register does not name. A Procas-owned plan is
      // never one a biller chose a cycle for — choosing flips it to manual —
      // so this both applies the register and UNDOES the Sep 25 change that
      // moved every imported plan to last-Friday, T.Y. Lin included. The count
      // is reported so the correction is not silent.
      const cycle = knownBillingCycle(linked.procasProject, linked.jobNumber, code) ?? "whole_month";
      if (linked.billingCycle !== cycle) {
        changes.billingCycle = cycle;
        cyclesCorrected += 1;
      }
      if (Object.keys(changes).length > 0) {
        // Guard on source at write time: if a biller edited this plan while
        // the import was running (flipping it to manual), the stale snapshot
        // must not stomp their change.
        const rows = await db
          .update(workPlansTable)
          .set(changes)
          .where(and(eq(workPlansTable.id, linked.id), eq(workPlansTable.source, "procas")))
          .returning({ id: workPlansTable.id });
        if (rows.length > 0) updated += 1;
      }
      continue;
    }
    if (claimed.has(code) || claimed.has(toStr(pr.ContractNumber))) continue;
    const acct = accountFor(code, acctByProject);
    // Procas returns indirect percentages as FRACTIONS (0.08 = 8%, 1.2058 =
    // 120.58%, 0.0039 = 0.39%); the schema/billing store whole-number percents,
    // so scale by 100. When a billing account exists we set ALL four rates
    // (including a 0 fringe) so the real Procas burden — which lives entirely in
    // OverheadPercent for BART — overrides the schema's default fringeRate of
    // 120.58 instead of double-counting on top of it.
    const rates = acct ? burdenFromAccount(acct, code) : {};
    // onConflictDoNothing on the partial unique index makes concurrent runs
    // (scheduler cycle vs manual refresh) race-safe.
    const inserted = await db
      .insert(workPlansTable)
      .values({
        code,
        title,
        client,
        jobNumber: code,
        totalBudget: budget,
        procasBudget: budget > 0 ? budget : null,
        agreementNo: contractNumber || null,
        procasProject: code,
        // From Julie's invoice register: last-Friday for AECOM, Parsons and
        // WSP ("billing period is wrong, should be the last Friday" on the
        // AECOM package), last day of the month for T.Y. Lin, and the
        // calendar-month default for anything the register does not name.
        billingCycle: knownBillingCycle(code) ?? "whole_month",
        status,
        source: "procas",
        ...rates,
      })
      .onConflictDoNothing()
      .returning({ id: workPlansTable.id });
    if (inserted.length > 0) {
      created += 1;
      claimed.add(code);
    }
  }
  // Budgets follow Procas (see syncedBudget) for every plan linked to a Procas
  // project, whoever owns its other fields: the budget has its own record of
  // what Procas last said, so a biller's rates or title are not a reason to
  // stop tracking it.
  for (const wp of await db.select().from(workPlansTable)) {
    const link = (wp.procasProject ?? "").trim();
    if (!link) continue;
    const procas = procasBudgetFor(link, projects as ProcasRow[]);
    if (!(procas > 0)) continue;
    const next = syncedBudget({
      local: wp.totalBudget,
      lastProcas: wp.procasBudget,
      procas,
      procasOwned: wp.source === "procas",
      // What the app itself may have put there before this rule: the project's
      // own Procas figure, or the budget off the reference invoice.
      appSet: [
        ownBudget((projects as ProcasRow[]).find((p) => toStr(p.Project) === link)),
        knownHeader(link, wp.jobNumber)?.totalBudget,
      ],
    });
    const budgetChanged = Math.abs(next - wp.totalBudget) >= 0.005;
    if (!budgetChanged && wp.procasBudget != null && Math.abs(wp.procasBudget - procas) < 0.005) continue;
    await db
      .update(workPlansTable)
      .set({ totalBudget: next, procasBudget: procas })
      .where(eq(workPlansTable.id, wp.id));
    if (budgetChanged) {
      updated += 1;
      const money = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
      await recordAudit({
        action: "budget updated from Procas",
        entityType: "workPlan",
        entityId: wp.id,
        description: `Work plan ${wp.code}: budget ${money(wp.totalBudget)} → ${money(next)} (Procas obligated amount)`,
      });
    }
  }

  return { created, updated, total, cyclesCorrected };
}

// Pulls the approved reference tables and folds them into existing entities:
// Personnel -> employees (name, classification, active, payroll pay rate),
// Item default billing rates for new employees, and Billing Setup percentages
// (BillingAccount) -> work plan fringe/overhead/fee rates for matching jobs.
export async function syncReferenceFromProcas(creds: ProcasCreds): Promise<ReferenceSyncResult> {
  const warnings: string[] = [];
  const [personnel, payRates, items, projects, billingAccounts] = await Promise.all([
    fetchProcasTable(creds, "Personnel"),
    fetchProcasTable(creds, "PayRateInfo"),
    fetchProcasTable(creds, "Item"),
    fetchProcasTable(creds, "Project"),
    fetchProcasTable(creds, "BillingAccount"),
  ]);

  // Latest (preferring active) pay rate per personnel code.
  const payByPersonnel = new Map<string, { rate: number; effective: string; active: boolean }>();
  for (const r of payRates) {
    const code = toStr(r.Personnel);
    const rate = toNum(r.PayRate);
    if (!code || rate <= 0) continue;
    const effective = toStr(r.EffectiveDate);
    const active = r.IsActivePayRateInfo === true;
    const prev = payByPersonnel.get(code);
    const wins =
      !prev ||
      (active && !prev.active) ||
      (active === prev.active && effective > prev.effective);
    if (wins) payByPersonnel.set(code, { rate, effective, active });
  }

  const defaultRateByLc = new Map<string, number>();
  for (const r of items) {
    const lc = toStr(r.LCItem);
    const rate = toNum(r.DefaultBillingRate);
    if (lc && rate > 0) defaultRateByLc.set(lc, rate);
  }

  const existing = await db.select().from(employeesTable);
  const byName = new Map(existing.map((e) => [e.name.toLowerCase().trim(), e]));

  let employeesCreated = 0;
  let employeesUpdated = 0;
  for (const p of personnel) {
    const name = toStr(p.PersonnelName);
    if (!name) continue;
    const code = toStr(p.Personnel);
    const classification = toStr(p.PersonnelLaborCategoryDesc) || toStr(p.PersonnelJobTitle) || "Unspecified";
    const active = p.IsActivePersonnel !== false;
    const payRate = payByPersonnel.get(code)?.rate ?? null;
    const current = byName.get(name.toLowerCase());
    if (current) {
      const changes: Partial<typeof employeesTable.$inferInsert> = {};
      if (classification !== "Unspecified" && classification !== current.classification) {
        changes.classification = classification;
      }
      if (current.active !== active) changes.active = active;
      if (payRate != null && payRate !== current.payRate) changes.payRate = payRate;
      if (Object.keys(changes).length > 0) {
        await db.update(employeesTable).set(changes).where(eq(employeesTable.id, current.id));
        employeesUpdated += 1;
      }
    } else {
      const lcCode = toStr(p.PersonnelLaborCategory);
      const homeRate = defaultRateByLc.get(lcCode) ?? 0;
      if (homeRate <= 0) {
        warnings.push(`${name}: no default billing rate found for labor category "${lcCode || "?"}" — set to 0, correct manually.`);
      }
      await db.insert(employeesTable).values({
        name,
        classification,
        homeRate,
        payRate,
        active,
      });
      employeesCreated += 1;
    }
  }

  // Match local work plans to Procas projects by job number (Project code or
  // contract number) and refresh their billing-setup percentages.
  const projByCode = new Map<string, Record<string, unknown>>();
  for (const pr of projects) {
    const codes = [toStr(pr.Project), toStr(pr.ContractNumber)].filter(Boolean);
    for (const c of codes) if (!projByCode.has(c)) projByCode.set(c, pr);
  }
  const acctByProject = currentAccountsByProject(billingAccounts as ProcasRow[]);

  const workPlans = await db.select().from(workPlansTable);
  let workPlansUpdated = 0;
  for (const wp of workPlans) {
    // Never stomp a biller-owned plan: once someone enters a static rate
    // override (which flips source to "manual"), Procas must not overwrite it.
    // Only "procas"-sourced plans track the Procas Billing Account. (Per the
    // documented work-plan ownership rule.)
    if (wp.source !== "procas") continue;
    const proj = projByCode.get(wp.jobNumber.trim());
    if (!proj) continue;
    const acct = accountFor(toStr(proj.Project), acctByProject);
    if (!acct) continue;
    const changes: Partial<typeof workPlansTable.$inferInsert> = {};
    // Procas percentages are fractions; scale to whole-number percents. Sync all
    // four unconditionally (a Procas billing account is authoritative) so a 0
    // fringe overrides the schema's 120.58 default rather than double-counting
    // with OverheadPercent, where BART's real burden lives.
    const {
      fringeRate: fringe,
      overheadRate: overhead,
      fixedFeeRate: fee,
      fccmRate: fccm,
    } = burdenFromAccount(acct, wp.procasProject, wp.jobNumber);
    if (fringe !== wp.fringeRate) changes.fringeRate = fringe;
    if (overhead !== wp.overheadRate) changes.overheadRate = overhead;
    if (fee !== wp.fixedFeeRate) changes.fixedFeeRate = fee;
    if (fccm !== wp.fccmRate) changes.fccmRate = fccm;
    if (Object.keys(changes).length > 0) {
      await db.update(workPlansTable).set(changes).where(eq(workPlansTable.id, wp.id));
      workPlansUpdated += 1;
    }
  }

  return { employeesCreated, employeesUpdated, workPlansUpdated, warnings };
}

// --- Per-invoice labor sync ---

// Pulls finalized labor for one invoice's billing period from Procas and
// imports it as line items. Finalized Labor Journal hours (GLDetail) are
// preferred — those are invoicing-grade. When the journal has no rows for the
// period yet, we fall back to raw Timesheet hours with a warning. Billing
// rates come from the project's Billing Setup (BillingItem), the authoritative
// source per Procas. Previously Billed is refreshed from BillingHistory unless
// the user has overridden it manually.
export async function syncInvoiceFromProcas(
  invoice: InvoiceRow,
  conn: Pick<ProcasConnectionRow, "companyCode" | "username" | "password">,
  source: "procas" | "procas-scheduled" = "procas",
): Promise<ProcasSyncResult> {
  const creds = credsFromConnection(conn);
  if (!creds) {
    return { ok: false, reason: "fetch_failed", message: "Procas credentials are missing.", warnings: [] };
  }

  const [workPlan] = await db.select().from(workPlansTable).where(eq(workPlansTable.id, invoice.workPlanId));
  if (!workPlan) {
    return { ok: false, reason: "fetch_failed", message: "Invoice has no work plan; cannot determine the Procas project.", warnings: [] };
  }
  const job = workPlan.jobNumber.trim();
  const warnings: string[] = [];

  let lines: ParsedLine[];
  try {
    const projectFilter = projectScopeFilter(job);
    const glRows = await fetchProcasTable(creds, "GLDetail", {
      filter: `${projectFilter} and TransDate ge ${dayStart(invoice.periodStart)} and TransDate le ${dayEnd(invoice.periodEnd)} and GLQty gt 0 and LCItem ne null`,
    });

    let raw: Array<{ name: string; hours: number; lcItem: string; lcDesc: string; payCodeDesc: string }>;
    if (glRows.length > 0) {
      raw = glRows.map((r) => ({
        name: toStr(r.OrganizationDesc) || toStr(r.Organization),
        hours: toNum(r.GLQty),
        lcItem: toStr(r.LCItem),
        lcDesc: toStr(r.LCItemDesc),
        payCodeDesc: toStr(r.PayCodeDesc) || toStr(r.PayCode),
      }));
    } else {
      const tsRows = await fetchProcasTable(creds, "Timesheet", {
        filter: `${projectFilter} and WorkDate ge ${dayStart(invoice.periodStart)} and WorkDate le ${dayEnd(invoice.periodEnd)}`,
      });
      if (tsRows.length > 0) {
        warnings.push(
          "Labor Journal (GLDetail) has no finalized hours for this period yet — using raw Timesheet hours instead. Re-sync after payroll finalizes.",
        );
      }
      raw = tsRows.map((r) => ({
        name: toStr(r.PersonnelName) || toStr(r.Personnel),
        hours: toNum(r.HoursWorked),
        lcItem: toStr(r.LCItem),
        lcDesc: toStr(r.LCItemDesc),
        payCodeDesc: toStr(r.PayCodeDesc) || toStr(r.PayCode),
      }));
    }

    if (raw.length === 0) {
      return {
        ok: false,
        reason: "no_rows",
        message: `Procas has no labor for project ${job} between ${invoice.periodStart} and ${invoice.periodEnd} (data is a daily 6 AM snapshot).`,
        warnings,
      };
    }

    // Billing rates from Billing Setup for this project, effective for the period.
    const billingItems = await fetchProcasTable(creds, "BillingItem", { filter: projectFilter });
    const rateByLc = buildRateLookup(billingItems, invoice.periodStart);

    // Aggregate by employee + labor category + pay category so one line item
    // per person/category lands on the invoice instead of one per day.
    const agg = new Map<string, ParsedLine>();
    for (const r of raw) {
      if (!r.name || r.hours === 0) continue;
      const category = normalizeCategory(r.payCodeDesc);
      const rate = rateByLc.get(r.lcItem) ?? 0;
      const key = `${r.name.toLowerCase()}|${r.lcItem}|${category}`;
      const existing = agg.get(key);
      if (existing) {
        existing.hours += r.hours;
      } else {
        agg.set(key, {
          employeeName: r.name,
          classification: r.lcDesc,
          category,
          location: "home",
          hours: r.hours,
          rate,
          notes: r.lcItem ? `Procas LC ${r.lcItem}` : null,
        });
      }
    }
    lines = Array.from(agg.values());
    const missingRates = new Set(
      lines.filter((l) => l.rate <= 0).map((l) => l.classification || l.employeeName),
    );
    if (missingRates.size > 0) {
      warnings.push(
        `No Procas billing rate found for: ${Array.from(missingRates).join(", ")} — falling back to local employee rates.`,
      );
    }
  } catch (e) {
    return {
      ok: false,
      reason: "fetch_failed",
      message: e instanceof Error ? e.message : "Failed to pull from Procas.",
      warnings,
    };
  }

  if (lines.length === 0) {
    return { ok: false, reason: "no_rows", message: "No valid labor rows returned by Procas.", warnings };
  }

  const employees = await db.select().from(employeesTable);
  const rateChanges = await loadRateChanges(employees.map((e) => e.id));
  const { toInsert, warnings: mapWarnings } = linesToLineItems(
    lines,
    invoice.id,
    employees,
    "procas",
    rateChanges,
    invoice.periodStart,
  );
  warnings.push(...mapWarnings);

  // Replace any previously auto-imported rows so re-syncing the same period
  // does not duplicate labor; hand-entered rows are preserved.
  const replacedCount = await clearAutoImportedLineItems(invoice.id);
  if (replacedCount > 0) {
    warnings.unshift(`Replaced ${replacedCount} previously imported line item(s) for this period.`);
  }

  const inserted = await db.insert(lineItemsTable).values(toInsert).returning();
  // New labor changes this invoice's total-to-date; refresh downstream carry-over.
  await recomputeCarryOverWithAudit(invoice.workPlanId, {
    invoiceId: invoice.id,
    invoiceNumber: invoice.invoiceNumber,
    reason: source === "procas-scheduled" ? "a scheduled Procas sync of" : "a Procas sync of",
  });

  // Previously Billed from Procas BillingHistory — authoritative over locally
  // derived carry-over, but never overrides a manual user-entered value.
  if (!invoice.carryOverManual) {
    try {
      const prevBilled = await fetchPreviouslyBilledFromProcas(creds, job);
      // BillingHistory is authoritative (including a legitimate $0) unless the
      // user has manually overridden the value.
      await db
        .update(invoicesTable)
        .set({ previouslyBilled: prevBilled, carryOverManual: false })
        .where(eq(invoicesTable.id, invoice.id));
      warnings.push(
        `Previously Billed set to $${prevBilled.toFixed(2)} from Procas BillingHistory (override it on the invoice if needed).`,
      );
    } catch (e) {
      logger.warn({ err: e, invoiceId: invoice.id }, "Could not refresh Previously Billed from Procas BillingHistory");
      warnings.push("Could not refresh Previously Billed from Procas BillingHistory; kept the locally derived value.");
    }
  }

  // Persist the warnings so billers can review them after a reload; each new
  // import replaces the previous set.
  await db
    .update(invoicesTable)
    .set({ importWarnings: warnings, lastImportAt: new Date(), lastImportSource: source })
    .where(eq(invoicesTable.id, invoice.id));

  await markProcasSynced(new Date());
  await recordAudit({
    action: source === "procas-scheduled" ? "auto-synced from Procas" : "synced from Procas",
    entityType: "invoice",
    entityId: invoice.id,
    description:
      source === "procas-scheduled"
        ? `${inserted.length} line items pulled by scheduled Procas refresh${replacedCount > 0 ? ` (replaced ${replacedCount})` : ""}`
        : `${inserted.length} line items pulled live from Procas${replacedCount > 0 ? ` (replaced ${replacedCount})` : ""}`,
  });

  return { ok: true, importedCount: inserted.length, replacedCount, warnings, lineItems: inserted };
}

export async function getInvoiceById(id: number): Promise<InvoiceRow | null> {
  const [row] = await db.select().from(invoicesTable).where(eq(invoicesTable.id, id));
  return row ?? null;
}
