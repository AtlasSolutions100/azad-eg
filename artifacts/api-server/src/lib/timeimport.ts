import ExcelJS from "exceljs";
import { Readable } from "node:stream";

export interface ParsedLine {
  employeeName: string;
  classification: string;
  category: "regular" | "ot" | "dt" | "holiday" | "pto";
  location: "home" | "field";
  hours: number;
  rate: number;
  taskNo?: string | null;
  notes?: string | null;
}

export interface ParseResult {
  lines: ParsedLine[];
  warnings: string[];
}

const HEADER_ALIASES: Record<string, string[]> = {
  name: ["employee", "name", "resource", "worker", "staff"],
  classification: ["classification", "class", "title", "role", "labor category"],
  category: ["category", "type", "hour type", "pay type", "ot/dt"],
  location: ["location", "loc", "site"],
  hours: ["hours", "hrs", "qty", "quantity", "time"],
  rate: ["rate", "bill rate", "billing rate", "hourly rate", "pay rate"],
  task: ["task", "task no", "task number", "phase", "code"],
};

function normalizeHeader(h: string): string {
  return h.toLowerCase().replace(/[^a-z0-9 ]/g, "").trim();
}

function matchColumn(headers: string[], key: string): number {
  const aliases = HEADER_ALIASES[key];
  for (let i = 0; i < headers.length; i++) {
    const h = normalizeHeader(headers[i]);
    if (aliases.some((a) => h === a || h.includes(a))) return i;
  }
  return -1;
}

function normalizeCategory(raw: string): ParsedLine["category"] {
  const v = raw.toLowerCase();
  if (v.includes("double") || v === "dt" || v.includes("dbl")) return "dt";
  if (v.includes("over") || v === "ot") return "ot";
  if (v.includes("holiday") || v === "hol") return "holiday";
  if (v.includes("pto") || v.includes("vacation") || v.includes("sick")) return "pto";
  return "regular";
}

function normalizeLocation(raw: string): ParsedLine["location"] {
  return raw.toLowerCase().includes("field") ? "field" : "home";
}

function rowsToLines(rows: string[][]): ParseResult {
  const warnings: string[] = [];
  const lines: ParsedLine[] = [];

  let headerRowIdx = -1;
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    if (matchColumn(rows[i], "name") >= 0 && matchColumn(rows[i], "hours") >= 0) {
      headerRowIdx = i;
      break;
    }
  }
  if (headerRowIdx === -1) {
    return { lines: [], warnings: ["Could not locate a header row with employee and hours columns."] };
  }

  const headers = rows[headerRowIdx];
  const cName = matchColumn(headers, "name");
  const cClass = matchColumn(headers, "classification");
  const cCat = matchColumn(headers, "category");
  const cLoc = matchColumn(headers, "location");
  const cHours = matchColumn(headers, "hours");
  const cRate = matchColumn(headers, "rate");
  const cTask = matchColumn(headers, "task");

  for (let i = headerRowIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    const name = (row[cName] ?? "").toString().trim();
    const hoursRaw = (row[cHours] ?? "").toString().trim();
    if (!name && !hoursRaw) continue;
    const hours = parseFloat(hoursRaw.replace(/[^0-9.-]/g, ""));
    if (!name) {
      warnings.push(`Row ${i + 1}: missing employee name, skipped.`);
      continue;
    }
    if (!Number.isFinite(hours) || hours === 0) {
      warnings.push(`Row ${i + 1} (${name}): missing or zero hours, skipped.`);
      continue;
    }
    const rate = cRate >= 0 ? parseFloat((row[cRate] ?? "").toString().replace(/[^0-9.-]/g, "")) : NaN;
    if (!Number.isFinite(rate)) {
      warnings.push(`Row ${i + 1} (${name}): no rate found, defaulted to 0 — set it manually.`);
    }
    lines.push({
      employeeName: name,
      classification: cClass >= 0 ? (row[cClass] ?? "").toString().trim() : "",
      category: cCat >= 0 ? normalizeCategory((row[cCat] ?? "").toString()) : "regular",
      location: cLoc >= 0 ? normalizeLocation((row[cLoc] ?? "").toString()) : "home",
      hours,
      rate: Number.isFinite(rate) ? rate : 0,
      taskNo: cTask >= 0 ? (row[cTask] ?? "").toString().trim() || null : null,
    });
  }

  if (lines.length === 0) warnings.push("No valid line items were found in the file.");
  return { lines, warnings };
}

// Maps arbitrary JSON timesheet records (e.g. from the live Procas API) through
// the same fuzzy column matching used for uploaded files, so any reasonable
// Procas field naming is understood without a hard-coded schema.
export function parseTimeRecords(records: Array<Record<string, unknown>>): ParseResult {
  if (records.length === 0) {
    return { lines: [], warnings: ["Procas returned no timesheet records for this period."] };
  }
  const headerSet = new Set<string>();
  for (const r of records) for (const k of Object.keys(r)) headerSet.add(k);
  const headers = [...headerSet];
  const rows: string[][] = [headers];
  for (const r of records) {
    rows.push(headers.map((h) => (r[h] == null ? "" : String(r[h]))));
  }
  return rowsToLines(rows);
}

export async function parseTimeFile(buffer: Buffer, filename: string): Promise<ParseResult> {
  const lower = filename.toLowerCase();
  const wb = new ExcelJS.Workbook();
  const rows: string[][] = [];

  if (lower.endsWith(".csv")) {
    const ws = await wb.csv.read(Readable.from(buffer.toString("utf8")));
    ws.eachRow({ includeEmpty: false }, (row) => {
      const vals: string[] = [];
      row.eachCell({ includeEmpty: true }, (cell) => {
        vals.push(cell.value == null ? "" : String(cell.text ?? cell.value));
      });
      rows.push(vals);
    });
  } else {
    await wb.xlsx.load(buffer as unknown as ArrayBuffer);
    const ws = wb.worksheets[0];
    if (!ws) return { lines: [], warnings: ["The workbook has no sheets."] };
    ws.eachRow({ includeEmpty: false }, (row) => {
      const vals: string[] = [];
      row.eachCell({ includeEmpty: true }, (cell) => {
        const v = cell.value;
        if (v == null) vals.push("");
        else if (typeof v === "object" && "result" in v) vals.push(String((v as { result: unknown }).result ?? ""));
        else vals.push(String(cell.text ?? v));
      });
      rows.push(vals);
    });
  }

  return rowsToLines(rows);
}
