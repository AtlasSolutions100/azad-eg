import ExcelJS from "exceljs";
import path from "node:path";
import fs from "node:fs";
import { ZipArchive } from "archiver";
import { templatesDir, generatedDir, ensureDirs } from "./paths";
import { convertToPdf, stripBrokenDefinedNames } from "./excel";
import { buildPackageRollup, contributorKey } from "./packageMappers";
import { pruneGeneratedFiles } from "./generatedCleanup";
import { logger } from "./logger";
import { clientFileBase } from "./invoiceRegister";
import type {
  PackageRow,
  PackageWeekRow,
  TimesheetEntryRow,
  PackageProgressReportRow,
  LaborOverrideRow,
  BilledLineItemRow,
  Employee,
} from "@workspace/db";
import type { EffectiveWorkPlan } from "./billingProfile";

export type PackageDocKind = "invoice" | "subcalc" | "progress" | "labor" | "timesheets";

export interface PackageDocContext {
  pkg: PackageRow;
  /** Legacy primary employee, or null for job-level (multi-employee) packages. */
  employee: Pick<Employee, "name" | "classification"> | null;
  /**
   * The package's effective billing profile — a real work plan when one is
   * linked, otherwise a view synthesized from the package's own billing
   * fields (see billingProfile.ts).
   */
  workPlan: EffectiveWorkPlan;
  weeks: PackageWeekRow[];
  entries: TimesheetEntryRow[];
  progress: PackageProgressReportRow | null;
  overrides: LaborOverrideRow[];
  /** Absolute path to the approver signature image, or null. */
  signatureImagePath: string | null;
  /** Invoice cover Billed Line Items (against PO line schedule). */
  billedLineItems: BilledLineItemRow[];
}

const TEMPLATES: Record<PackageDocKind, string> = {
  invoice: "package-invoice-template.xlsx",
  subcalc: "package-subcalc-template.xlsx",
  progress: "package-progress-template.xlsx",
  labor: "package-labor-template.xlsx",
  timesheets: "package-timesheets-template.xlsx",
};

/** Human-friendly file label used inside the ZIP and on disk. */
const DOC_LABELS: Record<PackageDocKind, string> = {
  invoice: "Invoice",
  subcalc: "SubCalc",
  progress: "ProgressReport",
  labor: "LaborAttachment",
  timesheets: "Timesheets",
};

/** The three client-facing documents that are also rendered to PDF. */
const PDF_DOCS: PackageDocKind[] = ["invoice", "progress", "labor"];

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** Parse a YYYY-MM-DD calendar day at local noon (avoids TZ rollover). */
function toDate(value: string): Date {
  const [y, m, d] = value.split("-").map((n) => parseInt(n, 10));
  return new Date(y, (m || 1) - 1, d || 1, 12, 0, 0);
}

