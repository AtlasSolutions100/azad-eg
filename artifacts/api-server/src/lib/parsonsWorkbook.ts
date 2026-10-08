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
  formatHoursUniformly,
  setNumberFormat,
  MONEY_FORMAT,
} from "./excel";
import { agreementLine } from "./knownInvoiceHeaders";
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
 *  - `Invoice Calc` (build-up): the invoice detail attachment, rows 14-52. Its
 *    "Total Amount Due" this-period cell (H52) is the authoritative "total this
 *    period" — the analog of WSP's `Sub Calc _revised!H51` and TYlin's
 *    `Sub1 Inv!H42` — and is mirrored to Invoice L27/L29. On the AZAD-11 sample
 *    it is 13,341.15. The template carries the reference contract's SECOND
 *    PO-line copy below it (Line 1.2 / 54RR510, rows 54-92, a +40 row mirror);
 *    we cannot split a package across PO lines, so that block is cleared and
 *    hidden rather than filled with a duplicate of the same totals.
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

/** Whose signature the template's timesheet tabs carry. */
const TEMPLATE_SIGNER = "Hashmatullah Ahmadzai";

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

/** Day columns on a generated timesheet tab: H=Sat, I=Sun … N=Fri. */
const DAY_COLS = ["H", "I", "J", "K", "L", "M", "N"] as const;

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
  // Hers reads "6M8146-B.40-01 20LK001" — the BART project after the work
  // plan — when the invoice is for one project.
  const contractLabel = [
    `${wp.agreementNo ?? wp.jobNumber ?? ""}-${wp.code}`.replace(/^-|-$/g, "").trim(),
    ctx.bartProject ?? "",
  ]
    .filter(Boolean)
    .join(" ");
  const saturday = saturdayOnOrBefore(toDate(week.weekStart));

  setVal(ws, "D6", person.name);
  // Day header dates: H=Sat, I=Sun, J=Mon, K=Tue, L=Wed, M=Thu, N=Fri.
  DAY_COLS.forEach((col, i) => setVal(ws, `${col}7`, addDays(saturday, i)));
  // "Week Ending" = Friday. The template's long date format does not fit the
  // narrow day column, so the printed timesheet read "Week Ending: ###" — the
  // same symptom Julie reported on the T.Y. Lin timesheets.
  setVal(ws, "J6", addDays(saturday, 6));
  ws.getCell("J6").numFmt = "m/d/yyyy";
  const weekEndingCol = ws.getColumn("J");
  weekEndingCol.width = Math.max(weekEndingCol.width ?? 0, 11);
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
    if (r <= 11) {
      setVal(ws, `B${r}`, contractLabel);
      // With a BART project on the end the label outgrows its cell.
      const label = ws.getCell(`B${r}`);
      label.alignment = { ...label.alignment, wrapText: false, shrinkToFit: true };
    }
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
    // Rows 9-11 are HIDDEN in the reference timesheet — that invoice kept its
    // hours on row 12 and tucked the three contract lines above it away. We
    // write straight time, overtime and doubletime onto exactly those three,
    // so every Parsons timesheet printed its totals with the hours row
    // invisible, and the reference's own highlighted row blank in its place.
    // Straight time always shows; the premium rows show when they carry hours.
    if (r <= 11) ws.getRow(r).hidden = r === 9 ? false : rowTotal <= 0;
  }
  // Row 12 was the reference invoice's labor line (highlighted, with weekend
  // cells shaded in a theme colour the PDF renderer paints black). Nothing is
  // written to it, so it is hidden rather than printed as an empty bar.
  ws.getRow(12).hidden = true;

  // TOTAL HOURS row (16): column sums + grand total.
  for (const col of DAY_COLS) setVal(ws, `${col}16`, round2(colTotals[col]));
  setVal(ws, "O16", round2(grandTotal));
  // One number of decimals for every hours figure on the sheet (see
  // formatHoursUniformly): whole hours print with none.
  const hourCells: string[] = [];
  for (let r = 9; r <= 16; r++) for (const col of [...DAY_COLS, "O"]) hourCells.push(`${col}${r}`);
  formatHoursUniformly(ws, hourCells);
}

