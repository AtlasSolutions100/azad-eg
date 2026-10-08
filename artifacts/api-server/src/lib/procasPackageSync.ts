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
import { knownHeader } from "./knownInvoiceHeaders";

export interface PullHoursResult {
  ok: boolean;
  importedCount: number;
  replacedCount: number;
  weeksCreated: number;
  // Total hours pulled whose Procas timesheet status is not yet finalized
  // (i.e. not Approved/Processed/Posted/Locked). Only approved hours may be
  // exported; the UI surfaces this count in a persistent banner and marks the
  // corresponding rows red. 0 means every pulled hour is approved.
  unapprovedHours: number;
  warnings: string[];
  error?: string;
}

// A Procas Timesheet Status counts as finalized (approved for billing) when it
// is one of these. Everything else (e.g. "Unsubmitted") is treated as not yet
// approved. Kept in one place so the warning, the per-entry `approved` flag,
// and the unapproved-hours tally all agree.
const FINAL_STATUS_RE = /\b(processed|approved|posted|locked)\b/i;
const NOT_FINAL_RE = /\b(not|rejected|pending|un\w+|dis\w+)\b/i;

/**
 * True for a Procas timesheet status that means the hours are approved.
 *
 * The test used to be "contains the word approved", and Procas has a status
 * called "Disapproved". A whole month of a project manager's disapproved
 * hours (September 2026, work plan B.40-02) pulled in as approved, with no
 * red rows and nothing to stop the export.
 */
export function isFinalStatus(status: string): boolean {
  return FINAL_STATUS_RE.test(status) && !NOT_FINAL_RE.test(status);
}

/** True when every observed status on an aggregated entry is finalized. An
 * entry with no status at all is treated as approved (nothing signals
 * otherwise). */
