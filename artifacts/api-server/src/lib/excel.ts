import ExcelJS from "exceljs";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { templatesDir, generatedDir, uploadsDir, ensureDirs } from "./paths";
import { logger } from "./logger";

const execFileAsync = promisify(execFile);

const TEMPLATE_PATH = path.resolve(templatesDir, "bart-invoice-template.xlsm");
const MASTER_SHEET = "Master File ";
const INVOICE_SHEET = "Invoice";
const PROGRESS_SHEET = "Progress Report";
const LABOR_SHEET = "Sub Labor";

// Row ranges in the LABOR ATTACHMENT ("Sub Labor") sheet. Home entries occupy
// rows 7-17 (subtotal row 18) and Field entries rows 20-25 (subtotal row 26).
const HOME_ROWS = { start: 7, end: 17 };
const FIELD_ROWS = { start: 20, end: 25 };

export interface ExportLineItem {
  classification: string;
  employeeName: string;
  hours: number;
  rate: number;
  location: string; // "home" | "field"
}

export interface ExportFinancials {
  laborTotal: number;
  fringeTotal: number;
  fixedFee: number;
  fccm: number;
  otdtPremium: number;
  otherDirectCosts: number;
  totalThisPeriod: number;
  previouslyBilled: number;
  totalToDate: number;
  remainingBalance: number;
}

export interface InvoiceExportData {
  invoiceNumber: string;
  invoiceDate: string; // YYYY-MM-DD
  periodStart: string; // YYYY-MM-DD
  periodEnd: string; // YYYY-MM-DD
  poNumber?: string | null;
  totalBudget: number;
  fringeRate: number; // percent, e.g. 120.58
  fixedFeeRate: number; // percent, e.g. 8
  lineItems: ExportLineItem[];
  financials: ExportFinancials;
  progress?: {
    summary?: string | null;
    workCompleted?: string | null;
    issues?: string | null;
    percentComplete?: number | null;
  } | null;
  /** Absolute path to a signature image to place on the Invoice sheet. */
  signatureImagePath?: string | null;
}

function toDate(value: string): Date {
  // Treat YYYY-MM-DD as a calendar day in local time (noon avoids TZ rollover).
  const [y, m, d] = value.split("-").map((n) => parseInt(n, 10));
  return new Date(y, (m || 1) - 1, d || 1, 12, 0, 0);
}

/**
 * Removes leftover defined (named) ranges whose target is a `#REF!` error or an
 * external-workbook reference (e.g. `'[1]Sub Calc'!$H$51`). Excel strips these
 * broken names when the regenerated workbook is opened and surfaces an alarming
 * "Removed Records: Named range from /xl/workbook.xml" repair prompt. None of
 * the broken names are used by the generated documents; valid in-workbook named
 * ranges that the templates' formulas rely on are preserved untouched.
 */
export function stripBrokenDefinedNames(wb: ExcelJS.Workbook): void {
  const isBrokenRange = (range: string): boolean =>
    /#REF!/i.test(range) || /\[[^\]]+\]/.test(range);
  try {
    const model = wb.definedNames.model;
    const kept = model.filter((dn) => !dn.ranges.some(isBrokenRange));
    if (kept.length !== model.length) {
      wb.definedNames.model = kept;
    }
  } catch (err) {
    logger.warn({ err }, "Failed to strip broken defined names from workbook");
  }
}

// ---------------------------------------------------------------------------
// Reference-workbook hardening
//
// The four export engines (master, WSP, TYLin, Parsons) all load one of Julie's
// real workbooks, delete the internal-only sheets, and ship the rest. Deleting a
// sheet orphans every formula and defined name that pointed at it, and Excel
// answers an uncompilable reference with the "We found a problem with some
// content… Do you want us to try to recover as much as we can?" repair prompt —
// in front of the client.
//
// These helpers were developed engine by engine (WSP → TYLin → Parsons) and
// diverged as they went, which is how masterWorkbook ended up with none of them.
// They live here now so all four engines harden identically and cannot drift
// apart again. The predicates below are the union of what the four engines had.
// ---------------------------------------------------------------------------

