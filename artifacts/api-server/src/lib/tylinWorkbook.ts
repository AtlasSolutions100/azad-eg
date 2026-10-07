import ExcelJS from "exceljs";
import path from "node:path";
import fs from "node:fs";
import { templatesDir, generatedDir, ensureDirs } from "./paths";
import {
  deletedRefTokens,
  dropDeadDefinedNames,
  fitSheetsToOnePage,
  freezeSharedFormulas,
  freezeUnstableFormulas,
  removeSheet,
  reviveModelDates,
  scrubInternalMarks,
  stripBrokenDefinedNames,
  settleTimesheetSignature,
  personKey,
  shrinkCellToFit,
} from "./excel";
import { agreementLine, knownBurden, knownHeader, type DetailParts } from "./knownInvoiceHeaders";
import { contributorKey } from "./packageMappers";
import { burdenOnFringeLine } from "./billingProfile";
import { logger } from "./logger";
import type { PackageDocContext } from "./packageDocs";
import type { PackageRow, PackageWeekRow, TimesheetEntryRow } from "@workspace/db";

/**
 * T.Y. Lin ("TYlin") invoice export engine (reference-workbook approach).
 *
 * The template (`tylin-invoice-template.xlsm`) is Julie's real T.Y. Lin/BART
 * invoice workbook (job 6M8213, Work Plan A.02-01/02, invoice AZAD-20). As with
 * the WSP engine, this loads that workbook and mutates it in place, writing
 * backend-computed VALUES (never formulas) into the reference cells so the
 * client file is authoritative even in a viewer that does not recalculate.
 *
 * Sheet map (differs from WSP):
 *  - `Invoice` (face): invoice no L6, date L8/M45, PO L10, job no L12, agreement
 *    E22, project no L22, title E23, period G24, billed line L28, TOTAL AMOUNT
 *    DUE L31, and the billing summary J35-J38 / M36-M38.
 *  - `Sub1 Inv` (build-up): field labor H11, fringe H12, overhead pool H13,
 *    ODCs H23-H25, OT/DT premium subconsultant lines H29/H30, fixed fee H35, and
 *    the AUTHORITATIVE totals G42 (budget) / H42 (this period) / I42 (previously
 *    billed) / J42 (to date). `Sub1 Inv!H42` is the headline "total this period"
 *    (the analog of WSP's `Sub Calc _revised!H51`), mirrored to Invoice L28/L31/
 *    J36. On the AZAD-20 sample it is 158,552.58.
 *  - `Sub1 Labor` (per-employee lines): classification A / name B / hours C /
 *    rate D / amount E, Field subtotal row 35, TOTAL LABOR row 38.
 *  - `ODCs`: kept (Other Direct Costs detail).
 *  - `Progress Report - <name>` (per employee): header refreshed; freeform
 *    narrative left as authored.
 *  - Weekly timesheet tabs `<name> Week N`: 7 day columns H..N starting SATURDAY
 *    (H=Sat … N=Fri), rows straight/OT/DT/PTO/holiday, weekly totals in col O.
 *
 * The billing math follows the definitive V1 BART model (identical to WSP):
 *   direct labor (straight+OT+DT hours × base rate)
 *     → + fringe (× fringeRate, e.g. 1.2058)
 *     → + overhead pool (× overheadRate; 0 for this contract)
 *     → + fixed fee (× fixedFeeRate on labor+fringe+pool)
 *     → + FCCM (× fccmRate on direct labor, per location, rounded; 0 for TYlin)
 *     → + OT/DT premium (0.5×base×OT, 1.0×base×DT — UNBURDENED, added after).
 * Previously-billed dollars carry forward from the prior invoice (scalar).
 *
 * Internal sheets (the hidden `master file`/`master file_old` header feeds, the
 * legacy `Sub1 Inv (2)`, `NOTES`, working inspection logs, and the template's
 * own week tabs) are removed; any straggler formula that still referenced them
 * (or an unsupported Google-Sheets `DUMMYFUNCTION`) is frozen to its cached
 * value so the client file never opens with #REF!/#NAME! or a repair prompt.
 */

/** Whose signature the template's timesheet tabs carry. */
const TEMPLATE_SIGNER = "Ryan Harper";

const TEMPLATE_FILE = "tylin-invoice-template.xlsm";

const INVOICE_SHEET = "Invoice";
const SUBINV_SHEET = "Sub1 Inv";
const SUBLABOR_SHEET = "Sub1 Labor";
const ODC_SHEET = "ODCs";

/** First and last detail rows of the ODCs table (row 23 is the grand total). */
const ODC_FIRST_ROW = 7;
const ODC_LAST_ROW = 16;

/** The pristine weekly-timesheet layout cloned for each generated tab. */
const PRISTINE_WEEK_SHEET = "Ryan Week 1";

/**
 * Sheets that must never ship to the client (removed from the workbook). The
 * per-employee progress reports are kept; the template's own weekly timesheet
 * tabs are removed dynamically (see `isTemplateWeekTab`) and regenerated.
 */
const INTERNAL_SHEETS = [
  "master file",
  "master file_old",
  "Sub1 Inv (2)",
  "NOTES",
  "Ryan MAY  2026 OSFM Inspections",
];

/** True for the template's own `<name> Week N` timesheet tabs (regenerated). */
function isTemplateWeekTab(name: string): boolean {
  return /\sWeek\s*\d+\s*$/i.test(name);
}

/** US-dollar text matching the template's DOLLAR() output, e.g. $2,588,054.11. */
function money(n: number): string {
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** Parse a YYYY-MM-DD calendar day at local noon (avoids TZ rollover). */
function toDate(value: string): Date {
  const [y, m, d] = value.split("-").map((n) => parseInt(n, 10));
  return new Date(y, (m || 1) - 1, d || 1, 12, 0, 0);
}

function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

/** The Saturday on or before the given day (weeks run Saturday → Friday). */
function saturdayOnOrBefore(date: Date): Date {
  // getDay(): Sun=0 … Sat=6. Saturday → shift 0; Sunday → 1; … Friday → 6.
  return addDays(date, -((date.getDay() + 1) % 7));
}

/** Formats a Date as "M/DD/YYYY" (e.g. 6/01/2026), matching the sample header. */
function formatMDY(date: Date): string {
  const m = date.getMonth() + 1;
  const d = String(date.getDate()).padStart(2, "0");
  return `${m}/${d}/${date.getFullYear()}`;
}

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function setVal(ws: ExcelJS.Worksheet, address: string, value: ExcelJS.CellValue): void {
  const cell = ws.getCell(address);
  const style = cell.style;
  cell.value = value;
  cell.style = style;
}

function clearCell(ws: ExcelJS.Worksheet, address: string): void {
  const cell = ws.getCell(address);
  const style = cell.style;
  cell.value = null;
  cell.style = style;
}

/** Excel-safe sheet name (31 chars, none of []:*?/\). */
function sheetSafe(label: string, fallback: string): string {
  const cleaned = (label || fallback).replace(/[\\/?*[\]:]/g, " ").replace(/\s+/g, " ").trim();
  // A sheet name may not begin or end with an apostrophe, and cutting a name
  // at 31 characters can leave one there ("… - De'" from De'Andre).
  return (cleaned || fallback).slice(0, 31).replace(/^'+|'+$/g, "").trim() || fallback;
}

function uniqueName(base: string, used: Set<string>): string {
  let name = base;
  let n = 2;
  while (used.has(name.toLowerCase())) {
    const suffix = `-${n}`;
    name = base.slice(0, 31 - suffix.length) + suffix;
    n += 1;
  }
  used.add(name.toLowerCase());
  return name;
}

/** First name (or first token) of a display name, for `<name> Week N` tabs. */
function firstNameOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return (parts[0] || "EE").replace(/[,]/g, "");
}

/**
 * Detects whether a package bills through T.Y. Lin as its prime. Free-text
 * `prime` ("T.Y. Lin", "TYLin International", "Lin") is matched case-
 * insensitively on the "lin"/"t.y" tokens, while WSP and AECOM are excluded so
 * a package never matches both engines.
 */
