import ExcelJS from "exceljs";
import path from "node:path";
import fs from "node:fs";
import { templatesDir, generatedDir, ensureDirs } from "./paths";
import {
  dropDeadDefinedNames,
  fitSheetsToOnePage,
  freezeUnstableFormulas,
  removeSheet,
  reviveModelDates,
  scrubInternalMarks,
  stripBrokenDefinedNames,
  settleTimesheetSignature,
  formatHoursUniformly,
  setNumberFormat,
  MONEY_FORMAT,
  shrinkCellToFit,
  wrapWords,
} from "./excel";
import { detailColumns } from "./detailColumns";
import { knownHeader } from "./knownInvoiceHeaders";
import { buildWspLinesWorkbook, isWspLinesForm } from "./wspLinesWorkbook";
import { contributorKey } from "./packageMappers";
import { burdenOnFringeLine } from "./billingProfile";
import { logger } from "./logger";
import type { PackageDocContext } from "./packageDocs";
import type { PackageRow, PackageWeekRow, TimesheetEntryRow } from "@workspace/db";

/**
 * WSP-format invoice export engine (reference-workbook approach).
 *
 * The template (`wsp-invoice-template.xlsm`) is Julie's real WSP/BART invoice
 * workbook (Jordy Peralta, Work Plan A.04-02). Instead of rebuilding sheets
 * from scratch, this engine loads that workbook and mutates it in place,
 * writing backend-computed VALUES (never formulas) into the reference cells so
 * the client file is authoritative even in a viewer that does not recalculate:
 *
 *  - Invoice (face): dates, invoice no, period, this-period total L27/L30,
 *    billing summary J34-J38.
 *  - `Sub Calc _revised` (build-up): the whole five-column grid — Budget (G),
 *    Amount This Period (H), Previously Billed (I), Amount To Date (J), %
 *    Expended (K) — plus the Hours to Date band and every SUBTOTAL row, all as
 *    values. Fringe and fee stay UNROUNDED and FCCM ROUNDED, exactly as the
 *    reference workbook computes them, so the headline rounds to the same cent
 *    (26,189.78 on the sample).
 *  - `Sub Labor` (per-employee lines): classification / name / hours / rate /
 *    amount, with location subtotals.
 *  - `Progress Report`: header, period, dates, narrative, percent expended.
 *  - Weekly timesheet tabs: 7 day columns G..M starting SATURDAY (G=Sat …
 *    M=Fri), rows for straight / OT / DT / PTO / holiday, and weekly totals.
 *
 * Two sheets carry Julie's working notes outside the form — a "Budget Increase"
 * back-solve calculator, a reconciliation strip, a "Max Rate Cap at $115"
 * reminder — and the template's print areas (`Sub Calc _revised`!A1:Q59 and
 * `Sub Labor`!A1:U31) reach all of it, so the client's copy printed her scratch
 * and scaled the type down to fit ~19 inches of it onto a page. Those cells are
 * CLEARED, which is what actually fixes the print: LibreOffice paginates an
 * .xlsx by the sheet's used extent and ignores the print area. The areas are
 * narrowed to the form as well, for Excel, which does honour them.
 *
 * The billing math follows the definitive V1 WSP/BART model:
 *   direct labor (straight+OT+DT hours × base rate)
 *     → + fringe (× fringeRate, e.g. 1.2058)
 *     → + overhead pool (× overheadRate; 0 for this contract)
 *     → + fixed fee (× fixedFeeRate on labor+fringe+pool)
 *     → + FCCM (× fccmRate on direct labor, per location, rounded)
 *     → + OT/DT premium (0.5×base×OT, 1.0×base×DT — UNBURDENED, added after).
 * Previously-billed dollars carry forward from the prior invoice (scalar), and
 * are written as the authoritative I51 total (decomposed onto the col-I leaf
 * rows when the work plan supplies a per-category split).
 *
 * Internal sheets (hidden Master File, legacy Sub Calc, Prime ODCs, ODC, the
 * MISC checklist, and the template's own week tabs) are removed; any straggler
 * formula that still referenced them is frozen to its cached value so the
 * client file never opens with #REF! or an Excel "repair" prompt.
 */

/** Whose signature the template's timesheet tabs carry. */
const TEMPLATE_SIGNER = "Jordy Peralta";

const TEMPLATE_FILE = "wsp-invoice-template.xlsm";

const INVOICE_SHEET = "Invoice";
const SUBCALC_SHEET = "Sub Calc _revised";
const SUBLABOR_SHEET = "Sub Labor";
const PROGRESS_SHEET = "Progress Report";

/** Sheets that must never ship to the client (removed from the workbook). */
const INTERNAL_SHEETS = ["Master File ", "Sub Calc", "Prime ODCs", "ODC", "MISC"];

/** The template's own weekly timesheet tabs — replaced with generated ones. */
const TEMPLATE_WEEK_TABS = [
  "JP Week 1",
  "JP Week 2",
  "JP Week 3",
  "JP Week 4",
  "JP Week 5",
  "JP Week6",
];

/**
 * Exact `'<sheet>'!` reference tokens for the removed sheets. Used to freeze
 * dangling formulas and drop dead defined names. `'Sub Calc'!` deliberately
 * carries its closing quote so it never matches `'Sub Calc _revised'!`.
 */
const DELETED_REF_TOKENS = [
  "'Master File '!",
  "'Sub Calc'!",
  "'Prime ODCs'!",
  "'ODC'!",
  "ODC!",
  "'MISC'!",
  "MISC!",
  ...TEMPLATE_WEEK_TABS.map((n) => `'${n}'!`),
];

/** `Sub Labor` columns right of the form (I..U) — Julie's working notes. */
const SUBLABOR_SCRATCH_COLS = [
  "I", "J", "K", "L", "M", "N", "O", "P", "Q", "R", "S", "T", "U",
] as const;

/** Columns the `Sub Calc _revised` form occupies (A..K). */
const SUBCALC_COLS = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K"] as const;

/**
 * `Sub Calc _revised` subtotal rows as `[row, firstRow, lastRow]` — the bands
 * the template summed with `SUBTOTAL(9, …)`. Written as values because nothing
 * downstream of ExcelJS recalculates them.
 */
