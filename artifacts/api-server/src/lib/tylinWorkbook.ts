import ExcelJS from "exceljs";
import path from "node:path";
import fs from "node:fs";
import { templatesDir, generatedDir, ensureDirs } from "./paths";
import { stripBrokenDefinedNames } from "./excel";
import { contributorKey } from "./packageMappers";
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

const TEMPLATE_FILE = "tylin-invoice-template.xlsm";

const INVOICE_SHEET = "Invoice";
const SUBINV_SHEET = "Sub1 Inv";
const SUBLABOR_SHEET = "Sub1 Labor";

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
  return (cleaned || fallback).slice(0, 31);
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
  hours: number; // billable hours (regular + night + OT + DT), billed at base
  amount: number; // round2(hours × rate) — direct labor at base rate
}

interface TylinLocationTotals {
  directLabor: number; // Σ row amounts (each rounded)
  fringe: number; // directLabor × fringeFrac (UNROUNDED)
  overheadPool: number; // directLabor × overheadFrac (UNROUNDED; 0 here)
  fccm: number; // round2(directLabor × fccmFrac); 0 for TYlin
}

export interface TylinFinancials {
  laborRows: TylinLaborRow[];
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
  const fringeFrac = (wp.fringeRate ?? 0) / 100;
  const overheadFrac = (wp.overheadRate ?? 0) / 100;
  const feeFrac = (wp.fixedFeeRate ?? 0) / 100;
  const fccmFrac = (wp.fccmRate ?? 0) / 100;