// ---------------------------------------------------------------------------
// Build-up (Invoice Calc) writer
// ---------------------------------------------------------------------------

/** Columns the `Labor_` attachment form occupies (B..H). */
const LABOR_COLS = ["B", "C", "D", "E", "F", "G", "H"] as const;

/** Columns the `Invoice Calc` form occupies (A..K). */
const CALC_COLS = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K"] as const;

/** `Invoice Calc` columns right of the form (L..V) — reference scratch. */
const CALC_SCRATCH_COLS = [
  "L", "M", "N", "O", "P", "Q", "R", "S", "T", "U", "V",
] as const;

/**
 * `Invoice Calc` subtotal rows within one block, as `[row, firstRow, lastRow]`
 * offsets from the block's base. These were `SUBTOTAL(9, …)` bands, which
 * ExcelJS emits without evaluating.
 */
const CALC_SUBTOTALS: ReadonlyArray<readonly [number, number, number]> = [
  [26, 22, 24], // field labor + burden
  [30, 17, 29], // Total Labor
  [37, 32, 36], // Total Other Direct Cost
  [49, 44, 48], // Total Fixed Fee
];

/**
 * Writes the PO-line build-up block on `Invoice Calc`. Line 1.1 lives at the
 * base rows (offset 0); the template's Line 1.2 mirror at +40 is cleared by the
 * builder rather than filled with a duplicate of the same totals.
 *
 * The block is the same five-column grid the other BART forms use: Budget (G),
 * Amount This Period (H), Previously Billed (I), Amount To Date (J), %
 * Expended (K). Only column H was ever written, so the rest still held the
 * reference invoice's own figures — a $61,776 labor budget, $45,031.74
 * previously billed, $111,663.73 to date, 81.9% expended — next to this
 * package's numbers. Every cell is a value, never a formula.
 */
