import ExcelJS from "exceljs";
import path from "node:path";
import fs from "node:fs";
import { templatesDir, generatedDir, ensureDirs } from "./paths";
import { stripBrokenDefinedNames } from "./excel";
import { contributorKey } from "./packageMappers";
import { logger } from "./logger";
import type { PackageDocContext } from "./packageDocs";
import type { PackageWeekRow, TimesheetEntryRow } from "@workspace/db";

/**
 * Reference-workbook export engine.
 *
 * The template (`package-master-template.xlsx`) is Julie's real BART/AECOM
 * invoice workbook. Instead of assembling sheets from scratch, this builder
 * loads that workbook and mutates it in place:
 *
 *  - internal-only sheets are deleted (IL Weeks, Non-Performance, Cost (3),
 *    ODCs — the single ODC roll-up is replaced with a literal first);
 *  - sheets are renamed to client-facing names (Master File→Overview,
 *    Cover→Invoice, Cost→Sub Calc, Labor→Labor Attachment, Report→Progress
 *    Report, TJ Week n→week labels) and every formula + defined name is
 *    rewritten for the renames (ExcelJS renames do NOT rewrite formulas);
 *  - Julie's internal notes/reminders and comments are cleared;
 *  - package data is injected at the reference cell addresses, keeping the
 *    live roll-up chain intact: week tab O totals → Overview B9:F9 →
 *    Labor C19 → Sub Calc H44 → Invoice M21 / Billing Summary.
 */

const TEMPLATE_FILE = "package-master-template.xlsx";

/** Sheets that must never ship to the client. */
const INTERNAL_SHEETS = [
  "IL Week 1",
  "IL Week 2",
  "IL Week 3",
  "IL Week 4",
  "IL Week 5",
  "Non-Performance",
  "Cost (3)",
  "ODCs",
];

const RENAMES: Array<[string, string]> = [
  ["Master File", "Overview"],
  ["Cover", "Invoice"],
  ["Cost", "Sub Calc"],
  ["Labor", "Labor Attachment"],
  ["Report", "Progress Report"],
];

/** Template week tabs, in order. */
const WEEK_TABS = ["TJ Week 1", "TJ Week 2", "TJ Week 3", "TJ Week 4", "TJ Week 5"];

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

function setVal(ws: ExcelJS.Worksheet, address: string, value: ExcelJS.CellValue): void {
  const cell = ws.getCell(address);
  const style = cell.style;
  cell.value = value;
  cell.style = style;
}

function setFormula(ws: ExcelJS.Worksheet, address: string, formula: string): void {
  const cell = ws.getCell(address);
  const style = cell.style;
  cell.value = { formula } as ExcelJS.CellValue;
  cell.style = style;
}

function clearCell(ws: ExcelJS.Worksheet, address: string): void {
  const cell = ws.getCell(address);
  const style = cell.style;
  cell.value = null;
  cell.style = style;
}

/** Excel-safe sheet name, 31 chars, no []:*?/\ characters. */
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

/** Quote a sheet name for use inside a formula when needed. */
function quoted(name: string): string {
  return /[^A-Za-z0-9_]/.test(name) ? `'${name.replace(/'/g, "''")}'` : name;
}

/**
 * Rewrites sheet references inside a formula string for renamed tabs. Handles
 * both quoted (`'Master File'!`) and bare (`Cover!`) references; renamed
 * targets are always emitted quoted, which Excel accepts for any name.
 */
function rewriteFormula(formula: string, renames: Map<string, string>): string {
  let out = formula;
  for (const [oldName, newName] of renames) {
    out = out.split(`'${oldName.replace(/'/g, "''")}'!`).join(`${quoted(newName)}!`);
    if (!/[^A-Za-z0-9_.]/.test(oldName)) {
      out = out.replace(
        new RegExp(`(^|[^A-Za-z0-9_.'])${oldName}!`, "g"),
        (_m, pre: string) => `${pre}${quoted(newName)}!`,
      );
    }
  }
  return out;
}

/** Rewrites every formula (and shared formula master) in the workbook. */
function rewriteAllFormulas(wb: ExcelJS.Workbook, renames: Map<string, string>): void {
  for (const ws of wb.worksheets) {
    ws.eachRow({ includeEmpty: false }, (row) => {
      row.eachCell({ includeEmpty: false }, (cell) => {
        const v = cell.value;
        if (v && typeof v === "object" && "formula" in v && typeof v.formula === "string") {
          const next = rewriteFormula(v.formula, renames);
          if (next !== v.formula) {
            cell.value = { ...(v as ExcelJS.CellFormulaValue), formula: next };
          }
        }
      });
    });
  }
  try {
    wb.definedNames.model = wb.definedNames.model.map((dn) => ({
      name: dn.name,
      ranges: dn.ranges.map((r) => rewriteFormula(r, renames)),
    }));
  } catch (err) {
    logger.warn({ err }, "Failed to rewrite defined names for renamed sheets");
  }
}

