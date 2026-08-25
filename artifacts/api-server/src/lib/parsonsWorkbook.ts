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
 * Parsons-format invoice export engine (reference-workbook approach).
 *
 * The template (`parsons-invoice-template.xlsm`) is Julie's real Parsons/BART
 * invoice workbook (Hashmatullah Ahmadzai, Agreement 6M8146, Work Plan B.55,
 * Procas project 10009.03, invoice AZAD-11 / "B.55-11"). As with the WSP and
 * T.Y. Lin engines this loads that workbook and mutates it in place, writing
 * backend-computed VALUES (never formulas) into the reference cells so the
 * client file is authoritative even in a viewer that does not recalculate.
 *
 * Sheet map (differs from WSP/TYlin):
 *  - `Invoice` (face): invoice no L5, date L7, PO L9, agreement E18, work-plan
 *    code E19, period G23, terms L24, billed line L27, TOTAL AMOUNT DUE L29, and
 *    the billing summary J33-J36.
 *  - `Invoice Calc` (build-up): the invoice detail attachment. It carries the
 *    contract's TWO reconciliation PO-line copies (Line 1.1 / 15NL005 at rows
 *    14-52 and Line 1.2 / 54RR510 at rows 54-92, a +40 row mirror). Each block's
 *    "Total Amount Due" this-period cell (H52 / H92) is the authoritative
 *    "total this period" — the analog of WSP's `Sub Calc _revised!H51` and
 *    TYlin's `Sub1 Inv!H42`. `Invoice Calc!H52` is mirrored to Invoice L27/L29.
 *    On the AZAD-11 sample it is 13,341.15.
 *  - `Labor_` (labor attachment): field labor hours/rate/amount.
 *  - `Progress Report-Hash` (per employee): header refreshed; narrative left as
 *    authored unless the package supplies one.
 *  - Weekly timesheet tabs `<name> Week N`: 7 day columns H..N starting SATURDAY
 *    (H=Sat … N=Fri), rows straight/OT/DT/PTO/holiday, weekly totals in col O.
 *
 * The billing math follows the definitive V1 BART model, with the PARSONS
 * rounding convention read straight off the sample's `Invoice Calc` formulas —
 * every indirect layer is ROUNDED per line (unlike WSP/TYlin, which keep fringe
 * and fee at full precision):
 *   Direct labor (straight+OT+DT hours × base rate)
 *     → + fringe        = ROUND(labor × fringeRate, 2)   // "Fringe Benefits on Labor" (0 for this contract)
 *     → + overhead pool = ROUND(labor × overheadRate, 2) // "H&B Overhead Pool on Labor" (D24 = 1.2058 = 120.58%)
 *     → + fixed fee     = ROUND((labor + fringe + overhead) × feeRate, 2)   // E45 = 0.08
 *     → + FCCM          = ROUND(labor × fccmRate, 2)      // D51 = 0.0039 (always 0.39%, on direct labor)
 *     → + OT/DT premium = ROUND(0.5×base×OT + 1.0×base×DT, 2)  // UNBURDENED, added after (0 for this sample)
 *   Total This Period   = ROUND(labor + fringe + overhead + fee + FCCM + premium + ODCs, 2)
 *
 * IMPORTANT: the Parsons contract's single indirect layer is the "H&B Overhead
 * Pool" (`overheadRate`, 120.58% on the sample); the "Fringe Benefits" row is a
 * distinct layer that is 0 here. This mirrors `packageMappers.buildPackageRollup`
 * (which burdens off `overheadRate`), so the export and the on-screen rollup
 * agree to the cent.
 *
 * Internal sheets (the hidden `master file` header feed, the alternate
 * `Invoice_1`, the corrupt `Invoice Calc Summary` / `Invoice Calc (2)`
 * combiners, the legacy `Labor`, `MISC`, ` Progress XXX-OLD`, the unused
 * `Progress Report-Jordy`, and the template's own week tabs) are removed; any
 * straggler formula that still referenced them (or a `#REF!`, `#NAME!`,
 * `DUMMYFUNCTION`, `_xlfn.SINGLE` Google-Sheets/implicit-intersection artifact)
 * is frozen to its cached value so the client file never opens with an error or
 * a "repair" prompt.
 */

const TEMPLATE_FILE = "parsons-invoice-template.xlsm";

const INVOICE_SHEET = "Invoice";
const CALC_SHEET = "Invoice Calc";
const LABOR_SHEET = "Labor_";

/** The pristine weekly-timesheet layout cloned for each generated tab. */
const PRISTINE_WEEK_SHEET = "Hash Week 1";

/**
 * Sheets that must never ship to the client (removed from the workbook). The
 * per-employee progress report(s) are kept; the template's own weekly timesheet
 * tabs are removed dynamically (see `isTemplateWeekTab`) and regenerated.
 */
const INTERNAL_SHEETS = [
  "master file",
  "Invoice_1",
  "Invoice Calc Summary",
  "Invoice Calc (2)",
  "Labor",
  "MISC",
  " Progress XXX-OLD",
  "Progress Report-Jordy",
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

/** Formats a Date as "MM/DD/YYYY" (e.g. 08/01/2026), matching the sample header. */
function formatMDY(date: Date): string {
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${m}/${d}/${date.getFullYear()}`;
}

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
 * Detects whether a package bills through Parsons as its prime. Free-text
 * `prime` ("Parsons", "Parsons Transport Group, Inc") is matched
 * case-insensitively on the "parsons" token.
 */
export function isParsonsPrime(pkg: Pick<PackageRow, "prime">): boolean {
  return /parsons/i.test(pkg.prime ?? "");
}

// ---------------------------------------------------------------------------
// Financials
// ---------------------------------------------------------------------------

interface ParsonsLaborRow {
  key: string;
  employeeName: string;
  classification: string;
  location: "home" | "field";
  rate: number;
  hours: number; // billable hours (regular + night + OT + DT), billed at base
  amount: number; // round2(hours × rate) — direct labor at base rate
}

export interface ParsonsFinancials {
  laborRows: ParsonsLaborRow[];
  homeDirectLabor: number; // round2(Σ home line amounts)
  fieldDirectLabor: number; // round2(Σ field line amounts)
  laborTotal: number; // round2(Σ billable hours × rate) — combined direct labor
  fringeTotal: number; // round2(labor × fringeFrac) — "Fringe Benefits" (0 here)
  overheadTotal: number; // round2(labor × overheadFrac) — "H&B Overhead Pool"
  fixedFee: number; // round2((labor + fringe + overhead) × feeFrac)
  fccm: number; // round2(labor × fccmFrac)
  otPremium: number; // round2(Σ 0.5 × base × OT hours) — unburdened
  dtPremium: number; // round2(Σ 1.0 × base × DT hours) — unburdened
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
 * Computes the Parsons burden chain from the package's timesheet entries.
 *
 * Every indirect layer is ROUNDED per line, exactly as the sample's
 * `Invoice Calc` formulas do (`ROUND($D$24*H22,2)` overhead, `ROUND(H30*0.08,2)`
 * fee, `ROUND(H22*0.0039,2)` FCCM), and the headline is rounded once. This
 * ordering is what makes the AZAD-11 sample's headline land exactly on
 * 13,341.15, and it matches `packageMappers.buildPackageRollup` to the cent.
 *
 * The combined direct-labor total (not a per-location split) drives every
 * burden, so the result never disagrees with the on-screen rollup by a rounding
 * cent. Per-location direct labor is tracked only for the sheet layout.
 */
export function computeParsonsFinancials(ctx: PackageDocContext): ParsonsFinancials {
  const wp = ctx.workPlan;
  const fringeFrac = (wp.fringeRate ?? 0) / 100;
  const overheadFrac = (wp.overheadRate ?? 0) / 100;
  const feeFrac = (wp.fixedFeeRate ?? 0) / 100;
  const fccmFrac = (wp.fccmRate ?? 0) / 100;

  // One labor row per (employee, location, rate). All billable hours
  // (straight + night + OT + DT) bill at the base rate; the OT/DT *premium* is
  // computed separately below and added unburdened.
  const rowMap = new Map<string, ParsonsLaborRow>();
  let straightLabor = 0;
  let otPremiumRaw = 0;
  let dtPremiumRaw = 0;
  for (const e of ctx.entries) {
    const hrs = round2(entryHours(e));
    if (hrs <= 0) continue;
    if (!isBillable(e.category)) continue;
    const location: "home" | "field" = e.location === "field" ? "field" : "home";
    straightLabor += hrs * e.rate;
    if (e.category === "ot") otPremiumRaw += 0.5 * hrs * e.rate;
    else if (e.category === "dt") dtPremiumRaw += 1.0 * hrs * e.rate;
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
      } as ParsonsLaborRow);
    row.hours = round2(row.hours + hrs);
    rowMap.set(key, row);
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

  const homeDirectLabor = round2(
    laborRows.filter((r) => r.location === "home").reduce((s, r) => s + r.amount, 0),
  );
  const fieldDirectLabor = round2(
    laborRows.filter((r) => r.location === "field").reduce((s, r) => s + r.amount, 0),
  );

  // Combined direct labor drives every indirect layer (matches buildPackageRollup).
  const laborTotal = round2(straightLabor);
  const fringeTotal = round2(laborTotal * fringeFrac);
  const overheadTotal = round2(laborTotal * overheadFrac);
  const fixedFee = round2((laborTotal + fringeTotal + overheadTotal) * feeFrac);
  const fccm = round2(laborTotal * fccmFrac);
  const otPremium = round2(otPremiumRaw);
  const dtPremium = round2(dtPremiumRaw);
  const otherDirectCosts = round2(ctx.pkg.otherDirectCosts ?? 0);

  const totalThisPeriod = round2(
    laborTotal +
      fringeTotal +
      overheadTotal +
      fixedFee +
      fccm +
      otPremium +
      dtPremium +
      otherDirectCosts,
  );

  const totalHours = round2(
    ctx.entries.filter((e) => isBillable(e.category)).reduce((s, e) => s + entryHours(e), 0),
  );
  const previouslyBilled = round2(ctx.pkg.previouslyBilled ?? 0);
  const totalToDate = round2(totalThisPeriod + previouslyBilled);
  const budget = wp.totalBudget ?? 0;
  const hasBudget = budget > 0;
  const remainingBalance = hasBudget ? round2(budget - totalToDate) : 0;
  const percentExpended = hasBudget ? totalToDate / budget : 0;

  return {
    laborRows,
    homeDirectLabor,
    fieldDirectLabor,
    laborTotal,
    fringeTotal,
    overheadTotal,
    fixedFee,
    fccm,
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
 * (b) uses an unsupported/unstable token (`#REF!`, `#NAME?`, `DUMMYFUNCTION`,
 * `_xleta`/`_xlfn.LAMBDA`, `_xlfn.SINGLE` implicit-intersection) with its cached
 * result value, so the client workbook never surfaces an error. The meaningful
 * cross-sheet cells were already overwritten with authoritative values before
 * this runs, so anything caught here is incidental.
 */
function freezeUnstableFormulas(wb: ExcelJS.Workbook, removedTokens: string[]): void {
  const isUnstable = (formula: string): boolean => {
    if (removedTokens.some((t) => formula.includes(t))) return true;
    return /DUMMYFUNCTION|_xleta|_xlfn\.LAMBDA|_xlfn\.SINGLE|#REF!|#NAME\?/i.test(formula);
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
              result === undefined || result === null || (typeof result === "object" && "error" in result)
                ? null
                : (result as ExcelJS.CellValue);
            cell.style = style;
          }
        }
      });
    });
  }
}

