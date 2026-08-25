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
 * Converts an .xlsx file to PDF using headless LibreOffice. LibreOffice
 * recalculates formulas on load, so the populated template renders with
 * correct computed values. Returns the path to the generated PDF. Calls are
 * serialized (see pdfQueue) so they can share one warm user profile.
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