export function isTylinPrime(pkg: Pick<PackageRow, "prime">): boolean {
  const prime = pkg.prime ?? "";
  if (/\bwsp\b/i.test(prime) || /aecom/i.test(prime)) return false;
  return /t\.?\s*y\.?\s*lin|\blin\b|tylin/i.test(prime);
}

// ---------------------------------------------------------------------------
// Financials
// ---------------------------------------------------------------------------

interface TylinLaborRow {
  key: string;
  employeeName: string;
  classification: string;
  location: "home" | "field";
  rate: number;
  /** "" for straight time; OT/DT hours get their own "<name>-OT" line. */
  premium: "" | "ot" | "dt";
  hours: number; // billable hours at the base rate
  amount: number; // round2(hours × rate) — direct labor at base rate
}

interface TylinLocationTotals {
  directLabor: number; // Σ row amounts (each rounded)
  fringe: number; // directLabor × fringeFrac (UNROUNDED)
  overheadPool: number; // directLabor × overheadFrac (UNROUNDED; 0 here)
  fccm: number; // round2(directLabor × fccmFrac); 0 for TYlin
}

/**
 * One person's overtime/doubletime premium for the period. The ODCs sheet
 * itemises these by name, so the premium has to be tracked per employee and
 * not only as the two workbook-level scalars.
 */
export interface TylinPremiumRow {
  employeeName: string;
  kind: "ot" | "dt";
  hours: number;
  amount: number;
  /** Premium per hour (0.5 or 1.0 x the base rate), for the build-up label. */
  perHour: number;
}

export interface TylinFinancials {
  laborRows: TylinLaborRow[];
  /** Per-employee OT/DT premium detail, for the ODCs itemisation. */
  premiumRows: TylinPremiumRow[];
  home: TylinLocationTotals;
  field: TylinLocationTotals;
  fixedFee: number; // (labor+fringe+pool) × feeFrac (UNROUNDED)
  otPremium: number; // round2(Σ 0.5 × base × OT hours)
  dtPremium: number; // round2(Σ 1.0 × base × DT hours)
  otherDirectCosts: number;
  totalHours: number; // billable hours only (excludes PTO/holiday)
  totalThisPeriod: number;
  previouslyBilled: number;
  totalToDate: number;
  budget: number;
  remainingBalance: number;
  percentExpended: number; // fraction (0..1)
  fringeFrac: number;
  overheadFrac: number;
  feeFrac: number;
  fccmFrac: number;
}

/**
 * "Field Inspector-Overtime" / "Resident Engineer1- Ov" → the classification
 * the straight time carries. Procas keeps overtime under its own labor
 * category; her labor attachment lists it under the person's normal one.
 */
export function baseClassification(classification: string): string {
  return (
    classification
      .replace(/\s*[-–]\s*(overtime|over\s*time|double\s*time|doubletime|ov|ot|dt)\b.*$/i, "")
      .trim() || classification
  );
}

function isBillable(category: string): boolean {
  return category !== "pto" && category !== "holiday";
}

function entryHours(e: TimesheetEntryRow): number {
  return (
    e.hoursMon + e.hoursTue + e.hoursWed + e.hoursThu + e.hoursFri + e.hoursSat + e.hoursSun
  );
}

/**
 * Computes the TYlin burden chain from the package's timesheet entries. Fringe,
 * overhead pool, and fixed fee are kept UNROUNDED (as the reference workbook's
 * formulas do); FCCM and the OT/DT premiums are rounded to the cent, and the
 * headline is rounded once. This ordering is what makes the AZAD-20 sample's
 * headline land on 158,552.58.
 */
export function computeTylinFinancials(ctx: PackageDocContext): TylinFinancials {
  const wp = ctx.workPlan;
  const { fringeFrac, overheadFrac } = burdenOnFringeLine(wp);
  const feeFrac = (wp.fixedFeeRate ?? 0) / 100;
  const fccmFrac = (wp.fccmRate ?? 0) / 100;

  // Her T.Y. Lin invoice bills every hour under Field (the staff sit at the
  // BART Police HQ site), and Procas does not say where an hour was worked, so
  // a pulled timesheet arrived as Home and the whole invoice printed in the
  // wrong block. A work plan whose reference invoice is all one location says
  // so in its known header.
  const forcedLocation =
    knownHeader((wp as { procasProject?: string | null }).procasProject, wp.jobNumber)
      ?.laborLocation ?? null;

  // One labor row per (employee, location, rate). All billable hours
  // (straight + night + OT + DT) bill at the base rate; the OT/DT *premium* is
  // computed separately below and added unburdened.
  const rowMap = new Map<string, TylinLaborRow>();
  const premiumMap = new Map<string, TylinPremiumRow>();
  const addPremium = (name: string, kind: "ot" | "dt", hrs: number, amount: number) => {
    const k = `${name.toLowerCase()}|${kind}`;
    const row = premiumMap.get(k) ?? { employeeName: name, kind, hours: 0, amount: 0, perHour: 0 };
    row.hours = round2(row.hours + hrs);
    row.amount = round2(row.amount + amount);
    row.perHour = row.hours > 0 ? round2(row.amount / row.hours) : 0;
    premiumMap.set(k, row);
  };
  let otPremiumRaw = 0;
  let dtPremiumRaw = 0;
  for (const e of ctx.entries) {
    const hrs = entryHours(e);
    if (hrs <= 0) continue;
    const location: "home" | "field" =
      forcedLocation ?? (e.location === "field" ? "field" : "home");
    if (isBillable(e.category)) {
      // Overtime prints as its own line, "Ryan Harper-OT", under the same
      // classification and at the same base rate as the straight time; the
      // premium half is billed separately (see premiumRows).
      const premium: "" | "ot" | "dt" = e.category === "ot" ? "ot" : e.category === "dt" ? "dt" : "";
      const key = `${contributorKey(e)}|${location}|${e.rate}|${premium}`;
      const row =
        rowMap.get(key) ??
        ({
          key,
          employeeName: premium ? `${e.employeeName}-${premium.toUpperCase()}` : e.employeeName,
          classification: baseClassification(e.classification),
          location,
          rate: e.rate,
          premium,
          hours: 0,
          amount: 0,
        } as TylinLaborRow);
      row.hours = round2(row.hours + hrs);
      rowMap.set(key, row);
      if (e.category === "ot") {
        otPremiumRaw += 0.5 * hrs * e.rate;
        addPremium(e.employeeName, "ot", hrs, 0.5 * hrs * e.rate);
      } else if (e.category === "dt") {
        dtPremiumRaw += 1.0 * hrs * e.rate;
        addPremium(e.employeeName, "dt", hrs, 1.0 * hrs * e.rate);
      }
    }
  }
  const laborRows = [...rowMap.values()].map((r) => ({
    ...r,
    amount: round2(r.hours * r.rate),
  }));
  laborRows.sort(
    (a, b) =>
      (a.location === b.location ? 0 : a.location === "home" ? -1 : 1) ||
      a.employeeName.replace(/-(OT|DT)$/, "").localeCompare(b.employeeName.replace(/-(OT|DT)$/, "")) ||
      a.premium.localeCompare(b.premium) ||
      b.amount - a.amount,
  );

  const locTotals = (loc: "home" | "field"): TylinLocationTotals => {
    const directLabor = round2(
      laborRows.filter((r) => r.location === loc).reduce((s, r) => s + r.amount, 0),
    );
    return {
      directLabor,
      fringe: directLabor * fringeFrac,
      overheadPool: directLabor * overheadFrac,
      fccm: round2(directLabor * fccmFrac),
    };
  };
  const home = locTotals("home");
  const field = locTotals("field");

  const totalDirectLabor = round2(home.directLabor + field.directLabor);
  const totalFringe = home.fringe + field.fringe;
  const totalPool = home.overheadPool + field.overheadPool;
  const fixedFee = (totalDirectLabor + totalFringe + totalPool) * feeFrac;
  const otPremium = round2(otPremiumRaw);
  const dtPremium = round2(dtPremiumRaw);
  const otherDirectCosts = round2(ctx.pkg.otherDirectCosts ?? 0);

  const totalThisPeriod =
    home.directLabor +
    home.fringe +
    home.overheadPool +
    home.fccm +
    field.directLabor +
    field.fringe +
    field.overheadPool +
    field.fccm +
    fixedFee +
    otPremium +
    dtPremium +
    otherDirectCosts;

  const totalHours = round2(
    ctx.entries.filter((e) => isBillable(e.category)).reduce((s, e) => s + entryHours(e), 0),
  );
  const previouslyBilled = round2(ctx.pkg.previouslyBilled ?? 0);
  const totalToDate = totalThisPeriod + previouslyBilled;
  const budget = wp.totalBudget ?? 0;
  const hasBudget = budget > 0;
  const remainingBalance = hasBudget ? budget - totalToDate : 0;
  const percentExpended = hasBudget ? totalToDate / budget : 0;

  const premiumRows = [...premiumMap.values()].sort(
    (a, b) => a.employeeName.localeCompare(b.employeeName) || a.kind.localeCompare(b.kind),
  );

  return {
    laborRows,
    premiumRows,
    home,
    field,
    fixedFee,
    otPremium,
    dtPremium,
    otherDirectCosts,
    totalHours,
    totalThisPeriod,
    previouslyBilled,
    totalToDate,
    budget,
    remainingBalance,
    percentExpended,
    fringeFrac,
    overheadFrac,
    feeFrac,
    fccmFrac,
  };
}