/** `'<name>'!` and `<name>!` reference tokens for the given removed sheets. */
export function deletedRefTokens(removed: string[]): string[] {
  const tokens: string[] = [];
  for (const name of removed) {
    tokens.push(`'${name}'!`);
    tokens.push(`${name}!`);
  }
  return tokens;
}

/** An Excel error literal, in either representation exceljs uses for a result. */
const ERROR_RESULT = /^#(REF!|VALUE!|DIV\/0!|NAME\?|NUM!|NULL!|N\/A|SPILL!|CALC!)$/i;

/**
 * True when a formula's cached result cannot be shipped as a literal — it is
 * absent, or it is an Excel error. Freezing a `#REF!` formula to its cached
 * result would otherwise put the *text* "#REF!" in front of the client, which
 * is no better than the broken formula; such cells are blanked instead.
 */
function unusableResult(result: unknown): boolean {
  if (result === undefined || result === null) return true;
  if (typeof result === "object" && "error" in (result as object)) return true;
  return typeof result === "string" && ERROR_RESULT.test(result);
}

type FormulaCellValue = {
  formula?: string;
  sharedFormula?: string;
  shareType?: string;
  result?: unknown;
};

function asFormulaCell(cell: ExcelJS.Cell): FormulaCellValue | null {
  const v = cell.value;
  if (!v || typeof v !== "object") return null;
  if (!("formula" in v) && !("sharedFormula" in v)) return null;
  return v as FormulaCellValue;
}

/** Replaces a formula cell with its cached result (or blank), keeping its style. */
function freezeCell(cell: ExcelJS.Cell, result: unknown): void {
  const style = cell.style;
  cell.value = unusableResult(result) ? null : (result as ExcelJS.CellValue);
  cell.style = style;
}

/**
 * Freezes every formula cell matching `matches` to its cached value, along with
 * any shared-formula child of a frozen master.
 *
 * The second pass is not optional: exceljs stores a shared group as one master
 * carrying the text and children carrying only `sharedFormula: "<master addr>"`.
 * Freezing the master alone leaves children pointing at a cell that no longer
 * holds a formula, which makes exceljs throw "Shared Formula master must exist
 * above and or left of clone" on write.
 */
function freezeFormulas(wb: ExcelJS.Workbook, matches: (formula: string) => boolean): void {
  for (const ws of wb.worksheets) {
    const frozenMasters = new Set<string>();
    ws.eachRow({ includeEmpty: false }, (row) => {
      row.eachCell({ includeEmpty: false }, (cell) => {
        const v = asFormulaCell(cell);
        if (!v || typeof v.formula !== "string" || !matches(v.formula)) return;
        frozenMasters.add(cell.address);
        freezeCell(cell, v.result);
      });
    });
    if (frozenMasters.size === 0) continue;
    ws.eachRow({ includeEmpty: false }, (row) => {
      row.eachCell({ includeEmpty: false }, (cell) => {
        const v = asFormulaCell(cell);
        if (!v || typeof v.sharedFormula !== "string") return;
        if (frozenMasters.has(v.sharedFormula)) freezeCell(cell, v.result);
      });
    });
  }
}

/**
 * Replaces every formula that cannot compile in the shipped workbook with its
 * cached result value, so the client file never opens to a repair prompt. A
 * formula is unstable when it
 *
 *  - references a sheet this engine removed (`removedTokens`);
 *  - carries an `[N]` external-workbook index. exceljs drops `xl/externalLinks`
 *    and the `<externalReferences>` list when it rewrites the file but leaves
 *    the index tokens in the formulas, so Excel cannot resolve them and reports
 *    "Removed Records: Formula from /xl/worksheets/sheetN.xml";
 *  - already evaluates to `#REF!`/`#NAME?` in the template; or
 *  - uses a function no real Excel has — the Google-Sheets export artifacts
 *    (`DUMMYFUNCTION`) and the `_xleta`/`_xlfn.LAMBDA`/`_xlfn.SINGLE` future
 *    functions.
 *
 * The meaningful cross-sheet cells are overwritten with authoritative values
 * before this runs, so anything caught here is incidental to the client's
 * numbers.
 */