const SUBCALC_SUBTOTALS: ReadonlyArray<readonly [number, number, number]> = [
  [10, 7, 9], // Home & Branch labor + burden
  [14, 11, 13], // Field labor + burden
  [19, 16, 18], // spare labor rows
  [20, 7, 19], // Total Labor
  [31, 22, 30], // Total Other Direct Cost
  [37, 33, 36], // Total Subconsultants
  [41, 39, 40], // Total PMAC
  [47, 42, 46], // Total Fixed Fee
];

/** The subtotal rows that state a "% Expended": Total Labor, ODC, Fixed Fee. */
const SUBCALC_PERCENT_ROWS: readonly number[] = [20, 31, 47];

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

/** Two-letter initials from a display name, e.g. "Jordy Peralta" → "JP". */
function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const letters = parts.slice(0, 2).map((p) => p[0]?.toUpperCase() ?? "");
  return letters.join("") || "EE";
}

/**
 * Detects whether a package bills through WSP as its prime. Free-text `prime`
 * (e.g. "WSP", "WSP USA Inc") is matched case-insensitively on the WSP token.
 */
export function isWspPrime(pkg: Pick<PackageRow, "prime">): boolean {
  return /\bwsp\b/i.test(pkg.prime ?? "");
}

// ---------------------------------------------------------------------------
// Financials
// ---------------------------------------------------------------------------

interface WspLaborRow {
  key: string;
  employeeName: string;
  classification: string;
  location: "home" | "field";
  rate: number;
  hours: number; // billable hours (regular + night + OT + DT)
  amount: number; // round2(hours × rate) — direct labor at base rate
}

interface WspLocationTotals {
  directLabor: number; // Σ row amounts (each rounded)
  fringe: number; // directLabor × fringeFrac (UNROUNDED)
  overheadPool: number; // directLabor × overheadFrac (UNROUNDED; 0 here)
  fccm: number; // round2(directLabor × fccmFrac)
}