/** Fill colors that mark internal notes/highlights and must never ship. */
const HIGHLIGHT_ARGB = /^(FF)?(FFFF00|FFFF33|FFFF66|FFFF99|FFFFCC|FFF2CC|FFE699|FFEB9C|FFFFE0)$/i;

/** Removes cell comments and yellow "internal note" highlight fills. */
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

interface WeekSheet {
  week: PackageWeekRow;
  /** Renamed tab names for this week (one per contributor). */
  tabNames: string[];
}

/** Distinct contributors (employee identity → display name) from entries. */
function contributors(ctx: PackageDocContext): Array<{ key: string; name: string; classification: string }> {
  const seen = new Map<string, { name: string; classification: string }>();
  for (const e of ctx.entries) {
    const name = e.employeeName.trim();
    if (!name) continue;
    const key = contributorKey(e);
    if (!seen.has(key)) seen.set(key, { name, classification: e.classification });
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
  return [...seen.entries()].map(([key, v]) => ({ key, ...v }));
}

/**
 * Billing rate for the Overview "Fully Burdened Billing Rate" cell: the rate
 * carried by the entry with the most hours (they are all the same rate in the
 * single-rate case), falling back to the work plan's overheadRate-free 0.
 */
function dominantRate(entries: TimesheetEntryRow[]): number {
  const byRate = new Map<number, number>();
  for (const e of entries) {
    const hrs =
      e.hoursMon + e.hoursTue + e.hoursWed + e.hoursThu + e.hoursFri + e.hoursSat + e.hoursSun;
    if (e.rate > 0 && hrs > 0) byRate.set(e.rate, (byRate.get(e.rate) ?? 0) + hrs);
  }
  let best = 0;
  let bestHrs = -1;
  for (const [rate, hrs] of byRate) {
    if (hrs > bestHrs) {
      best = rate;
      bestHrs = hrs;
    }
  }
  return best;
}

/** Category → reference week-tab row: 9 straight time, 11 holiday, 12 PTO. */
function weekRowFor(category: string): number {
  switch (category) {
    case "pto":
      return 12;
    case "holiday":
      return 11;
    default:
      return 9; // regular / ot / dt / night — billable straight time row
  }
}

/**
 * Fills one reference-layout week tab for one contributor. Columns H..N are
 * Sat..Fri; our weeks start Monday, so the tab's Saturday (H6) is
 * weekStart − 2 days. Row 9 is the billable row the Overview pulls (O9).
 */
function fillWeekTab(
  ws: ExcelJS.Worksheet,
  week: PackageWeekRow,
  ctx: PackageDocContext,
  person: { key: string; name: string; classification: string },
): void {
  setVal(ws, "D5", person.name);
  // H6 is the tab's Saturday: snap to the Saturday on/before weekStart.
  const start = toDate(week.weekStart);
  setVal(ws, "H6", addDays(start, -((start.getDay() + 1) % 7)));
  // I6..N6 are shared formulas (=prev+1) — leave them alone.

  // Clear sample content: contract/description labels and all day-hour cells.
  for (let r = 9; r <= 14; r++) {
    for (const col of ["B", "D", "H", "I", "J", "K", "L", "M", "N"]) clearCell(ws, `${col}${r}`);
  }
  setVal(ws, "B9", `${ctx.workPlan.agreementNo || ctx.workPlan.jobNumber} / ${ctx.workPlan.code}`);
  setVal(ws, "D9", person.classification);
  setVal(ws, "B11", "Holiday");
  setVal(ws, "B12", "PTO (Sick/Vacation)");

  // Day columns: H=Sat, I=Sun, J=Mon, K=Tue, L=Wed, M=Thu, N=Fri.
  const acc = new Map<number, Record<string, number>>();
  for (const e of ctx.entries.filter(
    (x) => x.weekId === week.id && contributorKey(x) === person.key,
  )) {
    const r = weekRowFor(e.category);
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
  for (const [r, a] of acc) {
    for (const col of ["H", "I", "J", "K", "L", "M", "N"]) {
      const v = a[col];
      if (v > 0) setVal(ws, `${col}${r}`, round2(v));
    }
  }
}

/** Removes a worksheet with the ExcelJS id-based API. */
function removeSheet(wb: ExcelJS.Workbook, name: string): void {
  const ws = wb.getWorksheet(name);
  if (ws) wb.removeWorksheet(ws.id);
}

/**
 * Builds the client-ready workbook from the reference template. Returns the
 * workbook plus the ordered week tab names (needed for verification/tests).
 */
export async function buildMasterWorkbook(
  ctx: PackageDocContext,
): Promise<{ wb: ExcelJS.Workbook; weekSheets: WeekSheet[] }> {
  const file = path.resolve(templatesDir, TEMPLATE_FILE);
  if (!fs.existsSync(file)) {
    throw new Error(`Package master template not found at ${file}`);
  }
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);

  const wp = ctx.workPlan;
  const pkg = ctx.pkg;
  const cost = wb.getWorksheet("Cost")!;
  const cover = wb.getWorksheet("Cover")!;
  const master = wb.getWorksheet("Master File")!;
  const labor = wb.getWorksheet("Labor")!;
  const report = wb.getWorksheet("Report")!;

  // -- 1. Replace the ODC roll-up with a literal, then drop internal sheets.
  setVal(cost, "H27", round2(pkg.otherDirectCosts));
  for (const name of INTERNAL_SHEETS) removeSheet(wb, name);

  // -- 2. Week tabs: one per package week per contributor (row 9 feeds the
  // Overview). Weeks are cloned from a pristine TJ Week 1 model when the
  // package needs more tabs than the template carries.
  const weeks = [...ctx.weeks].sort((a, b) => a.sortOrder - b.sortOrder);
  const people = contributors(ctx);
  const persons = people.length > 0 ? people : [{ key: "name:", name: "", classification: "" }];
  const pristine = JSON.parse(JSON.stringify(wb.getWorksheet("TJ Week 1")!.model));

  const renames = new Map<string, string>(RENAMES);
  const usedNames = new Set<string>([
    ...RENAMES.map(([, n]) => n.toLowerCase()),
    ...WEEK_TABS.map((n) => n.toLowerCase()),
  ]);
  const weekSheets: WeekSheet[] = [];
  let templateIdx = 0;
  for (let i = 0; i < weeks.length; i++) {
    const week = weeks[i];
    const tabNames: string[] = [];
    for (const person of persons) {
      const label = sheetSafe(week.label, `Week ${i + 1}`);
      const base =
        persons.length > 1 && person.name
          ? sheetSafe(`${label} - ${person.name}`, label)
          : label;
      const name = uniqueName(base, usedNames);
      let ws: ExcelJS.Worksheet;
      if (templateIdx < WEEK_TABS.length) {
        ws = wb.getWorksheet(WEEK_TABS[templateIdx])!;
        renames.set(WEEK_TABS[templateIdx], name);
      } else {
        ws = wb.addWorksheet(name);
        const cloned = JSON.parse(JSON.stringify(pristine));
        cloned.id = ws.id;
        cloned.name = name;
        ws.model = cloned;
        ws.name = name;
      }
      templateIdx += 1;
      fillWeekTab(ws, week, ctx, person);
      tabNames.push(name);
    }
    weekSheets.push({ week, tabNames });
  }
  // Unused template week tabs never ship.
  for (let i = templateIdx; i < WEEK_TABS.length; i++) removeSheet(wb, WEEK_TABS[i]);

  // -- 3. Overview (Master File): clean Julie's reminders, inject the header
  // data, and point the W1..W5 roll-up at the real week tabs.
  master.state = "visible";
  for (const addr of ["E3", "D5", "H9", "I9", "H12", "I16", "G23", "I23", "H18"]) {
    clearCell(master, addr);
  }
  for (let c = 2; c <= 9; c++) clearCell(master, master.getRow(15).getCell(c).address);
  setVal(master, "C3", pkg.invoiceNumber || "");
  setVal(master, "D4", wp.agreementNo || "");
  if (pkg.invoiceDate) setVal(master, "C5", toDate(pkg.invoiceDate));
  setVal(master, "E12", toDate(pkg.payPeriodStart));
  setVal(master, "G12", toDate(pkg.payPeriodEnd));
  setVal(master, "B18", wp.totalBudget);
  setVal(master, "D18", 0);
  setVal(master, "E18", 0);
  const rate = dominantRate(ctx.entries);
  setVal(master, "I17", rate);
  setVal(master, "I18", rate);
  setVal(master, "D23", 0);
  setVal(master, "E23", round2(pkg.previouslyBilled));
  // W1..F5 roll-up: sum the billable row (O9) of every tab of that week.
  const weekCols = ["B", "C", "D", "E", "F"];
  for (let i = 0; i < weekCols.length; i++) {
    const addr = `${weekCols[i]}9`;
    const ws = weekSheets[i];
    if (!ws) {
      setVal(master, addr, 0);
    } else {
      setFormula(master, addr, ws.tabNames.map((t) => `${quoted(t)}!O9`).join("+"));
    }
  }
  // Weeks beyond the 5-column Overview grid still roll into G9.
  if (weekSheets.length > 5) {
    const extra = weekSheets
      .slice(5)
      .flatMap((wsx) => wsx.tabNames)
      .map((t) => `${quoted(t)}!O9`)
      .join("+");
    setFormula(master, "G9", `SUBTOTAL(9,B9:F9)+${extra}`);
  }

  // -- 4. Invoice (Cover): header, addresses, and the Billed Line Items table.
  if (pkg.invoiceDate) setVal(cover, "U6", toDate(pkg.invoiceDate));
  setVal(cover, "U8", wp.poNumber || "--");
  setVal(cover, "U10", wp.supplierId || "--");
  setVal(cover, "U12", wp.clientProjectNo || "--");
  setVal(cover, "H10", wp.sendToCompany || "");
  setVal(cover, "H11", wp.sendToAddress1 || "");
  setVal(cover, "H12", wp.sendToAddress2 || "");
  setVal(cover, "B13", `${(wp.sendToCompany || "Client").trim()} Contact Person: `);
  setVal(cover, "H13", wp.contactPerson || "");
  setVal(cover, "F17", ` ${wp.title}`);
  setVal(cover, "R17", wp.bartProjectNumbers || "");
  if (wp.terms) setVal(cover, "T18", wp.terms);
  if (wp.clientProjectNo) setVal(cover, "U11", `${wp.client} Project No. `);

  const items = [...ctx.billedLineItems].sort(
    (a, b) => a.sortOrder - b.sortOrder || a.id - b.id,
  );
  if (items.length > 10) {
    // The reference cover carries exactly 10 line rows (25–34); more would
    // silently drop money, so fail loudly.
    throw new Error(
      `Invoice cover supports up to 10 billed line items; package has ${items.length}`,
    );
  }
  for (let r = 25; r <= 34; r++) {
    for (const col of ["C", "E", "G", "H", "J", "M", "P", "S", "V"]) clearCell(cover, `${col}${r}`);
  }
  items.forEach((it, i) => {
    const r = 25 + i;
    if (it.workScopeNo) setVal(cover, `C${r}`, it.workScopeNo);
    if (it.poNo) setVal(cover, `E${r}`, it.poNo);
    if (it.lineNo != null) setVal(cover, `G${r}`, it.lineNo);
    if (it.bartProjectNo) setVal(cover, `H${r}`, it.bartProjectNo);
    setVal(cover, `J${r}`, round2(it.poAmount));
    setVal(cover, `M${r}`, round2(it.previousInvoiced));
    setVal(cover, `P${r}`, round2(it.currentInvoiced));
    setFormula(cover, `S${r}`, `P${r}+M${r}`);
    setFormula(cover, `V${r}`, `IF(ABS(J${r}-S${r})<0.01,0,J${r}-S${r})`);
  });

  // -- 5. Sub Calc (Cost): rates from the work plan; the reference's per-row
  // budget/previous decomposition is not in the data model, so the whole
  // work-plan budget and previously-billed land on the package's own rows
  // (G11 / I13) and every other literal is zeroed — totals (G44/I44) match.
  // Work-plan rates are stored as percentages (e.g. 120.58); the reference
  // sheet cells hold fractions (1.2058). Missing/zero rates are written as 0
  // — never left as-is, or Julie's template rates would silently leak in.
  const oh = (wp.overheadRate ?? 0) / 100;
  for (const addr of ["C12", "C14", "C18", "C19"]) setVal(cost, addr, oh);
  const fee = (wp.fixedFeeRate ?? 0) / 100;
  setVal(cost, "E37", fee);
  setVal(cost, "E39", fee);
  setVal(cost, "D43", (wp.fccmRate ?? 0) / 100);
  setVal(cost, "G11", wp.totalBudget);
  for (const addr of ["G12", "G13", "G14", "G37", "G39", "G43"]) setVal(cost, addr, 0);
  clearCell(cost, "D38");
  for (const addr of ["I11", "I12", "I14", "I32", "I37", "I38", "I39", "I41", "I43"]) {
    setVal(cost, addr, 0);
  }
  setVal(cost, "I13", round2(pkg.previouslyBilled));
  setVal(cost, "A13", `Field ${wp.code}`);
  setVal(cost, "A14", `${wp.code}_Field OH`);
  setVal(cost, "A11", "Field");
  setVal(cost, "A12", "Field OH");
  // H14 must follow the injected OH rate even for zero G rows.
  setFormula(cost, "H14", "ROUND(H13*C14,2)");
  setFormula(cost, "H43", "H13*D43");

  // -- 6. Labor Attachment: all billable hours at the injected rate. The
  // reference's two-rate split (16 hrs old / 128 hrs new) collapses to one
  // row unless a mid-period rate change is modeled.
  // All contributors are named on the labor line: the hours total (C19)
  // includes every contributor's billable hours.
  const laborNames = persons
    .filter((p) => p.name)
    .map((p) => `${p.name}, ${p.classification}`)
    .join("; ");
  setVal(labor, "A17", `${wp.code} - Project ${wp.bartProjectNumbers || ""}`.trim());
  setVal(labor, "A18", laborNames);
  setFormula(labor, "C19", "+'Master File'!G9");
  setVal(labor, "C20", 0);
  clearCell(labor, "B20");
  clearCell(labor, "H13");
  setVal(labor, "A11", "");
  setVal(labor, "A14", "");
  setVal(labor, "A22", `${wp.code} - Subtotal `);

  // -- 7. Progress Report: replace Julie's narrative with the package's.
  for (let r = 21; r <= 64; r++) {
    clearCell(report, `B${r}`);
    clearCell(report, `C${r}`);
  }
  const narrative = (ctx.progress?.workPerformed || ctx.progress?.summary || "").trim();
  const lines = narrative
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .slice(0, 42);
  let r = 23;
  for (const line of lines) {
    const bullet = /^[-•·*]/.test(line);
    if (bullet) setVal(report, `B${r}`, "•");
    setVal(report, `C${r}`, bullet ? line.replace(/^[-•·*]\s*/, "") : line);
    r += 1;
  }
  setVal(
    report,
    "B72",
    `Concerns: ${(ctx.progress?.concerns || "").trim() || "None at the present."} `,
  );
  setVal(
    report,
    "B74",
    `Recommendation of Corrective Actions: ${(ctx.progress?.correctiveAction || "").trim() || "None at the present."} `,
  );
  if (pkg.approvedBy) setVal(report, "D81", pkg.approvedBy);

  // -- 8. Rename tabs, rewrite every formula + defined name, scrub notes.
  for (const [oldName, newName] of renames) {
    const ws = wb.getWorksheet(oldName);
    if (ws) ws.name = newName;
  }
  rewriteAllFormulas(wb, renames);
  scrubInternalMarks(wb);
  stripBrokenDefinedNames(wb);
  wb.calcProperties.fullCalcOnLoad = true;
  return { wb, weekSheets };
}

function safeSlug(ctx: PackageDocContext): string {
  const num = ctx.pkg.invoiceNumber || `PKG-${ctx.pkg.id}`;
  return num.replace(/[^A-Za-z0-9._-]/g, "_");
}

/** Writes the client-ready Excel workbook (Overview visible, first tab). */
export async function generateMasterWorkbookFile(ctx: PackageDocContext): Promise<string> {
  ensureDirs();
  const { wb } = await buildMasterWorkbook(ctx);
  const outPath = path.resolve(generatedDir, `InvoicePackage_${safeSlug(ctx)}_${Date.now()}.xlsx`);
  await wb.xlsx.writeFile(outPath);
  return outPath;
}

/**
 * Writes the workbook variant used for PDF rendering: the Overview tab is
 * hidden so LibreOffice's PDF export (which skips hidden sheets) emits pages
 * in the reference order — Invoice, Sub Calc, Labor Attachment, Progress
 * Report, then the weekly timesheets.
 */
export async function generateMasterPdfSource(ctx: PackageDocContext): Promise<string> {
  ensureDirs();
  const { wb } = await buildMasterWorkbook(ctx);
  const overview = wb.getWorksheet("Overview");
  if (overview) overview.state = "hidden";
  const first = wb.worksheets.find((w) => w.state === "visible");
  if (first) wb.views = [{ activeTab: wb.worksheets.indexOf(first) } as ExcelJS.WorkbookView];
  const outPath = path.resolve(
    generatedDir,
    `InvoicePackagePdfSrc_${safeSlug(ctx)}_${Date.now()}.xlsx`,
  );
  await wb.xlsx.writeFile(outPath);
  return outPath;
}