export function freezeUnstableFormulas(wb: ExcelJS.Workbook, removedTokens: string[]): void {
  freezeFormulas(wb, (formula) => {
    if (removedTokens.some((t) => formula.includes(t))) return true;
    if (/\[\d+\]/.test(formula)) return true;
    return /DUMMYFUNCTION|_xleta|_xlfn\.LAMBDA|_xlfn\.SINGLE|#REF!|#NAME\?/i.test(formula);
  });
}

/**
 * Converts every shared-formula cell (both the `shareType:"shared"` master and
 * its `sharedFormula` children) and every array-formula cell to its cached
 * result value.
 *
 * The TYLin and Parsons templates originated as Google-Sheets exports whose
 * shared/array groups span cells the engines clear or overwrite; leaving a
 * dangling shared child makes exceljs throw "Shared Formula master must exist
 * above and or left of clone" on write. The authoritative figures are already
 * written as values, so freezing these does not change any client-visible
 * number.
 */
export function freezeSharedFormulas(wb: ExcelJS.Workbook): void {
  for (const ws of wb.worksheets) {
    ws.eachRow({ includeEmpty: false }, (row) => {
      row.eachCell({ includeEmpty: false }, (cell) => {
        const v = asFormulaCell(cell);
        if (!v) return;
        if (v.sharedFormula !== undefined || v.shareType === "shared" || v.shareType === "array") {
          freezeCell(cell, v.result);
        }
      });
    });
  }
}

/**
 * Drops defined names that point at a removed sheet, a `#REF!`, or an external
 * workbook (`[1]…`). The reference templates carry several (INVOICE, FEEBAL,
 * EDATE, STDATE, TotalToDate) that would otherwise trigger Excel's repair
 * prompt once their target sheets are gone.
 */
export function dropDeadDefinedNames(
  wb: ExcelJS.Workbook,
  removedTokens: string[],
  engine: string,
): void {
  const isDead = (range: string): boolean =>
    /#REF!/i.test(range) ||
    /\[[^\]]+\]/.test(range) ||
    removedTokens.some((t) => range.includes(t));
  try {
    const model = wb.definedNames.model;
    const kept = model.filter((dn) => !dn.ranges.some(isDead));
    if (kept.length !== model.length) wb.definedNames.model = kept;
  } catch (err) {
    logger.warn({ err, engine }, "Failed to drop dead defined names from workbook");
  }
}

/** Fill colors that mark internal notes/highlights and must never ship. */
const HIGHLIGHT_ARGB = /^(FF)?(FFFF00|FFFF33|FFFF66|FFFF99|FFFFCC|FFF2CC|FFE699|FFEB9C|FFFFE0)$/i;

/**
 * Removes cell comments and yellow "internal note / input" highlight fills that
 * Julie's working templates carry, so the client workbook ships clean.
 */