function addDays(value: string, days: number): Date {
  const base = toDate(value);
  base.setDate(base.getDate() + days);
  return base;
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

function safeSlug(ctx: PackageDocContext): string {
  const num = ctx.pkg.invoiceNumber || `PKG-${ctx.pkg.id}`;
  return num.replace(/[^A-Za-z0-9._-]/g, "_");
}

/** Strips characters that are illegal in filenames while keeping spaces/dashes. */
function sanitizeFilePart(value: string): string {
  return value
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
    .replace(/\s+/g, " ")
    .trim();
}

export interface Contributor {
  /** Identity key: `id:<employeeId>` or `name:<normalized>` for legacy rows. */
  key: string;
  name: string;
}

/** Distinct contributing employees from the package's timesheet entries. */
export function packageContributors(ctx: Pick<PackageDocContext, "entries" | "employee">): Contributor[] {
  const seen = new Map<string, string>();
  for (const e of ctx.entries) {
    const name = e.employeeName.trim();
    if (!name) continue;
    const key = contributorKey(e);
    if (!seen.has(key)) seen.set(key, name);
  }
  if (seen.size === 0 && ctx.employee?.name) {
    return [{ key: `name:${ctx.employee.name.trim().toLowerCase()}`, name: ctx.employee.name }];
  }
  return [...seen.entries()].map(([key, name]) => ({ key, name }));
}

/**
 * Builds the prefix shared by every exported document, so files are
 * identifiable and two packages never collide on `Invoice.xlsx`. A single
 * contributor keeps the legacy `EmployeeName_Job#` shape; multi-employee
 * invoices use just the job number.
 */
function docFileBase(ctx: PackageDocContext): string {
  const contributors = packageContributors(ctx);
  const parts = [contributors.length === 1 ? contributors[0].name : "", ctx.workPlan.jobNumber]
    .map((p) => sanitizeFilePart(p ?? ""))
    .filter((p) => p.length > 0);
  const base = parts.join("_");
  return base || `Package-${ctx.pkg.id}`;
}

/** User-facing download name: `EmployeeName_Job#_DocumentName.ext`. */
export function packageDocFileName(
  ctx: PackageDocContext,
  kind: PackageDocKind,
  format: "xlsx" | "pdf",
): string {
  return `${docFileBase(ctx)}_${DOC_LABELS[kind]}.${format}`;
}

async function loadTemplate(kind: PackageDocKind): Promise<ExcelJS.Workbook> {
  const file = path.resolve(templatesDir, TEMPLATES[kind]);
  if (!fs.existsSync(file)) {
    throw new Error(`Package ${kind} template not found at ${file}`);
  }
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  return wb;
}

function computeRollup(ctx: PackageDocContext): ReturnType<typeof buildPackageRollup> {
  return buildPackageRollup(ctx.entries, ctx.workPlan, {
    previouslyBilled: ctx.pkg.previouslyBilled,
    otherDirectCosts: ctx.pkg.otherDirectCosts,
  });
}

/** Splits straight-time labor base between Home and Field locations. */
function laborSplit(rollup: ReturnType<typeof buildPackageRollup>): {
  homeBase: number;
  fieldBase: number;
} {
  let homeBase = 0;
  let fieldBase = 0;
  for (const l of rollup.laborLines) {
    if (l.location === "field") fieldBase += l.amount;
    else homeBase += l.amount;
  }
  return { homeBase: round2(homeBase), fieldBase: round2(fieldBase) };
}

function placeSignature(
  wb: ExcelJS.Workbook,
  ws: ExcelJS.Worksheet,
  sigPath: string | null,
  tl: { col: number; row: number },
): void {
  if (!sigPath || !fs.existsSync(sigPath)) return;
  try {
    const ext = path.extname(sigPath).replace(".", "").toLowerCase();
    const extension: "png" | "jpeg" | "gif" =
      ext === "jpg" || ext === "jpeg" ? "jpeg" : ext === "gif" ? "gif" : "png";
    const buffer = fs.readFileSync(sigPath) as unknown as ExcelJS.Buffer;
    const id = wb.addImage({ buffer, extension });
    ws.addImage(id, { tl, ext: { width: 180, height: 55 } });
  } catch (err) {
    logger.warn({ err }, "Failed to embed signature image into package document");
  }
}

async function writeOut(wb: ExcelJS.Workbook, kind: PackageDocKind, ctx: PackageDocContext): Promise<string> {
  stripBrokenDefinedNames(wb);
  wb.calcProperties.fullCalcOnLoad = true;
  const filename = `${DOC_LABELS[kind]}_${safeSlug(ctx)}_${Date.now()}.xlsx`;
  const outPath = path.resolve(generatedDir, filename);
  await wb.xlsx.writeFile(outPath);
  return outPath;
}

// ---------------------------------------------------------------------------
// Invoice (Professional Service Agreement Invoice)
// ---------------------------------------------------------------------------

async function buildInvoice(ctx: PackageDocContext): Promise<ExcelJS.Workbook> {
  const wb = await loadTemplate("invoice");
  const ws = wb.getWorksheet("Invoice");
  const wp = ctx.workPlan;
  const rollup = computeRollup(ctx);
  if (ws) {
    if (ctx.pkg.invoiceDate) setVal(ws, "L6", toDate(ctx.pkg.invoiceDate));
    if (wp.poNumber) setVal(ws, "L8", wp.poNumber);
    setVal(ws, "L10", ctx.pkg.invoiceNumber ? " " + ctx.pkg.invoiceNumber : "");
    if (wp.agreementNo) setVal(ws, "E21", wp.agreementNo);
    setVal(ws, "E22", wp.title);
    setVal(ws, "C27", "Work Plan " + wp.code);
    setVal(ws, "B24", toDate(ctx.pkg.payPeriodStart));
    setVal(ws, "H24", toDate(ctx.pkg.payPeriodEnd));
    // Headline billing figures — injected as authoritative values so the
    // template's stale single-employee cross-sheet formulas are overridden.
    setVal(ws, "L27", rollup.totalThisPeriod);
    setVal(ws, "L30", rollup.totalThisPeriod);
    setVal(ws, "J34", wp.totalBudget);
    setVal(ws, "J35", rollup.totalThisPeriod);
    setVal(ws, "J36", rollup.previouslyBilled);
    setVal(ws, "J37", rollup.totalToDate);
    setVal(ws, "J38", rollup.remainingBalance);
    if (ctx.pkg.invoiceDate) setVal(ws, "M45", toDate(ctx.pkg.invoiceDate));
    placeSignature(wb, ws, ctx.signatureImagePath, { col: 1, row: 43 });
  }
  return wb;
}

async function generateInvoice(ctx: PackageDocContext): Promise<string> {
  return writeOut(await buildInvoice(ctx), "invoice", ctx);
}

// ---------------------------------------------------------------------------
// Labor Attachment (Sub Labor)
// ---------------------------------------------------------------------------

const HOME_ROWS = { start: 7, end: 17 };
const FIELD_ROWS = { start: 20, end: 25 };

async function buildLaborAttachment(ctx: PackageDocContext): Promise<ExcelJS.Workbook> {
  const wb = await loadTemplate("labor");
  const ws = wb.getWorksheet("Sub Labor");
  const wp = ctx.workPlan;
  const rollup = computeRollup(ctx);
  if (ws) {
    const fringeRate = wp.fringeRate ?? 0;
    const fixedFeeRate = wp.fixedFeeRate ?? 0;
    const burden = (1 + fringeRate / 100) * (1 + fixedFeeRate / 100);

    if (ctx.pkg.invoiceDate) setVal(ws, "F1", toDate(ctx.pkg.invoiceDate));
    setVal(ws, "F2", ctx.pkg.invoiceNumber ? " " + ctx.pkg.invoiceNumber : "");
    setVal(ws, "F3", wp.jobNumber);
    // Drive the per-row burden formulas with the package's fringe fraction.
    setVal(ws, "H6", round2(fringeRate / 100));
    setVal(ws, "H19", round2(fringeRate / 100));

    // Wipe both sample blocks first.
    for (const block of [HOME_ROWS, FIELD_ROWS]) {
      for (let r = block.start; r <= block.end; r++) {
        for (const col of ["B", "C", "D", "E", "F", "G", "H"]) clearCell(ws, `${col}${r}`);
      }
    }

    const homeLines = rollup.laborLines.filter((l) => l.location !== "field");
    const fieldLines = rollup.laborLines.filter((l) => l.location === "field");

    const writeBlock = (lines: typeof rollup.laborLines, block: { start: number; end: number }) => {
      const cap = block.end - block.start + 1;
      const overflow = Math.max(0, lines.length - cap);
      let hours = 0;
      let amount = 0;
      let billed = 0;
      lines.slice(0, cap).forEach((l, i) => {
        const r = block.start + i;
        const amt = round2(l.hours * l.rate);
        const bill = round2(amt * burden);
        setVal(ws, `B${r}`, l.classification);
        setVal(ws, `C${r}`, l.employeeName);
        setVal(ws, `D${r}`, l.hours);
        setVal(ws, `E${r}`, l.rate);
        setVal(ws, `F${r}`, amt);
        setVal(ws, `H${r}`, bill);
        hours += l.hours;
        amount += amt;
        billed += bill;
      });
      return { overflow, hours: round2(hours), amount: round2(amount), billed: round2(billed) };
    };

    const home = writeBlock(homeLines, HOME_ROWS);
    const field = writeBlock(fieldLines, FIELD_ROWS);
    if (home.overflow + field.overflow > 0) {
      logger.warn(
        { overflow: home.overflow + field.overflow },
        "Labor attachment has more line items than template rows; extra rows omitted",
      );
    }

    // Authoritative subtotals/totals (override template SUBTOTAL/SUM cells).
    setVal(ws, "D18", home.hours);
    setVal(ws, "F18", home.amount);
    setVal(ws, "H18", home.billed);
    setVal(ws, "D26", field.hours);
    setVal(ws, "F26", field.amount);
    setVal(ws, "H26", field.billed);
    setVal(ws, "D29", round2(home.hours + field.hours));
    setVal(ws, "F29", round2(home.amount + field.amount));
    setVal(ws, "H29", round2(home.billed + field.billed));
    setVal(ws, "H30", rollup.otherDirectCosts);
    setVal(ws, "H31", round2(home.billed + field.billed + rollup.otherDirectCosts));

    // Manual overrides win over auto-calculated values.
    for (const o of ctx.overrides) {
      const num = Number(o.value);
      const value = o.value !== "" && !Number.isNaN(num) ? num : o.value;
      try {
        setVal(ws, o.cellKey, value);
      } catch (err) {
        logger.warn({ err, cellKey: o.cellKey }, "Skipped invalid labor override cell key");
      }
    }
  }
  return wb;
}

async function generateLaborAttachment(ctx: PackageDocContext): Promise<string> {
  return writeOut(await buildLaborAttachment(ctx), "labor", ctx);
}

// ---------------------------------------------------------------------------
// SubCalc (Invoice Detail Attachment — "Sub Calc _revised")
// ---------------------------------------------------------------------------

async function buildSubCalc(ctx: PackageDocContext): Promise<ExcelJS.Workbook> {
  const wb = await loadTemplate("subcalc");
  const ws = wb.getWorksheet("Sub Calc _revised");
  const wp = ctx.workPlan;
  const rollup = computeRollup(ctx);
  if (ws) {
    const { homeBase, fieldBase } = laborSplit(rollup);
    const totalBase = homeBase + fieldBase;
    const fringeRate = wp.fringeRate ?? 0;
    const homeFringe = round2((homeBase * fringeRate) / 100);
    const fieldFringe = round2((fieldBase * fringeRate) / 100);
    // Split overhead and FCCM between Home and Field proportionally to each
    // location's straight-time labor base ("...Pool on Labor").
    const homeShare = totalBase > 0 ? homeBase / totalBase : 1;
    const homeOverhead = round2(rollup.overheadTotal * homeShare);
    const fieldOverhead = round2(rollup.overheadTotal - homeOverhead);
    const homeFccm = round2(rollup.fccm * homeShare);
    const fieldFccm = round2(rollup.fccm - homeFccm);

    if (ctx.pkg.invoiceDate) setVal(ws, "J1", toDate(ctx.pkg.invoiceDate));
    setVal(ws, "J2", ctx.pkg.invoiceNumber ? " " + ctx.pkg.invoiceNumber : "");
    setVal(ws, "J3", wp.jobNumber);

    // Inject only LEAF cells of the "Amount This Period" (H) column. The in-file
    // SUBTOTAL roll-up rows (H10/H14/H20/H31/H47) are left intact and recompute
    // from these authoritative leaves on open (fullCalcOnLoad). Sample rows we
    // do not use are zeroed so they cannot leak stale template figures.
    // Labor block — Home (R7 labor, R8 fringe, R9 overhead pool).
    setVal(ws, "H7", homeBase);
    setVal(ws, "H8", homeFringe);
    setVal(ws, "H9", homeOverhead);
    // Labor block — Field (R11 labor, R12 fringe, R13 overhead pool).
    setVal(ws, "H11", fieldBase);
    setVal(ws, "H12", fieldFringe);
    setVal(ws, "H13", fieldOverhead);
    for (const r of [16, 17, 18]) setVal(ws, `H${r}`, 0);
    // Other Direct Costs (R23 generic ODC, R24/R25 OT/DT premium, R26-30 misc).
    setVal(ws, "H23", rollup.otherDirectCosts);
    setVal(ws, "H24", rollup.otdtPremium);
    setVal(ws, "H25", 0);
    for (const r of [26, 27, 28, 29, 30]) setVal(ws, `H${r}`, 0);
    // PMAC and subconsultant fee are unused (overhead already in H9/H13).
    setVal(ws, "H39", 0);
    setVal(ws, "H44", 0);
    // Fixed Fee (R43) and FCCM (R48 home, R49 field).
    setVal(ws, "H43", rollup.fixedFee);
    setVal(ws, "H48", homeFccm);
    setVal(ws, "H49", fieldFccm);
    setVal(ws, "H50", 0);

    // Authoritative package-level figures (not derivable from sheet leaves).
    // H51 (Total Amount Due) is force-set so the headline is correct even in a
    // viewer that does not recalculate; G52/K51 stay as formulas off G51/J51.
    setVal(ws, "G51", wp.totalBudget);
    setVal(ws, "H51", rollup.totalThisPeriod);
    setVal(ws, "I51", rollup.previouslyBilled);
    setVal(ws, "J51", rollup.totalToDate);
  }
  return wb;
}

async function generateSubCalc(ctx: PackageDocContext): Promise<string> {
  return writeOut(await buildSubCalc(ctx), "subcalc", ctx);
}

// ---------------------------------------------------------------------------
// Progress Report
// ---------------------------------------------------------------------------

async function buildProgressReport(ctx: PackageDocContext): Promise<ExcelJS.Workbook> {
  const wb = await loadTemplate("progress");
  const ws = wb.getWorksheet("Progress Report");
  const wp = ctx.workPlan;
  const rollup = computeRollup(ctx);
  const pr = ctx.progress;
  if (ws) {
    const reportDate = pr?.reportDate || ctx.pkg.invoiceDate;
    if (reportDate) setVal(ws, "I6", toDate(reportDate));
    setVal(ws, "B6", "Work Plan " + wp.code);
    if (wp.poNumber) setVal(ws, "E6", wp.poNumber);
    setVal(ws, "B7", wp.title);
    setVal(ws, "G7", toDate(ctx.pkg.payPeriodStart));
    setVal(ws, "I7", toDate(ctx.pkg.payPeriodEnd));

    // Narrative. Clear the template's sample bullet rows, then write ours.
    for (let r = 11; r <= 18; r++) {
      clearCell(ws, `B${r}`);
      clearCell(ws, `C${r}`);
    }
    setVal(ws, "B11", "•");
    setVal(ws, "C11", pr?.workPerformed || pr?.summary || "");
    setVal(ws, "C22", pr?.concerns || "N/A");
    setVal(ws, "C25", pr?.correctiveAction || "N/A");
    if (pr?.scheduleComment) setVal(ws, "B28", pr.scheduleComment);

    const pctComplete =
      pr?.percentComplete != null ? round2(pr.percentComplete / 100) : round2(rollup.percentExpended / 100);
    setVal(ws, "E26", pctComplete);
    setVal(ws, "F29", wp.totalBudget);
    setVal(ws, "D30", rollup.totalToDate);
    setVal(ws, "E30", wp.totalBudget > 0 ? round2(rollup.totalToDate / wp.totalBudget) : 0);
    if (reportDate) setVal(ws, "G35", toDate(reportDate));
    placeSignature(wb, ws, ctx.signatureImagePath, { col: 1, row: 33 });
  }
  return wb;
}

async function generateProgressReport(ctx: PackageDocContext): Promise<string> {
  return writeOut(await buildProgressReport(ctx), "progress", ctx);
}

// ---------------------------------------------------------------------------
// Timesheets (one sheet per week)
// ---------------------------------------------------------------------------

/** Excel sheet names cannot exceed 31 chars or contain : \ / ? * [ ]. */
function sheetName(label: string, fallback: string): string {
  const cleaned = (label || fallback).replace(/[\\/?*[\]:]/g, " ").trim();
  return (cleaned || fallback).slice(0, 31);
}

/**
 * Ensures a sheet name is unique (case-insensitive, as Excel requires) within
 * `used`, appending a `-2`, `-3`, … suffix and re-truncating to 31 chars on
 * collision. Records the chosen name and returns it.
 */
function uniqueSheetName(base: string, used: Set<string>): string {
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

/** Maps a timesheet category to its fixed template row. */
function categoryRow(category: string): number {
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
      return 9; // regular / night — straight time
  }
}

interface DayAcc {
  desc: string | null;
  G: number;
  H: number;
  I: number;
  J: number;
  K: number;
  L: number;
  M: number;
}

function fillWeek(
  ws: ExcelJS.Worksheet,
  week: PackageWeekRow,
  ctx: PackageDocContext,
  contributor: Contributor,
): void {
  setVal(ws, "C5", contributor.name);
  // Header dates: Mon=I, Tue=J, Wed=K, Thu=L, Fri=M, Sat=G, Sun=H.
  setVal(ws, "I6", toDate(week.weekStart));
  setVal(ws, "J6", addDays(week.weekStart, 1));
  setVal(ws, "K6", addDays(week.weekStart, 2));
  setVal(ws, "L6", addDays(week.weekStart, 3));
  setVal(ws, "M6", addDays(week.weekStart, 4));
  setVal(ws, "G6", addDays(week.weekStart, 5));
  setVal(ws, "H6", addDays(week.weekStart, 6));

  // Clear the template's sample hours and descriptions (rows 9-14).
  for (let r = 9; r <= 14; r++) {
    for (const col of ["C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M"]) clearCell(ws, `${col}${r}`);
  }

  const acc = new Map<number, DayAcc>();
  for (const e of ctx.entries.filter(
    (x) => x.weekId === week.id && contributorKey(x) === contributor.key,
  )) {
    const r = categoryRow(e.category);
    const a =
      acc.get(r) ?? { desc: null, G: 0, H: 0, I: 0, J: 0, K: 0, L: 0, M: 0 };
    a.desc = a.desc || e.classification;
    a.I += e.hoursMon;
    a.J += e.hoursTue;
    a.K += e.hoursWed;
    a.L += e.hoursThu;
    a.M += e.hoursFri;
    a.G += e.hoursSat;
    a.H += e.hoursSun;
    acc.set(r, a);
  }

  for (const [r, a] of acc) {
    if (a.desc) setVal(ws, `C${r}`, a.desc);
    const cols: (keyof DayAcc)[] = ["G", "H", "I", "J", "K", "L", "M"];
    for (const col of cols) {
      const v = a[col] as number;
      if (v > 0) setVal(ws, `${col}${r}`, round2(v));
    }
  }
}

async function buildTimesheets(ctx: PackageDocContext): Promise<ExcelJS.Workbook> {
  const wb = await loadTemplate("timesheets");
  const template = wb.worksheets[0];
  const weeks = [...ctx.weeks].sort((a, b) => a.sortOrder - b.sortOrder);

  if (weeks.length === 0) {
    return wb;
  }

  // Capture a pristine copy of the template sheet before mutating it so extra
  // weeks can be cloned with the same styling/layout.
  const pristine = JSON.parse(JSON.stringify(template.model));

  // One sheet per week per contributing employee, so a multi-employee invoice
  // ships every person's weekly timesheet. Single-employee packages keep the
  // legacy one-sheet-per-week layout (no name suffix).
  const contributors = packageContributors(ctx);
  const people: Contributor[] =
    contributors.length > 0 ? contributors : [{ key: "name:", name: "" }];

  const usedNames = new Set<string>();
  let sheetIndex = 0;
  weeks.forEach((week, i) => {
    for (const person of people) {
      const label = sheetName(week.label, `Week ${i + 1}`);
      const base =
        people.length > 1 && person.name
          ? sheetName(`${label} - ${person.name}`, label)
          : label;
      const name = uniqueSheetName(base, usedNames);
      let ws: ExcelJS.Worksheet;
      if (sheetIndex === 0) {
        ws = template;
        ws.name = name;
      } else {
        ws = wb.addWorksheet(name);
        const cloned = JSON.parse(JSON.stringify(pristine));
        cloned.name = name;
        cloned.id = ws.id;
        ws.model = cloned;
        ws.name = name;
      }
      sheetIndex += 1;
      fillWeek(ws, week, ctx, person);
    }
  });

  return wb;
}

async function generateTimesheets(ctx: PackageDocContext): Promise<string> {
  return writeOut(await buildTimesheets(ctx), "timesheets", ctx);
}

// ---------------------------------------------------------------------------
// Dispatch + export
// ---------------------------------------------------------------------------

const GENERATORS: Record<PackageDocKind, (ctx: PackageDocContext) => Promise<string>> = {
  invoice: generateInvoice,
  subcalc: generateSubCalc,
  progress: generateProgressReport,
  labor: generateLaborAttachment,
  timesheets: generateTimesheets,
};

/** Best-effort removal of intermediate artifacts when generation fails. */
function cleanupFiles(paths: string[]): void {
  for (const p of paths) {
    try {
      fs.rmSync(p, { force: true });
    } catch {
      // ignore — cleanup is best-effort.
    }
  }
}

/** Generates a single package document, optionally rendered to PDF. */
export async function generatePackageDocument(
  ctx: PackageDocContext,
  doc: PackageDocKind,
  format: "xlsx" | "pdf",
): Promise<string> {
  ensureDirs();
  const xlsx = await GENERATORS[doc](ctx);
  if (format !== "pdf") return xlsx;
  try {
    return await convertToPdf(xlsx);
  } catch (err) {
    cleanupFiles([xlsx]);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Combined client-ready workbook (one multi-tab Excel per package)
// ---------------------------------------------------------------------------

/** Fill colors that mark internal notes/highlights and must never ship. */
const HIGHLIGHT_ARGB = /^(FF)?(FFFF00|FFFF33|FFFF66|FFFF99|FFFFCC|FFF2CC|FFE699|FFEB9C|FFFFE0)$/i;

/**
 * Scrubs a plain worksheet model in place so the client-ready workbook carries
 * no comments/notes and no yellow "internal highlight" fills. Structure,
 * formulas, and all other formatting are untouched.
 */
function scrubSheetModel(model: {
  rows?: Array<{ cells?: Array<Record<string, unknown>> }>;
}): void {
  const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
  for (const row of model.rows ?? []) {
    for (const cell of row.cells ?? []) {
      if (!cell) continue;
      delete cell.comment;
      // JSON deep-cloning serializes Date values to ISO strings while the
      // cell type stays "date"; revive them or ExcelJS crashes on write.
      if (typeof cell.value === "string" && ISO_DATE.test(cell.value)) {
        cell.value = new Date(cell.value as string);
      }
      if (typeof cell.result === "string" && ISO_DATE.test(cell.result as string)) {
        cell.result = new Date(cell.result as string);
      }
      const style = cell.style as
        | { fill?: { type?: string; pattern?: string; fgColor?: { argb?: string } } }
        | undefined;
      const argb = style?.fill?.fgColor?.argb;
      if (argb && HIGHLIGHT_ARGB.test(argb)) {
        delete style!.fill;
      }
    }
  }
}

/**
 * Clones a worksheet from a per-document template workbook into the combined
 * client-ready workbook: deep-copies the sheet model (styles, merges, widths,
 * formulas), scrubs internal notes/highlights, and re-attaches images (logos,
 * signatures) through the target workbook's media store.
 */
function cloneSheetInto(
  target: ExcelJS.Workbook,
  srcWb: ExcelJS.Workbook,
  srcWs: ExcelJS.Worksheet,
  name: string,
): void {
  const model = JSON.parse(JSON.stringify({ ...srcWs.model, media: [] }));
  scrubSheetModel(model);
  const ws = target.addWorksheet(name);
  model.id = ws.id;
  model.name = name;
  ws.model = model;
  ws.name = name;
  // `Workbook.media` exists at runtime but is missing from the ExcelJS typings.
  const srcMedia =
    (srcWb as unknown as { media?: Array<{ buffer?: ExcelJS.Buffer; extension?: string }> }).media ?? [];
  for (const img of srcWs.getImages()) {
    const media = srcMedia[Number(img.imageId)];
    if (!media?.buffer) continue;
    const id = target.addImage({
      buffer: media.buffer as ExcelJS.Buffer,
      extension: (media.extension as "png" | "jpeg" | "gif") || "png",
    });
    const range = img.range as unknown as {
      tl: ExcelJS.Anchor;
      br?: ExcelJS.Anchor;
      ext?: { width: number; height: number };
      editAs?: string;
    };
    ws.addImage(id, {
      tl: range.tl,
      ...(range.br ? { br: range.br } : {}),
      ...(range.ext ? { ext: range.ext } : {}),
      ...(range.editAs ? { editAs: range.editAs } : {}),
    } as ExcelJS.ImageRange);
  }
}

/**
 * Copies the source workbook's valid defined names into the combined workbook,
 * rewriting sheet references for renamed tabs. Broken (#REF!/external) names
 * are dropped, as are Excel-internal `_xlnm.*` names (autofilter markers that
 * are sheet-scoped and meaningless once the sheet moves workbooks).
 */
function copyDefinedNames(
  target: ExcelJS.Workbook,
  srcWb: ExcelJS.Workbook,
  renames: Map<string, string>,
): void {
  const isBroken = (range: string): boolean => /#REF!/i.test(range) || /\[[^\]]+\]/.test(range);
  const rewrite = (range: string): string => {
    let out = range;
    for (const [oldName, newName] of renames) {
      out = out.split(`'${oldName}'!`).join(`'${newName}'!`);
      if (!/[^A-Za-z0-9_]/.test(oldName)) out = out.split(`${oldName}!`).join(`'${newName}'!`);
    }
    return out;
  };
  try {
    const existing = new Set(target.definedNames.model.map((dn) => dn.name.toLowerCase()));
    const incoming = srcWb.definedNames.model
      .filter((dn) => !dn.name.startsWith("_xlnm") && !dn.ranges.some(isBroken))
      .filter((dn) => !existing.has(dn.name.toLowerCase()))
      .map((dn) => ({ name: dn.name, ranges: dn.ranges.map(rewrite) }));
    if (incoming.length > 0) {
      target.definedNames.model = [...target.definedNames.model, ...incoming];
    }
  } catch (err) {
    logger.warn({ err }, "Failed to copy defined names into combined workbook");
  }
}

const CURRENCY_FMT = '"$"#,##0.00';

/** Builds the summary Overview tab at the front of the combined workbook. */
function buildOverviewSheet(wb: ExcelJS.Workbook, ctx: PackageDocContext): void {
  const ws = wb.addWorksheet("Overview");
  const wp = ctx.workPlan;
  const rollup = computeRollup(ctx);
  const contributors = packageContributors(ctx);

  ws.getColumn(1).width = 2;
  ws.getColumn(2).width = 28;
  ws.getColumn(3).width = 40;

  const title = ws.getCell("B2");
  title.value = "Invoice Package Overview";
  title.font = { bold: true, size: 16, color: { argb: "FF333333" } };
  ws.getCell("B3").value = "Azad Engineering, Inc.";
  ws.getCell("B3").font = { size: 11, color: { argb: "FF5F5F5F" } };

  let r = 5;
  const addRow = (label: string, value: ExcelJS.CellValue, numFmt?: string): void => {
    const l = ws.getCell(`B${r}`);
    l.value = label;
    l.font = { bold: true, size: 10, color: { argb: "FF5F5F5F" } };
    const v = ws.getCell(`C${r}`);
    v.value = value;
    v.font = { size: 11 };
    if (numFmt) v.numFmt = numFmt;
    r += 1;
  };
  const addSection = (label: string): void => {
    r += 1;
    const c = ws.getCell(`B${r}`);
    c.value = label;
    c.font = { bold: true, size: 12 };
    r += 1;
  };

  addRow("Client", wp.client);
  addRow("Job Number", wp.jobNumber);
  addRow("Work Plan", `${wp.code} — ${wp.title}`);
  addRow("Billing Period", `${ctx.pkg.payPeriodStart} to ${ctx.pkg.payPeriodEnd}`);
  addRow("Invoice Number", ctx.pkg.invoiceNumber || "");
  if (ctx.pkg.invoiceDate) addRow("Invoice Date", toDate(ctx.pkg.invoiceDate));
  addRow("Personnel", contributors.map((c) => c.name).join(", "));

  addSection("Billing Summary");
  addRow("Total Hours", round2(rollup.totalHours));
  addRow("Labor Total", rollup.laborTotal, CURRENCY_FMT);
  addRow("Total This Period", rollup.totalThisPeriod, CURRENCY_FMT);
  addRow("Previously Billed", rollup.previouslyBilled, CURRENCY_FMT);
  addRow("Total Billed To Date", rollup.totalToDate, CURRENCY_FMT);
  addRow("Total Work Plan Budget", wp.totalBudget, CURRENCY_FMT);
  addRow("Remaining Balance", rollup.remainingBalance, CURRENCY_FMT);

  addSection("Contents");
  for (const tab of ["Invoice", "Sub Calc", "Progress Report", "Labor Attachment", "Weekly Timesheets"]) {
    addRow("•", tab);
  }
}

/**
 * Assembles the single client-ready multi-tab workbook: Overview, Invoice,
 * Sub Calc, Progress Report, Labor Attachment, then one tab per weekly
 * timesheet. Each tab is the fully populated per-document template sheet,
 * scrubbed of internal notes/highlights.
 */
export async function generateCombinedWorkbook(ctx: PackageDocContext): Promise<string> {
  // Route by prime contractor: WSP- and T.Y. Lin-format packages use their own
  // invoice engines; AECOM (and everything else) fall back to the
  // master/reference engine.
  const { isWspPrime, generateWspWorkbookFile } = await import("./wspWorkbook");
  if (isWspPrime(ctx.pkg)) return generateWspWorkbookFile(ctx);
  const { isTylinPrime, generateTylinWorkbookFile } = await import("./tylinWorkbook");
  if (isTylinPrime(ctx.pkg)) return generateTylinWorkbookFile(ctx);
  const { isParsonsPrime, generateParsonsWorkbookFile } = await import("./parsonsWorkbook");
  if (isParsonsPrime(ctx.pkg)) return generateParsonsWorkbookFile(ctx);
  const { generateMasterWorkbookFile } = await import("./masterWorkbook");
  return generateMasterWorkbookFile(ctx);
}

// ---------------------------------------------------------------------------
// Merged client-ready PDF (one multi-page PDF per package)
// ---------------------------------------------------------------------------

/**
 * Renders the reference workbook (Overview hidden) to a single PDF via
 * LibreOffice. Hidden sheets are skipped by the converter, so pages come out
 * in the reference order: Invoice → Sub Calc → Labor Attachment → Progress
 * Report → weekly timesheets. The intermediate xlsx is removed.
 */
export async function generateMergedPdf(ctx: PackageDocContext): Promise<string> {
  ensureDirs();
  // Route by prime contractor (see generateCombinedWorkbook): WSP-format
  // packages render from the WSP engine, AECOM/others from the master engine.
  const { isWspPrime, generateWspPdfSource } = await import("./wspWorkbook");
  const { isTylinPrime, generateTylinPdfSource } = await import("./tylinWorkbook");
  const { isParsonsPrime, generateParsonsPdfSource } = await import("./parsonsWorkbook");
  const { generateMasterPdfSource } = await import("./masterWorkbook");
  const buildPdfSource = isWspPrime(ctx.pkg)
    ? generateWspPdfSource
    : isTylinPrime(ctx.pkg)
      ? generateTylinPdfSource
      : isParsonsPrime(ctx.pkg)
        ? generateParsonsPdfSource
        : generateMasterPdfSource;
  const intermediates: string[] = [];
  try {
    const src = await buildPdfSource(ctx);
    intermediates.push(src);
    const pdf = await convertToPdf(src);
    const outPath = path.resolve(generatedDir, `InvoicePackage_${safeSlug(ctx)}_${Date.now()}.pdf`);
    fs.renameSync(pdf, outPath);
    return outPath;
  } finally {
    cleanupFiles(intermediates);
  }
}

// ---------------------------------------------------------------------------
// Two-file export (Excel + PDF in a ZIP)
// ---------------------------------------------------------------------------

export interface PackageExportEntry {
  doc: PackageDocKind | "package";
  filename: string;
  format: "xlsx" | "pdf";
}

export interface PackageExportResult {
  zipPath: string;
  zipName: string;
  documents: PackageExportEntry[];
}

/** Client-facing name for the two combined export files. */
export function packageExportFileName(ctx: PackageDocContext, format: "xlsx" | "pdf"): string {
  // The name the invoice is actually sent under, when Julie's register gives
  // one — "08-2026-BART6M8142-AECOM-B.50-01 Invoice_AZAD-32" — so the export
  // is ready to attach rather than "Johnson, Travis_10007_InvoicePackage".
  const sentAs = clientFileBase(
    [ctx.workPlan.procasProject, ctx.workPlan.jobNumber],
    ctx.pkg.payPeriodEnd,
    ctx.pkg.invoiceNumber,
  );
  return `${sentAs ?? `${docFileBase(ctx)}_InvoicePackage`}.${format}`;
}

/**
 * Produces the client-ready two-file export: one multi-tab Excel workbook and
 * one merged multi-page PDF, bundled into a ZIP containing exactly those two
 * files.
 */
export async function generatePackageZip(ctx: PackageDocContext): Promise<PackageExportResult> {
  ensureDirs();
  const zipName = `Package_${safeSlug(ctx)}_${Date.now()}.zip`;
  const zipPath = path.resolve(generatedDir, zipName);
  const files: { path: string; name: string; format: "xlsx" | "pdf" }[] = [];

  try {
    const xlsx = await generateCombinedWorkbook(ctx);
    files.push({ path: xlsx, name: packageExportFileName(ctx, "xlsx"), format: "xlsx" });
    const pdf = await generateMergedPdf(ctx);
    files.push({ path: pdf, name: packageExportFileName(ctx, "pdf"), format: "pdf" });

    await new Promise<void>((resolve, reject) => {
      const output = fs.createWriteStream(zipPath);
      const archive = new ZipArchive({ zlib: { level: 9 } });
      output.on("close", () => resolve());
      output.on("error", reject);
      archive.on("error", reject);
      archive.pipe(output);
      for (const f of files) archive.file(f.path, { name: f.name });
      void archive.finalize();
    });
  } catch (err) {
    // Leave no partial artifacts (generated xlsx/pdf or a truncated zip) behind.
    cleanupFiles([...files.map((f) => f.path), zipPath]);
    throw err;
  }

  // The ZIP now contains both files; the standalone combined xlsx/pdf are
  // intermediates and would otherwise accumulate forever.
  cleanupFiles(files.map((f) => f.path));
  // Bound disk growth: keep only the newest ZIPs per package and sweep
  // stale loose files (including legacy per-document exports).
  pruneGeneratedFiles();

  return {
    zipPath,
    zipName,
    documents: files.map((f) => ({ doc: "package" as const, filename: f.name, format: f.format })),
  };
}