// ---------------------------------------------------------------------------
// Sheet cleanup helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Contributors
// ---------------------------------------------------------------------------

interface TylinContributor {
  key: string;
  name: string;
  classification: string;
}

function contributors(ctx: PackageDocContext): TylinContributor[] {
  const seen = new Map<string, TylinContributor>();
  for (const e of ctx.entries) {
    const name = e.employeeName.trim();
    if (!name) continue;
    const key = contributorKey(e);
    if (!seen.has(key)) seen.set(key, { key, name, classification: e.classification });
  }
  if (seen.size === 0 && ctx.employee?.name) {
    return [
      {
        key: `name:${ctx.employee.name.trim().toLowerCase()}`,
        name: ctx.employee.name,
        classification: ctx.employee.classification,
      },
    ];
  }
  return [...seen.values()];
}

// ---------------------------------------------------------------------------
// Timesheet tabs
// ---------------------------------------------------------------------------

/** Category → generated-timesheet row (uniform TYlin layout, cloned per week). */
function timesheetRow(category: string): number {
  switch (category) {
    case "ot":
      return 9;
    case "dt":
      return 10;
    case "pto":
      return 11;
    case "holiday":
      return 12;
    default:
      return 8; // regular / night → straight time
  }
}

/** Day columns on a generated timesheet tab: H=Sat, I=Sun … N=Fri. */
const DAY_COLS = ["H", "I", "J", "K", "L", "M", "N"] as const;

/**
 * Fills one generated weekly timesheet tab for one contributor. Day columns run
 * Saturday (H) → Friday (N); H6 is the week's Saturday, and every hour cell and
 * total is written as a value (the tab carries no live cross-sheet formulas).
 */
