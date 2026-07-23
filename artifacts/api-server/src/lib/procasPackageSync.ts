import { eq, and } from "drizzle-orm";
import {
  db,
  packageWeeksTable,
  timesheetEntriesTable,
  employeesTable,
  type PackageRow,
  type WorkPlan,
  type PackageWeekRow,
  type InsertTimesheetEntry,
} from "@workspace/db";
import { fetchProcasTable, odataString, type ProcasCreds } from "./procas";
import { resolveEmployeeIdByName } from "./employeeResolve";
import { effectiveRate, loadRateChanges } from "./employeeRates";
import { recordAudit } from "./audit";
import { markProcasSynced } from "./procas";

export interface PullHoursResult {
  ok: boolean;
  importedCount: number;
  replacedCount: number;
  weeksCreated: number;
  warnings: string[];
  error?: string;
}

function toStr(v: unknown): string {
  return typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim();
}
function toNum(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Extracts the local calendar date (YYYY-MM-DD) from a Procas timestamp like
 * "2026-07-23T00:00:00-04:00". Procas serves midnight-anchored local dates, so
 * the date part before "T" is the intended calendar day. */
function datePart(v: unknown): string {
  const s = toStr(v);
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(s);
  return m ? m[1] : "";
}

const DAY_COLUMNS = [
  "hoursSun", "hoursMon", "hoursTue", "hoursWed", "hoursThu", "hoursFri", "hoursSat",
] as const;

/** Day-of-week for a YYYY-MM-DD string, computed in UTC to avoid TZ drift. */
function dayColumn(dateISO: string): (typeof DAY_COLUMNS)[number] | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateISO);
  if (!m) return null;
  const dow = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).getUTCDay();
  return DAY_COLUMNS[dow];
}

function normalizeCategory(payCodeDesc: string): string {
  const v = payCodeDesc.toLowerCase();
  if (v.includes("double") || v.includes("dbl")) return "dt";
  if (v.includes("over") || /\bot\b/.test(v)) return "ot";
  if (v.includes("holiday")) return "holiday";
  if (v.includes("pto") || v.includes("vacation") || v.includes("sick") || v.includes("leave")) return "pto";
  return "regular";
}

function fmtLabel(startISO: string, endISO: string): string {
  const f = (iso: string) => {
    const [y, mo, d] = iso.split("-");
    return `${Number(mo)}/${Number(d)}/${y}`;
  };
  return `Week ${f(startISO)} – ${f(endISO)}`;
}

function dayStart(date: string): string {
  return `${date}T00:00:00Z`;
}
function dayEnd(date: string): string {
  return `${date}T23:59:59Z`;
}

/** Deterministic best billing rate per LC item effective at the period start
 * (same policy as the invoice-side sync). */
function buildRateLookup(
  billingItems: Array<Record<string, unknown>>,
  periodStart: string,
): Map<string, number> {
  const at = new Date(dayStart(periodStart)).getTime();
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
    if (!prev || (inRange && !prev.inRange) || (inRange === prev.inRange && beginAt > prev.beginAt)) {
      best.set(lcItem, { rate, inRange, beginAt });
    }
  }
  const rates = new Map<string, number>();
  for (const [lcItem, { rate }] of best) rates.set(lcItem, rate);
  return rates;
}

interface AggEntry {
  weekStart: string;
  weekEnd: string;
  employeeName: string;
  lcItem: string;
  classification: string;
  category: string;
  days: Record<(typeof DAY_COLUMNS)[number], number>;
  statuses: Set<string>;
}

/**
 * Pulls labor hours for one package's pay period live from the Procas
 * Timesheet feed and imports them as weekly timesheet entries.
 *
 * - The work plan's `procasProject` is used as a project prefix
 *   (`startswith`) because Procas books time at leaf task codes like
 *   "10007.01.01.0.CA" while the mapping targets the root project.
 * - Weeks come from Procas's own time periods (Mon–Sun) so daily hours land
 *   on the right weekday columns; missing package weeks are created.
 * - Only previously Procas-imported entries (source="procas") are replaced;
 *   manually entered rows are never touched.
 * - Rates prefer the project's Procas Billing Setup (BillingItem) per labor
 *   category, falling back to the local employee's effective-dated rate.
 */