export function scrubInternalMarks(wb: ExcelJS.Workbook): void {
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

/** Removes a worksheet by name, via the exceljs id-based API. */
export function removeSheet(wb: ExcelJS.Workbook, name: string): void {
  const ws = wb.getWorksheet(name);
  if (ws) wb.removeWorksheet(ws.id);
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function setValuePreserveStyle(ws: ExcelJS.Worksheet, address: string, value: ExcelJS.CellValue): void {
  const cell = ws.getCell(address);
  const style = cell.style;
  cell.value = value;
  cell.style = style;
}

/**
 * Clears the value of a cell while keeping its style intact. Used to wipe the
 * template's hardcoded sample labor rows before writing real data so stale
 * figures cannot leak into (or double-count within) the generated attachment.
 */
function clearCell(ws: ExcelJS.Worksheet, address: string): void {
  const cell = ws.getCell(address);
  const style = cell.style;
  cell.value = null;
  cell.style = style;
}

/**
 * Writes the invoice's labor line items into the LABOR ATTACHMENT sheet,
 * grouped Home vs Field. We first clear the template's hardcoded sample rows,
 * then write classification / name / hours / rate plus the computed amount and
 * fully-burdened "Billed $" (labor * (1 + fringe) * (1 + fixed fee)) — mirroring
 * the template's own per-row burden math. The SUBTOTAL/SUM rows in the template
 * recompute from these values automatically.
 */
function writeLaborAttachment(ws: ExcelJS.Worksheet, data: InvoiceExportData): void {
  const burdenFactor = (1 + data.fringeRate / 100) * (1 + data.fixedFeeRate / 100);

  // Wipe both sample blocks first.
  for (const block of [HOME_ROWS, FIELD_ROWS]) {
    for (let r = block.start; r <= block.end; r++) {
      for (const col of ["B", "C", "D", "E", "F", "H"]) {
        clearCell(ws, `${col}${r}`);
      }
    }
  }

  const home = data.lineItems.filter((li) => li.location !== "field");
  const field = data.lineItems.filter((li) => li.location === "field");

  const writeRows = (items: ExportLineItem[], block: { start: number; end: number }): number => {
    const capacity = block.end - block.start + 1;
    const overflow = Math.max(0, items.length - capacity);
    items.slice(0, capacity).forEach((li, idx) => {
      const r = block.start + idx;
      const amount = round2(li.hours * li.rate);
      setValuePreserveStyle(ws, `B${r}`, li.classification);
      setValuePreserveStyle(ws, `C${r}`, li.employeeName);
      setValuePreserveStyle(ws, `D${r}`, li.hours);
      setValuePreserveStyle(ws, `E${r}`, li.rate);
      setValuePreserveStyle(ws, `F${r}`, amount);
      setValuePreserveStyle(ws, `H${r}`, round2(amount * burdenFactor));
    });
    return overflow;
  };

  const overflow = writeRows(home, HOME_ROWS) + writeRows(field, FIELD_ROWS);
  if (overflow > 0) {
    logger.warn({ overflow }, "Labor attachment has more line items than template rows; extra rows omitted");
  }
}

/**
 * Loads the master BART template, injects the values we control, and writes a
 * populated .xlsx. All formulas, number formats, merged cells, column widths,
 * and embedded images from the template are preserved; only the explicit input
 * cells below are overwritten. The headline billing figures are injected as the
 * authoritative computed values (the deep cross-sheet formula chain in the
 * template assumes a single hardcoded employee, so we drive the summary
 * directly while still populating the labor attachment for supporting detail).
 * The workbook is flagged for full recalculation so dependent formula cells
 * recompute when opened (in Excel or during LibreOffice PDF conversion).
 */
export async function buildInvoiceWorkbook(data: InvoiceExportData): Promise<string> {
  ensureDirs();
  if (!fs.existsSync(TEMPLATE_PATH)) {
    throw new Error("Invoice template not found at " + TEMPLATE_PATH);
  }

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(TEMPLATE_PATH);

  const master = wb.getWorksheet(MASTER_SHEET);
  if (master) {
    setValuePreserveStyle(master, "C3", " " + data.invoiceNumber);
    setValuePreserveStyle(master, "C4", toDate(data.invoiceDate));
    setValuePreserveStyle(master, "D6", toDate(data.periodStart));
    setValuePreserveStyle(master, "G6", toDate(data.periodEnd));
  }

  const invoice = wb.getWorksheet(INVOICE_SHEET);
  if (invoice) {
    if (data.poNumber) setValuePreserveStyle(invoice, "L8", data.poNumber);
    // Billing summary (override the cross-sheet formula refs with authoritative values).
    setValuePreserveStyle(invoice, "L27", data.financials.totalThisPeriod); // Amount due / line item
    setValuePreserveStyle(invoice, "J34", data.totalBudget); // Total Work Plan Budget
    // J35 is "=L30" in the template (a stale single-employee chain). Override with the
    // authoritative this-period total so J37 (=J35+J36) and J38 (=J34-J37) recompute correctly.
    setValuePreserveStyle(invoice, "J35", data.financials.totalThisPeriod); // This Period Billed
    setValuePreserveStyle(invoice, "J36", data.financials.previouslyBilled); // Previously Billed
    // J37/J38 are template formulas (=J35+J36, =J34-J37) but exceljs only stores stale cached
    // results and headless soffice may not recalc, so write the authoritative backend values.
    setValuePreserveStyle(invoice, "J37", data.financials.totalToDate); // Total Billed To Date
    setValuePreserveStyle(invoice, "J38", data.financials.remainingBalance); // Remaining Balance
  }

  const labor = wb.getWorksheet(LABOR_SHEET);
  if (labor) {
    writeLaborAttachment(labor, data);
  }

  const progress = wb.getWorksheet(PROGRESS_SHEET);
  if (progress && data.progress) {
    if (data.progress.workCompleted || data.progress.summary) {
      setValuePreserveStyle(progress, "C11", data.progress.workCompleted || data.progress.summary || "");
    }
    if (data.progress.issues) {
      setValuePreserveStyle(progress, "C22", data.progress.issues);
    }
  }

  // Place the approver signature on the Invoice sheet and the Progress Report
  // sheet, just above each signer line.
  if (data.signatureImagePath && fs.existsSync(data.signatureImagePath)) {
    try {
      const ext = path.extname(data.signatureImagePath).replace(".", "").toLowerCase();
      const extension = ext === "jpg" || ext === "jpeg" ? "jpeg" : ext === "gif" ? "gif" : "png";
      const buffer = fs.readFileSync(data.signatureImagePath) as unknown as ExcelJS.Buffer;
      const ext2: { width: number; height: number } = { width: 180, height: 55 };
      if (invoice) {
        const id = wb.addImage({ buffer, extension });
        invoice.addImage(id, { tl: { col: 1, row: 43 }, ext: ext2 }); // ~B44, above "Mahsa Azad, President" (row 46)
      }
      if (progress) {
        const id = wb.addImage({ buffer, extension });
        progress.addImage(id, { tl: { col: 1, row: 26 }, ext: ext2 }); // signature block on the progress report
      }
    } catch (err) {
      logger.warn({ err }, "Failed to embed signature image into workbook");
    }
  }

  stripBrokenDefinedNames(wb);
  wb.calcProperties.fullCalcOnLoad = true;

  const safeNumber = data.invoiceNumber.replace(/[^A-Za-z0-9._-]/g, "_");
  const filename = `Invoice_${safeNumber}_${Date.now()}.xlsx`;
  const outPath = path.resolve(generatedDir, filename);
  await wb.xlsx.writeFile(outPath);
  return outPath;
}

/**
 * The last row/column on a sheet that actually holds a value.
 *
 * The reference templates declare a padded dimension (e.g. A1:Z1000) that is
 * mostly empty. Excel and LibreOffice size the printed page from that padded
 * range, so a one-page fit shrinks the real content to an unreadable speck —
 * which is exactly what Julie saw ("it's because this is shrunk that it's not
 * showing up on the PDF"). Measuring the populated range instead lets us print
 * only the content that exists, at a legible scale.
 */
function usedRange(ws: ExcelJS.Worksheet): { lastRow: number; lastCol: number; firstCol: number } {
  let lastRow = 0;
  let lastCol = 0;
  let firstCol = Number.MAX_SAFE_INTEGER;
  ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    let rowHasValue = false;
    row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
      const v = cell.value;
      // Blank strings and null-ish formula results don't count as content;
      // otherwise a sheet padded with "" would defeat the whole measurement.
      const empty =
        v === null ||
        v === undefined ||
        (typeof v === "string" && v.trim() === "") ||
        (typeof v === "object" && "result" in v && (v.result === null || v.result === undefined) && !("formula" in v));
      if (empty) return;
      rowHasValue = true;
      if (colNumber > lastCol) lastCol = colNumber;
      if (colNumber < firstCol) firstCol = colNumber;
    });
    if (rowHasValue && rowNumber > lastRow) lastRow = rowNumber;
  });
  return { lastRow, lastCol, firstCol: firstCol === Number.MAX_SAFE_INTEGER ? 1 : firstCol };
}