function fillTimesheet(
  ws: ExcelJS.Worksheet,
  week: PackageWeekRow,
  ctx: PackageDocContext,
  person: TylinContributor,
): void {
  const wp = ctx.workPlan;
  const contractLabel = `${wp.agreementNo ?? ""} ${wp.code}`.trim();
  const saturday = saturdayOnOrBefore(toDate(week.weekStart));

  setVal(ws, "D5", person.name);
  // "Amirhossein Hashemiastaneh" is wider than the name box.
  if (person.name.length > 20) shrinkCellToFit(ws, "D5");
  // Day header dates: H=Sat, I=Sun, J=Mon, K=Tue, L=Wed, M=Thu, N=Fri.
  DAY_COLS.forEach((col, i) => setVal(ws, `${col}6`, addDays(saturday, i)));
  // "Week Ending" = Friday. The template formats J5 as `[$-409]mmmm d, yyyy`
  // ("August 21, 2026"), which is 13 characters in an 8.9-wide column, so the
  // printed timesheet read "Week Ending: ###". A short numeric date fits.
  setVal(ws, "J5", addDays(saturday, 6));
  ws.getCell("J5").numFmt = "m/d/yyyy";
  // The reference workbook carries a stray backtick in V36, inside the print
  // area (A1:V36), so it printed in the bottom-right corner of every single
  // timesheet page.
  clearCell(ws, "V36");

  // Clear the sample data region (descriptions + all day/total cells, rows 8-13).
  for (let r = 8; r <= 13; r++) {
    for (const col of ["A", "B", "D", ...DAY_COLS, "O"]) clearCell(ws, `${col}${r}`);
  }
  // Clear the cloned signer name (row 17 on some layouts) so it does not leak.
  clearCell(ws, "E17");
  clearCell(ws, "G17");

  // Aggregate the contributor's hours per category into day columns.
  const acc = new Map<number, Record<string, number>>();
  for (const e of ctx.entries.filter(
    (x) => x.weekId === week.id && contributorKey(x) === person.key,
  )) {
    const r = timesheetRow(e.category);
    const a = acc.get(r) ?? { H: 0, I: 0, J: 0, K: 0, L: 0, M: 0, N: 0 };
    a.H += e.hoursSat;
    a.I += e.hoursSun;
    a.J += e.hoursMon;
    a.K += e.hoursTue;
    a.L += e.hoursWed;
    a.M += e.hoursThu;
    a.N += e.hoursFri;
    acc.set(r, a);
  }

  const rowLabel: Record<number, string> = {
    8: person.classification,
    9: `${person.classification}-OT`,
    10: `${person.classification}-DT`,
    11: "PTO (Sick/Vacation)",
    12: "Holiday",
  };

  const colTotals: Record<string, number> = { H: 0, I: 0, J: 0, K: 0, L: 0, M: 0, N: 0 };
  let grandTotal = 0;
  for (const r of [8, 9, 10, 11, 12]) {
    const a = acc.get(r);
    if (r <= 10) setVal(ws, `B${r}`, contractLabel);
    setVal(ws, `D${r}`, rowLabel[r]);
    // "Assistant Resident Engineer 2-OT" lost its end, and with it the only
    // thing telling the three rows apart.
    if ((rowLabel[r] ?? "").length > 26) shrinkCellToFit(ws, `D${r}`);
    let rowTotal = 0;
    for (const col of DAY_COLS) {
      const v = round2(a?.[col] ?? 0);
      if (v > 0) setVal(ws, `${col}${r}`, v);
      rowTotal += v;
      colTotals[col] += v;
    }
    setVal(ws, `O${r}`, round2(rowTotal));
    grandTotal += rowTotal;
  }

  // TOTAL HOURS row (14): column sums + grand total.
  for (const col of DAY_COLS) setVal(ws, `${col}14`, round2(colTotals[col]));
  setVal(ws, "O14", round2(grandTotal));
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

/**
 * Writes one "Hours to Date" band: Current (D) / Previous (E) / To Date (F).
 * A null `previous` leaves Previous blank and makes To Date equal Current —
 * better than a 0 that reads as "nobody has ever worked this job".
 */
function writeHoursToDate(
  ws: ExcelJS.Worksheet,
  row: number,
  current: number,
  previous: number | null,
): void {
  setVal(ws, `D${row}`, current);
  if (previous == null) clearCell(ws, `E${row}`);
  else setVal(ws, `E${row}`, previous);
  setVal(ws, `F${row}`, round2(current + (previous ?? 0)));
}

/**
 * People in the order her labor attachment lists them (Sarah, Ryan, Amir, …).
 * Everything that is per person — labor lines, progress reports, timesheets —
 * follows it; somebody new to the job comes after, alphabetically.
 */
function rosterOrder(sublabor: ExcelJS.Worksheet): string[] {
  const order: string[] = [];
  for (let r = 6; r <= 34; r++) {
    const v = sublabor.getCell(`B${r}`).value;
    if (typeof v !== "string") continue;
    const key = personKey(v.replace(/-(OT|DT)\s*$/i, "").replace(/,\s*PE\s*$/i, ""));
    if (key && !order.includes(key)) order.push(key);
  }
  return order;
}

function byRoster(order: string[]): (a: string, b: string) => number {
  const rank = (name: string) => {
    const i = order.indexOf(personKey(name.replace(/-(OT|DT)\s*$/i, "")));
    return i < 0 ? order.length : i;
  };
  return (a, b) => rank(a) - rank(b) || a.localeCompare(b);
}

const NO_PARTS: DetailParts = { labor: 0, fringe: 0, odc: 0, premium: 0, fee: 0, fccm: 0, total: 0 };

/**
 * Splits a known total into the detail page's rows at the given burden: labor,
 * fringe on it, the fee on both, FCCM on the labor. Any cent of rounding is
 * left on the labor so the rows add up to the total.
 */
export function splitDetailTotal(
  total: number,
  r: { fringeFrac: number; overheadFrac: number; feeFrac: number; fccmFrac: number },
): DetailParts {
  const burden = r.fringeFrac + r.overheadFrac;
  const multiplier = (1 + burden) * (1 + r.feeFrac) + r.fccmFrac;
  if (!(total > 0) || multiplier <= 0) return { ...NO_PARTS };
  const labor = round2(total / multiplier);
  const fringe = round2(labor * burden);
  const fee = round2((labor + fringe) * r.feeFrac);
  const fccm = round2(labor * r.fccmFrac);
  const residue = round2(total - (labor + fringe + fee + fccm));
  return { labor: round2(labor + residue), fringe, odc: 0, premium: 0, fee, fccm, total: round2(total) };
}

function addParts(a: DetailParts, b: DetailParts): DetailParts {
  return {
    labor: round2(a.labor + b.labor),
    fringe: round2(a.fringe + b.fringe),
    odc: round2(a.odc + b.odc),
    premium: round2(a.premium + b.premium),
    fee: round2(a.fee + b.fee),
    fccm: round2(a.fccm + b.fccm),
    total: round2(a.total + b.total),
  };
}

/**
 * The detail page's Budget and Previously Billed columns, row by row.
 *
 * Julie's page fills all four money columns on every row; ours printed only
 * the totals ("Not seeing any information populated in the Budget, Previously
 * billed or amount to date field"). Procas knows the totals but not the rows.
 * In order of preference:
 *
 *  - the split typed on the Work Plan screen (Budget / Previously billed by
 *    cost category), which is exact;
 *  - her last invoice's own rows, for whatever of the total it accounts for;
 *  - the remainder split at the burden of the periods it was billed in. That
 *    part is arithmetic: it puts everything billed since her invoice on the
 *    labor, fringe and fee rows, and cannot know how much of it was overtime
 *    premium. The column totals are exact either way.
 */
export function tylinDetailColumns(
  ctx: PackageDocContext,
  fin: TylinFinancials,
  pastRates: { fringeFrac: number; overheadFrac: number; feeFrac: number; fccmFrac: number },
): { budget: DetailParts; previous: DetailParts } {
  const wp = ctx.workPlan;
  const anchor = knownHeader((wp as { procasProject?: string | null }).procasProject, wp.jobNumber)
    ?.detailAnchor;
  const near = (a: number, b: number) => Math.abs(a - b) < 0.005;

  const prev = round2(fin.previouslyBilled);
  let previous: DetailParts;
  if (
    wp.prevBilledLabor != null ||
    wp.prevBilledOverhead != null ||
    wp.prevBilledFixedFee != null ||
    wp.prevBilledFccm != null
  ) {
    previous = {
      labor: round2(wp.prevBilledLabor ?? 0),
      fringe: round2(wp.prevBilledOverhead ?? 0),
      odc: 0,
      premium: 0,
      fee: round2(wp.prevBilledFixedFee ?? 0),
      fccm: round2(wp.prevBilledFccm ?? 0),
      total: prev,
    };
  } else {
    const from = anchor && prev >= anchor.toDate.total - 0.005 && ctx.pkg.payPeriodStart > anchor.through
      ? anchor.toDate
      : NO_PARTS;
    previous = addParts(from, splitDetailTotal(round2(prev - from.total), pastRates));
    previous.total = prev;
  }

  const total = fin.budget;
  let budget: DetailParts;
  if (wp.budgetLabor != null || wp.budgetOverhead != null || wp.budgetFixedFee != null || wp.budgetFccm != null) {
    budget = {
      labor: round2(wp.budgetLabor ?? 0),
      fringe: round2(wp.budgetOverhead ?? 0),
      odc: 0,
      premium: 0,
      fee: round2(wp.budgetFixedFee ?? 0),
      fccm: round2(wp.budgetFccm ?? 0),
      total,
    };
  } else if (anchor && near(total, anchor.budget.total)) {
    budget = anchor.budget;
  } else {
    budget = splitDetailTotal(total, fin);
  }
  return { budget, previous };
}

/**
 * Fills in a progress report's heading, wherever its cells are.
 *
 * Each person's report in her workbook was laid out by hand and no two agree:
 * Sarah's has "MONTH" in B4 with the month beside it and the year in its own
 * cell, Ryan's has "MONTH:" in D4 and the year inside the "/ YEAR 2026" label.
 * Writing to fixed addresses put Ryan's month to the LEFT of its label
 * ("SeptembMONTH: 2026 / YEAR 2026") and a second work plan number on top of
 * Jordy's ("Work Pl|A.02-01"). So the labels are found and the values put
 * beside them. The work plan number and title are hers already and stay.
 */
function writeReportHeading(
  ws: ExcelJS.Worksheet,
  h: { month: string; year: number; date: Date | null; period: string },
): void {
  const text = (c: ExcelJS.Cell) => (typeof c.value === "string" ? c.value : "");
  for (let r = 3; r <= 8; r++) {
    const row = ws.getRow(r);
    for (let c = 1; c <= 8; c++) {
      const cell = row.getCell(c);
      const label = text(cell).trim();
      if (!label) continue;
      const beside = row.getCell(c + 1).address;
      if (/^month\b/i.test(label)) {
        setVal(ws, beside, h.month);
        // "September" is wider than the cell "June" fitted in.
        shrinkCellToFit(ws, beside);
      } else if (/^work plan title:\s*\S/i.test(label)) {
        // Label and title share one cell here, and ran into "Period:" beside it.
        shrinkCellToFit(ws, cell.address);
      } else if (/^\/\s*year/i.test(label)) {
        if (/\d{4}/.test(label)) setVal(ws, cell.address, label.replace(/\d{4}/, String(h.year)));
        else setVal(ws, beside, h.year);
      } else if (/^date:?$/i.test(label)) {
        // No date yet: blank, not the date of the invoice the report came from.
        setVal(ws, beside, h.date);
      } else if (/^period:?$/i.test(label)) setVal(ws, beside, h.period);
    }
  }
}

export interface TylinBuildResult {
  wb: ExcelJS.Workbook;
  timesheetTabs: string[];
  financials: TylinFinancials;
}

/**
 * Columns cleared on each Sub1 Labor line. A..E carry the generated line
 * (classification / name / hours / rate / amount); F..L are scratch cells Julie
 * kept beside the FIELD block in the reference workbook — a "MODIFY THE FORMULA
 * FOR THE MONTH STARTING DATE" note, half-rate helpers, and running sums like
 * `=E18+E20+E26+…`. Clearing only A..E left all of that sitting next to the
 * real lines, which is the "formatting is funky for staff's names/roles" Julie
 * saw on the Labor Attachment.
 */
const LABOR_COLS = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L"] as const;

const LABOR_STYLE_COLS = ["A", "B", "C", "D", "E"] as const;
/** A reference labor line whose look (10pt, $ formats) every line takes. */
const LABOR_STYLE_ROW = 18;

/** Writes one Sub1 Labor location block (rows start..end) and its subtotal. */
function writeLaborBlock(
  ws: ExcelJS.Worksheet,
  fin: TylinFinancials,
  location: "home" | "field",
  block: { start: number; end: number; hoursSubtotal: string; amountSubtotal: string },
  look: Array<Partial<ExcelJS.Style>>,
): void {
  // The reference rows are a patchwork: some are hidden (staff who had left by
  // the time Julie sent it), and their fonts run 10, 11 and 12 point. Lines
  // written into them inherited both — Sarah Boyd's overtime landed on a
  // hidden row, so it was in the subtotal but not on the page, and the visible
  // lines printed in three sizes. Every line now takes one row's look and is
  // shown; rows with nothing on them are hidden, bar one for breathing room.
  for (let r = block.start; r <= block.end; r++) {
    for (const col of LABOR_COLS) clearCell(ws, `${col}${r}`);
  }
  const rows = fin.laborRows.filter((r) => r.location === location);
  for (let r = block.start; r <= block.end; r++) {
    LABOR_STYLE_COLS.forEach((col, i) => {
      ws.getCell(`${col}${r}`).style = JSON.parse(JSON.stringify(look[i]));
    });
    ws.getRow(r).hidden = r - block.start > Math.max(rows.length, 1);
  }
  const cap = block.end - block.start + 1;
  let hours = 0;
  let amount = 0;
  rows.slice(0, cap).forEach((r, i) => {
    const row = block.start + i;
    const amt = round2(r.hours * r.rate);
    setVal(ws, `A${row}`, r.classification);
    if (r.classification.length > 26) shrinkCellToFit(ws, `A${row}`);
    setVal(ws, `B${row}`, r.employeeName);
    setVal(ws, `C${row}`, r.hours);
    setVal(ws, `D${row}`, r.rate);
    setVal(ws, `E${row}`, amt);
    hours += r.hours;
    amount += amt;
  });
  if (rows.length > cap) {
    logger.warn(
      { location, overflow: rows.length - cap },
      "TYlin Sub1 Labor block has more lines than template rows; extra lines omitted",
    );
  }
  setVal(ws, block.hoursSubtotal, round2(hours));
  setVal(ws, block.amountSubtotal, round2(amount));
}

/**
 * Builds the client-ready TYlin workbook from the reference template. Returns
 * the workbook plus the ordered timesheet tab names and computed financials
 * (for verification/tests).
 */
export async function buildTylinWorkbook(ctx: PackageDocContext): Promise<TylinBuildResult> {
  const file = path.resolve(templatesDir, TEMPLATE_FILE);
  if (!fs.existsSync(file)) {
    throw new Error(`TYlin invoice template not found at ${file}`);
  }
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);

  const wp = ctx.workPlan;
  const pkg = ctx.pkg;
  const fin = computeTylinFinancials(ctx);

  const invoice = wb.getWorksheet(INVOICE_SHEET)!;
  const subinv = wb.getWorksheet(SUBINV_SHEET)!;
  const sublabor = wb.getWorksheet(SUBLABOR_SHEET)!;

  // Her order of people, read before the labor attachment is rewritten.
  const inRosterOrder = byRoster(rosterOrder(sublabor));
  fin.laborRows.sort(
    (a, b) =>
      (a.location === b.location ? 0 : a.location === "home" ? -1 : 1) ||
      inRosterOrder(a.employeeName, b.employeeName) ||
      a.premium.localeCompare(b.premium),
  );

  // Capture a pristine week-tab layout before we drop the template's tabs.
  const pristineWeek = JSON.parse(
    JSON.stringify(wb.getWorksheet(PRISTINE_WEEK_SHEET)!.model),
  );

  // An unset invoice number prints blank, never the work-plan code. Falling back
  // to the code put "10014" in the Invoice No. box, which reads as a real invoice
  // number and sent Julie looking for where the system got it. The package
  // tie-out already flags a missing number, and the biller supplies the first one
  // for a work plan (every later package increments it — see bumpInvoiceNumber).
  const invoiceNo = pkg.invoiceNumber || "";
  const invoiceDate = pkg.invoiceDate ? toDate(pkg.invoiceDate) : null;
  const periodStart = toDate(pkg.payPeriodStart);
  const periodEnd = toDate(pkg.payPeriodEnd);
  const periodStr = `${formatMDY(periodStart)} to ${formatMDY(periodEnd)}`;

  const totalThisPeriod = round2(fin.totalThisPeriod);
  const previouslyBilled = round2(fin.previouslyBilled);
  const totalToDate = round2(fin.totalToDate);
  const budget = fin.budget;
  const remaining = round2(budget - totalToDate);

  // -- 1. Invoice (face). Every cross-sheet cell is overwritten with a value.
  setVal(invoice, "L6", invoiceNo);
  if (invoiceDate) {
    setVal(invoice, "L8", invoiceDate);
    setVal(invoice, "M45", invoiceDate);
  } else {
    clearCell(invoice, "L8");
    clearCell(invoice, "M45");
  }
  setVal(invoice, "L10", wp.poNumber || "");
  setVal(invoice, "L12", wp.jobNumber || "");
  if (wp.sendToCompany) setVal(invoice, "D14", wp.sendToCompany);
  if (wp.sendToAddress1) setVal(invoice, "D15", wp.sendToAddress1);
  // Hers reads "6M8213 General Engineering Services", not the bare number.
  setVal(invoice, "E22", agreementLine(wp.agreementNo, wp.procasProject));
  // L22 is the "Project No:" label; the number, when there is one, goes under
  // it. Writing the number INTO L22 erased the label on every invoice.
  setVal(invoice, "L23", wp.bartProjectNumbers || wp.clientProjectNo || "");
  setVal(invoice, "E23", wp.title || "");
  // The full title has to fit beside the Project No. box ("…& PM Support"),
  // which it does a size down. Not shrink-to-fit: the text runs on past its
  // own narrow cell, and shrinking it to that cell leaves a line of specks.
  const titleCell = invoice.getCell("E23");
  titleCell.font = { ...titleCell.font, size: Math.max(7, (titleCell.font?.size ?? 9) - 1.5) };
  setVal(invoice, "G24", periodStr);
  setVal(invoice, "L25", wp.terms || "");
  setVal(invoice, "C28", `Work Plan ${wp.code}`);
  setVal(invoice, "L28", totalThisPeriod);
  setVal(invoice, "L31", totalThisPeriod);
  // Billing summary.
  setVal(invoice, "J35", budget);
  setVal(invoice, "J36", totalThisPeriod);
  setVal(invoice, "J37", previouslyBilled);
  setVal(invoice, "J38", remaining);
  setVal(invoice, "M36", budget > 0 ? totalThisPeriod / budget : 0);
  setVal(invoice, "M37", budget > 0 ? previouslyBilled / budget : 0);
  setVal(invoice, "M38", budget > 0 ? remaining / budget : 0);
  // The form occupies columns B..O. Columns P..V hold Julie's working notes —
  // a stray backtick, a 2,588,054.11 budget tally, a `=J38/588.75` unit-rate
  // check — and the template's print area (A1:V49) reaches all of them, so
  // they printed on the right-hand side of the client's invoice.
  for (let r = 1; r <= 49; r++) {
    for (const col of ["P", "Q", "R", "S", "T", "U", "V"]) clearCell(invoice, `${col}${r}`);
  }

  // -- 2. Sub1 Inv (build-up). Leaf cells written as values; the authoritative
  // totals G42/H42/I42/J42 forced so non-recalc viewers are correct.
  //
  // Before writing anything, wipe the four right-hand columns across the whole
  // body. Only column H (Amount This Period) was ever regenerated, so Budget
  // (G), Previously Billed (I), Amount To Date (J) and % Expended (K) still
  // carried the reference workbook's own invoice: $1.2M and $2.39M budgets,
  // $1.95M previously billed, $2.09M to date and a 87.6% expended figure, none
  // of which belong to this package. Those seven-figure leftovers are also what
  // overflowed the narrow columns into the `###` Julie reported — the real
  // numbers for this period fit fine.
  for (let r = 5; r <= 41; r++) {
    for (const col of ["G", "I", "J", "K"]) clearCell(subinv, `${col}${r}`);
  }
  setVal(subinv, "K1", invoiceDate ?? "");
  setVal(subinv, "J2", invoiceNo);

  // Home labor block (rows 7 labor / 8 fringe / 9 overhead pool) — 0 for BART.
  //
  // Hours to Date: Current (D) / Previous (E) / To Date (F). E and F were left
  // as an empty cell and a `=D+E` formula whose cached result was the
  // template's 11,028.5 hours, so the row read blank-or-wrong. Previous now
  // comes from Procas — every hour booked under this project's leaf codes
  // before the period start, captured on the package at creation (10007 has
  // 6,627 of them); it used to be a hard 0, which is what Julie's "missing
  // previous hours" note was about. Null means Procas was never asked, and the
  // cell is left blank rather than stating a confident 0.
  //
  // The figure is a project total, not split by location, so it lands on the
  // row that carries this period's labor — the same rule the previously-billed
  // dollars follow.
  writeHoursToDate(subinv, 7, round2(homeHours(fin)), fieldHours(fin) <= 0 ? ctx.pkg.previousHours : null);
  setVal(subinv, "H7", fin.home.directLabor);
  setVal(subinv, "H8", fin.home.fringe);
  setVal(subinv, "H9", fin.home.overheadPool);
  // Field labor block (rows 11 labor / 12 fringe / 13 overhead pool).
  writeHoursToDate(subinv, 11, round2(fieldHours(fin)), fieldHours(fin) > 0 ? ctx.pkg.previousHours : null);
  setVal(subinv, "H11", fin.field.directLabor);
  setVal(subinv, "D12", fin.fringeFrac); // fringe multiplier, e.g. 1.2058 (full precision)
  setVal(subinv, "H12", fin.field.fringe);
  setVal(subinv, "D13", fin.overheadFrac);
  setVal(subinv, "H13", fin.field.overheadPool);
  // Subtotals (labor + fringe + pool).
  setVal(subinv, "H14", round2(fin.field.directLabor + fin.field.fringe + fin.field.overheadPool));
  setVal(
    subinv,
    "H20",
    round2(
      fin.home.directLabor +
        fin.home.fringe +
        fin.home.overheadPool +
        fin.field.directLabor +
        fin.field.fringe +
        fin.field.overheadPool,
    ),
  );
  // Other Direct Costs (rows 23-27).
  for (const r of [23, 24, 25]) setVal(subinv, `H${r}`, 0);
  setVal(subinv, "H23", fin.otherDirectCosts);
  setVal(subinv, "H27", fin.otherDirectCosts);
  // Subconsultants: OT/DT premium lines (rows 29-32), unburdened.
  for (const r of [29, 30, 31, 32]) {
    for (const col of ["C", "F", "G", "H"]) clearCell(subinv, `${col}${r}`);
  }
  const otHrs = round2(otHours(ctx));
  const dtHrs = round2(dtHours(ctx));
  // Hers names each person: "SS OT Premium(Ryan) 41.50/HR HRS   24   996.00".
  // There are four rows; more people than that fall back to one line per kind.
  const premiumLines = fin.premiumRows.filter((r) => r.amount > 0);
  if (premiumLines.length > 0 && premiumLines.length <= 4) {
    premiumLines.forEach((p, i) => {
      const r = 29 + i;
      setVal(
        subinv,
        `C${r}`,
        `SS ${p.kind.toUpperCase()} Premium(${firstNameOf(p.employeeName)}) ${p.perHour.toFixed(2)}/HR HRS`,
      );
      setVal(subinv, `F${r}`, p.hours);
      setVal(subinv, `H${r}`, p.amount);
    });
  } else {
    setVal(subinv, "C29", "OT Premium (0.5 x base rate)");
    setVal(subinv, "F29", otHrs);
    setVal(subinv, "H29", fin.otPremium);
    setVal(subinv, "C30", "DT Premium (1.0 x base rate)");
    setVal(subinv, "F30", dtHrs);
    setVal(subinv, "H30", fin.dtPremium);
  }
  setVal(subinv, "H33", round2(fin.otPremium + fin.dtPremium));
  // Fixed Fee (rows 34-39). E35 = fee fraction; H35 = ROUND(fee).
  setVal(subinv, "E35", fin.feeFrac);
  setVal(subinv, "H35", round2(fin.fixedFee));
  setVal(subinv, "H39", round2(fin.fixedFee));
  // FCCM, on the line between Total Fixed Fee and Total Amount Due. BART asked
  // for it on this invoice from September 2026: 0.39% of direct labor only.
  // The figure was already in the total; the page had no line to show it on.
  const fccm = round2(fin.home.fccm + fin.field.fccm);
  if (fin.fccmFrac > 0) {
    // The label starts in column A: from B it ran into the percentage and lost
    // its "(FCCM)".
    for (const [from, to] of [["B35", "A40"], ["E35", "E40"], ["H35", "H40"], ["I35", "I40"], ["J35", "J40"], ["G35", "G40"]]) {
      subinv.getCell(to).style = JSON.parse(JSON.stringify(subinv.getCell(from).style));
    }
    setVal(subinv, "A40", "Facilities Capital Cost of Money (FCCM)");
    setVal(subinv, "E40", fin.fccmFrac);
    subinv.getCell("E40").numFmt = "0.00%";
    setVal(subinv, "H40", fccm);
  }
  // Authoritative totals (values, not formulas).
  setVal(subinv, "G42", budget);
  setVal(subinv, "H42", totalThisPeriod);
  setVal(subinv, "I42", previouslyBilled);
  setVal(subinv, "J42", totalToDate);
  // % Expended was a `=J42/G42` formula, which renders #DIV/0! on a work plan
  // whose budget has not been entered yet. Written as a value, and 0 when there
  // is no budget to divide by.
  setVal(subinv, "K42", budget > 0 ? totalToDate / budget : 0);
  setVal(subinv, "G43", remaining);
  // The last three template formulas on the build-up: two hour/rate subtotals
  // and the subconsultant fee leaf, all reading empty cells.
  setVal(subinv, "D10", 0);
  // Not rounded: 1.2058 rounded to the cent printed as "121.00%".
  setVal(subinv, "D14", fin.fringeFrac + fin.overheadFrac);
  setVal(subinv, "H36", 0);

  // Previously-billed column I decomposition. We only carry a scalar forward,
  // so unused leaves are zeroed (never left as template constants) and the
  // scalar lands on the field-labor previous row unless the work plan supplies
  // an explicit per-category split (labor / overhead / fixed fee / FCCM).
  for (const r of [7, 8, 9, 11, 12, 13, 16, 17, 18, 23, 24, 25, 29, 30, 35, 38, 40]) {
    clearCell(subinv, `I${r}`);
  }
  // Budget (G), Previously Billed (I) and Amount To Date (J) on every row, and
  // % Expended (K) on the section totals — see tylinDetailColumns.
  const pastRates = {
    ...burdenOnFringeLine(
      knownBurden([(wp as { procasProject?: string | null }).procasProject, wp.jobNumber], priorDay(pkg.payPeriodStart)) ?? wp,
    ),
    feeFrac: fin.feeFrac,
    fccmFrac:
      (knownBurden([(wp as { procasProject?: string | null }).procasProject, wp.jobNumber], priorDay(pkg.payPeriodStart))
        ?.fccmRate ?? wp.fccmRate ?? 0) / 100,
  };
  const cols = tylinDetailColumns(ctx, fin, pastRates);
  const current: DetailParts = {
    labor: round2(fin.home.directLabor + fin.field.directLabor),
    fringe: round2(fin.home.fringe + fin.home.overheadPool + fin.field.fringe + fin.field.overheadPool),
    odc: fin.otherDirectCosts,
    premium: round2(fin.otPremium + fin.dtPremium),
    fee: round2(fin.fixedFee),
    fccm,
    total: totalThisPeriod,
  };
  const share = (part: number, whole: number) => (whole > 0 ? part / whole : 0);
  const put = (row: number, b: number, p: number, c: number, pct = false) => {
    setVal(subinv, `G${row}`, b);
    setVal(subinv, `I${row}`, p);
    setVal(subinv, `J${row}`, round2(p + c));
    if (pct) setVal(subinv, `K${row}`, share(p + c, b));
  };
  const { budget: bud, previous: was } = cols;
  put(11, bud.labor, was.labor, current.labor);
  put(12, bud.fringe, was.fringe, current.fringe);
  put(14, round2(bud.labor + bud.fringe), round2(was.labor + was.fringe), round2(current.labor + current.fringe));
  put(20, round2(bud.labor + bud.fringe), round2(was.labor + was.fringe), round2(current.labor + current.fringe), true);
  if (bud.odc || was.odc || current.odc) {
    // Her earlier overtime adjustments sit on this line of the ODC block.
    if (was.odc) {
      setVal(subinv, "I25", was.odc);
      setVal(subinv, "J25", was.odc);
    }
    put(27, bud.odc, was.odc, current.odc, true);
  }
  if (bud.premium || was.premium || current.premium) put(33, bud.premium, was.premium, current.premium);
  put(35, bud.fee, was.fee, current.fee);
  put(39, bud.fee, was.fee, current.fee, true);
  if (fin.fccmFrac > 0 || was.fccm) put(40, bud.fccm, was.fccm, current.fccm);

  // -- 3. Sub1 Labor (per-employee lines). Clear both blocks, then write rows.
  setVal(sublabor, "E1", invoiceDate ?? "");
  setVal(sublabor, "E2", invoiceNo);
  const laborLook = LABOR_STYLE_COLS.map((col) =>
    JSON.parse(JSON.stringify(sublabor.getCell(`${col}${LABOR_STYLE_ROW}`).style)),
  );
  // Row 6 is the "Home" heading (as row 14 is "Field"); the lines start under it.
  writeLaborBlock(
    sublabor,
    fin,
    "home",
    { start: 7, end: 12, hoursSubtotal: "C13", amountSubtotal: "E13" },
    laborLook,
  );
  writeLaborBlock(
    sublabor,
    fin,
    "field",
    { start: 16, end: 34, hoursSubtotal: "C35", amountSubtotal: "E35" },
    laborLook,
  );
  // TOTAL LABOR (row 38).
  const totalLaborHours = round2(fin.laborRows.reduce((s, r) => s + r.hours, 0));
  const totalLaborAmount = round2(fin.home.directLabor + fin.field.directLabor);
  setVal(sublabor, "C38", totalLaborHours);
  setVal(sublabor, "E38", totalLaborAmount);
  // Row 38 also carried Julie's own reconciliation scratch — `=59250.7-E38` in
  // H38 and the bare label "ODC" in I38 — parked to the right of TOTAL LABOR
  // and outside both labor blocks, so nothing ever cleared it. It printed on
  // the client's Labor Attachment ("hide/delete where it says ODC on the
  // bottom right").
  for (const col of ["F", "G", "H", "I", "J", "K", "L"]) clearCell(sublabor, `${col}38`);

  // -- 3b. ODCs (Other Direct Costs detail). This sheet shipped straight from
  // the reference workbook, untouched: it still said "Month of May", carried
  // July invoice dates, and itemised the overtime of whoever happened to be on
  // Julie's original invoice via `='Sub1 Labor'!B24` formulas whose cached
  // results named staff who did not work this period. It is now regenerated
  // from the package's own OT/DT premiums.
  const odcs = wb.getWorksheet(ODC_SHEET);
  if (odcs) {
    setVal(
      odcs,
      "A1",
      [
        wp.agreementNo ? `Agreement No. ${wp.agreementNo}` : "",
        wp.code ? `Work Plan No ${wp.code}` : "",
      ]
        .filter(Boolean)
        .join("  "),
    );
    setVal(odcs, "C3", `${MONTH_NAMES[periodStart.getMonth()]} ${periodStart.getFullYear()}`);
    // Rows 7..16 are the ten detail rows; row 23 is the grand total.
    for (let r = ODC_FIRST_ROW; r <= ODC_LAST_ROW; r++) {
      for (const col of ["A", "B", "C", "D", "E", "F", "G"]) clearCell(odcs, `${col}${r}`);
    }
    // Her table names BART as the vendor on every overtime line.
    const vendor = "BART";
    const premiums = fin.premiumRows.filter((r) => r.amount > 0);
    // Eight of the ten detail rows are hidden in the reference workbook (it
    // shows only the two people who had overtime that month). The lines were
    // written into rows 7 and 8, both hidden, so the table printed empty above
    // a grand total — which is what Julie's "is this meant to be blank?" was.
    const odcCols = ["A", "B", "C", "D", "E", "F", "G"];
    const odcLook = odcCols.map((col) => JSON.parse(JSON.stringify(odcs.getCell(`${col}9`).style)));
    for (let r = ODC_FIRST_ROW; r <= ODC_LAST_ROW; r++) {
      odcCols.forEach((col, i) => {
        odcs.getCell(`${col}${r}`).style = JSON.parse(JSON.stringify(odcLook[i]));
      });
      odcs.getRow(r).hidden = r - ODC_FIRST_ROW >= premiums.length;
    }
    premiums.slice(0, ODC_LAST_ROW - ODC_FIRST_ROW + 1).forEach((row, i) => {
      const r = ODC_FIRST_ROW + i;
      setVal(odcs, `A${r}`, i + 1);
      if (invoiceDate) setVal(odcs, `B${r}`, invoiceDate);
      setVal(odcs, `C${r}`, vendor);
      setVal(odcs, `D${r}`, `${row.employeeName}-${row.kind.toUpperCase()}`);
      setVal(odcs, `F${r}`, row.amount);
      setVal(odcs, `G${r}`, row.kind === "ot" ? "Overtime" : "DoubleTime");
    });
    if (premiums.length > ODC_LAST_ROW - ODC_FIRST_ROW + 1) {
      logger.warn(
        { overflow: premiums.length - (ODC_LAST_ROW - ODC_FIRST_ROW + 1) },
        "TYlin ODCs sheet has more premium lines than template rows; extra lines omitted",
      );
    }
    setVal(odcs, "F23", round2(premiums.reduce((sum, r) => sum + r.amount, 0)));
  }

  // -- 4. Progress Reports: refresh the header of each retained report so the
  // period/date/work-plan no longer point at the removed `master file` feed.
  //
  // The template ships a progress report per person who was on the job when
  // Julie built it. Anyone no longer charging the project (and the two hidden
  // reports for Mahsa and Robert) would otherwise ride along into the client's
  // package with a refreshed header and last period's narrative, so reports
  // that do not belong to a contributor on this package are dropped.
  const reportDate = ctx.progress?.reportDate ? toDate(ctx.progress.reportDate) : invoiceDate;
  const contributorTokens = new Set(
    contributors(ctx)
      .flatMap((p) => p.name.split(/[\s,]+/))
      .map((t) => t.replace(/[^A-Za-z]/g, "").toLowerCase())
      .filter((t) => t.length >= 3),
  );
  for (const ws of [...wb.worksheets]) {
    if (!/^Progress Report/i.test(ws.name)) continue;
    const nameTokens = ws.name
      .replace(/^Progress Report/i, "")
      .split(/[\s,-]+/)
      .map((t) => t.replace(/[^A-Za-z]/g, "").toLowerCase())
      .filter((t) => t.length >= 3);
    // A tab is kept when one of its name tokens prefixes (or is prefixed by) a
    // contributor's — "Progress Report - Amir" belongs to Amirhossein
    // Hashemiastaneh, while "Progress Report - Shane Terrell" matches no one.
    const keep = nameTokens.some((t) =>
      [...contributorTokens].some((c) => c.startsWith(t) || t.startsWith(c)),
    );
    if (!keep) {
      wb.removeWorksheet(ws.id);
      continue;
    }
    ws.state = "visible";
    writeReportHeading(ws, {
      month: MONTH_NAMES[periodStart.getMonth()],
      year: periodStart.getFullYear(),
      date: reportDate,
      period: periodStr,
    });
    // The narrative closes with a CONCATENATE that quotes the budget, the
    // amount billed to date and the percent expended by reaching into the
    // Invoice and Sub1 Inv. Unevaluated, it prints the sentence built from the
    // reference invoice — "$2,588,054.11 … 87.9% has been billed" — on a work
    // plan that may have billed nothing at all. Rewritten as the real sentence.
    const forecast =
      `Cost Forecast Completion: Current approved budget is ${money(budget)}. ` +
      `Through this invoice, ${money(totalToDate)} ` +
      `(${budget > 0 ? ((totalToDate / budget) * 100).toFixed(1) : "0.0"}%) has been billed. `;
    ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
        const v = cell.value as { formula?: string } | string | null;
        if (v && typeof v === "object" && typeof v.formula === "string" &&
            v.formula.includes("Cost Forecast Completion")) {
          setVal(ws, cell.address, forecast);
          // Two lines of text in a one-line row cut the sentence off mid-word.
          row.height = 30;
        }
        // The signature block's date sits above its "Date" caption and was a
        // typed 7/8/2026 from the reference invoice.
        // (Ryan's caption is padded with spaces; and with no date set the
        // line is left blank to be dated by hand.)
        if (typeof v === "string" && /^\s*date\s*$/i.test(v) && rowNumber > 20) {
          setVal(ws, ws.getCell(rowNumber - 1, colNumber).address, reportDate);
        }
      });
    });
  }

  // -- 5. Remove internal sheets + template week tabs, then sever any straggler
  // formulas/defined names that still pointed at them.
  const removed: string[] = [];
  for (const name of INTERNAL_SHEETS) {
    if (wb.getWorksheet(name)) {
      removeSheet(wb, name);
      removed.push(name);
    }
  }
  for (const ws of [...wb.worksheets]) {
    if (isTemplateWeekTab(ws.name)) {
      removed.push(ws.name);
      wb.removeWorksheet(ws.id);
    }
  }
  const removedTokens = deletedRefTokens(removed);
  freezeUnstableFormulas(wb, removedTokens);
  dropDeadDefinedNames(wb, removedTokens, "TYLin");
  stripBrokenDefinedNames(wb);

  // -- 6. Generate fresh weekly timesheet tabs (one per week per contributor).
  const weeks = [...ctx.weeks].sort((a, b) => a.sortOrder - b.sortOrder);
  const people = contributors(ctx).sort((a, b) => inRosterOrder(a.name, b.name));
  const persons =
    people.length > 0 ? people : [{ key: "name:", name: "", classification: "" }];
  const usedNames = new Set<string>(wb.worksheets.map((w) => w.name.toLowerCase()));
  const timesheetTabs: string[] = [];
  // One person's weeks together, then the next person's — "Please group
  // timesheets by person" — in her order of people. They used to run week by
  // week, every person's first week before anyone's second.
  for (const person of persons) {
    weeks.forEach((week, i) => {
      const label = person.name
        ? `${firstNameOf(person.name)} Week ${i + 1}`
        : sheetSafe(week.label, `Week ${i + 1}`);
      const name = uniqueName(sheetSafe(label, `Week ${i + 1}`), usedNames);
      // A person with no hours in a week gets no timesheet. Package weeks can
      // straddle the billing period (the 10014 package ran six Sat-Fri weeks
      // against an 8/1-8/31 period), and a blank sheet of zeroes for a week
      // someone did not work is a page of noise in the client's PDF.
      const hasHours = ctx.entries.some(
        (x) => x.weekId === week.id && contributorKey(x) === person.key && entryHours(x) > 0,
      );
      if (!hasHours) return;
      const ws = wb.addWorksheet(name);
      const cloned = JSON.parse(JSON.stringify(pristineWeek));
      reviveModelDates(cloned);
      cloned.id = ws.id;
      cloned.name = name;
      ws.model = cloned;
      ws.name = name;
      ws.state = "visible";
      fillTimesheet(ws, week, ctx, person);
      // The template's timesheets carry Ryan Harper's signature; only that
      // person's own timesheet may keep it.
      const signed = settleTimesheetSignature(ws, person.name, TEMPLATE_SIGNER, ctx.employeeSignatures);
      // Nobody's picture to use: sign the way her workbook signs for the
      // people it has no picture of, with the name in a script face under
      // "Submitted by". (Upload a signature on the Signatures page to replace it.)
      if (signed === "none" && person.name) {
        setVal(ws, "E17", person.name);
        ws.getCell("E17").font = { name: "Courgette", size: 18, italic: true };
        ws.getCell("E17").alignment = { horizontal: "left", vertical: "middle" };
        ws.getRow(17).height = 24;
      }
      timesheetTabs.push(name);
    });
  }

  // -- 7. Finalize: freeze straggler shared formulas (Google-Sheets export
  // artifact) so the workbook writes cleanly, scrub internal marks, recalc on
  // load, Invoice active tab.
  freezeSharedFormulas(wb);
  scrubInternalMarks(wb);
  wb.calcProperties.fullCalcOnLoad = true;
  const inv = wb.worksheets.findIndex((w) => w.name === INVOICE_SHEET);
  if (inv >= 0) wb.views = [{ activeTab: inv } as ExcelJS.WorkbookView];

  fitSheetsToOnePage(wb);
  return { wb, timesheetTabs, financials: fin };
}