function statusesApproved(statuses: Set<string>): boolean {
  for (const s of statuses) {
    if (!isFinalStatus(s)) return false;
  }
  return true;
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

/**
 * "holiday" or "pto" for a Procas pay code that is leave (Holiday; Sick;
 * "Vacation (or PTO)"), null for anything else — regular time, overtime, and
 * leave without pay, which is neither worked nor paid and has no row on the
 * timesheet.
 */
export function leaveCategory(payCodeDesc: string): "holiday" | "pto" | null {
  const v = payCodeDesc.trim().toLowerCase();
  if (v === "h" || v.includes("holiday")) return "holiday";
  if (v === "s" || v === "v" || /\b(sick|vacation|pto)\b/.test(v)) return "pto";
  return null;
}

export function normalizeCategory(payCodeDesc: string, accountDesc = ""): string {
  // Account Desc (Timesheet Col E) is the billable-vs-not source of truth.
  // G&A, B&P (bid & proposal) and Overhead are indirect accounts that are NEVER
  // charged to the client — capture them as non-billable PTO (bill $0) rather
  // than letting them fall through to billable "regular".
  const acct = accountDesc.toLowerCase();
  const isIndirect =
    acct.includes("g&a") ||
    acct.includes("g & a") ||
    acct.includes("b&p") ||
    acct.includes("b & p") ||
    acct.includes("bid & proposal") ||
    acct.includes("bid and proposal") ||
    (acct.includes("overhead") && !acct.includes("direct"));
  if (isIndirect) return "pto";
  // Non-direct leave accounts also read as non-billable.
  if (acct.includes("holiday")) return "holiday";
  if (acct.includes("sick") || acct.includes("vacation") || acct.includes("pto") || acct.includes("leave"))
    return "pto";

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

/**
 * Above this, a Procas billing rate is taken to be a LOADED rate.
 *
 * Procas's Billing Setup holds two different kinds of number under the same
 * column. For some projects it is the direct rate the employee is paid
 * (10013.TO01 Warehouse Specialist, $74.00). For others it is what the prime is
 * charged per hour with fringe, overhead and fee already rolled in (10014 Field
 * Inspector, $197.73 — which is $83.00 x 2.2058 x 1.08). BART invoices always
 * show the direct rate and add the burden on the page (Julie, Aug 26: "for
 * BART, we always show them as the direct rate that we're actually paying the
 * employee"), so a loaded rate has to be unwound or the invoice burdens it a
 * second time: the August T.Y. Lin package came out at $348,167.93 against a
 * real figure around $150,000.
 *
 * Nothing in the feed says which kind a rate is, so it is told apart by size.
 * The highest direct rate on any invoice she has sent us is $140.00 and the
 * lowest loaded rate in Procas is $146.72. If a rate ever lands on the wrong
 * side of this line, this is the one number to move.
 */
export const LOADED_RATE_FLOOR = 145;

type BurdenRates = Partial<
  Pick<WorkPlan, "fringeRate" | "overheadRate" | "fixedFeeRate" | "fccmRate">
>;

/**
 * What one dollar of direct labor becomes on the invoice: labor plus fringe and
 * overhead, the fixed fee on all of that, and FCCM on the labor alone.
 * T.Y. Lin: 2.2058 x 1.08 = 2.3823. WSP: 2.2058 x 1.08 + 0.0039 = 2.3862.
 */
export function burdenMultiplier(wp: BurdenRates): number {
  const pct = (v: number | null | undefined) => (Number.isFinite(v) ? Number(v) / 100 : 0);
  return (
    (1 + pct(wp.fringeRate) + pct(wp.overheadRate)) * (1 + pct(wp.fixedFeeRate)) + pct(wp.fccmRate)
  );
}

/**
 * The direct pay rate behind a Procas billing rate, or the rate itself when it
 * is already a direct rate (or the work plan has no burden to unwind).
 */
export function directRate(billingRate: number, wp: BurdenRates): number {
  const multiplier = burdenMultiplier(wp);
  if (billingRate < LOADED_RATE_FLOOR || multiplier <= 1.5) return billingRate;
  return Math.round((billingRate / multiplier + Number.EPSILON) * 100) / 100;
}

/**
 * The straight-time labor category an overtime one belongs to: "FI-O" → "FI",
 * "RE1-O" → "RE1", "INSP-D" → "INSP". Procas prices overtime as its own
 * category (the loaded base plus the unburdened premium); the invoice bills the
 * hours at the base rate and the premium as a separate line.
 */
export function baseLcItem(lcItem: string): string {
  return lcItem.replace(/-(O|OT|D|DT|NO|ND)$/i, (m) => (/^-N/i.test(m) ? "-N" : ""));
}

/**
 * The BART project a Procas leaf project is for, read from its description:
 * "WSP CM Services for BART 15EJRRC" → 15EJRRC, "20LN003 Parsons BART TO
 * B.40-02-001 LNP" → 20LN003. Empty for a leaf that is not project-specific
 * ("Parsons BART TO B.55-01"). BART project numbers are two digits, two
 * letters and three more characters; an agreement number (6M8146) is not one.
 */
export function bartProjectOf(projectDesc: string): string {
  return /\b(\d{2}[A-Z]{2}[A-Z0-9]{3})\b/.exec(projectDesc.toUpperCase())?.[1] ?? "";
}

interface AggEntry {
  bartProject: string;
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
  workPlan: Pick<WorkPlan, "procasProject"> & BurdenRates,
  creds: ProcasCreds,
): Promise<PullHoursResult> {
  const warnings: string[] = [];
  const project = (workPlan.procasProject ?? "").trim();
  if (!project) {
    return {
      ok: false, importedCount: 0, replacedCount: 0, weeksCreated: 0, unapprovedHours: 0, warnings,
      error: "This work plan is not linked to a Procas project yet. Edit the work plan and pick its Procas project first.",
    };
  }

  const projectFilter = `startswith(Project, ${odataString(project)})`;
  let tsRows: Array<Record<string, unknown>>;
  let billingItems: Array<Record<string, unknown>>;
  try {
    // Fetched together, not one after the other. Neither depends on the other,
    // and on Replit these two round trips ran back-to-back inside one HTTP
    // request — long enough for the proxy in front of the app to give up and
    // return a 502 while the import carried on and completed server-side.
    // Julie saw a fetch-timeout error and then found the hours had imported
    // anyway. Halving the wall time keeps the response inside the proxy's
    // budget; `withProcasDeadline` below bounds the worst case.
    [tsRows, billingItems] = await Promise.all([
      fetchProcasTable(creds, "Timesheet", {
        filter: `${projectFilter} and WorkDate ge ${dayStart(pkg.payPeriodStart)} and WorkDate le ${dayEnd(pkg.payPeriodEnd)}`,
      }),
      fetchProcasTable(creds, "BillingItem", { filter: projectFilter }),
    ]);
  } catch (e) {
    return {
      ok: false, importedCount: 0, replacedCount: 0, weeksCreated: 0, unapprovedHours: 0, warnings,
      error: e instanceof Error ? e.message : "Failed to pull timesheets from Procas.",
    };
  }

  if (tsRows.length === 0) {
    return {
      ok: false, importedCount: 0, replacedCount: 0, weeksCreated: 0, unapprovedHours: 0, warnings,
      error: `Procas has no timesheet hours for project ${project} between ${pkg.payPeriodStart} and ${pkg.payPeriodEnd}. The feed is a daily 6 AM Eastern snapshot, so today's entries appear tomorrow.`,
    };
  }

  const rateByLc = buildRateLookup(billingItems, pkg.payPeriodStart);
  // Work plans whose paperwork is kept per BART project get one entry per
  // project, so the invoice can bill each on its own line (or its own invoice).
  const byBartProject = !!knownHeader(project)?.billsByBartProject;
  // Procas does not say where an hour was worked; her invoice does.
  const location = knownHeader(project)?.laborLocation ?? "home";

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
    const category = normalizeCategory(
      toStr(r.PayCodeDesc) || toStr(r.PayCode),
      toStr(r.AccountDesc),
    );
    const bartProject = byBartProject ? bartProjectOf(toStr(r.ProjectDesc)) : "";
    const key = `${weekStart}|${name.toLowerCase()}|${lcItem}|${category}|${bartProject}`;
    let entry = agg.get(key);
    if (!entry) {
      entry = {
        bartProject,
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

  // Leave. Procas books sick and vacation time to its own projects ("Sick Time
  // 2026", "Vacation Time 2026") and holidays to no project at all, so a pull
  // by client project never saw them and every timesheet's "PTO
  // (Sick/Vacation)" and "Holiday" rows printed empty. BART's timesheets have
  // to show them ("Need to show on timesheet if Imani worked Holiday or PTO.
  // This needs to be on for all BART timesheets"). They are fetched for the
  // people on this package, for the same dates, and carried as non-billable
  // rows: they print on the timesheet and add nothing to the invoice.
  const personnel = [...new Set(tsRows.map((r) => toStr(r.Personnel)).filter(Boolean))];
  if (personnel.length > 0) {
    try {
      const who = personnel.map((p) => `Personnel eq ${odataString(p)}`).join(" or ");
      const others = await fetchProcasTable(creds, "Timesheet", {
        filter: `(${who}) and WorkDate ge ${dayStart(pkg.payPeriodStart)} and WorkDate le ${dayEnd(pkg.payPeriodEnd)}`,
      });
      // The classification a person's leave is filed under on the timesheet
      // is the one they work under here, not Procas's generic "Employee".
      const worksAs = new Map<string, string>();
      for (const e of agg.values()) {
        const k = e.employeeName.toLowerCase();
        if (e.category === "regular" || !worksAs.has(k)) worksAs.set(k, e.classification);
      }
      for (const r of others) {
        if (toStr(r.Project).startsWith(project)) continue; // already counted above
        const category = leaveCategory(toStr(r.PayCodeDesc) || toStr(r.PayCode));
        if (!category) continue;
        const name = toStr(r.PersonnelName) || toStr(r.Personnel);
        const workDate = datePart(r.WorkDate);
        const hours = toNum(r.HoursWorked);
        const col = dayColumn(workDate);
        if (!name || !col || hours === 0) continue;
        const weekStart = datePart(r.TimePeriodBeginningDate) || workDate;
        const key = `${weekStart}|${name.toLowerCase()}|leave|${category}|`;
        let entry = agg.get(key);
        if (!entry) {
          entry = {
            bartProject: "",
            weekStart,
            weekEnd: datePart(r.TimePeriodEndingDate) || workDate,
            employeeName: name,
            lcItem: "",
            classification: worksAs.get(name.toLowerCase()) ?? toStr(r.LCItemDesc),
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
    } catch (e) {
      warnings.push(
        `Holiday and PTO hours could not be read from Procas (${e instanceof Error ? e.message : "request failed"}), so those timesheet rows are blank. Pull again to retry.`,
      );
    }
  }

  const entries = [...agg.values()];
  const nonFinal = new Set<string>();
  for (const e of entries) {
    for (const s of e.statuses) {
      if (!isFinalStatus(s)) nonFinal.add(s);
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
  const unloaded = new Map<string, string>();
  const lcDesc = new Map<string, string>();
  for (const e of entries) if (e.category === "regular") lcDesc.set(e.lcItem, e.classification);
  const toInsert: InsertTimesheetEntry[] = [];
  // Running tally of pulled hours whose Procas status is not yet finalized, so
  // the package API can surface a durable "N hours not yet approved" signal.
  let unapprovedHours = 0;
  for (const e of entries) {
    const week = weekByStart.get(e.weekStart);
    if (!week) continue;
    const emp = empByName.get(e.employeeName.trim().toLowerCase());
    const employeeId = emp?.id ?? (await resolveEmployeeIdByName(e.employeeName));
    // Overtime and doubletime bill at the straight-time rate of the same
    // labor category; the premium is the invoice's own separate line.
    const premium = e.category === "ot" || e.category === "dt";
    const baseLc = premium ? baseLcItem(e.lcItem) : e.lcItem;
    const rateLc = premium && rateByLc.has(baseLc) ? baseLc : e.lcItem;
    if (premium && lcDesc.has(baseLc)) e.classification = lcDesc.get(baseLc)!;
    // Leave is not billed: no rate, and no "missing rate" warning for it.
    const leave = e.category === "pto" || e.category === "holiday";
    let rate = leave ? 0 : (rateByLc.get(rateLc) ?? 0);
    if (rate > 0) {
      const direct = directRate(rate, workPlan);
      if (direct !== rate) {
        unloaded.set(
          `${e.classification}|${rate}`,
          `${e.classification} $${rate.toFixed(2)} → $${direct.toFixed(2)}`,
        );
        rate = direct;
      }
    }
    if (rate <= 0 && !leave) {
      const empRow = emp ?? employees.find((x) => x.id === employeeId);
      if (empRow) {
        rate = effectiveRate(empRow, rateChanges.get(empRow.id) ?? [], "home", week.weekStart);
      }
    }
    if (rate <= 0 && !leave) missingRates.add(e.classification || e.employeeName);
    const approved = statusesApproved(e.statuses);
    if (!approved) {
      for (const col of DAY_COLUMNS) unapprovedHours += e.days[col];
    }
    toInsert.push({
      packageId: pkg.id,
      weekId: week.id,
      employeeId,
      employeeName: e.employeeName,
      classification: e.classification,
      category: e.category,
      location,
      ...e.days,
      rate,
      source: "procas",
      approved,
      taskNo: e.bartProject || null,
      notes: e.lcItem ? `Procas LC ${e.lcItem}` : leave ? "Procas leave (not billed)" : null,
    });
  }
  unapprovedHours = Math.round((unapprovedHours + Number.EPSILON) * 100) / 100;
  if (unloaded.size > 0) {
    warnings.push(
      `Procas lists loaded billing rates for this project. The invoice shows the direct pay rate and adds the burden itself, so each was divided by this work plan's multiplier (${burdenMultiplier(workPlan).toFixed(4)}): ${[...unloaded.values()].join("; ")}. If a rate is wrong, change it on the timesheet entry.`,
    );
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

  return { ok: true, importedCount: toInsert.length, replacedCount: replaced.length, weeksCreated, unapprovedHours, warnings };
}