/**
 * Printable width of a sheet's populated columns, in inches.
 *
 * Excel stores column width in "characters" of the default font, where the
 * 8.43 default is 64px ≈ 0.667in — so one width unit ≈ 0.0791in. Columns with
 * no explicit width fall back to that default.
 */
const EXCEL_WIDTH_UNIT_INCHES = 0.0791;
const DEFAULT_COL_WIDTH = 8.43;
/** US Letter (8.5in) less the 0.3in side margins set below. */
const PORTRAIT_PRINTABLE_INCHES = 8.5 - 0.6;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

/**
 * Restores Date objects to a worksheet model that was deep-cloned through
 * JSON.
 *
 * The engines clone a pristine template sheet with
 * `JSON.parse(JSON.stringify(...))`, which turns every Date into an ISO string.
 * exceljs later calls `getTime()` on those values while writing the file and
 * throws `TypeError: d.getTime is not a function`. Every engine that clones a
 * sheet must run this over the clone first — masterWorkbook once didn't, and
 * crashed whenever a package needed more week tabs than the template had.
 */
export function reviveModelDates(model: {
  rows?: Array<{ cells?: Array<Record<string, unknown>> }>;
}): void {
  for (const row of model.rows ?? []) {
    for (const cell of row.cells ?? []) {
      if (!cell) continue;
      if (typeof cell.value === "string" && ISO_DATE.test(cell.value)) {
        cell.value = new Date(cell.value);
      }
      if (typeof cell.result === "string" && ISO_DATE.test(cell.result as string)) {
        cell.result = new Date(cell.result as string);
      }
    }
  }
}