function writeCalcBlock(
  ws: ExcelJS.Worksheet,
  fin: ParsonsFinancials,
  wp: PackageDocContext["workPlan"],
  previousHours: number | null,
  offset: number,
): void {
  /** Block-relative row → sheet row. */
  const r = (row: number) => row + offset;
  // Wipe the four columns the engine never regenerated, plus the hours band.
  for (let row = r(15); row <= r(52); row++) {
    for (const col of ["D", "E", "F", "G", "I", "J", "K"]) clearCell(ws, `${col}${row}`);
  }
  // "Check!!!" is a QA marker the template raises when a line exceeds budget;
  // it has no business on the client's copy, and its cached value came from the
  // reference invoice anyway.
  clearCell(ws, `K${r(46)}`);
  clearCell(ws, `K${r(48)}`);
  setVal(ws, `G${r(14)}`, `Budget ${wp.code}`);

  // Hours to Date band: Current (D) / Previous (E) / To Date (F). No
  // Previous comes from Procas — every hour under this project's leaf codes
  // before the period start, captured on the package at creation. It was a
  // hard 0, which is what Julie's "missing previous hours" note was about, and
  // the template's own cached 339.75 before that. Null means Procas was never
  // asked, and the cell stays blank rather than stating a confident 0. The
  // figure is a project total, so it lands on the row carrying this period's
  // labor — the same rule the previously-billed dollars follow.
  const hoursAt = (loc: "home" | "field") =>
    round2(fin.laborRows.filter((x) => x.location === loc).reduce((s, x) => s + x.hours, 0));
  const fieldIsBilling = hoursAt("field") > 0;
  for (const [row, loc] of [[17, "home"], [22, "field"]] as const) {
    const current = hoursAt(loc);
    const previous = (loc === "field") === fieldIsBilling ? previousHours : null;
    setVal(ws, `D${r(row)}`, current);
    if (previous == null) clearCell(ws, `E${r(row)}`);
    else setVal(ws, `E${r(row)}`, previous);
    setVal(ws, `F${r(row)}`, round2(current + (previous ?? 0)));
  }
  // Rate cells the burden rows multiply by.
  setVal(ws, `D${r(18)}`, fin.fringeFrac);
  setVal(ws, `D${r(19)}`, fin.overheadFrac);
  setVal(ws, `D${r(20)}`, fin.fccmFrac);
  setVal(ws, `D${r(23)}`, fin.fringeFrac);
  setVal(ws, `D${r(24)}`, fin.overheadFrac); // "H&B Overhead Pool" multiplier
  setVal(ws, `E${r(45)}`, fin.feeFrac);
  setVal(ws, `D${r(51)}`, fin.fccmFrac);

  // The OT/DT premium is unburdened and was never written onto the build-up at
  // all, so a period with overtime produced a detail attachment that did not
  // add up to the invoice it was attached to. It lands on the Other Direct
  // Costs block, whose "Travel"/"Reproduction" labels were placeholders.
  setVal(ws, `B${r(33)}`, "OT Premium (0.5 x base rate)");
  setVal(ws, `B${r(34)}`, "DT Premium (1.0 x base rate)");
  setVal(ws, `B${r(35)}`, "Other Direct Costs");

  const amountThisPeriod: Record<number, number> = {
    17: fin.homeDirectLabor,
    18: 0,
    19: 0,
    20: 0,
    22: fin.fieldDirectLabor,
    23: fin.fringeTotal,
    24: fin.overheadTotal,
    33: fin.otPremium,
    34: fin.dtPremium,
    35: fin.otherDirectCosts,
    45: fin.fixedFee,
    51: fin.fccm,
  };

  // Previously Billed carries forward as a scalar; it lands on the field-labor
  // row unless the work plan supplies an explicit per-category split.
  const previouslyBilledRows: Record<number, number> = {};
  for (const row of Object.keys(amountThisPeriod)) previouslyBilledRows[Number(row)] = 0;
  if (
    wp.prevBilledLabor != null ||
    wp.prevBilledOverhead != null ||
    wp.prevBilledFixedFee != null ||
    wp.prevBilledFccm != null
  ) {
    previouslyBilledRows[22] = round2(wp.prevBilledLabor ?? 0);
    previouslyBilledRows[24] = round2(wp.prevBilledOverhead ?? 0);
    previouslyBilledRows[45] = round2(wp.prevBilledFixedFee ?? 0);
    previouslyBilledRows[51] = round2(wp.prevBilledFccm ?? 0);
  } else if (fin.previouslyBilled !== 0) {
    previouslyBilledRows[22] = fin.previouslyBilled;
  }

  // Budget per row only when the work plan carries an explicit split — the
  // total alone cannot be apportioned without guessing at the contract.
  const budgetRows: Record<number, number> = {};
  if (
    wp.budgetLabor != null ||
    wp.budgetOverhead != null ||
    wp.budgetFixedFee != null ||
    wp.budgetFccm != null
  ) {
    budgetRows[22] = round2(wp.budgetLabor ?? 0);
    budgetRows[24] = round2(wp.budgetOverhead ?? 0);
    budgetRows[45] = round2(wp.budgetFixedFee ?? 0);
    budgetRows[51] = round2(wp.budgetFccm ?? 0);
  }

  for (const [row, amount] of Object.entries(amountThisPeriod)) {
    const row0 = Number(row);
    const prev = previouslyBilledRows[row0] ?? 0;
    setVal(ws, `H${r(row0)}`, amount);
    setVal(ws, `I${r(row0)}`, prev);
    setVal(ws, `J${r(row0)}`, round2(amount + prev));
    if (budgetRows[row0] != null) setVal(ws, `G${r(row0)}`, budgetRows[row0]);
  }

  const bandSum = (src: Record<number, number>, from: number, to: number) =>
    Object.entries(src)
      .filter(([row]) => Number(row) >= from && Number(row) <= to)
      .reduce((s, [, v]) => s + v, 0);
  for (const [row, from, to] of CALC_SUBTOTALS) {
    const period = round2(bandSum(amountThisPeriod, from, to));
    const prev = round2(bandSum(previouslyBilledRows, from, to));
    const budgeted = round2(bandSum(budgetRows, from, to));
    setVal(ws, `H${r(row)}`, period);
    setVal(ws, `I${r(row)}`, prev);
    setVal(ws, `J${r(row)}`, round2(period + prev));
    if (budgeted > 0) {
      setVal(ws, `G${r(row)}`, budgeted);
      setVal(ws, `K${r(row)}`, (period + prev) / budgeted);
    }
  }

  // Total Amount Due (row 52) — AUTHORITATIVE "total this period".
  setVal(ws, `H${r(52)}`, fin.totalThisPeriod);
  setVal(ws, `G${r(52)}`, fin.budget);
  setVal(ws, `I${r(52)}`, fin.previouslyBilled);
  setVal(ws, `J${r(52)}`, fin.totalToDate);
  // `=J52/G52` renders #DIV/0! on a work plan with no budget entered yet.
  setVal(ws, `K${r(52)}`, fin.budget > 0 ? fin.totalToDate / fin.budget : 0);
}