export async function pullPackageHoursFromProcas(
  pkg: PackageRow,
  workPlan: WorkPlan,
  creds: ProcasCreds,
): Promise<PullHoursResult> {
  const warnings: string[] = [];
  const project = (workPlan.procasProject ?? "").trim();
  if (!project) {
    return {
      ok: false, importedCount: 0, replacedCount: 0, weeksCreated: 0, warnings,
      error: "This work plan is not linked to a Procas project yet. Edit the work plan and pick its Procas project first.",
    };
  }

  const projectFilter = `startswith(Project, ${odataString(project)})`;
  let tsRows: Array<Record<string, unknown>>;
  let billingItems: Array<Record<string, unknown>>;
  try {
    tsRows = await fetchProcasTable(creds, "Timesheet", {
      filter: `${projectFilter} and WorkDate ge ${dayStart(pkg.payPeriodStart)} and WorkDate le ${dayEnd(pkg.payPeriodEnd)}`,
    });
    billingItems = await fetchProcasTable(creds, "BillingItem", { filter: projectFilter });
  } catch (e) {
    return {
      ok: false, importedCount: 0, replacedCount: 0, weeksCreated: 0, warnings,
      error: e instanceof Error ? e.message : "Failed to pull timesheets from Procas.",
    };
  }

  if (tsRows.length === 0) {
    return {
      ok: false, importedCount: 0, replacedCount: 0, weeksCreated: 0, warnings,
      error: `Procas has no timesheet hours for project ${project} between ${pkg.payPeriodStart} and ${pkg.payPeriodEnd}. The feed is a daily 6 AM Eastern snapshot, so today's entries appear tomorrow.`,
    };
  }

  const rateByLc = buildRateLookup(billingItems, pkg.payPeriodStart);

  // Aggregate daily rows into one entry per Procas week + employee + labor
  // category + pay category, with hours in the right weekday column.
  const agg = new Map<string, AggEntry>();
  let skippedRows = 0;
  for (const r of tsRows) {
    const name = toStr(r.PersonnelName) || toStr(r.Personnel);
    const workDate = datePart(r.WorkDate);
    const weekStart = datePart(r.TimePeriodBeginningDate) || workDate;
    const weekEnd = datePart(r.TimePeriodEndingDate) || workDate;
    const hours = toNum(r.HoursWorked);
    const col = dayColumn(workDate);
    if (!name || !col || hours === 0) {
      if (hours !== 0) skippedRows += 1;
      continue;
    }
    const lcItem = toStr(r.LCItem);
    const category = normalizeCategory(toStr(r.PayCodeDesc) || toStr(r.PayCode));
    const key = `${weekStart}|${name.toLowerCase()}|${lcItem}|${category}`;
    let entry = agg.get(key);
    if (!entry) {
      entry = {
        weekStart, weekEnd,
        employeeName: name,
        lcItem,
        classification: toStr(r.LCItemDesc) || lcItem,
        category,
        days: { hoursSun: 0, hoursMon: 0, hoursTue: 0, hoursWed: 0, hoursThu: 0, hoursFri: 0, hoursSat: 0 },
        statuses: new Set(),
      };
      agg.set(key, entry);
    }
    entry.days[col] += hours;
    const status = toStr(r.Status);
    if (status) entry.statuses.add(status);
  }
  if (skippedRows > 0) {
    warnings.push(`${skippedRows} Procas row(s) had an unreadable work date and were skipped.`);
  }

  const entries = [...agg.values()];
  const nonFinal = new Set<string>();
  for (const e of entries) {
    for (const s of e.statuses) {
      if (!/processed|approved|posted|locked/i.test(s)) nonFinal.add(s);
    }
  }
  if (nonFinal.size > 0) {
    warnings.push(
      `Some pulled hours are not finalized in Procas yet (status: ${[...nonFinal].join(", ")}). Re-pull after timesheets are approved.`,
    );
  }

  // Ensure a package week exists for every Procas week involved.
  const existingWeeks = await db
    .select()
    .from(packageWeeksTable)
    .where(eq(packageWeeksTable.packageId, pkg.id));
  const weekByStart = new Map<string, PackageWeekRow>(existingWeeks.map((w) => [w.weekStart, w]));
  const neededStarts = [...new Set(entries.map((e) => e.weekStart))].sort();
  let weeksCreated = 0;
  let sortOrder = existingWeeks.reduce((m, w) => Math.max(m, w.sortOrder), -1) + 1;
  for (const start of neededStarts) {
    if (weekByStart.has(start)) continue;
    const end = entries.find((e) => e.weekStart === start)?.weekEnd ?? start;
    const [row] = await db
      .insert(packageWeeksTable)
      .values({ packageId: pkg.id, label: fmtLabel(start, end), weekStart: start, weekEnd: end, sortOrder })
      .returning();
    weekByStart.set(start, row);
    weeksCreated += 1;
    sortOrder += 1;
  }

  // Resolve employees and rates.
  const employees = await db.select().from(employeesTable);
  const empByName = new Map(employees.map((e) => [e.name.trim().toLowerCase(), e]));
  const rateChanges = await loadRateChanges(employees.map((e) => e.id));
  const missingRates = new Set<string>();
  const toInsert: InsertTimesheetEntry[] = [];
  for (const e of entries) {
    const week = weekByStart.get(e.weekStart);
    if (!week) continue;
    const emp = empByName.get(e.employeeName.trim().toLowerCase());
    const employeeId = emp?.id ?? (await resolveEmployeeIdByName(e.employeeName));
    let rate = rateByLc.get(e.lcItem) ?? 0;
    if (rate <= 0) {
      const empRow = emp ?? employees.find((x) => x.id === employeeId);
      if (empRow) {
        rate = effectiveRate(empRow, rateChanges.get(empRow.id) ?? [], "home", week.weekStart);
      }
    }
    if (rate <= 0) missingRates.add(e.classification || e.employeeName);
    toInsert.push({
      packageId: pkg.id,
      weekId: week.id,
      employeeId,
      employeeName: e.employeeName,
      classification: e.classification,
      category: e.category,
      location: "home",
      ...e.days,
      rate,
      source: "procas",
      notes: e.lcItem ? `Procas LC ${e.lcItem}` : null,
    });
  }
  if (missingRates.size > 0) {
    warnings.push(
      `No billing rate found for: ${[...missingRates].join(", ")} — the rate was left at $0. Set it on the entry or the employee.`,
    );
  }

  // Replace prior Procas-imported entries so re-pulls never duplicate hours;
  // manual entries are untouched. One transaction so a failed insert never
  // leaves the package with its previous pull deleted.
  const replaced = await db.transaction(async (tx) => {
    const deleted = await tx
      .delete(timesheetEntriesTable)
      .where(and(eq(timesheetEntriesTable.packageId, pkg.id), eq(timesheetEntriesTable.source, "procas")))
      .returning({ id: timesheetEntriesTable.id });
    if (toInsert.length > 0) {
      await tx.insert(timesheetEntriesTable).values(toInsert);
    }
    return deleted;
  });
  if (replaced.length > 0) {
    warnings.unshift(`Replaced ${replaced.length} previously pulled entr${replaced.length === 1 ? "y" : "ies"}.`);
  }

  await markProcasSynced(new Date());
  await recordAudit({
    action: "pulled hours from Procas",
    entityType: "package",
    entityId: pkg.id,
    description: `${toInsert.length} timesheet entr${toInsert.length === 1 ? "y" : "ies"} pulled from Procas project ${project} for ${pkg.payPeriodStart} – ${pkg.payPeriodEnd}${replaced.length > 0 ? ` (replaced ${replaced.length})` : ""}`,
  });

  return { ok: true, importedCount: toInsert.length, replacedCount: replaced.length, weeksCreated, warnings };
}
