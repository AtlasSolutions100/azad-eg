import ExcelJS from "exceljs";
import path from "node:path";
import fs from "node:fs";
import { templatesDir } from "./paths";
import {
  fitSheetsToOnePage,
  reviveModelDates,
  scrubInternalMarks,
  settleTimesheetSignature,
  stripBrokenDefinedNames,
} from "./excel";
import { agreementNumber, knownHeader } from "./knownInvoiceHeaders";
import { knownPoSchedule, splitProRata, type PoLine } from "./poSchedule";
import { contributorKey } from "./packageMappers";
import { burdenOnFringeLine } from "./billingProfile";
import { logger } from "./logger";
import type { PackageDocContext } from "./packageDocs";
import type { PackageWeekRow, TimesheetEntryRow } from "@workspace/db";

/**
 * WSP invoice for a work plan billed against several PO lines.
 *
 * De'Andre Rashad's work plan (A.03.01, Procas 10013.TO01) is charged to three
 * BART projects — 15EJRRC, 15EJRRK, 49GH006 — and each is its own line on WSP's
 * purchase order. Julie's invoice for it is a different form from the one the
 * other WSP work plans use: the cover lists the three lines (Current Month /
 * Previously Billed / Total to-Date / Budget / Remaining), each line has its
 * own Invoice Detail and Labor Attachment, an "Overall Invoice Detail" adds
 * them up, and the timesheet has one row per BART project.
 *
 * The single-line WSP form could only print this work plan as one lump, so it
 * was the one WSP invoice the app could not produce. This engine fills her own
 * workbook (invoice A.03.01-23, June 2026) the way the other engines do: every
 * cell is written as a value, because the PDF renderer does not recalculate.
 *
 * Which line an hour belongs to comes from Procas: time is booked to a leaf
 * project per BART project ("10013.TO01.0001…" is 15EJRRC), and the pull keeps
 * that on the timesheet entry's Task No.
 */

const TEMPLATE_FILE = "wsp-lines-invoice-template.xlsx";
/** Whose signature the template's timesheet tab carries. */
const TEMPLATE_SIGNER = "De'Andre Rashad";

const INVOICE_SHEET = "Invoice";
const OVERALL_SHEET = "Prime Overall Inv";
const PROGRESS_SHEET = "Progress Report-DeAndre";
const LABOR_TEMPLATE_SHEET = "Prime Labor 1-1";
const WEEK_TEMPLATE_SHEET = "DR Week 1";
/** The form has a Calc/Labor pair, a cover row and a timesheet row for each. */
const MAX_LINES = 3;

/** Field labor rows on the Labor Attachment (home rows 6-17 stay empty). */
const LABOR_FIELD = { start: 28, end: 31, subtotal: 32, total: 35 };
const LABOR_STYLE_ROW = 29;

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function toDate(value: string): Date {
  const [y, m, d] = value.split("-").map((n) => parseInt(n, 10));
  return new Date(y, (m || 1) - 1, d || 1, 12, 0, 0);
}

function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function saturdayOnOrBefore(date: Date): Date {
  return addDays(date, -((date.getDay() + 1) % 7));
}

function formatMDY(date: Date): string {
  return `${date.getMonth() + 1}/${date.getDate()}/${date.getFullYear()}`;
}

function setVal(ws: ExcelJS.Worksheet, address: string, value: ExcelJS.CellValue): void {
  const cell = ws.getCell(address);
  const style = cell.style;
  cell.value = value;
  cell.style = style;
}

function clearCell(ws: ExcelJS.Worksheet, address: string): void {
  setVal(ws, address, null);
}

/**
 * Lets a timesheet's contract label shrink to its cell instead of being cut
 * off ("6M8178 A.03.01 15EJRRC" loses its project number otherwise).
 *
 * Only for cells whose text must fit the cell itself. A label that is meant
 * to run on into the empty cells beside it ("Home & Branch (H&B)", "Fixed Fee
 * on Labor & Overhead", "TOTAL AMOUNT DUE") is shrunk to a few points by this,
 * and so is every other cell sharing its style — the style is replaced here,
 * never edited in place, because exceljs hands the same object to all of them.
 */
function shrink(ws: ExcelJS.Worksheet, ...addresses: string[]): void {
  for (const a of addresses) {
    const cell = ws.getCell(a);
    cell.style = {
      ...cell.style,
      alignment: { ...cell.style.alignment, wrapText: false, shrinkToFit: true },
    };
  }
}