export interface WspFinancials {
  laborRows: WspLaborRow[];
  home: WspLocationTotals;
  field: WspLocationTotals;
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
 * Computes the WSP burden chain from the package's timesheet entries. Fringe,
 * overhead pool, and fixed fee are kept UNROUNDED (as the reference workbook's
 * formulas do); FCCM and the premiums are rounded to the cent. This ordering is
 * what makes the sample's headline land on 26,189.78 rather than 26,189.77.
 */
export function computeWspFinancials(ctx: PackageDocContext): WspFinancials {
  const wp = ctx.workPlan;
  const { fringeFrac, overheadFrac } = burdenOnFringeLine(wp);
  const feeFrac = (wp.fixedFeeRate ?? 0) / 100;
  const fccmFrac = (wp.fccmRate ?? 0) / 100;

  // One labor row per (employee, location, rate). All billable hours
  // (straight + night + OT + DT) bill at the base rate; the OT/DT *premium* is
  // computed separately below and added unburdened.
  const rowMap = new Map<string, WspLaborRow>();
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
        } as WspLaborRow);
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

  const locTotals = (loc: "home" | "field"): WspLocationTotals => {
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

// ---------------------------------------------------------------------------
// Contributors
// ---------------------------------------------------------------------------

interface WspContributor {
  key: string;
  name: string;
  classification: string;
}

function contributors(ctx: PackageDocContext): WspContributor[] {
  const seen = new Map<string, WspContributor>();
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

/** Category → generated-timesheet row (uniform layout, cloned per week). */
function timesheetRow(category: string): number {
  switch (category) {
    case "ot":
      return 11;
    case "dt":
      return 12;
    case "pto":
      return 13;
    case "holiday":
      return 14;
    default:
      return 9; // regular / night → straight time
  }
}

/**
 * Fills one generated weekly timesheet tab for one contributor. Day columns run
 * Saturday (G) → Friday (M); G6 is the week's Saturday, and every hour cell and
 * total is written as a value (the tab carries no live cross-sheet formulas).
 */
function fillTimesheet(
  ws: ExcelJS.Worksheet,
  week: PackageWeekRow,
  ctx: PackageDocContext,
  person: WspContributor,
): void {
  const wp = ctx.workPlan;
  const contractLabel = `${wp.agreementNo ?? ""} ${wp.code}`.trim();
  const saturday = saturdayOnOrBefore(toDate(week.weekStart));

  setVal(ws, "C5", person.name);
  // Day header dates: G=Sat, H=Sun, I=Mon, J=Tue, K=Wed, L=Thu, M=Fri.
  const dayCols = ["G", "H", "I", "J", "K", "L", "M"];
  dayCols.forEach((col, i) => setVal(ws, `${col}6`, addDays(saturday, i)));
  // "Week Ending" = Friday. The template formats I5 as a long date in a narrow
  // day column, so the printed timesheet read "Week Ending: ###" — the same
  // symptom Julie reported on the T.Y. Lin timesheets. A short numeric date fits.
  setVal(ws, "I5", addDays(saturday, 6));
  ws.getCell("I5").numFmt = "m/d/yyyy";

  // Clear the sample data region (descriptions + all day/total cells, rows 9-15).
  for (let r = 9; r <= 15; r++) {
    for (const col of ["A", "C", "G", "H", "I", "J", "K", "L", "M", "N"]) clearCell(ws, `${col}${r}`);
  }

  // Aggregate the contributor's hours per category into day columns.
  const acc = new Map<number, Record<string, number>>();
  for (const e of ctx.entries.filter(
    (x) => x.weekId === week.id && contributorKey(x) === person.key,
  )) {
    const r = timesheetRow(e.category);
    const a = acc.get(r) ?? { G: 0, H: 0, I: 0, J: 0, K: 0, L: 0, M: 0 };
    a.G += e.hoursSat;
    a.H += e.hoursSun;
    a.I += e.hoursMon;
    a.J += e.hoursTue;
    a.K += e.hoursWed;
    a.L += e.hoursThu;
    a.M += e.hoursFri;
    acc.set(r, a);
  }

  // Row labels for the categories we populate.
  const rowLabel: Record<number, string> = {
    9: `${person.classification} - Straight Time`,
    11: `${person.classification} - Overtime`,
    12: `${person.classification} - Doubletime`,
    13: "PTO (Sick/Vacation)",
    14: "Holiday",
  };

  const colTotals: Record<string, number> = { G: 0, H: 0, I: 0, J: 0, K: 0, L: 0, M: 0 };
  let grandTotal = 0;
  for (const r of [9, 11, 12, 13, 14]) {
    const a = acc.get(r);
    if (r <= 12) setVal(ws, `A${r}`, contractLabel);
    setVal(ws, `C${r}`, rowLabel[r]);
    let rowTotal = 0;
    for (const col of dayCols) {
      const v = round2(a?.[col] ?? 0);
      if (v > 0) setVal(ws, `${col}${r}`, v);
      rowTotal += v;
      colTotals[col] += v;
    }
    setVal(ws, `N${r}`, round2(rowTotal));
    grandTotal += rowTotal;
  }

  // TOTAL HOURS row (16 in the cloned layout): column sums + grand total.
  for (const col of dayCols) setVal(ws, `${col}16`, round2(colTotals[col]));
  setVal(ws, "N16", round2(grandTotal));

  // One number of decimals for every hours figure on the sheet.
  const hourCells: string[] = [];
  for (const r of [9, 10, 11, 12, 13, 14, 15, 16]) {
    for (const col of [...dayCols, "N"]) hourCells.push(`${col}${r}`);
  }
  formatHoursUniformly(ws, hourCells);
  // The day headings as "8/29": the full date in bold filled its cell edge to
  // edge. And the labels that lost their ends — "ntract / Workpl",
  // "Assistant Resident Engineer - Strai" — fit their cells.
  for (const col of dayCols) setNumberFormat(ws, `${col}6`, "m/d");
  shrinkCellToFit(ws, "A7");
  for (const r of [9, 11, 12]) shrinkCellToFit(ws, `C${r}`);
  // The TOTAL column is bold except on the PTO row, and the two leave labels
  // are a size larger than the rows above them.
  const totalFont = ws.getCell("N9").style.font;
  for (const r of [10, 11, 12, 13, 14, 15]) {
    const cell = ws.getCell(`N${r}`);
    cell.style = { ...cell.style, font: { ...cell.style.font, bold: totalFont?.bold ?? true } };
  }
  for (const r of [13, 14]) {
    const cell = ws.getCell(`C${r}`);
    cell.style = { ...cell.style, font: { ...cell.style.font, size: 10 } };
  }
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

export interface WspBuildResult {
  wb: ExcelJS.Workbook;
  timesheetTabs: string[];
  financials: WspFinancials;
}

/**
 * Builds the client-ready WSP workbook from the reference template. Returns the
 * workbook plus the ordered timesheet tab names and computed financials (for
 * verification/tests).
 */
export async function buildWspWorkbook(ctx: PackageDocContext): Promise<WspBuildResult> {
  const file = path.resolve(templatesDir, TEMPLATE_FILE);
  if (!fs.existsSync(file)) {
    throw new Error(`WSP invoice template not found at ${file}`);
  }
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);

  const wp = ctx.workPlan;
  const pkg = ctx.pkg;
  const fin = computeWspFinancials(ctx);

  const invoice = wb.getWorksheet(INVOICE_SHEET)!;
  const subcalc = wb.getWorksheet(SUBCALC_SHEET)!;
  const sublabor = wb.getWorksheet(SUBLABOR_SHEET)!;
  const report = wb.getWorksheet(PROGRESS_SHEET)!;

  // Capture a pristine week-tab layout before we drop the template's tabs.
  const pristineWeek = JSON.parse(
    JSON.stringify(wb.getWorksheet("JP Week 5")!.model),
  );

  // An unset invoice number prints blank, never the work-plan code. Falling back
  // to the code put "10014" in the Invoice No. box, which reads as a real invoice
  // number and sent Julie looking for where the system got it. The package
  // tie-out already flags a missing number, and the biller supplies the first one
  // for a work plan (every later package increments it — see bumpInvoiceNumber).
  const invoiceNo = pkg.invoiceNumber ? " " + pkg.invoiceNumber : "";

  // Several attachment headers read `=Invoice!B4` for the firm name. Resolve it
  // once from the cell itself so those become values without hardcoding it.
  const firmName = String(invoice.getCell("B4").value ?? "");

  // -- 1. Invoice (face). Every cross-sheet cell is overwritten with a value.
  if (pkg.invoiceDate) {
    setVal(invoice, "L6", toDate(pkg.invoiceDate));
    setVal(invoice, "M45", toDate(pkg.invoiceDate));
  } else {
    clearCell(invoice, "L6");
    clearCell(invoice, "M45");
  }
  setVal(invoice, "L8", wp.poNumber || "");
  setVal(invoice, "L10", invoiceNo);
  setVal(invoice, "L11", `WSP Project No.: ${wp.wspProjectNo ?? ""}`.trim());
  // The box is sized for this line in Excel, but the PDF renderer lays the form
  // out a little narrower and "WSP Project No.: 30900569.4687" lost both ends.
  // Let it shrink to the box rather than be cut.
  {
    const projectNo = invoice.getCell("L11");
    projectNo.alignment = { ...projectNo.alignment, shrinkToFit: true, wrapText: false };
    projectNo.font = { ...projectNo.font, size: 8 };
  }
  setVal(invoice, "E21", wp.agreementNo || "");
  setVal(invoice, "E22", wp.title || "");
  setVal(invoice, "L22", wp.bartProjectNumbers || "");
  setVal(invoice, "L24", wp.terms || "");
  setVal(invoice, "D12", wp.sendToCompany || "");
  setVal(invoice, "D13", wp.sendToAddress1 || "");
  setVal(invoice, "D14", wp.sendToAddress2 || "");
  // The line under the address is the prime's AP contact email. It is the
  // reference invoice's own, so it is only kept for a work plan whose real
  // invoice carries one; otherwise it is cleared rather than left hardcoded.
  const sendToExtra = knownHeader(wp.procasProject, wp.jobNumber)?.sendToExtra;
  if (sendToExtra) setVal(invoice, "D15", sendToExtra);
  else clearCell(invoice, "D15");
  // The signature line is split across two cells in the template ("Mahsa
  // Azad," in B46 and ",President" in D46), which Excel lets run together and
  // the PDF renderer does not: it printed "Mahsa Az,President".
  setVal(invoice, "B46", pkg.approvedBy || "Mahsa Azad, President");
  clearCell(invoice, "D46");
  setVal(invoice, "E19", wp.contactPerson || "");
  setVal(invoice, "B24", toDate(pkg.payPeriodStart));
  setVal(invoice, "H24", toDate(pkg.payPeriodEnd));
  setVal(invoice, "C27", `Work Plan ${wp.code}`);
  setVal(invoice, "L27", fin.totalThisPeriod);
  setVal(invoice, "L30", fin.totalThisPeriod);
  // Billing summary.
  setVal(invoice, "J34", fin.budget);
  setVal(invoice, "J35", fin.totalThisPeriod);
  setVal(invoice, "J36", fin.previouslyBilled);
  setVal(invoice, "J37", fin.totalToDate);
  setVal(invoice, "J38", fin.remainingBalance);

  // -- 2. Sub Calc _revised (build-up).
  //
  // The sheet is a five-column grid: Budget (G), Amount This Period (H),
  // Previously Billed (I), Amount To Date (J), % Expended (K). Only column H
  // was ever regenerated, so G/J/K still carried the reference invoice's own
  // figures — a $68,450 labor budget, $137,956.72 previously billed, a 113.4%
  // expended reading and a `#DIV/0!` on the PMAC row — and the Hours to Date
  // band still showed the reference's 1,475 previous hours. Wipe the four
  // columns across the body, then write every figure this package can actually
  // state, as a value.
  for (let r = 5; r <= 50; r++) {
    for (const col of ["G", "I", "J", "K"]) clearCell(subcalc, `${col}${r}`);
  }
  // Rows 53-59 are Julie's reconciliation strip (Original / Checked / Fixed
  // Fee, and `=+'Sub Calc _revised'!INVOICE-H31` beside the words "labor" and
  // "expenses"); columns O..Q hold a "Budget Increase" back-solve calculator
  // carrying the reference contract's target total and a 1.09 fringe. Both sit
  // inside the template's print area (A1:Q59), so both printed on the client's
  // invoice detail.
  for (let r = 53; r <= 59; r++) {
    for (const col of SUBCALC_COLS) clearCell(subcalc, `${col}${r}`);
  }
  for (let r = 1; r <= 25; r++) {
    for (const col of ["O", "P", "Q"]) clearCell(subcalc, `${col}${r}`);
  }
  // The header band read `=Invoice!B4` across A1:D1 and repeated the reference
  // invoice number in K2, beside the cell the engine writes.
  setVal(subcalc, "A1", firmName);
  setVal(subcalc, "J1", pkg.invoiceDate ? toDate(pkg.invoiceDate) : "");
  setVal(subcalc, "J2", invoiceNo);
  setVal(subcalc, "K2", invoiceNo);
  setVal(subcalc, "J3", wp.code);

  // Hours to Date band: Current (D) / Previous (E) / To Date (F), per location.
  // We do not carry prior-period hours on the package, so Previous is an
  // explicit 0 and To Date equals Current — never the template's 1,475.
  const hoursAt = (loc: "home" | "field") =>
    round2(fin.laborRows.filter((r) => r.location === loc).reduce((s, r) => s + r.hours, 0));
  // Previous comes from Procas — every hour under this project's leaf codes
  // before the period start, captured on the package at creation. It was a
  // hard 0 ("missing previous hours"). Null means Procas was never asked, and
  // the cell stays blank rather than stating a confident 0. The figure is a
  // project total, so it lands on the row carrying this period's labor — the
  // same rule the previously-billed dollars follow.
  const fieldIsBilling = hoursAt("field") > 0;
  for (const [row, loc] of [[7, "home"], [11, "field"]] as const) {
    const current = hoursAt(loc);
    const previous =
      (loc === "field") === fieldIsBilling ? (pkg.previousHours ?? null) : null;
    setVal(subcalc, `D${row}`, current);
    if (previous == null) clearCell(subcalc, `E${row}`);
    else setVal(subcalc, `E${row}`, previous);
    setVal(subcalc, `F${row}`, round2(current + (previous ?? 0)));
  }
  // The rate cells the burden rows multiply by, and their `=SUM()` companions.
  setVal(subcalc, "D8", fin.fringeFrac);
  setVal(subcalc, "D9", fin.overheadFrac);
  setVal(subcalc, "D10", fin.fringeFrac + fin.overheadFrac);
  setVal(subcalc, "D12", fin.fringeFrac);
  setVal(subcalc, "D13", fin.overheadFrac);
  setVal(subcalc, "D14", fin.fringeFrac + fin.overheadFrac);
  setVal(subcalc, "E43", fin.feeFrac);
  setVal(subcalc, "E44", 0);
  setVal(subcalc, "E48", fin.fccmFrac);
  setVal(subcalc, "E49", fin.fccmFrac);
  // Both FCCM labels are literal text in the template and read "(0.00% x Direct
  // labor)" however the contract's rate is actually set.
  const fccmPct = round2(fin.fccmFrac * 100);
  setVal(subcalc, "B48", `FCCM Home (${fccmPct}% x Direct labor)`);
  setVal(subcalc, "B49", `FCCM Field (${fccmPct}% x Direct labor)`);

  // Amount This Period (H), row by row.
  const amountThisPeriod: Record<number, number> = {
    7: fin.home.directLabor,
    8: fin.home.fringe,
    9: fin.home.overheadPool,
    11: fin.field.directLabor,
    12: fin.field.fringe,
    13: fin.field.overheadPool,
    16: 0,
    17: 0,
    18: 0,
    23: fin.otherDirectCosts,
    24: fin.otPremium,
    25: fin.dtPremium,
    26: 0,
    27: 0,
    28: 0,
    29: 0,
    30: 0,
    33: 0,
    34: 0,
    35: 0,
    36: 0,
    39: 0,
    43: fin.fixedFee,
    44: 0,
    48: fin.home.fccm,
    49: fin.field.fccm,
    50: 0,
  };

  // Previously Billed (I). We carry a scalar forward, so unused leaves are zero
  // (never left as template constants) and the scalar lands on the field-labor
  // row unless the work plan supplies an explicit per-category split.
  // (Now on every row, not one lump on the labor line: see detailColumns.)
  const cols = detailColumns(ctx, fin);
  // The block this period's labor is in carries the history too.
  const laborRow = fieldIsBilling || hoursAt("home") === 0 ? 11 : 7;
  const fccmRow = laborRow === 11 ? 49 : 48;
  const previouslyBilledRows: Record<number, number> = {};
  for (const r of Object.keys(amountThisPeriod)) previouslyBilledRows[Number(r)] = 0;
  previouslyBilledRows[laborRow] = cols.previous.labor;
  previouslyBilledRows[laborRow + 1] = cols.previous.fringe;
  previouslyBilledRows[23] = cols.previous.odc;
  previouslyBilledRows[24] = cols.previous.premium;
  previouslyBilledRows[43] = cols.previous.fee;
  previouslyBilledRows[fccmRow] = cols.previous.fccm;

  // Budget (G) per row. The work plan stores a total; the per-category split is
  // optional and only the biller can supply it, so the column stays blank
  // rather than showing a back-solved figure that would not tie to the
  // contract. The total (G51) and remaining balance (G52) are always stated.
  //
  // The split is what the biller entered with the budget (the pencil on a
  // package); until one is entered it is worked out from the total at this
  // work plan's rates, so the column is not empty in the meantime.
  const budgetRows: Record<number, number> = {};
  if (fin.budget > 0) {
    budgetRows[laborRow] = cols.budget.labor;
    budgetRows[laborRow + 1] = cols.budget.fringe;
    if (cols.budget.odc) budgetRows[23] = cols.budget.odc;
    budgetRows[43] = cols.budget.fee;
    if (cols.budget.fccm) budgetRows[fccmRow] = cols.budget.fccm;
  }

  // Written UNROUNDED, as the reference workbook's own formulas leave them: the
  // fringe and fixed-fee leaves carry full precision so the headline rounds to
  // 26,189.78 rather than .77. The cells' number formats do the displaying.
  for (const [row, amount] of Object.entries(amountThisPeriod)) {
    const r = Number(row);
    const prev = previouslyBilledRows[r] ?? 0;
    setVal(subcalc, `H${r}`, amount);
    setVal(subcalc, `I${r}`, prev);
    setVal(subcalc, `J${r}`, amount + prev);
    if (budgetRows[r] != null) setVal(subcalc, `G${r}`, budgetRows[r]);
  }

  // Subtotal rows, as values. Each mirrors the SUBTOTAL(9, …) band it replaced.
  const bandSum = (src: Record<number, number>, from: number, to: number) =>
    Object.entries(src)
      .filter(([r]) => Number(r) >= from && Number(r) <= to)
      .reduce((s, [, v]) => s + v, 0);
  for (const [row, from, to] of SUBCALC_SUBTOTALS) {
    const period = bandSum(amountThisPeriod, from, to);
    const prev = bandSum(previouslyBilledRows, from, to);
    const budgeted = bandSum(budgetRows, from, to);
    setVal(subcalc, `H${row}`, period);
    setVal(subcalc, `I${row}`, prev);
    setVal(subcalc, `J${row}`, period + prev);
    if (budgeted > 0) {
      setVal(subcalc, `G${row}`, budgeted);
      // % Expended goes on the "Total …" rows, as on hers. The block subtotals
      // above them have no percent format, and printed "0.78078237".
      if (SUBCALC_PERCENT_ROWS.includes(row)) {
        setVal(subcalc, `K${row}`, (period + prev) / budgeted);
        const pctCell = subcalc.getCell(`K${row}`);
        pctCell.style = {
          ...pctCell.style,
          numFmt: "0.0%",
          alignment: { ...pctCell.style.alignment, horizontal: "center" },
        };
      }
    }
  }

  // The OT/DT premium rows named one employee and one rate from the reference
  // workbook ("SS OT Premium(Jordy)", "37/HR") no matter who actually worked
  // the overtime — the same complaint Julie raised about the T.Y. Lin ODCs
  // sheet. Name this period's people, their premium rate and their hours.
  writePremiumRow(subcalc, 24, "SS OT Premium", premiumDetail(ctx, "ot"));
  writePremiumRow(subcalc, 25, "SS DT Premium", premiumDetail(ctx, "dt"));

  // The unit-priced ODC lines (car rental / lodging / meals) are not sourced
  // from the package, so their quantity and count cells are zeroed rather than
  // left carrying the reference invoice's.
  for (let r = 27; r <= 30; r++) {
    setVal(subcalc, `D${r}`, 0);
    setVal(subcalc, `F${r}`, 0);
  }

  // Authoritative totals (values, not formulas).
  setVal(subcalc, "G51", fin.budget);
  setVal(subcalc, "H51", fin.totalThisPeriod);
  setVal(subcalc, "I51", fin.previouslyBilled);
  setVal(subcalc, "J51", fin.totalToDate);
  // `=J51/G51` renders #DIV/0! on a work plan whose budget has not been entered
  // yet; written as a value, and 0 when there is no budget to divide by.
  setVal(subcalc, "K51", fin.budget > 0 ? fin.totalToDate / fin.budget : 0);
  setVal(subcalc, "G52", fin.remainingBalance);

  // Print only the form (Excel honours this; LibreOffice goes by the used
  // extent, which the clearing above is what fixes).
  subcalc.pageSetup = { ...subcalc.pageSetup, printArea: "$A$1:$K$52" };
  // The column headings wrap to two lines ("Amount This / Period") in a row
  // one line tall, so their top half printed cut off, and "% Expended" ran
  // out of its column.
  const headings = subcalc.getRow(4);
  headings.height = Math.max(headings.height ?? 0, 30);
  const expended = subcalc.getColumn("K");
  expended.width = Math.max(expended.width ?? 0, 11);
  // "Home & Branch (H&B", "Fringe Benefits on Labc": the row labels run from
  // column A into the hours box and lost their last letters to it.
  const labelRoom = subcalc.getColumn("C");
  labelRoom.width = Math.max(labelRoom.width ?? 0, 17.5);

  // -- 3. Sub Labor (per-employee lines). Clear both blocks, then write rows.
  //
  // The form is columns A..H, but the template's print area runs A1:U31 and
  // columns I..U hold Julie's working notes: a "Max Rate Cap / at $115 / Bill
  // Rate Overide" reminder, a 1/1/2022 effective date, a "Total Billed Hours"
  // tally across L..U, and a fringe/fee reconciliation in I21:I26. All of it
  // printed on the client's labor attachment and stretched the sheet across 21
  // columns, so the type scaled down to fit.
  for (let r = 1; r <= 31; r++) {
    for (const col of SUBLABOR_SCRATCH_COLS) clearCell(sublabor, `${col}${r}`);
  }
  // The attachment is Classification / Name / Hours / Rate / Amount, columns B
  // to F, as on the one she sends. Column A is a row-has-hours flag ("1", "0")
  // and column H a "Billed $" working column with the burdened figures; both
  // printed ("Please delete the column that says billed").
  sublabor.pageSetup = { ...sublabor.pageSetup, printArea: "$B$1:$F$29" };
  sublabor.getColumn("A").hidden = true;
  for (let r = 1; r <= 33; r++) {
    clearCell(sublabor, `A${r}`);
    clearCell(sublabor, `G${r}`);
    clearCell(sublabor, `H${r}`);
  }
  // "Hours" is right-aligned hard against "Rate/Hour": "HoursRate/Hour".
  const hoursHeading = sublabor.getCell("D5");
  hoursHeading.style = {
    ...hoursHeading.style,
    alignment: { ...hoursHeading.style.alignment, horizontal: "center" },
  };
  const rateCol = sublabor.getColumn("E");
  rateCol.width = Math.max(rateCol.width ?? 0, 11.5);
  setVal(sublabor, "B1", firmName);
  setVal(sublabor, "F1", pkg.invoiceDate ? toDate(pkg.invoiceDate) : "");
  setVal(sublabor, "F2", invoiceNo);
  setVal(sublabor, "F3", wp.code);
  writeLaborBlock(sublabor, fin, "home", { start: 7, end: 17, subtotal: 18 });
  writeLaborBlock(sublabor, fin, "field", { start: 20, end: 25, subtotal: 26 });
  // TOTAL LABOR (row 29) and the ODC / grand rows.
  const totalHours = round2(
    fin.laborRows.reduce((s, r) => s + r.hours, 0),
  );
  const totalAmount = round2(fin.home.directLabor + fin.field.directLabor);
  setVal(sublabor, "D29", totalHours);
  setVal(sublabor, "F29", totalAmount);
  // Money reads as money and hours as hours. The accounting format parks its
  // "$" at the far left of the cell, where it sat against the hours in the
  // next column: "128.00 $   83.00" ("There's funky dollar signs here").
  for (const r of [18, 26, 29]) setNumberFormat(sublabor, `F${r}`, MONEY_FORMAT);
  // Rows 30-31 were a reconciliation strip below TOTAL LABOR — two burdened
  // figures whose only labels ("ODC", "manual") lived in the notes column we
  // clear above, leaving bare numbers under the total. The attachment ends at
  // TOTAL LABOR.
  for (let r = 30; r <= 31; r++) {
    for (const col of ["A", ...LABOR_COLS]) clearCell(sublabor, `${col}${r}`);
  }

  // -- 4. Progress Report: header, period, dates, narrative, percent expended.
  const reportDate = ctx.progress?.reportDate || pkg.invoiceDate;
  setVal(report, "B2", `Agreement No. ${wp.agreementNo ?? ""}`.trim());
  setVal(report, "B6", `Work Plan ${wp.code}`);
  setVal(report, "E6", wp.poNumber || "");
  const mdy = (d: Date) => `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
  // Under the title goes the period the report covers, as on hers
  // ("5/30/2026 to 6/30/2026"), not a second copy of the invoice date.
  setVal(report, "B4", `${mdy(toDate(pkg.payPeriodStart))} to ${mdy(toDate(pkg.payPeriodEnd))}`);
  if (reportDate) {
    setVal(report, "I6", toDate(reportDate));
    setVal(report, "G35", toDate(reportDate));
  } else {
    clearCell(report, "I6");
    clearCell(report, "G35");
  }
  setVal(report, "B7", wp.title || "");
  setVal(report, "G7", toDate(pkg.payPeriodStart));
  setVal(report, "I7", toDate(pkg.payPeriodEnd));
  // The period row printed "5/2/2026 to ###": column I is a couple of
  // characters narrower than G, so the end date did not fit beside the start.
  for (const addr of ["G7", "I7", "I6"]) report.getCell(addr).numFmt = "m/d/yyyy";
  const periodEndCol = report.getColumn("I");
  periodEndCol.width = Math.max(periodEndCol.width ?? 0, 11);
  const people = contributors(ctx);
  setVal(
    report,
    "B10",
    `Summarize Work Completed to Date (Milestones Completed and Dates) by ${people
      .map((p) => p.name)
      .join(", ")}`,
  );
  const NARRATIVE = { first: 11, last: 20 };
  for (let r = NARRATIVE.first; r <= NARRATIVE.last; r++) {
    clearCell(report, `B${r}`);
    clearCell(report, `C${r}`);
  }
  // Every line the PM wrote goes on the report. It used to stop at eight, and
  // a long line ran straight through the box's right-hand edge. Each bullet is
  // wrapped to the width of the box; when there are more lines than the form
  // has rows, the last row grows to hold the rest.
  const narrative = (ctx.progress?.workPerformed || ctx.progress?.summary || "").trim();
  const physical: Array<{ bullet: boolean; text: string }> = [];
  for (const line of narrative.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
    wrapWords(line.replace(/^[-•·*]\s*/, ""), 92).forEach((text, i) => physical.push({ bullet: i === 0, text }));
  }
  const rowsAvailable = NARRATIVE.last - NARRATIVE.first + 1;
  const single = physical.length <= rowsAvailable ? physical : physical.slice(0, rowsAvailable - 1);
  single.forEach((p, i) => {
    if (p.bullet) setVal(report, `B${NARRATIVE.first + i}`, "•");
    setVal(report, `C${NARRATIVE.first + i}`, p.text);
  });
  const rest = physical.slice(single.length);
  if (rest.length > 0) {
    const last = report.getCell(`C${NARRATIVE.last}`);
    report.mergeCells(`C${NARRATIVE.last}:H${NARRATIVE.last}`);
    last.value = rest.map((p) => `${p.bullet ? "•  " : "    "}${p.text}`).join("\n");
    last.style = { ...last.style, alignment: { ...last.style.alignment, wrapText: true, vertical: "top" } };
    report.getRow(NARRATIVE.last).height = 15.75 * rest.length;
  }
  setVal(report, "C22", (ctx.progress?.concerns || "").trim() || "N/A");
  setVal(report, "C25", (ctx.progress?.correctiveAction || "").trim() || "N/A");
  // Row 28 carried the reference report's schedule sentence verbatim
  // ("Schedule: 24months. Time Passed: 11 months, Remaining 14 months") beside
  // Julie's own "UPDATE" reminder in K28, and the print area (A1:K36) reached
  // both. We hold no contract start/end date, so the line is cleared rather
  // than restated from another work plan's schedule.
  clearCell(report, "B28");
  clearCell(report, "K28");
  // …and the emptied row is hidden: it kept its grey fill, a bar across the page.
  report.getRow(28).hidden = true;
  const pct =
    ctx.progress?.percentComplete != null
      ? round2(ctx.progress.percentComplete / 100)
      : round2(fin.percentExpended);
  setVal(report, "E26", pct);
  // The cost forecast was a sentence assembled from six cells, and printed
  // with its figures adrift of its words ("…budget is        $ 850,000.00 .").
  // Written as the two sentences it is.
  const money = (n: number) =>
    `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const billedPct = fin.budget > 0 ? Math.round((fin.totalToDate / fin.budget) * 100) : 0;
  setVal(report, "B29", `Cost Forecast at Completion:  Current approved budget is ${money(fin.budget)}.`);
  try {
    report.unMergeCells("B30:C30");
  } catch {
    // not merged in this copy of the template
  }
  setVal(report, "B30", `Through this invoice, ${money(fin.totalToDate)} (${billedPct}%) has been billed.`);
  for (const addr of ["F29", "G29", "C30", "D30", "E30", "F30"]) clearCell(report, addr);
  // B30 wraps, in a column a few characters wide: only "billed." showed.
  const second = report.getCell("B30");
  second.style = {
    ...second.style,
    alignment: { ...second.style.alignment, wrapText: false, horizontal: "left", vertical: "middle" },
  };
  report.getRow(30).height = Math.max(report.getRow(30).height ?? 0, 18);

  // The frame. The report is one box, columns A to I, with A as its left
  // margin. The reference sheet also draws a line down the inside of that
  // margin, closes the title off in a box of its own, and the print area
  // stopped two rows short of the bottom edge — so the page came out as a
  // narrow strip down the left with an open-ended box beside it ("Please fix
  // the formatting so it looks good").
  for (let r = 1; r <= 38; r++) {
    for (const col of ["A", "B", "C", "D", "E", "F", "G", "H", "I"]) {
      const cell = report.getCell(`${col}${r}`);
      const border = { ...(cell.style.border ?? {}) };
      if (col === "B") delete border.left; // the line inside the margin
      if (col === "A") delete border.right;
      if (r === 2) delete border.top; // the line boxing the title in
      if (r === 1) border.top = { style: "thin" };
      if (r === 38) border.bottom = { style: "thin" };
      if (col === "A") border.left = { style: "thin" };
      if (col === "I") border.right = { style: "thin" };
      if (col === "A") {
        // The rules under the title carry on across the margin at the same
        // weight, instead of thinning out for its width.
        const beside = report.getCell(`B${r}`).style.border ?? {};
        if (r >= 5 && r <= 8) {
          if (beside.top) border.top = beside.top;
          if (beside.bottom) border.bottom = beside.bottom;
        }
      }
      cell.style = { ...cell.style, border };
    }
  }
  report.pageSetup = { ...report.pageSetup, printArea: "$A$1:$I$38" };

  // -- 5. Remove internal sheets + template week tabs, then sever any straggler
  // formulas/defined names that still pointed at them.
  for (const name of INTERNAL_SHEETS) removeSheet(wb, name);
  for (const name of TEMPLATE_WEEK_TABS) removeSheet(wb, name);
  freezeUnstableFormulas(wb, DELETED_REF_TOKENS);
  dropDeadDefinedNames(wb, DELETED_REF_TOKENS, "WSP");
  stripBrokenDefinedNames(wb);

  // -- 6. Generate fresh weekly timesheet tabs (one per week per contributor).
  const weeks = [...ctx.weeks].sort((a, b) => a.sortOrder - b.sortOrder);
  const persons = people.length > 0 ? people : [{ key: "name:", name: "", classification: "" }];
  const usedNames = new Set<string>(wb.worksheets.map((w) => w.name.toLowerCase()));
  const timesheetTabs: string[] = [];
  weeks.forEach((week, i) => {
    for (const person of persons) {
      const label = person.name
        ? `${initialsOf(person.name)} Week ${i + 1}`
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
      // The template's timesheets carry Jordy Peralta's signature; only that
      // person's own timesheet may keep it.
      // …and anyone else's starts clear of the words "Submitted by:", which
      // the template's own signature leaves room for inside its picture.
      settleTimesheetSignature(ws, person.name, TEMPLATE_SIGNER, ctx.employeeSignatures, { shiftRightPx: 26 });
      timesheetTabs.push(name);
    }
  });

  // Page order: the labor attachment comes before the progress report, as in
  // the packet she sends ("This page should be before progress report").
  const front = [INVOICE_SHEET, SUBCALC_SHEET, SUBLABOR_SHEET, PROGRESS_SHEET];
  const ordered = [
    ...front.map((n) => wb.getWorksheet(n)).filter((w): w is ExcelJS.Worksheet => !!w),
    ...wb.worksheets.filter((w) => !front.includes(w.name)),
  ];
  ordered.forEach((w, i) => {
    (w as unknown as { orderNo: number }).orderNo = i;
  });

  // -- 7. Finalize: scrub internal marks, recalc on load, Invoice active tab.
  scrubInternalMarks(wb);
  wb.calcProperties.fullCalcOnLoad = true;
  const inv = wb.worksheets.findIndex((w) => w.name === INVOICE_SHEET);
  if (inv >= 0) wb.views = [{ activeTab: inv } as ExcelJS.WorkbookView];

  fitSheetsToOnePage(wb);
  return { wb, timesheetTabs, financials: fin };
}

/** Who worked overtime (or doubletime) this period, at what premium rate. */
interface PremiumDetail {
  names: string[];
  hours: number;
  /** Distinct premium rates (0.5 × base for OT, 1.0 × base for DT). */
  rates: number[];
}

function premiumDetail(ctx: PackageDocContext, category: "ot" | "dt"): PremiumDetail {
  const factor = category === "ot" ? 0.5 : 1;
  const names = new Set<string>();
  const rates = new Set<number>();
  let hours = 0;
  for (const e of ctx.entries) {
    if (e.category !== category) continue;
    const h = entryHours(e);
    if (h <= 0) continue;
    const name = e.employeeName.trim();
    if (name) names.add(name);
    rates.add(round2(e.rate * factor));
    hours += h;
  }
  return { names: [...names], hours: round2(hours), rates: [...rates] };
}

/**
 * Writes one `Sub Calc _revised` premium row (24 = OT, 25 = DT). The template
 * hardcodes the reference invoice's employee and rate into the label cells
 * ("SS OT Premium(Jordy)" / "37/HR"), so a period worked by somebody else still
 * printed Jordy's name. When nobody worked the category the row is blanked
 * rather than left naming a person who did not.
 */
function writePremiumRow(
  ws: ExcelJS.Worksheet,
  row: number,
  label: string,
  detail: PremiumDetail,
): void {
  if (detail.hours <= 0 || detail.names.length === 0) {
    for (const col of ["D", "E", "F"]) clearCell(ws, `${col}${row}`);
    return;
  }
  const multiplier = row === 24 ? "0.5" : "1.0";
  const text = `${label} (${detail.names.join(", ")})`;
  setVal(ws, `D${row}`, text);
  // The label column is sized for the template's one-name text and the rate
  // cell beside it clips anything longer, so "SS OT Premium (Ana Ruiz)" printed
  // as "SS OT Premium (Ana". Widen it to fit whoever actually worked.
  const labelCol = ws.getColumn("D");
  labelCol.width = Math.max(labelCol.width ?? 0, text.length + 2);
  setVal(
    ws,
    `E${row}`,
    detail.rates.length === 1
      ? `${detail.rates[0].toFixed(2)}/HR`
      : `${multiplier} x base rate`,
  );
  setVal(ws, `F${row}`, `${detail.hours} HRS`);
}

const LABOR_COLS = ["B", "C", "D", "E", "F", "G", "H"] as const;

/** Writes one Sub Labor location block (rows start..end) and its subtotal. */
function writeLaborBlock(
  ws: ExcelJS.Worksheet,
  fin: WspFinancials,
  location: "home" | "field",
  block: { start: number; end: number; subtotal: number },
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
    setVal(ws, `B${row}`, r.classification);
    setVal(ws, `C${row}`, r.employeeName);
    setVal(ws, `D${row}`, r.hours);
    setVal(ws, `E${row}`, r.rate);
    setVal(ws, `F${row}`, amt);
    setNumberFormat(ws, `D${row}`, "0.00");
    setNumberFormat(ws, `E${row}`, MONEY_FORMAT);
    setNumberFormat(ws, `F${row}`, MONEY_FORMAT);
    // The rate cell alone is centred top-to-bottom, so it printed a little
    // above the hours and amount either side of it.
    const hoursCell = ws.getCell(`D${row}`);
    for (const col of ["E", "F"]) {
      const cell = ws.getCell(`${col}${row}`);
      cell.style = { ...cell.style, alignment: { ...hoursCell.style.alignment, horizontal: "right" } };
    }
    hours += r.hours;
    amount += amt;
  });
  if (rows.length > cap) {
    logger.warn(
      { location, overflow: rows.length - cap },
      "WSP Sub Labor block has more lines than template rows; extra lines omitted",
    );
  }
  setVal(ws, `D${block.subtotal}`, round2(hours));
  setVal(ws, `F${block.subtotal}`, round2(amount));
}