/**
 * Converts every shared-formula cell (both the `shareType:"shared"` master and
 * its `sharedFormula` children) and every array-formula cell to its cached
 * result value. The Parsons template originated as a Google-Sheets export whose
 * shared/array-formula groups span cells we clear/overwrite; leaving a dangling
 * shared child makes ExcelJS throw "Shared Formula master must exist above and
 * or left of clone" on write. Since the authoritative figures are already
 * written as values, freezing these has no effect on the client-visible numbers.
 */
function freezeSharedFormulas(wb: ExcelJS.Workbook): void {
  for (const ws of wb.worksheets) {
    ws.eachRow({ includeEmpty: false }, (row) => {
      row.eachCell({ includeEmpty: false }, (cell) => {
        const v = cell.value as
          | { formula?: string; sharedFormula?: string; shareType?: string; result?: unknown }
          | null;
        if (
          v &&
          typeof v === "object" &&
          ("sharedFormula" in v || v.shareType === "shared" || v.shareType === "array")
        ) {
          const style = cell.style;
          const result = v.result;
          cell.value =
            result === undefined || result === null || (typeof result === "object" && "error" in result)
              ? null
              : (result as ExcelJS.CellValue);
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
 * workbook (`[1]…`/`[2]…`). The Parsons template carries several (FEEBAL,
 * INVOICE, TotalToDate, plus a batch of `#REF!` leftovers) that would otherwise
 * trigger Excel's repair prompt once their target sheets are gone.
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
    logger.warn({ err }, "Failed to drop dead defined names from Parsons workbook");
  }
}

// ---------------------------------------------------------------------------
// Contributors
// ---------------------------------------------------------------------------

interface ParsonsContributor {
  key: string;
  name: string;
  classification: string;
}

function contributors(ctx: PackageDocContext): ParsonsContributor[] {
  const seen = new Map<string, ParsonsContributor>();
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

/** Category → generated-timesheet row (uniform Parsons layout, cloned per week). */
function timesheetRow(category: string): number {
  switch (category) {
    case "ot":
      return 10;
    case "dt":
      return 11;
    case "pto":
      return 13;
    case "holiday":
      return 14;
    default:
      return 9; // regular / night → straight time
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
 * Saturday (H) → Friday (N); H7 is the week's Saturday, and every hour cell and
 * total is written as a value (the tab carries no live cross-sheet formulas).
 */
function fillTimesheet(
  ws: ExcelJS.Worksheet,
  week: PackageWeekRow,
  ctx: PackageDocContext,
  person: ParsonsContributor,
): void {
  const wp = ctx.workPlan;
  const contractLabel = `${wp.agreementNo ?? wp.jobNumber ?? ""}-${wp.code}`.replace(/^-|-$/g, "").trim();
  const saturday = saturdayOnOrBefore(toDate(week.weekStart));

  setVal(ws, "D6", person.name);
  // Day header dates: H=Sat, I=Sun, J=Mon, K=Tue, L=Wed, M=Thu, N=Fri.
  DAY_COLS.forEach((col, i) => setVal(ws, `${col}7`, addDays(saturday, i)));
  setVal(ws, "J6", addDays(saturday, 6)); // "Week Ending" = Friday
  setVal(ws, "C21", person.name); // submitted-by signer name

  // Clear the sample data region (labels + all day/total cells, rows 9-15).
  for (let r = 9; r <= 15; r++) {
    for (const col of ["B", "D", ...DAY_COLS, "O"]) clearCell(ws, `${col}${r}`);
  }

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
    9: person.classification || "Straight Time",
    10: `${person.classification} - Overtime`,
    11: `${person.classification} - Doubletime`,
    13: "PTO (Sick/Vacation)",
    14: "Holiday",
  };

  const colTotals: Record<string, number> = { H: 0, I: 0, J: 0, K: 0, L: 0, M: 0, N: 0 };
  let grandTotal = 0;
  for (const r of [9, 10, 11, 13, 14]) {
    const a = acc.get(r);
    if (r <= 11) setVal(ws, `B${r}`, contractLabel);
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

  // TOTAL HOURS row (16): column sums + grand total.
  for (const col of DAY_COLS) setVal(ws, `${col}16`, round2(colTotals[col]));
  setVal(ws, "O16", round2(grandTotal));
}

// ---------------------------------------------------------------------------
// Build-up (Invoice Calc) writer
// ---------------------------------------------------------------------------

/**
 * Writes one PO-line build-up block on `Invoice Calc`. Line 1.1 lives at the
 * base rows (offset 0); Line 1.2 is a +40-row mirror. Both are written with the
 * same authoritative values (they are reconciliation duplicates of the same
 * billed work), so the sheet's own reconciliation stays at 0. Every cell is a
 * value, never a formula.
 */
function writeCalcBlock(ws: ExcelJS.Worksheet, fin: ParsonsFinancials, offset: number): void {
  const r = (row: number) => row + offset;
  const totalLabor = round2(fin.laborTotal + fin.fringeTotal + fin.overheadTotal);
  // Home & Branch (H&B) labor block (rows 17 labor / 18 fringe / 19 OH / 20 FCCM).
  setVal(ws, `H${r(17)}`, fin.homeDirectLabor);
  setVal(ws, `H${r(18)}`, 0);
  setVal(ws, `H${r(19)}`, 0);
  setVal(ws, `H${r(20)}`, 0);
  // Field labor block (rows 22 labor / 23 fringe / 24 OH pool).
  setVal(ws, `H${r(22)}`, fin.fieldDirectLabor);
  setVal(ws, `H${r(23)}`, fin.fringeTotal);
  setVal(ws, `D${r(24)}`, fin.overheadFrac); // "H&B Overhead Pool" multiplier (e.g. 1.2058)
  setVal(ws, `H${r(24)}`, fin.overheadTotal);
  // Field subtotal (row 26) and Total Labor (row 30).
  setVal(ws, `H${r(26)}`, totalLabor);
  setVal(ws, `H${r(30)}`, totalLabor);
  // Fixed Fee (row 45), Total Fixed Fee (row 49).
  setVal(ws, `E${r(45)}`, fin.feeFrac);
  setVal(ws, `H${r(45)}`, fin.fixedFee);
  setVal(ws, `H${r(49)}`, fin.fixedFee);
  // FCCM (row 51).
  setVal(ws, `D${r(51)}`, fin.fccmFrac);
  setVal(ws, `H${r(51)}`, fin.fccm);
  // Total Amount Due (row 52) — AUTHORITATIVE "total this period".
  setVal(ws, `H${r(52)}`, fin.totalThisPeriod);
  // Budget / previously billed / to-date (row 52 columns G/I/J).
  setVal(ws, `G${r(52)}`, fin.budget);
  setVal(ws, `I${r(52)}`, fin.previouslyBilled);
  setVal(ws, `J${r(52)}`, fin.totalToDate);
}

// ---------------------------------------------------------------------------
// Labor attachment (Labor_) writer
// ---------------------------------------------------------------------------

/** Writes the field-labor lines onto the `Labor_` attachment. */
function writeLaborAttachment(ws: ExcelJS.Worksheet, fin: ParsonsFinancials, names: string): void {
  const field = fin.laborRows.filter((r) => r.location === "field");
  const totalFieldHours = round2(field.reduce((s, r) => s + r.hours, 0));
  const uniformRate = field.length > 0 && field.every((r) => r.rate === field[0].rate) ? field[0].rate : 0;

  setVal(ws, "C12", names);
  // Clear the template's Home split rows (they double-count the field hours).
  for (const addr of ["E21", "E23", "C21", "C23"]) clearCell(ws, addr);
  // Field aggregate (row 26): hours / rate / amount as values (was a
  // `='master file'!...` feed — overwrite so no #REF! after removal).
  setVal(ws, "E26", totalFieldHours);
  setVal(ws, "F26", uniformRate);
  setVal(ws, "G26", fin.fieldDirectLabor);
  // Field + total-labor subtotals.
  setVal(ws, "E28", totalFieldHours);
  setVal(ws, "G28", fin.fieldDirectLabor);
  setVal(ws, "E31", round2(fin.homeDirectLabor > 0 ? totalFieldHours : totalFieldHours));
  setVal(ws, "G31", round2(fin.homeDirectLabor + fin.fieldDirectLabor));
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

export interface ParsonsBuildResult {
  wb: ExcelJS.Workbook;
  timesheetTabs: string[];
  financials: ParsonsFinancials;
}

/**
 * Builds the client-ready Parsons workbook from the reference template. Returns
 * the workbook plus the ordered timesheet tab names and computed financials
 * (for verification/tests).
 */
export async function buildParsonsWorkbook(ctx: PackageDocContext): Promise<ParsonsBuildResult> {
  const file = path.resolve(templatesDir, TEMPLATE_FILE);
  if (!fs.existsSync(file)) {
    throw new Error(`Parsons invoice template not found at ${file}`);
  }
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);

  const wp = ctx.workPlan;
  const pkg = ctx.pkg;
  const fin = computeParsonsFinancials(ctx);

  const invoice = wb.getWorksheet(INVOICE_SHEET)!;
  const calc = wb.getWorksheet(CALC_SHEET)!;
  const labor = wb.getWorksheet(LABOR_SHEET)!;

  // Capture a pristine week-tab layout before we drop the template's tabs.
  const pristineWeek = JSON.parse(JSON.stringify(wb.getWorksheet(PRISTINE_WEEK_SHEET)!.model));

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

  const people = contributors(ctx);

  // -- 1. Invoice (face). Every cross-sheet cell is overwritten with a value.
  setVal(invoice, "L5", invoiceNo);
  if (invoiceDate) setVal(invoice, "L7", invoiceDate);
  else clearCell(invoice, "L7");
  setVal(invoice, "L9", wp.poNumber || "N/A");
  setVal(invoice, "E18", wp.agreementNo || "");
  setVal(invoice, "E19", wp.code || "");
  setVal(invoice, "G23", periodStr);
  setVal(invoice, "L24", wp.terms || "");
  setVal(invoice, "C27", wp.code || "");
  setVal(invoice, "L27", totalThisPeriod);
  setVal(invoice, "L29", totalThisPeriod); // TOTAL AMOUNT DUE THIS INVOICE (authoritative face)
  if (wp.sendToCompany) setVal(invoice, "D11", wp.sendToCompany);
  if (wp.sendToAddress1) setVal(invoice, "D12", wp.sendToAddress1);
  if (wp.sendToAddress2) setVal(invoice, "D13", wp.sendToAddress2);
  if (wp.contactPerson) setVal(invoice, "E16", wp.contactPerson);
  // Billing summary (sample keeps this-period / previous as negatives so the
  // running SUM yields the remaining balance).
  setVal(invoice, "J33", budget);
  setVal(invoice, "J34", -totalThisPeriod);
  setVal(invoice, "J35", -previouslyBilled);
  setVal(invoice, "J36", round2(budget - totalToDate));

  // -- 2. Invoice Calc (build-up). Both reconciliation PO-line copies get the
  // same authoritative values; H52 (Line 1.1) is the headline "total this
  // period". Clear the stray N34 = #REF! first.
  clearCell(calc, "N34");
  writeCalcBlock(calc, fin, 0); // Line 1.1 (rows 14-52)
  writeCalcBlock(calc, fin, 40); // Line 1.2 (rows 54-92) — +40 mirror
  if (invoiceDate) setVal(calc, "J10", invoiceDate);
  setVal(calc, "J11", invoiceNo);

  // -- 3. Labor_ (labor attachment).
  const laborNames = people.length > 0
    ? people.map((p) => `${p.name}${p.classification ? `, ${p.classification}` : ""}`).join("; ")
    : "";
  setVal(labor, "C11", `${wp.jobNumber ?? wp.agreementNo ?? ""}-${wp.code}`.replace(/^-|-$/g, ""));
  writeLaborAttachment(labor, fin, laborNames);

  // -- 4. Progress Report(s): refresh the header cells that fed off the removed
  // `master file`, plus the period, and (optionally) the narrative.
  const reportDate = ctx.progress?.reportDate ? toDate(ctx.progress.reportDate) : invoiceDate;
  for (const ws of wb.worksheets) {
    if (!/^Progress Report/i.test(ws.name)) continue;
    if (ws.name === "Progress Report-Jordy") continue; // removed below
    if (reportDate) setVal(ws, "H5", reportDate);
    setVal(ws, "H6", invoiceNo);
    setVal(ws, "H8", wp.agreementNo || "");
    setVal(ws, "D8", wp.code || "");
    setVal(ws, "D9", wp.title || "");
    setVal(ws, "H9", periodStr);
    const narrative = (ctx.progress?.workPerformed || ctx.progress?.summary || "").trim();
    if (narrative) {
      // Clear the template's sample bullet rows (17-48), then write ours.
      for (let rr = 17; rr <= 48; rr++) {
        clearCell(ws, `B${rr}`);
        clearCell(ws, `C${rr}`);
      }
      const lines = narrative
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.length > 0)
        .slice(0, 30);
      let rr = 17;
      for (const line of lines) {
        setVal(ws, `B${rr}`, "•");
        setVal(ws, `C${rr}`, line.replace(/^[-•·*]\s*/, ""));
        rr += 1;
      }
    }
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

  // -- 7. Finalize: freeze straggler shared/array formulas (Google-Sheets export
  // artifact) so the workbook writes cleanly, scrub internal marks, recalc on
  // load, Invoice active tab.
  freezeSharedFormulas(wb);
  scrubInternalMarks(wb);
  wb.calcProperties.fullCalcOnLoad = true;
  const inv = wb.worksheets.findIndex((w) => w.name === INVOICE_SHEET);
  if (inv >= 0) wb.views = [{ activeTab: inv } as ExcelJS.WorkbookView];

  return { wb, timesheetTabs, financials: fin };
}

function safeSlug(ctx: PackageDocContext): string {
  const num = ctx.pkg.invoiceNumber || `PKG-${ctx.pkg.id}`;
  return num.replace(/[^A-Za-z0-9._-]/g, "_");
}

/** Writes the client-ready Parsons Excel workbook (Invoice as the first tab). */
export async function generateParsonsWorkbookFile(ctx: PackageDocContext): Promise<string> {
  ensureDirs();
  const { wb } = await buildParsonsWorkbook(ctx);
  const outPath = path.resolve(generatedDir, `InvoicePackage_${safeSlug(ctx)}_${Date.now()}.xlsx`);
  await wb.xlsx.writeFile(outPath);
  return outPath;
}

/**
 * Writes the workbook variant used for PDF rendering. The Parsons deliverable
 * carries only client pages after cleanup, so this is the same workbook; the tab
 * order is Invoice → Invoice Calc → Labor_ → Progress Report → timesheets.
 */
export async function generateParsonsPdfSource(ctx: PackageDocContext): Promise<string> {
  ensureDirs();
  const { wb } = await buildParsonsWorkbook(ctx);
  const outPath = path.resolve(
    generatedDir,
    `InvoicePackagePdfSrc_${safeSlug(ctx)}_${Date.now()}.xlsx`,
  );
  await wb.xlsx.writeFile(outPath);
  return outPath;
}