function entryHours(e: TimesheetEntryRow): number {
  return e.hoursMon + e.hoursTue + e.hoursWed + e.hoursThu + e.hoursFri + e.hoursSat + e.hoursSun;
}

function isBillable(category: string): boolean {
  return category !== "pto" && category !== "holiday";
}

function initialsOf(name: string): string {
  const parts = name.replace(/[^A-Za-z\s]/g, "").trim().split(/\s+/).filter(Boolean);
  return (parts.map((p) => p[0]).join("") || "EE").toUpperCase().slice(0, 3);
}

const projectKey = (v: string | null | undefined) => (v ?? "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();

/**
 * True when this work plan's invoice lists more than one PO line, which is
 * what makes it this form rather than the single-line WSP one.
 */
export function isWspLinesForm(ctx: Pick<PackageDocContext, "workPlan">): boolean {
  const wp = ctx.workPlan as { procasProject?: string | null; jobNumber?: string | null };
  const schedule = knownPoSchedule(wp.procasProject, wp.jobNumber);
  return !!schedule && schedule.length > 1 && schedule.length <= MAX_LINES;
}

// ---------------------------------------------------------------------------
// Financials
// ---------------------------------------------------------------------------

interface LineLaborRow {
  name: string;
  classification: string;
  rate: number;
  hours: number;
  amount: number;
}

/** One column of an Invoice Detail: labor, fringe, overhead pool, fee, FCCM. */
interface Parts {
  labor: number;
  fringe: number;
  pool: number;
  fee: number;
  fccm: number;
  total: number;
}

export interface WspLine {
  project: string;
  lineNo: number;
  laborRows: LineLaborRow[];
  hours: number;
  previousHours: number | null;
  budget: Parts;
  current: Parts;
  previous: Parts;
  toDate: Parts;
}

export interface WspLinesFinancials {
  lines: WspLine[];
  fringeFrac: number;
  poolFrac: number;
  feeFrac: number;
  fccmFrac: number;
  totalThisPeriod: number;
  previouslyBilled: number;
  totalToDate: number;
  budget: number;
}

const ZERO: Parts = { labor: 0, fringe: 0, pool: 0, fee: 0, fccm: 0, total: 0 };

function addParts(a: Parts, b: Parts): Parts {
  return {
    labor: round2(a.labor + b.labor),
    fringe: round2(a.fringe + b.fringe),
    pool: round2(a.pool + b.pool),
    fee: round2(a.fee + b.fee),
    fccm: round2(a.fccm + b.fccm),
    total: round2(a.total + b.total),
  };
}

interface Rates {
  fringeFrac: number;
  poolFrac: number;
  feeFrac: number;
  fccmFrac: number;
}

/** Builds a column up from its direct labor, as her formulas do. */
function partsFromLabor(labor: number, r: Rates): Parts {
  const fringe = round2(labor * r.fringeFrac);
  const pool = round2(labor * r.poolFrac);
  const fee = round2((labor + fringe + pool) * r.feeFrac);
  const fccm = round2(labor * r.fccmFrac);
  return { labor: round2(labor), fringe, pool, fee, fccm, total: round2(labor + fringe + pool + fee + fccm) };
}

/**
 * Splits a known total back into its parts at the work plan's rates. Only the
 * total is known for money billed before this package, so the parts are what
 * they would be at today's rates, with any cent of rounding left on the labor.
 */
function partsFromTotal(total: number, r: Rates): Parts {
  const multiplier = (1 + r.fringeFrac + r.poolFrac) * (1 + r.feeFrac) + r.fccmFrac;
  if (total === 0 || multiplier <= 0) return { ...ZERO };
  const p = partsFromLabor(round2(total / multiplier), r);
  const residue = round2(total - p.total);
  return { ...p, labor: round2(p.labor + residue), total: round2(total) };
}

type EntryList = PackageDocContext["entries"];

/**
 * The entries behind each PO line. An entry's Task No. names its BART project.
 * Entries without one (typed by hand, or pulled before the pull kept the
 * project) are shared across the lines in proportion to their PO amounts, in
 * quarter hours, so the invoice still totals what the timesheets do.
 */
function hoursByLine(
  entries: EntryList,
  lines: Array<{ project: string; poAmount: number }>,
): { rows: LineLaborRow[][]; unassignedHours: number } {
  const maps = lines.map(() => new Map<string, LineLaborRow>());
  const add = (i: number, e: EntryList[number], hours: number) => {
    if (hours <= 0) return;
    const key = `${contributorKey(e)}|${e.rate}`;
    const row = maps[i].get(key) ?? {
      name: e.employeeName,
      classification: e.classification,
      rate: e.rate,
      hours: 0,
      amount: 0,
    };
    row.hours = round2(row.hours + hours);
    maps[i].set(key, row);
  };
  let unassignedHours = 0;
  for (const e of entries) {
    if (!isBillable(e.category)) continue;
    const hours = entryHours(e);
    if (hours <= 0) continue;
    const i = lines.findIndex((l) => l.project === projectKey(e.taskNo));
    if (i >= 0) {
      add(i, e, hours);
      continue;
    }
    unassignedHours += hours;
    const quarters = splitProRata(hours * 4, lines.map((l) => l.poAmount)).map((q) => Math.round(q));
    quarters[quarters.length - 1] += Math.round(hours * 4) - quarters.reduce((s, q) => s + q, 0);
    quarters.forEach((q, n) => add(n, e, q / 4));
  }
  return {
    rows: maps.map((m) =>
      [...m.values()]
        .map((r) => ({ ...r, amount: round2(r.hours * r.rate) }))
        .sort((a, b) => b.amount - a.amount || a.name.localeCompare(b.name)),
    ),
    unassignedHours: round2(unassignedHours),
  };
}

export function computeWspLinesFinancials(ctx: PackageDocContext): WspLinesFinancials {
  const wp = ctx.workPlan as PackageDocContext["workPlan"] & { procasProject?: string | null };
  const rates: Rates = {
    fringeFrac: burdenOnFringeLine(wp).fringeFrac,
    poolFrac: burdenOnFringeLine(wp).overheadFrac,
    feeFrac: (wp.fixedFeeRate ?? 0) / 100,
    fccmFrac: (wp.fccmRate ?? 0) / 100,
  };
  const schedule = knownPoSchedule(wp.procasProject, wp.jobNumber) ?? [];
  const detail = new Map<string, PoLine>(schedule.map((l) => [projectKey(l.bartProjectNo), l]));

  // The rows the package shows — typed by the biller, carried forward, or
  // computed from the PO schedule — are the lines, their budgets and what each
  // has been billed before.
  const rows = [...ctx.billedLineItems]
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .slice(0, MAX_LINES);
  const base = rows.map((r) => ({ project: projectKey(r.bartProjectNo), poAmount: r.poAmount }));
  const { rows: labor } = hoursByLine(ctx.entries, base);

  const prevHoursTotal = ctx.pkg.previousHours;
  const anchorHours = rows.map((r) => detail.get(projectKey(r.bartProjectNo))?.anchor?.hours ?? 0);
  const anchorHoursTotal = anchorHours.reduce((s, h) => s + h, 0);
  const laterHours =
    prevHoursTotal == null
      ? null
      : splitProRata(
          Math.max(0, prevHoursTotal - anchorHoursTotal),
          rows.map((r) => r.poAmount),
        );

  const lines: WspLine[] = rows.map((r, i) => {
    const known = detail.get(projectKey(r.bartProjectNo));
    const laborRows = labor[i];
    const current = partsFromLabor(round2(laborRows.reduce((s, x) => s + x.amount, 0)), rates);

    // Previously billed, part by part: her invoice's own to-date figures as far
    // as they go, and anything billed since at the current rates.
    const anchor = known?.anchor;
    let previous: Parts;
    if (anchor && r.previousInvoiced >= anchor.total - 0.005) {
      const anchorParts: Parts = {
        labor: anchor.labor,
        fringe: anchor.fringe,
        pool: 0,
        fee: anchor.fee,
        fccm: anchor.fccm,
        total: anchor.total,
      };
      previous = addParts(anchorParts, partsFromTotal(round2(r.previousInvoiced - anchor.total), rates));
    } else {
      previous = partsFromTotal(round2(r.previousInvoiced), rates);
    }

    // The budget column. Hers splits each line's budget into labor, fringe and
    // fee; where we hold that split it is used, otherwise it is derived.
    let budget: Parts;
    if (known?.budgetSplit && Math.abs(known.poAmount - r.poAmount) < 0.005) {
      const { labor: bl, fringe: bf } = known.budgetSplit;
      budget = { labor: bl, fringe: bf, pool: 0, fee: round2(r.poAmount - bl - bf), fccm: 0, total: round2(r.poAmount) };
    } else {
      budget = { ...partsFromTotal(round2(r.poAmount), { ...rates, fccmFrac: 0 }) };
    }

    return {
      project: (r.bartProjectNo ?? "").trim(),
      lineNo: r.lineNo ?? i + 1,
      laborRows,
      hours: round2(laborRows.reduce((s, x) => s + x.hours, 0)),
      previousHours: laterHours == null ? null : round2((anchor ? anchorHours[i] : 0) + laterHours[i]),
      budget,
      current,
      previous,
      toDate: addParts(current, previous),
    };
  });

  const totalThisPeriod = round2(lines.reduce((s, l) => s + l.current.total, 0));
  const previouslyBilled = round2(lines.reduce((s, l) => s + l.previous.total, 0));
  return {
    lines,
    ...rates,
    totalThisPeriod,
    previouslyBilled,
    totalToDate: round2(totalThisPeriod + previouslyBilled),
    budget: round2(lines.reduce((s, l) => s + l.budget.total, 0)),
  };
}

// ---------------------------------------------------------------------------
// Sheet writers
// ---------------------------------------------------------------------------

/**
 * Replaces every formula on a sheet with a plain value before the real figures
 * go in: a label keeps its text, a number becomes 0, anything else is emptied.
 * The reference workbook's formulas reach into forty sheets that are not part
 * of the deliverable, and unevaluated they print its June numbers.
 */
function settleFormulas(ws: ExcelJS.Worksheet): void {
  ws.eachRow({ includeEmpty: false }, (row) => {
    row.eachCell({ includeEmpty: false }, (cell) => {
      const v = cell.value as { formula?: string; sharedFormula?: string; result?: unknown } | null;
      if (!v || typeof v !== "object" || (v.formula == null && v.sharedFormula == null)) return;
      const r = v.result;
      const style = cell.style;
      cell.value = typeof r === "string" && !r.startsWith("#") ? r : typeof r === "number" ? 0 : null;
      cell.style = style;
    });
  });
}

/** Empties the working columns to the right of a form. */
function clearRight(ws: ExcelJS.Worksheet, firstCol: number, lastRow: number): void {
  for (let r = 1; r <= lastRow; r++) {
    const row = ws.getRow(r);
    for (let c = firstCol; c <= Math.max(ws.columnCount, firstCol); c++) {
      const cell = row.getCell(c);
      if (cell.value != null) {
        const style = cell.style;
        cell.value = null;
        cell.style = style;
      }
    }
  }
}

const pct = (part: number, whole: number) => (whole > 0 ? part / whole : 0);

/** Writes an Invoice Detail sheet (one line's, or the overall one). */
function writeDetail(
  ws: ExcelJS.Worksheet,
  head: { date: Date | null; invoiceNo: string; workPlan: string; project: string },
  hours: { current: number; previous: number | null },
  cols: { budget: Parts; current: Parts; previous: Parts; toDate: Parts },
  rates: Rates,
): void {
  settleFormulas(ws);
  clearRight(ws, 12, 60);
  setVal(ws, "J1", head.date);
  setVal(ws, "J2", head.invoiceNo);
  setVal(ws, "I3", head.workPlan);
  setVal(ws, "J3", head.project);

  // Hours to date: the work is all Field on this form.
  setVal(ws, "D7", 0);
  setVal(ws, "E7", 0);
  setVal(ws, "F7", 0);
  setVal(ws, "D11", hours.current);
  if (hours.previous == null) clearCell(ws, "E11");
  else setVal(ws, "E11", hours.previous);
  setVal(ws, "F11", round2(hours.current + (hours.previous ?? 0)));
  setVal(ws, "D12", rates.fringeFrac);
  setVal(ws, "D13", rates.poolFrac);
  setVal(ws, "D14", rates.fringeFrac + rates.poolFrac);
  clearCell(ws, "D15");
  setVal(ws, "E38", rates.feeFrac);
  setVal(ws, "E44", rates.fccmFrac);
  setVal(ws, "B44", `FCCM Field (${(rates.fccmFrac * 100).toFixed(2)}% x Direct labor)`);

  const columns: Array<[string, Parts]> = [
    ["G", cols.budget],
    ["H", cols.current],
    ["I", cols.previous],
    ["J", cols.toDate],
  ];
  for (const [col, p] of columns) {
    const laborBlock = round2(p.labor + p.fringe + p.pool);
    setVal(ws, `${col}11`, p.labor);
    setVal(ws, `${col}12`, p.fringe);
    setVal(ws, `${col}13`, p.pool);
    setVal(ws, `${col}14`, laborBlock);
    setVal(ws, `${col}20`, laborBlock);
    setVal(ws, `${col}38`, p.fee);
    setVal(ws, `${col}42`, p.fee);
    setVal(ws, `${col}44`, p.fccm);
    setVal(ws, `${col}46`, p.total);
  }
  const laborOf = (p: Parts) => p.labor + p.fringe + p.pool;
  setVal(ws, "K20", pct(laborOf(cols.toDate), laborOf(cols.budget)));
  setVal(ws, "K42", pct(cols.toDate.fee, cols.budget.fee));
  setVal(ws, "K46", pct(cols.toDate.total, cols.budget.total));
  // `=J36/G36` on an empty PMAC block is #DIV/0!; the row is hidden but an
  // error cell is still an error cell when the workbook is opened.
  setVal(ws, "K36", 0);
  setVal(ws, "G47", round2(cols.budget.total - cols.toDate.total));
  const expended = ws.getColumn("K");
  expended.width = Math.max(expended.width ?? 0, 11);
  ws.pageSetup = { ...ws.pageSetup, printArea: "A1:K47" };
}

/** Writes one line's Labor Attachment. */
function writeLabor(
  ws: ExcelJS.Worksheet,
  head: { date: Date | null; invoiceNo: string; workPlan: string; project: string },
  rows: LineLaborRow[],
): void {
  settleFormulas(ws);
  clearRight(ws, 7, 60);
  setVal(ws, "F1", head.date);
  setVal(ws, "F2", head.invoiceNo);
  setVal(ws, "E3", head.workPlan);
  setVal(ws, "F3", head.project);
  // A stray backtick under the form in the reference workbook.
  clearCell(ws, "D45");
  for (let r = 5; r <= 40; r++) clearCell(ws, `A${r}`);

  const look = ["B", "C", "D", "E", "F"].map((col) =>
    JSON.parse(JSON.stringify(ws.getCell(`${col}${LABOR_STYLE_ROW}`).style)),
  );
  const cap = LABOR_FIELD.end - LABOR_FIELD.start + 1;
  if (rows.length > cap) {
    logger.warn(
      { overflow: rows.length - cap },
      "WSP line-form Labor Attachment has more people than template rows; extra lines omitted",
    );
  }
  let hours = 0;
  let amount = 0;
  for (let r = LABOR_FIELD.start; r <= LABOR_FIELD.end; r++) {
    const row = rows[r - LABOR_FIELD.start];
    ["B", "C", "D", "E", "F"].forEach((col, i) => {
      clearCell(ws, `${col}${r}`);
      ws.getCell(`${col}${r}`).style = JSON.parse(JSON.stringify(look[i]));
    });
    // The reference hides the rows of people who had no hours that month.
    ws.getRow(r).hidden = !row && r > LABOR_FIELD.start;
    if (!row) continue;
    setVal(ws, `B${r}`, row.name);
    setVal(ws, `C${r}`, row.classification);
    setVal(ws, `D${r}`, row.hours);
    setVal(ws, `E${r}`, row.rate);
    setVal(ws, `F${r}`, row.amount);
    hours += row.hours;
    amount += row.amount;
  }
  setVal(ws, `D${LABOR_FIELD.subtotal}`, round2(hours));
  setVal(ws, `F${LABOR_FIELD.subtotal}`, round2(amount));
  setVal(ws, `D${LABOR_FIELD.total}`, round2(hours));
  setVal(ws, `F${LABOR_FIELD.total}`, round2(amount));
  ws.pageSetup = { ...ws.pageSetup, printArea: `A1:F${LABOR_FIELD.total}` };
}

interface Contributor {
  key: string;
  name: string;
  classification: string;
}

function contributors(ctx: PackageDocContext): Contributor[] {
  const seen = new Map<string, Contributor>();
  for (const e of ctx.entries) {
    const name = e.employeeName.trim();
    if (!name) continue;
    const key = contributorKey(e);
    if (!seen.has(key)) seen.set(key, { key, name, classification: e.classification });
  }
  return [...seen.values()];
}

/** Day columns on the timesheet: H=Sat … N=Fri; O is the row total. */
const DAY_COLS = ["H", "I", "J", "K", "L", "M", "N"] as const;
const DAY_FIELDS = ["hoursSat", "hoursSun", "hoursMon", "hoursTue", "hoursWed", "hoursThu", "hoursFri"] as const;

/**
 * Fills a weekly timesheet: one row per BART project (rows 9-11), then PTO
 * (12), Holiday (13) and a spare row (14) for hours with no project on them.
 */
function fillTimesheet(
  ws: ExcelJS.Worksheet,
  week: PackageWeekRow,
  ctx: PackageDocContext,
  person: Contributor,
  projects: string[],
): void {
  const wp = ctx.workPlan;
  const saturday = saturdayOnOrBefore(toDate(week.weekStart));
  settleFormulas(ws);
  setVal(ws, "D5", person.name);
  DAY_COLS.forEach((col, i) => setVal(ws, `${col}6`, addDays(saturday, i)));
  setVal(ws, "J5", addDays(saturday, 6));

  for (let r = 9; r <= 14; r++) {
    for (const col of ["B", "D", ...DAY_COLS, "O"]) clearCell(ws, `${col}${r}`);
  }
  const contract = `${agreementNumber(wp.agreementNo)} ${wp.code}`.trim();
  const rowOf = (e: TimesheetEntryRow): number => {
    if (e.category === "pto") return 12;
    if (e.category === "holiday") return 13;
    const i = projects.findIndex((p) => projectKey(p) === projectKey(e.taskNo));
    return i >= 0 ? 9 + i : 14;
  };
  const acc = new Map<number, number[]>();
  for (const e of ctx.entries.filter((x) => x.weekId === week.id && contributorKey(x) === person.key)) {
    const r = rowOf(e);
    const a = acc.get(r) ?? [0, 0, 0, 0, 0, 0, 0];
    DAY_FIELDS.forEach((f, i) => (a[i] += e[f]));
    acc.set(r, a);
  }
  projects.forEach((p, i) => {
    setVal(ws, `B${9 + i}`, `${contract}  ${p}`);
    setVal(ws, `D${9 + i}`, person.classification);
    shrink(ws, `B${9 + i}`);
  });
  shrink(ws, "B7");
  setVal(ws, "B12", "PTO (Sick/Vacation)");
  setVal(ws, "B13", "Holiday");
  if (acc.has(14)) {
    setVal(ws, "B14", contract);
    setVal(ws, "D14", person.classification);
  }
  const colTotals = [0, 0, 0, 0, 0, 0, 0];
  let grand = 0;
  for (let r = 9; r <= 14; r++) {
    const a = acc.get(r);
    let rowTotal = 0;
    DAY_COLS.forEach((col, i) => {
      const v = round2(a?.[i] ?? 0);
      if (v > 0) setVal(ws, `${col}${r}`, v);
      rowTotal += v;
      colTotals[i] += v;
    });
    setVal(ws, `O${r}`, round2(rowTotal));
    grand += rowTotal;
  }
  DAY_COLS.forEach((col, i) => setVal(ws, `${col}15`, round2(colTotals[i])));
  setVal(ws, "O15", round2(grand));
  ws.pageSetup = { ...ws.pageSetup, printArea: "A1:O20" };
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

export interface WspLinesBuildResult {
  wb: ExcelJS.Workbook;
  timesheetTabs: string[];
  financials: WspLinesFinancials;
}

export async function buildWspLinesWorkbook(ctx: PackageDocContext): Promise<WspLinesBuildResult> {
  const file = path.resolve(templatesDir, TEMPLATE_FILE);
  if (!fs.existsSync(file)) throw new Error(`WSP line-form template not found at ${file}`);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);

  const wp = ctx.workPlan as PackageDocContext["workPlan"] & { procasProject?: string | null };
  const pkg = ctx.pkg;
  const fin = computeWspLinesFinancials(ctx);
  const rates: Rates = fin;
  const header = knownHeader(wp.procasProject, wp.jobNumber);

  const invoiceDate = pkg.invoiceDate ? toDate(pkg.invoiceDate) : null;
  const invoiceNo = pkg.invoiceNumber || "";
  const periodStart = toDate(pkg.payPeriodStart);
  const periodEnd = toDate(pkg.payPeriodEnd);
  const workPlanLabel = `Work Plan ${wp.code}`;

  const laborModel = JSON.parse(JSON.stringify(wb.getWorksheet(LABOR_TEMPLATE_SHEET)!.model));
  const weekModel = JSON.parse(JSON.stringify(wb.getWorksheet(WEEK_TEMPLATE_SHEET)!.model));
  const clone = (model: unknown, name: string): ExcelJS.Worksheet => {
    const ws = wb.addWorksheet(name);
    const cloned = JSON.parse(JSON.stringify(model));
    reviveModelDates(cloned);
    cloned.id = ws.id;
    cloned.name = name;
    ws.model = cloned;
    ws.name = name;
    ws.state = "visible";
    return ws;
  };

  // -- 1. Invoice (cover).
  const invoice = wb.getWorksheet(INVOICE_SHEET)!;
  settleFormulas(invoice);
  clearRight(invoice, 16, 60);
  setVal(invoice, "L5", `${agreementNumber(wp.agreementNo)} ${invoiceNo}`.trim());
  setVal(invoice, "L7", invoiceDate);
  setVal(invoice, "M40", invoiceDate);
  setVal(invoice, "L9", wp.poNumber || "");
  setVal(invoice, "L11", wp.supplierId || "");
  setVal(invoice, "N12", invoiceNo);
  if (wp.sendToCompany) setVal(invoice, "D13", wp.sendToCompany);
  if (wp.sendToAddress1) setVal(invoice, "D14", wp.sendToAddress1);
  if (wp.sendToAddress2) setVal(invoice, "D15", wp.sendToAddress2);
  const email = (header?.sendToExtra ?? "").replace(/^email:\s*/i, "");
  if (email) {
    setVal(invoice, "D16", email);
    setVal(invoice, "H19", `Email: ${email}`);
  }
  clearCell(invoice, "J16");
  if (wp.contactPerson) setVal(invoice, "B19", `Contact Person: ${wp.contactPerson}`);
  setVal(invoice, "E21", agreementNumber(wp.agreementNo));
  setVal(invoice, "E22", wp.title || "");
  setVal(invoice, "L22", wp.bartProjectNumbers || fin.lines.map((l) => l.project).join(", "));
  setVal(invoice, "G23", periodStart);
  setVal(invoice, "I23", periodEnd);
  setVal(invoice, "L24", wp.terms || "");
  setVal(invoice, "B26", workPlanLabel);
  for (let i = 0; i < MAX_LINES; i++) {
    const r = 28 + i;
    const line = fin.lines[i];
    for (const col of ["B", "C", "F", "H", "J", "L", "N"]) clearCell(invoice, `${col}${r}`);
    if (!line) continue;
    setVal(invoice, `B${r}`, `${line.lineNo}- 1`);
    setVal(invoice, `C${r}`, line.project);
    setVal(invoice, `F${r}`, line.current.total);
    setVal(invoice, `H${r}`, line.previous.total);
    setVal(invoice, `J${r}`, line.toDate.total);
    setVal(invoice, `L${r}`, line.budget.total);
    setVal(invoice, `N${r}`, round2(line.budget.total - line.toDate.total));
  }
  setVal(invoice, "F33", fin.totalThisPeriod);
  setVal(invoice, "H33", fin.previouslyBilled);
  setVal(invoice, "J33", fin.totalToDate);
  setVal(invoice, "L33", fin.budget);
  setVal(invoice, "N33", round2(fin.budget - fin.totalToDate));
  invoice.pageSetup = { ...invoice.pageSetup, printArea: "A1:O46" };

  // -- 2. One Invoice Detail + Labor Attachment per line.
  const order: ExcelJS.Worksheet[] = [invoice];
  for (let i = 1; i < MAX_LINES; i++) {
    const own = wb.getWorksheet(`Prime Labor ${i + 1}-1`);
    if (own) wb.removeWorksheet(own.id);
  }
  fin.lines.forEach((line, i) => {
    const head = { date: invoiceDate, invoiceNo, workPlan: workPlanLabel, project: line.project };
    const calc = wb.getWorksheet(`Prime Calc ${i + 1}-1`)!;
    writeDetail(calc, head, { current: line.hours, previous: line.previousHours }, line, rates);
    // The three reference Labor Attachments are laid out three different ways
    // (the field block starts on row 28, 19 and 24), so lines after the first
    // are built on a copy of the first.
    const labor =
      i === 0 ? wb.getWorksheet(LABOR_TEMPLATE_SHEET)! : clone(laborModel, `Prime Labor ${i + 1}-1`);
    writeLabor(labor, head, line.laborRows);
    order.push(calc, labor);
  });
  for (let i = fin.lines.length; i < MAX_LINES; i++) {
    const calc = wb.getWorksheet(`Prime Calc ${i + 1}-1`);
    if (calc) wb.removeWorksheet(calc.id);
  }

  // -- 3. Overall Invoice Detail: the lines added up.
  const overall = wb.getWorksheet(OVERALL_SHEET)!;
  const sum = (pick: (l: WspLine) => Parts) => fin.lines.reduce((s, l) => addParts(s, pick(l)), { ...ZERO });
  const anyPrevHours = fin.lines.some((l) => l.previousHours != null);
  writeDetail(
    overall,
    { date: invoiceDate, invoiceNo, workPlan: workPlanLabel, project: "" },
    {
      current: round2(fin.lines.reduce((s, l) => s + l.hours, 0)),
      previous: anyPrevHours ? round2(fin.lines.reduce((s, l) => s + (l.previousHours ?? 0), 0)) : null,
    },
    {
      budget: sum((l) => l.budget),
      current: sum((l) => l.current),
      previous: sum((l) => l.previous),
      toDate: sum((l) => l.toDate),
    },
    rates,
  );
  order.push(overall);

  // -- 4. Progress Report.
  const report = wb.getWorksheet(PROGRESS_SHEET)!;
  settleFormulas(report);
  clearRight(report, 7, 60);
  const people = contributors(ctx);
  const periodStr = `${formatMDY(periodStart)}-${formatMDY(periodEnd)}`;
  const reportDate = ctx.progress?.reportDate ? toDate(ctx.progress.reportDate) : invoiceDate;
  setVal(report, "A2", `Agreement No. ${agreementNumber(wp.agreementNo)}`);
  setVal(report, "A4", periodStr);
  // The label and the number sit in two cells and printed run together
  // ("Work Plan NA.03.01"); one cell keeps the space between them.
  setVal(report, "A6", `Work Plan No:  ${wp.code}`);
  clearCell(report, "B6");
  setVal(report, "D6", wp.poNumber || "");
  setVal(report, "F6", reportDate);
  setVal(report, "E54", reportDate);
  setVal(report, "A7", wp.title || "");
  setVal(report, "F7", periodStr);
  setVal(report, "A9", people.length ? `${people.map((p) => p.name).join(", ")}'s summary:` : "");
  for (let r = 11; r <= 39; r++) {
    clearCell(report, `A${r}`);
    clearCell(report, `B${r}`);
  }
  const narrative = (ctx.progress?.workPerformed || ctx.progress?.summary || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 28);
  narrative.forEach((line, i) => {
    setVal(report, `A${11 + i}`, "•");
    setVal(report, `B${11 + i}`, line.replace(/^[-•·*]\s*/, ""));
  });
  setVal(report, "D41", (ctx.progress?.concerns || "").trim() || "N/A");
  setVal(report, "D42", (ctx.progress?.correctiveAction || "").trim() || "N/A");
  setVal(
    report,
    "D45",
    ctx.progress?.percentComplete != null
      ? ctx.progress.percentComplete / 100
      : pct(fin.totalToDate, fin.budget),
  );
  // The reference report's schedule sentence ("19 months. Time Passed: 22
  // months…") is its own month's; we hold no contract dates to restate it.
  clearCell(report, "A47");
  setVal(report, "E48", fin.budget);
  setVal(report, "C49", fin.totalToDate);
  clearCell(report, "D49");
  report.name = "Progress Report";
  report.pageSetup = { ...report.pageSetup, printArea: "A1:F56" };
  order.push(report);

  // -- 5. Weekly timesheets, one per person per week worked.
  const template = wb.getWorksheet(WEEK_TEMPLATE_SHEET)!;
  wb.removeWorksheet(template.id);
  const projects = fin.lines.map((l) => l.project);
  const weeks = [...ctx.weeks].sort((a, b) => a.sortOrder - b.sortOrder);
  const used = new Set(wb.worksheets.map((w) => w.name.toLowerCase()));
  const timesheetTabs: string[] = [];
  weeks.forEach((week, i) => {
    for (const person of people) {
      const worked = ctx.entries.some(
        (x) => x.weekId === week.id && contributorKey(x) === person.key && entryHours(x) > 0,
      );
      if (!worked) continue;
      let name = `${initialsOf(person.name)} Week ${i + 1}`;
      for (let n = 2; used.has(name.toLowerCase()); n++) name = `${initialsOf(person.name)}${n} Week ${i + 1}`;
      used.add(name.toLowerCase());
      const ws = clone(weekModel, name);
      fillTimesheet(ws, week, ctx, person, projects);
      settleTimesheetSignature(ws, person.name, TEMPLATE_SIGNER, ctx.employeeSignatures);
      timesheetTabs.push(name);
      order.push(ws);
    }
  });

  // -- 6. Finalize: page order, no leftovers, print setup.
  order.forEach((ws, i) => {
    (ws as unknown as { orderNo: number }).orderNo = i;
  });
  stripBrokenDefinedNames(wb);
  scrubInternalMarks(wb);
  wb.calcProperties.fullCalcOnLoad = true;
  wb.views = [{ activeTab: 0 } as ExcelJS.WorkbookView];
  fitSheetsToOnePage(wb);
  return { wb, timesheetTabs, financials: fin };
}
