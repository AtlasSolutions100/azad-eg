import ExcelJS from "exceljs";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { templatesDir, generatedDir, ensureDirs } from "./paths";
import { logger } from "./logger";

const execFileAsync = promisify(execFile);

const TEMPLATE_PATH = path.resolve(templatesDir, "bart-invoice-template.xlsm");
const MASTER_SHEET = "Master File ";
const INVOICE_SHEET = "Invoice";
const PROGRESS_SHEET = "Progress Report";

export interface InvoiceExportData {
  invoiceNumber: string;
  invoiceDate: string; // YYYY-MM-DD
  periodStart: string; // YYYY-MM-DD
  periodEnd: string; // YYYY-MM-DD
  poNumber?: string | null;
  totalBudget: number;
  previouslyBilled: number;
  totalThisPeriod: number;
  progress?: {
    summary?: string | null;
    workCompleted?: string | null;
    issues?: string | null;
    percentComplete?: number | null;
  } | null;
}

function toDate(value: string): Date {
  // Treat YYYY-MM-DD as a calendar day in local time (noon avoids TZ rollover).
  const [y, m, d] = value.split("-").map((n) => parseInt(n, 10));
  return new Date(y, (m || 1) - 1, d || 1, 12, 0, 0);
}

function setValuePreserveStyle(ws: ExcelJS.Worksheet, address: string, value: ExcelJS.CellValue): void {
  const cell = ws.getCell(address);
  const style = cell.style;
  cell.value = value;
  cell.style = style;
}

/**
 * Loads the master BART template, injects the values we control into the
 * canonical input cells, and writes a populated .xlsx. All formulas, number
 * formats, merged cells, column widths, and embedded images from the template
 * are preserved; only the explicit input cells below are overwritten. The
 * workbook is flagged for full recalculation so downstream formula cells
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
    setValuePreserveStyle(invoice, "J34", data.totalBudget);
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

  wb.calcProperties.fullCalcOnLoad = true;

  const safeNumber = data.invoiceNumber.replace(/[^A-Za-z0-9._-]/g, "_");
  const filename = `Invoice_${safeNumber}_${Date.now()}.xlsx`;
  const outPath = path.resolve(generatedDir, filename);
  await wb.xlsx.writeFile(outPath);
  return outPath;
}

let sofficeBin: string | null = null;

function resolveSoffice(): string {
  if (sofficeBin) return sofficeBin;
  const candidates = ["soffice", "libreoffice"];
  for (const c of candidates) {
    sofficeBin = c;
    return c;
  }
  return "soffice";
}

/**
 * Converts an .xlsx file to PDF using headless LibreOffice. LibreOffice
 * recalculates formulas on load, so the populated template renders with
 * correct computed values. Returns the path to the generated PDF.
 */
export async function convertToPdf(xlsxPath: string): Promise<string> {
  ensureDirs();
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "lo-profile-"));
  const bin = resolveSoffice();
  try {
    await execFileAsync(
      bin,
      [
        "--headless",
        "--norestore",
        "--convert-to",
        "pdf:calc_pdf_Export",
        "--outdir",
        generatedDir,
        xlsxPath,
      ],
      {
        env: { ...process.env, HOME: profileDir },
        timeout: 120000,
        maxBuffer: 1024 * 1024 * 32,
      },
    );
  } catch (err) {
    logger.error({ err }, "LibreOffice PDF conversion failed");
    throw new Error("PDF conversion failed");
  } finally {
    fs.rmSync(profileDir, { recursive: true, force: true });
  }

  const pdfPath = path.resolve(generatedDir, path.basename(xlsxPath).replace(/\.xlsx$/i, ".pdf"));
  if (!fs.existsSync(pdfPath)) {
    throw new Error("PDF conversion produced no output");
  }
  return pdfPath;
}