  // One labor row per (employee, location, rate). All billable hours
  // (straight + night + OT + DT) bill at the base rate; the OT/DT *premium* is
  // computed separately below and added unburdened.
  const rowMap = new Map<string, TylinLaborRow>();
  let otPremiumRaw = 0;
  let dtPremiumRaw = 0;
  for (const e of ctx.entries) {
    const hrs = entryHours(e);
    if (hrs <= 0) continue;
    const location: "home" | "field" = e.location === "field" ? "field" : "home";
    if (isBillable(e.category)) {
      const key = `${contributorKey(e)}|${location}|${e.rate}`;
      const row =
        rowMap.get(key) ??
        ({
          key,
          employeeName: e.employeeName,
          classification: e.classification,
          location,
          rate: e.rate,
          hours: 0,
          amount: 0,
        } as TylinLaborRow);
      row.hours = round2(row.hours + hrs);
      rowMap.set(key, row);
      if (e.category === "ot") otPremiumRaw += 0.5 * hrs * e.rate;
      else if (e.category === "dt") dtPremiumRaw += 1.0 * hrs * e.rate;
    }
  }
  const laborRows = [...rowMap.values()].map((r) => ({
    ...r,
    amount: round2(r.hours * r.rate),
  }));
  laborRows.sort(
    (a, b) =>
      (a.location === b.location ? 0 : a.location === "home" ? -1 : 1) ||
      a.employeeName.localeCompare(b.employeeName) ||
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

  return {
    laborRows,
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

function removeSheet(wb: ExcelJS.Workbook, name: string): void {
  const ws = wb.getWorksheet(name);
  if (ws) wb.removeWorksheet(ws.id);
}

/** `'<name>'!` and `<name>!` reference tokens for the given removed sheets. */
function deletedRefTokens(removed: string[]): string[] {
  const tokens: string[] = [];
  for (const name of removed) {
    tokens.push(`'${name}'!`);
    tokens.push(`${name}!`);
  }
  return tokens;
}

/**
 * Replaces every remaining formula cell that (a) references a removed sheet or
 * (b) uses an unsupported Google-Sheets import function (`DUMMYFUNCTION`,
 * `_xleta`/`_xlfn.LAMBDA`) with its cached result value, so the client workbook
 * never surfaces #REF! or #NAME!. The meaningful cross-sheet cells were already
 * overwritten with authoritative values before this runs, so anything caught
 * here is incidental.
 */
function freezeUnstableFormulas(wb: ExcelJS.Workbook, removedTokens: string[]): void {
  const isUnstable = (formula: string): boolean => {
    if (removedTokens.some((t) => formula.includes(t))) return true;
    return /DUMMYFUNCTION|_xleta|_xlfn\.LAMBDA|#REF!/i.test(formula);
  };
  for (const ws of wb.worksheets) {
    ws.eachRow({ includeEmpty: false }, (row) => {
      row.eachCell({ includeEmpty: false }, (cell) => {
        const v = cell.value;
        if (v && typeof v === "object" && "formula" in v && typeof v.formula === "string") {
          if (isUnstable(v.formula)) {
            const style = cell.style;
            const result = (v as ExcelJS.CellFormulaValue).result;
            cell.value =
              result === undefined || result === null ? null : (result as ExcelJS.CellValue);
            cell.style = style;
          }
        }
      });
    });
  }
}

/**
 * Converts every shared-formula cell (both the `shareType:"shared"` master and
 * its `sharedFormula` children) to its cached result value. The TYlin template
 * originated as a Google-Sheets export whose shared-formula groups span cells we
 * clear/overwrite; leaving a dangling shared child makes ExcelJS throw
 * "Shared Formula master must exist above and or left of clone" on write. Since
 * the authoritative figures are already written as values, freezing these has no
 * effect on the client-visible numbers.
 */
function freezeSharedFormulas(wb: ExcelJS.Workbook): void {
  for (const ws of wb.worksheets) {
    ws.eachRow({ includeEmpty: false }, (row) => {
      row.eachCell({ includeEmpty: false }, (cell) => {
        const v = cell.value as
          | { formula?: string; sharedFormula?: string; shareType?: string; result?: unknown }
          | null;
        if (v && typeof v === "object" && ("sharedFormula" in v || v.shareType === "shared")) {
          const style = cell.style;
          const result = v.result;
          cell.value =
            result === undefined || result === null ? null : (result as ExcelJS.CellValue);
          cell.style = style;
        }
      });
    });
  }
}

/** Fill colors that mark internal notes/highlights and must never ship. */
const HIGHLIGHT_ARGB = /^(FF)?(FFFF00|FFFF33|FFFF66|FFFF99|FFFFCC|FFF2CC|FFE699|FFEB9C|FFFFE0)$/i;

/**
 * Removes cell comments and yellow "internal note / input" highlight fills that
 * Julie's working template carries, so the client workbook ships clean.
 */
function scrubInternalMarks(wb: ExcelJS.Workbook): void {
  for (const ws of wb.worksheets) {
    ws.eachRow({ includeEmpty: false }, (row) => {
      row.eachCell({ includeEmpty: false }, (cell) => {
        // `cell.model` is rebuilt on each access, so mutate the backing field.
        const backing = cell as unknown as { _comment?: unknown };
        if (backing._comment) backing._comment = undefined;
        const fill = cell.style?.fill as
          | { type?: string; fgColor?: { argb?: string } }
          | undefined;
        if (fill?.fgColor?.argb && HIGHLIGHT_ARGB.test(fill.fgColor.argb)) {
          cell.style = { ...cell.style, fill: { type: "pattern", pattern: "none" } };
        }
      });
    });
  }
}

/**
 * Drops defined names that point at a removed sheet, a `#REF!`, or an external
 * workbook (`[1]…`). The TYlin template carries several (INVOICE, FEEBAL,
 * EDATE, STDATE, TotalToDate) that would otherwise trigger Excel's repair
 * prompt once their target sheets are gone.
 */
function dropDeadDefinedNames(wb: ExcelJS.Workbook, removedTokens: string[]): void {
  const isDead = (range: string): boolean =>
    /#REF!/i.test(range) ||
    /\[[^\]]+\]/.test(range) ||
    removedTokens.some((t) => range.includes(t));
  try {
    const kept = wb.definedNames.model.filter((dn) => !dn.ranges.some(isDead));
    if (kept.length !== wb.definedNames.model.length) wb.definedNames.model = kept;
  } catch (err) {
    logger.warn({ err }, "Failed to drop dead defined names from TYlin workbook");
  }
}

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

const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

/** Revives ISO-string dates a JSON deep-clone produced back into Date objects. */
function reviveModelDates(model: {
  rows?: Array<{ cells?: Array<Record<string, unknown>> }>;
}): void {
  for (const row of model.rows ?? []) {
    for (const cell of row.cells ?? []) {
      if (!cell) continue;
      if (typeof cell.value === "string" && ISO_DATE.test(cell.value)) cell.value = new Date(cell.value);
      if (typeof cell.result === "string" && ISO_DATE.test(cell.result as string)) {
        cell.result = new Date(cell.result as string);
      }
    }
  }
}

const DAY_COLS = ["H", "I", "J", "K", "L", "M", "N"] as const; // Sat … Fri

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
  // Day header dates: H=Sat, I=Sun, J=Mon, K=Tue, L=Wed, M=Thu, N=Fri.
  DAY_COLS.forEach((col, i) => setVal(ws, `${col}6`, addDays(saturday, i)));
  setVal(ws, "J5", addDays(saturday, 6)); // "Week Ending" = Friday

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

export interface TylinBuildResult {
  wb: ExcelJS.Workbook;
  timesheetTabs: string[];
  financials: TylinFinancials;
}

const LABOR_COLS = ["A", "B", "C", "D", "E"] as const;

/** Writes one Sub1 Labor location block (rows start..end) and its subtotal. */
function writeLaborBlock(
  ws: ExcelJS.Worksheet,
  fin: TylinFinancials,
  location: "home" | "field",
  block: { start: number; end: number; hoursSubtotal: string; amountSubtotal: string },
): void {
  for (let r = block.start; r <= block.end; r++) {
    for (const col of LABOR_COLS) clearCell(ws, `${col}${r}`);
  }
  const rows = fin.laborRows.filter((r) => r.location === location);
  const cap = block.end - block.start + 1;
  let hours = 0;
  let amount = 0;
  rows.slice(0, cap).forEach((r, i) => {
    const row = block.start + i;
    const amt = round2(r.hours * r.rate);
    setVal(ws, `A${row}`, r.classification);
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

  // Capture a pristine week-tab layout before we drop the template's tabs.
  const pristineWeek = JSON.parse(
    JSON.stringify(wb.getWorksheet(PRISTINE_WEEK_SHEET)!.model),
  );

  const invoiceNo = pkg.invoiceNumber || wp.code;
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
  setVal(invoice, "E22", wp.agreementNo || "");
  setVal(invoice, "L22", wp.bartProjectNumbers || wp.clientProjectNo || "");
  setVal(invoice, "E23", wp.title || "");
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

  // -- 2. Sub1 Inv (build-up). Leaf cells written as values; the authoritative
  // totals G42/H42/I42/J42 forced so non-recalc viewers are correct.
  setVal(subinv, "K1", invoiceDate ?? "");
  setVal(subinv, "J2", invoiceNo);

  // Home labor block (rows 7 labor / 8 fringe / 9 overhead pool) — 0 for BART.
  setVal(subinv, "D7", round2(homeHours(fin)));
  clearCell(subinv, "E7");
  setVal(subinv, "H7", fin.home.directLabor);
  setVal(subinv, "H8", fin.home.fringe);
  setVal(subinv, "H9", fin.home.overheadPool);
  // Field labor block (rows 11 labor / 12 fringe / 13 overhead pool).
  setVal(subinv, "D11", round2(fieldHours(fin)));
  clearCell(subinv, "E11");
  setVal(subinv, "G11", 0); // per-line budget not tracked (see G42 total)
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
  setVal(subinv, "C29", "OT Premium (0.5 x base rate)");
  setVal(subinv, "F29", otHrs);
  setVal(subinv, "H29", fin.otPremium);
  setVal(subinv, "C30", "DT Premium (1.0 x base rate)");
  setVal(subinv, "F30", dtHrs);
  setVal(subinv, "H30", fin.dtPremium);
  setVal(subinv, "H33", round2(fin.otPremium + fin.dtPremium));
  // Fixed Fee (rows 34-39). E35 = fee fraction; H35 = ROUND(fee).
  setVal(subinv, "E35", fin.feeFrac);
  setVal(subinv, "H35", round2(fin.fixedFee));
  setVal(subinv, "H39", round2(fin.fixedFee));
  // Authoritative totals (values, not formulas).
  setVal(subinv, "G42", budget);
  setVal(subinv, "H42", totalThisPeriod);
  setVal(subinv, "I42", previouslyBilled);
  setVal(subinv, "J42", totalToDate);
  setVal(subinv, "G43", remaining);

  // Previously-billed column I decomposition. We only carry a scalar forward,
  // so unused leaves are zeroed (never left as template constants) and the
  // scalar lands on the field-labor previous row unless the work plan supplies
  // an explicit per-category split (labor / overhead / fixed fee / FCCM).
  for (const r of [7, 8, 9, 11, 12, 13, 16, 17, 18, 23, 24, 25, 29, 30, 35, 38, 40]) {
    clearCell(subinv, `I${r}`);
  }
  const prevSplit =
    wp.prevBilledLabor != null ||
    wp.prevBilledOverhead != null ||
    wp.prevBilledFixedFee != null ||
    wp.prevBilledFccm != null;
  if (prevSplit) {
    setVal(subinv, "I11", round2(wp.prevBilledLabor ?? 0));
    setVal(subinv, "I12", round2(wp.prevBilledOverhead ?? 0));
    setVal(subinv, "I35", round2(wp.prevBilledFixedFee ?? 0));
  } else if (previouslyBilled !== 0) {
    setVal(subinv, "I11", previouslyBilled);
  }

  // -- 3. Sub1 Labor (per-employee lines). Clear both blocks, then write rows.
  setVal(sublabor, "E1", invoiceDate ?? "");
  setVal(sublabor, "E2", invoiceNo);
  writeLaborBlock(sublabor, fin, "home", {
    start: 6,
    end: 12,
    hoursSubtotal: "C13",
    amountSubtotal: "E13",
  });
  writeLaborBlock(sublabor, fin, "field", {
    start: 16,
    end: 34,
    hoursSubtotal: "C35",
    amountSubtotal: "E35",
  });
  // TOTAL LABOR (row 38).
  const totalLaborHours = round2(fin.laborRows.reduce((s, r) => s + r.hours, 0));
  const totalLaborAmount = round2(fin.home.directLabor + fin.field.directLabor);
  setVal(sublabor, "C38", totalLaborHours);
  setVal(sublabor, "E38", totalLaborAmount);

  // -- 4. Progress Reports: refresh the header of each retained report so the
  // period/date/work-plan no longer point at the removed `master file` feed.
  const reportDate = ctx.progress?.reportDate ? toDate(ctx.progress.reportDate) : invoiceDate;
  for (const ws of wb.worksheets) {
    if (!/^Progress Report/i.test(ws.name)) continue;
    setVal(ws, "C4", MONTH_NAMES[periodStart.getMonth()]);
    setVal(ws, "E4", periodStart.getFullYear());
    setVal(ws, "B6", wp.code || "");
    if (reportDate) setVal(ws, "F6", reportDate);
    setVal(ws, "F7", periodStr);
    setVal(ws, "B7", wp.title || ws.getCell("B7").value);
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
  dropDeadDefinedNames(wb, removedTokens);
  stripBrokenDefinedNames(wb);

  // -- 6. Generate fresh weekly timesheet tabs (one per week per contributor).
  const weeks = [...ctx.weeks].sort((a, b) => a.sortOrder - b.sortOrder);
  const people = contributors(ctx);
  const persons =
    people.length > 0 ? people : [{ key: "name:", name: "", classification: "" }];
  const usedNames = new Set<string>(wb.worksheets.map((w) => w.name.toLowerCase()));
  const timesheetTabs: string[] = [];
  weeks.forEach((week, i) => {
    for (const person of persons) {
      const label = person.name
        ? `${firstNameOf(person.name)} Week ${i + 1}`
        : sheetSafe(week.label, `Week ${i + 1}`);
      const name = uniqueName(sheetSafe(label, `Week ${i + 1}`), usedNames);
      const ws = wb.addWorksheet(name);
      const cloned = JSON.parse(JSON.stringify(pristineWeek));
      reviveModelDates(cloned);
      cloned.id = ws.id;
      cloned.name = name;
      ws.model = cloned;
      ws.name = name;
      ws.state = "visible";
      fillTimesheet(ws, week, ctx, person);
      timesheetTabs.push(name);
    }
  });

  // -- 7. Finalize: freeze straggler shared formulas (Google-Sheets export
  // artifact) so the workbook writes cleanly, scrub internal marks, recalc on
  // load, Invoice active tab.
  freezeSharedFormulas(wb);
  scrubInternalMarks(wb);
  wb.calcProperties.fullCalcOnLoad = true;
  const inv = wb.worksheets.findIndex((w) => w.name === INVOICE_SHEET);
  if (inv >= 0) wb.views = [{ activeTab: inv } as ExcelJS.WorkbookView];

  return { wb, timesheetTabs, financials: fin };
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