// ---------------------------------------------------------------------------
// Labor attachment (Labor_) writer
// ---------------------------------------------------------------------------

/**
 * Writes the labor lines onto the `Labor_` attachment.
 *
 * Rows 16-23 were the reference invoice's home-labor split: two PO-line
 * headings fed from `Invoice Calc` (`='Invoice Calc'!A14`), two bare
 * classification lines, and a `SUBTOTAL(9, E15:E23)` that printed the
 * reference's 168 hours directly under this package's 84. They are cleared and
 * the home aggregate is written on row 15 the way the field one is on row 26.
 */
function writeLaborAttachment(
  ws: ExcelJS.Worksheet,
  fin: ParsonsFinancials,
  names: string,
  invoiceDate: Date | null,
  invoiceNo: string,
): void {
  const aggregate = (loc: "home" | "field") => {
    const rows = fin.laborRows.filter((r) => r.location === loc);
    const hours = round2(rows.reduce((s, r) => s + r.hours, 0));
    const uniformRate =
      rows.length > 0 && rows.every((r) => r.rate === rows[0].rate) ? rows[0].rate : 0;
    return { hours, uniformRate };
  };
  const home = aggregate("home");
  const field = aggregate("field");

  // The header read `=Invoice!L7` / `=Invoice!L5` across the sheet boundary.
  if (invoiceDate) setVal(ws, "G9", invoiceDate);
  else clearCell(ws, "G9");
  setVal(ws, "G10", invoiceNo);
  setVal(ws, "C12", names);
  // Home aggregate (row 15) and its subtotal (row 24).
  setVal(ws, "E15", home.hours);
  setVal(ws, "F15", home.uniformRate);
  setVal(ws, "G15", fin.homeDirectLabor);
  for (let r = 16; r <= 23; r++) {
    for (const col of LABOR_COLS) clearCell(ws, `${col}${r}`);
  }
  setVal(ws, "E24", home.hours);
  setVal(ws, "G24", fin.homeDirectLabor);
  // Field aggregate (row 26): hours / rate / amount as values (was a
  // `='master file'!...` feed — overwrite so no #REF! after removal).
  setVal(ws, "E26", field.hours);
  setVal(ws, "F26", field.uniformRate);
  setVal(ws, "G26", fin.fieldDirectLabor);
  // "$66.56", as the amounts beside it already read (see MONEY_FORMAT).
  setNumberFormat(ws, "F26", MONEY_FORMAT);
  // Field + total-labor subtotals.
  setVal(ws, "E28", field.hours);
  setVal(ws, "G28", fin.fieldDirectLabor);
  setVal(ws, "E31", round2(home.hours + field.hours));
  setVal(ws, "G31", round2(fin.homeDirectLabor + fin.fieldDirectLabor));
  // Columns I..M carried a burdened cross-check (`=G26*1.09*1.08`) beside the
  // form. Outside the print area (B7:H42), but it ships in the .xlsx.
  for (let r = 7; r <= 42; r++) {
    for (const col of ["I", "J", "K", "L", "M"]) clearCell(ws, `${col}${r}`);
  }
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

  const people = contributors(ctx);

  // -- 1. Invoice (face). Every cross-sheet cell is overwritten with a value.
  setVal(invoice, "L5", invoiceNo);
  if (invoiceDate) setVal(invoice, "L7", invoiceDate);
  else clearCell(invoice, "L7");
  setVal(invoice, "L9", wp.poNumber || "N/A");
  // Hers reads "6M8146 – Scheduling Support for Capital Projects".
  setVal(invoice, "E18", agreementLine(wp.agreementNo, wp.procasProject));
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
  // The summary's first line is headed by the work plan number, typed into the
  // reference invoice as "B.55" — which every other Parsons work plan then
  // printed above its own budget.
  setVal(invoice, "C33", wp.code || "");
  // An invoice for one BART project names it in the Project No. box.
  if (ctx.bartProject) setVal(invoice, "L19", ctx.bartProject);
  setVal(invoice, "J33", budget);
  setVal(invoice, "J34", -totalThisPeriod);
  setVal(invoice, "J35", -previouslyBilled);
  setVal(invoice, "J36", remaining);
  // Each summary line also prints its share of the budget in M/N (`=-J34/$J$33`)
  // — inside the print area, and still showing the reference invoice's split.
  const shareOfBudget = (amount: number) => (budget > 0 ? amount / budget : 0);
  for (const col of ["M", "N"]) {
    setVal(invoice, `${col}34`, shareOfBudget(totalThisPeriod));
    setVal(invoice, `${col}35`, shareOfBudget(previouslyBilled));
    setVal(invoice, `${col}36`, shareOfBudget(remaining));
  }
  // The signature block's date cells read `=L7` off the invoice-date cell.
  for (const col of ["I", "J", "K"]) {
    if (invoiceDate) setVal(invoice, `${col}43`, invoiceDate);
    else clearCell(invoice, `${col}43`);
  }

  // -- 2. Invoice Calc (build-up). Both reconciliation PO-line copies get the
  // same authoritative values; H52 (Line 1.1) is the headline "total this
  // period". Clear the stray N34 = #REF! first.
  clearCell(calc, "N34");
  // Columns L..V hold the reference workbook's own reconciliation — a per-PO
  // "Summary" table (Budget / Previously billed / Currently Invoiced /
  // Remaining) and a column of half-rate checks. They sit outside the printed
  // form but ship in the .xlsx the client opens.
  for (let r = 7; r <= 95; r++) {
    for (const col of CALC_SCRATCH_COLS) clearCell(calc, `${col}${r}`);
  }
  writeCalcBlock(calc, fin, wp, pkg.previousHours ?? null, 0); // Line 1.1 (rows 14-52)
  // Rows 53-95 are the reference contract's second PO-line block (Line 1.2 /
  // 54RR510), a +40-row mirror, plus a two-cell tie-out below it. The engine
  // has no way to split a package across two PO lines, so it used to write the
  // SAME totals into both blocks — and LibreOffice paginated straight past the
  // print area, printing the duplicate as a second page of the client's invoice
  // detail. Two identical "Total Amount Due" blocks on one attachment invite
  // exactly the wrong reading, so the mirror is cleared rather than duplicated.
  // (If a contract really does bill against two PO lines, that is a data model
  // change — one billed line item per PO line — not a copy of the same block.)
  //
  // They are hidden as well as cleared: LibreOffice paginates an .xlsx by the
  // sheet's used extent and ignores the print area, so 43 rows of empty-but-
  // styled cells still came out as a blank third page. Hidden rows it skips.
  for (let r = 53; r <= 95; r++) {
    for (const col of [...CALC_COLS, ...CALC_SCRATCH_COLS]) clearCell(calc, `${col}${r}`);
    calc.getRow(r).hidden = true;
  }
  // Header band: the firm name and the work-plan subtitle were defined-name
  // formulas (`=Firm_Name`, `=WP_Title&" "&Proj_No`), and the "Project No:"
  // cell read an empty date cell on the Invoice face, so it printed 12/30/1899.
  setVal(calc, "A10", String(invoice.getCell("B4").value ?? ""));
  setVal(calc, "A11", [wp.code, wp.title].filter(Boolean).join(" "));
  // Cleared when unset: the reference invoice's own date printed otherwise.
  if (invoiceDate) setVal(calc, "J10", invoiceDate);
  else clearCell(calc, "J10");
  setVal(calc, "J11", invoiceNo);
  setVal(calc, "J12", wp.clientProjectNo || wp.wspProjectNo || wp.jobNumber || "");
  // The PO-line heading names the reference contract's own line and project ID
  // ("P.O. Line 1.1 - 15NL005"), and `Labor_` fed off it. We hold one client
  // project number per work plan, so it labels the block we ship.
  const clientProjectNo = (wp.clientProjectNo || "").trim();
  setVal(calc, "A14", clientProjectNo ? `P.O. Line 1.1 - ${clientProjectNo}` : "P.O. Line 1.1");
  // Print the first PO-line block only. The template's area (A7:K59) ran six
  // rows into the second block, so the client's page ended on a stranded
  // "P.O. Line 1.2" header with nothing under it.
  calc.pageSetup = { ...calc.pageSetup, printArea: "$A$7:$K$52" };

  // -- 3. Labor_ (labor attachment).
  const laborNames = people.length > 0
    ? people.map((p) => `${p.name}${p.classification ? `, ${p.classification}` : ""}`).join("; ")
    : "";
  setVal(labor, "C11", `${wp.jobNumber ?? wp.agreementNo ?? ""}-${wp.code}`.replace(/^-|-$/g, ""));
  writeLaborAttachment(labor, fin, laborNames, invoiceDate, invoiceNo);

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
    // Signature block: "Submitted by" read `=Labor_!C12` and the date `=H5`.
    setVal(ws, "D60", laborNames);
    if (reportDate) setVal(ws, "H65", reportDate);
    else clearCell(ws, "H65");
    // Cost Forecast at Completion. The budget and to-date cells fed off
    // `Invoice Calc`, and the sentence beside them was an IFERROR/TEXT formula,
    // so the report stated the reference invoice's "81.95% has been billed"
    // whatever this package's numbers were.
    setVal(ws, "E53", budget);
    setVal(ws, "E54", totalToDate);
    // A seven-figure budget does not fit the template's column width, so the
    // approved-budget line printed "###" beside a to-date figure that fitted.
    const forecastCol = ws.getColumn("E");
    forecastCol.width = Math.max(forecastCol.width ?? 0, 16);
    setVal(
      ws,
      "G54",
      budget > 0 ? `${((totalToDate / budget) * 100).toFixed(2)}% has been billed.` : "",
    );
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
  dropDeadDefinedNames(wb, removedTokens, "Parsons");
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
      // The template's timesheets carry Hashmatullah Ahmadzai's signature; only that
      // person's own timesheet may keep it.
      settleTimesheetSignature(ws, person.name, TEMPLATE_SIGNER, ctx.employeeSignatures);
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

  fitSheetsToOnePage(wb);
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