/** Column letters ("A", "AG") → 1-based column number. */
function colLetterToNumber(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

/**
 * First/last column of an A1-style range, tolerating the `$` anchors and
 * sheet-name prefixes Excel writes into print areas ("'Sub Calc'!$A$1:$K$52").
 * Multi-area print ranges (comma separated) fall back to their first area.
 */
function parseRangeBounds(range: string): { firstCol: number; lastCol: number } | null {
  const firstArea = range.split(",")[0];
  const cells = firstArea.replace(/^.*!/, "").replace(/\$/g, "");
  const m = cells.match(/^([A-Za-z]+)\d+(?::([A-Za-z]+)\d+)?$/);
  if (!m) return null;
  const firstCol = colLetterToNumber(m[1]);
  return { firstCol, lastCol: m[2] ? colLetterToNumber(m[2]) : firstCol };
}

function contentWidthInches(ws: ExcelJS.Worksheet, firstCol: number, lastCol: number): number {
  let units = 0;
  for (let c = firstCol; c <= lastCol; c++) {
    const col = ws.getColumn(c);
    if (col.hidden) continue;
    units += col.width ?? DEFAULT_COL_WIDTH;
  }
  return units * EXCEL_WIDTH_UNIT_INCHES;
}

/**
 * Sets a sane print layout on every visible sheet so the client PDF is legible
 * and nothing is clipped.
 *
 * Julie's demo feedback was twofold: content was cut off, and what did print
 * was "too shrunk". Both trace to print setup rather than missing data —
 *   - the templates carry a padded dimension (A1:Z1000) and, in some cases, a
 *     stale print area left over from the previous hand-built workbooks, which
 *     clipped real columns off the page ("we need to … re-select the print
 *     area from Excel");
 *   - a strict one-page fit (fitToHeight: 1) then crammed ~1000 rows onto a
 *     single sheet, shrinking the type to nothing.
 *
 * So: re-derive the print area from the populated range, fit the columns to one
 * page WIDE, and let rows flow down as many pages as they need (fitToHeight: 0)
 * so the font stays the size Julie expects. A `scale` is deliberately not set —
 * it is mutually exclusive with fitToPage in the OOXML spec, and leaving it
 * lets the reader do the width math.
 */
/**
 * Sheets whose whole point is to be a single printed form. Julie reviews these
 * as one page each and flagged both the T.Y. Lin `Invoice` and `Sub1 Inv`
 * spilling a few rows onto a second sheet of paper. Everything else (labor
 * lines, timesheets, progress narratives) genuinely flows down and keeps
 * `fitToHeight: 0`.
 */
const SINGLE_PAGE_FORMS = new Set(
  [
    "invoice",
    "cover",
    "sub calc",
    "sub calc _revised",
    "sub1 inv",
    "sub1 labor",
    "labor attachment",
    "overview",
    "odcs",
  ].map((n) => n.toLowerCase()),
);

export function fitSheetsToOnePage(wb: ExcelJS.Workbook): void {
  for (const ws of wb.worksheets) {
    if (ws.state === "hidden" || ws.state === "veryHidden") continue;

    const { lastRow, lastCol } = usedRange(ws);
    if (lastRow === 0 || lastCol === 0) {
      // Nothing on the sheet — drop any print area rather than keeping a range
      // that would send a blank page to the client.
      ws.pageSetup = { ...ws.pageSetup, printArea: undefined };
      continue;
    }

    // The reference templates already carry the print area Julie set up by
    // hand (e.g. Invoice!$A$1:$O$46). That range is authoritative: it
    // deliberately excludes the helper cells parked off to the right of the
    // form, which a naive "everything that has a value" scan would drag in —
    // widening the page to ~15in and shrinking the type to 4pt. Only derive a
    // range when the template didn't define one.
    const printArea =
      ws.pageSetup?.printArea ?? `A1:${ws.getColumn(lastCol).letter}${lastRow}`;

    // Orientation follows whatever we are actually printing. A form that is
    // genuinely wider than a portrait page gets turned sideways rather than
    // scaled into illegibility; anything that fits keeps the template's look.
    const bounds = parseRangeBounds(printArea);
    const width = bounds
      ? contentWidthInches(ws, bounds.firstCol, bounds.lastCol)
      : 0;
    const orientation: "portrait" | "landscape" =
      width > PORTRAIT_PRINTABLE_INCHES ? "landscape" : (ws.pageSetup?.orientation ?? "portrait");

    ws.pageSetup = {
      ...ws.pageSetup,
      printArea,
      orientation,
      fitToPage: true,
      fitToWidth: 1,
      // Forms are pinned to a single page; list-shaped sheets flow down rather
      // than being squeezed to illegibility.
      fitToHeight: SINGLE_PAGE_FORMS.has(ws.name.toLowerCase()) ? 1 : 0,
      horizontalCentered: true,
      margins: { left: 0.3, right: 0.3, top: 0.35, bottom: 0.35, header: 0.2, footer: 0.2 },
    };
  }
}

/**
 * Resolves the signature image's absolute path from its stored imageUrl
 * (e.g. "/api/files/signature_123.png" -> uploadsDir/signature_123.png).
 * Returns null when the file cannot be located.
 */
export function resolveSignaturePath(imageUrl: string | null | undefined): string | null {
  if (!imageUrl) return null;
  const filename = decodeURIComponent(path.basename(imageUrl));
  const abs = path.resolve(uploadsDir, filename);
  return fs.existsSync(abs) ? abs : null;
}

let sofficeBin: string | null = null;

function resolveSoffice(): string {
  if (sofficeBin) return sofficeBin;
  // 1. Explicit override — an absolute path to soffice(.exe). Lets a machine
  // without a system-wide install (e.g. a portable or msiexec-extracted
  // LibreOffice) point the server straight at the binary.
  const override = process.env.SOFFICE_BIN;
  if (override && fs.existsSync(override)) {
    sofficeBin = override;
    return override;
  }
  // 2. On PATH (Linux/Replit, or a normal install that registered PATH).
  const candidates = ["soffice", "libreoffice"];
  const whichCmd = process.platform === "win32" ? "where" : "which";
  for (const c of candidates) {
    try {
      execFileSync(whichCmd, [c], { stdio: "ignore" });
      sofficeBin = c;
      return c;
    } catch {
      // not found on PATH, try next candidate
    }
  }
  // 3. Common Windows install locations (system-wide MSI installs).
  if (process.platform === "win32") {
    const guesses = [
      "C:/Program Files/LibreOffice/program/soffice.exe",
      "C:/Program Files (x86)/LibreOffice/program/soffice.exe",
    ];
    for (const g of guesses) {
      if (fs.existsSync(g)) {
        sofficeBin = g;
        return g;
      }
    }
  }
  sofficeBin = "soffice";
  return sofficeBin;
}

// LibreOffice needs a writable user profile. Building a fresh one on every
// call forces a slow first-run initialization each time (which on Windows can
// exceed the timeout and hang), so we reuse a single persistent profile via
// -env:UserInstallation. A shared profile can't be driven by two headless
// instances at once, so conversions run one at a time through this in-process
// queue. Override the location with SOFFICE_PROFILE_DIR if needed.
let pdfQueue: Promise<unknown> = Promise.resolve();

function userInstallationUrl(): string {
  const dir = process.env.SOFFICE_PROFILE_DIR || path.join(os.tmpdir(), "azad-lo-profile");
  fs.mkdirSync(dir, { recursive: true });
  // file:// URL with forward slashes. Windows paths keep their drive letter
  // after the three slashes (file:///C:/...); POSIX paths already start with /.
  const normalized = dir.replace(/\\/g, "/").replace(/^\/+/, "");
  return `file:///${normalized}`;
}

async function convertToPdfOnce(xlsxPath: string): Promise<string> {
  ensureDirs();
  const bin = resolveSoffice();
  try {
    await execFileAsync(
      bin,
      [
        "--headless",
        "--invisible",
        "--nodefault",
        "--nofirststartwizard",
        "--nologo",
        "--norestore",
        `-env:UserInstallation=${userInstallationUrl()}`,
        "--convert-to",
        "pdf:calc_pdf_Export",
        "--outdir",
        generatedDir,
        xlsxPath,
      ],
      {
        // Generous timeout: the very first conversion warms the profile and can
        // take ~40s; subsequent ones are fast.
        timeout: 180000,
        maxBuffer: 1024 * 1024 * 32,
      },
    );
  } catch (err) {
    logger.error({ err }, "LibreOffice PDF conversion failed");
    throw new Error("PDF conversion failed");
  }

  const pdfPath = path.resolve(generatedDir, path.basename(xlsxPath).replace(/\.xlsx$/i, ".pdf"));
  if (!fs.existsSync(pdfPath)) {
    throw new Error("PDF conversion produced no output");
  }
  return pdfPath;
}

/**
 * Converts an .xlsx file to PDF using headless LibreOffice. Returns the path to
 * the generated PDF. Calls are serialized (see pdfQueue) so they can share one
 * warm user profile.
 *
 * Do NOT rely on this to evaluate formulas. LibreOffice defaults to "never
 * recalculate" for xlsx, so a formula cell renders whatever cached result the
 * file carries — which, for a workbook built from one of Julie's reference
 * invoices, is her previous invoice's number. Every figure in a deliverable
 * must be written as a value by its export engine before it gets here.
 */
export async function convertToPdf(xlsxPath: string): Promise<string> {
  const task = pdfQueue.then(
    () => convertToPdfOnce(xlsxPath),
    () => convertToPdfOnce(xlsxPath),
  );
  // Keep the queue alive regardless of this task's outcome.
  pdfQueue = task.then(
    () => undefined,
    () => undefined,
  );
  return task;
}