/** The day before a YYYY-MM-DD date: the last day of the previous period. */
function priorDay(date: string): string {
  const d = toDate(date);
  d.setDate(d.getDate() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function homeHours(fin: TylinFinancials): number {
  return fin.laborRows.filter((r) => r.location === "home").reduce((s, r) => s + r.hours, 0);
}
function fieldHours(fin: TylinFinancials): number {
  return fin.laborRows.filter((r) => r.location === "field").reduce((s, r) => s + r.hours, 0);
}
function otHours(ctx: PackageDocContext): number {
  return ctx.entries.filter((e) => e.category === "ot").reduce((s, e) => s + entryHours(e), 0);
}
function dtHours(ctx: PackageDocContext): number {
  return ctx.entries.filter((e) => e.category === "dt").reduce((s, e) => s + entryHours(e), 0);
}

function safeSlug(ctx: PackageDocContext): string {
  const num = ctx.pkg.invoiceNumber || `PKG-${ctx.pkg.id}`;
  return num.replace(/[^A-Za-z0-9._-]/g, "_");
}

/** Writes the client-ready TYlin Excel workbook (Invoice as the first tab). */
export async function generateTylinWorkbookFile(ctx: PackageDocContext): Promise<string> {
  ensureDirs();
  const { wb } = await buildTylinWorkbook(ctx);
  const outPath = path.resolve(generatedDir, `InvoicePackage_${safeSlug(ctx)}_${Date.now()}.xlsx`);
  await wb.xlsx.writeFile(outPath);
  return outPath;
}

/**
 * Writes the workbook variant used for PDF rendering. The TYlin deliverable
 * carries only client pages after cleanup (hidden per-employee progress reports
 * are skipped by LibreOffice), so this is the same workbook; the tab order is
 * Invoice → Sub1 Inv → Sub1 Labor → ODCs → Progress Reports → timesheets.
 */
export async function generateTylinPdfSource(ctx: PackageDocContext): Promise<string> {
  ensureDirs();
  const { wb } = await buildTylinWorkbook(ctx);
  const outPath = path.resolve(
    generatedDir,
    `InvoicePackagePdfSrc_${safeSlug(ctx)}_${Date.now()}.xlsx`,
  );
  await wb.xlsx.writeFile(outPath);
  return outPath;
}