/**
 * WSP has two forms: the single-line one built here, and the one for a work
 * plan billed against several PO lines (see wspLinesWorkbook).
 */
function buildForForm(ctx: PackageDocContext): Promise<{ wb: ExcelJS.Workbook }> {
  return isWspLinesForm(ctx) ? buildWspLinesWorkbook(ctx) : buildWspWorkbook(ctx);
}

function safeSlug(ctx: PackageDocContext): string {
  const num = ctx.pkg.invoiceNumber || `PKG-${ctx.pkg.id}`;
  return num.replace(/[^A-Za-z0-9._-]/g, "_");
}

/** Writes the client-ready WSP Excel workbook (Invoice as the first tab). */
export async function generateWspWorkbookFile(ctx: PackageDocContext): Promise<string> {
  ensureDirs();
  const { wb } = await buildForForm(ctx);
  const outPath = path.resolve(generatedDir, `InvoicePackage_${safeSlug(ctx)}_${Date.now()}.xlsx`);
  await wb.xlsx.writeFile(outPath);
  return outPath;
}

/**
 * Writes the workbook variant used for PDF rendering. The WSP deliverable
 * carries no hidden client sheets — every remaining sheet is a client page —
 * so this is the same workbook; LibreOffice renders Invoice → Sub Calc
 * _revised → Progress Report → Sub Labor → weekly timesheets in order.
 */
export async function generateWspPdfSource(ctx: PackageDocContext): Promise<string> {
  ensureDirs();
  const { wb } = await buildForForm(ctx);
  const outPath = path.resolve(
    generatedDir,
    `InvoicePackagePdfSrc_${safeSlug(ctx)}_${Date.now()}.xlsx`,
  );
  await wb.xlsx.writeFile(outPath);
  return outPath;
}
