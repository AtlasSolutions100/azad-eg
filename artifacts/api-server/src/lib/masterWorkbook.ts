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

interface RateSegment {
  rate: number;
  hours: number;
  /** Week start of the first week this rate appears in (chronological). */
  firstWeekStart: Date | null;
}

/**
 * Billable-rate segments across the period, in chronological order of first
 * appearance. The reference workbook models a mid-period rate change as two
 * labor rows (Master File I17/I18 → Labor rows 19/20); more than two distinct
 * rates cannot be represented on the reference sheet, so the caller must fail
 * loudly rather than silently merging money.
 */
function rateSegments(ctx: PackageDocContext): RateSegment[] {
  const weekStartById = new Map<number, Date>();
  for (const w of ctx.weeks) weekStartById.set(w.id, toDate(w.weekStart));
  const byRate = new Map<number, { hours: number; firstWeekStart: Date | null }>();
  for (const e of ctx.entries) {
    const hrs =
      e.hoursMon + e.hoursTue + e.hoursWed + e.hoursThu + e.hoursFri + e.hoursSat + e.hoursSun;
    if (!(e.rate > 0 && hrs > 0)) continue;
    const ws = weekStartById.get(e.weekId) ?? null;
    const seg = byRate.get(e.rate);
    if (!seg) {
      byRate.set(e.rate, { hours: hrs, firstWeekStart: ws });
    } else {
      seg.hours += hrs;
      if (ws && (!seg.firstWeekStart || ws < seg.firstWeekStart)) seg.firstWeekStart = ws;
    }
  }
  return [...byRate.entries()]
    .map(([rate, v]) => ({ rate, ...v }))
    .sort((a, b) => {
      const ta = a.firstWeekStart?.getTime() ?? 0;
      const tb = b.firstWeekStart?.getTime() ?? 0;
      return ta - tb || a.rate - b.rate;
    });
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
  // Billing rates: the reference models a mid-period rate change as two rate
  // cells (I17 old, I18 new — "Effective <date>" label in H18). More than two
  // distinct rates cannot be represented on the reference sheets.
  const segments = rateSegments(ctx);
  if (segments.length > 2) {
    throw new Error(
      `The reference workbook supports at most 2 billing rates per period; found ${segments.length} (${segments.map((s) => s.rate).join(", ")})`,
    );
  }
  const rate1 = segments[0]?.rate ?? 0;
  const rate2 = segments[1]?.rate ?? rate1;
  setVal(master, "I17", rate1);
  setVal(master, "I18", rate2);
  if (segments.length === 2 && segments[1].firstWeekStart) {
    const d = segments[1].firstWeekStart;
    setVal(master, "H18", `Effective ${d.getMonth() + 1}/${d.getDate()}/${String(d.getFullYear()).slice(-2)}`);
  }
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

  // -- 5. Sub Calc (Cost). Rates come from the work plan; work-plan rates are
  // stored as percentages (e.g. 120.58) while the reference cells hold
  // fractions (1.2058). Missing/zero rates are written as 0 — never left
  // as-is, or Julie's template rates would silently leak in.
  const oh = (wp.overheadRate ?? 0) / 100;
  for (const addr of ["C12", "C14", "C18", "C19"]) setVal(cost, addr, oh);
  const fee = (wp.fixedFeeRate ?? 0) / 100;
  setVal(cost, "E37", fee);
  setVal(cost, "E39", fee);
  const fccm = (wp.fccmRate ?? 0) / 100;
  setVal(cost, "D43", fccm);

  // Budget (G) and Previously Billed (I) decompose per work scope, mirroring
  // the reference layout: the package's own scope lives on rows 13/14 (labor /
  // OH) with its fixed fee on row 39 and FCCM on row 43; every other billed
  // scope aggregates onto rows 11/12 with fixed fee on row 37. Each scope
  // total (PO Amount / Previous Invoiced from the Billed Line Items) is
  // back-solved into labor via T = L·(1+OH)·(1+fee) + L·FCCM — the same math
  // the reference sheet applies (G14=G13·C14, G39=(G13+G14)·E39, G43=G13·D43)
  // — with rounding residue folded into the fee row so column totals are
  // exact to the cent.
  const currentItems = items.filter((it) => it.currentInvoiced > 0);
  // Before any billing is entered, every carried-forward item belongs to the
  // package's own scope bucket so budget/previous still land on rows 13/14.
  const ownItems = currentItems.length > 0 ? currentItems : items;
  const ownKeys = new Set(ownItems.map((it) => it.id));
  const otherItems = items.filter((it) => !ownKeys.has(it.id));
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  const decompose = (total: number, withFccm: boolean) => {
    const divisor = (1 + oh) * (1 + fee) + (withFccm ? fccm : 0);
    const laborBase = divisor > 0 ? total / divisor : total;
    const laborRow = round2(laborBase);
    const ohRow = round2(laborRow * oh);
    const fccmRow = withFccm ? round2(laborRow * fccm) : 0;
    const feeRow = round2(total - laborRow - ohRow - fccmRow);
    return { laborRow, ohRow, feeRow, fccmRow };
  };
  // The package's own scope: fall back to the whole work-plan budget /
  // previously-billed when no line items exist yet.
  const ownBudget = items.length > 0 ? sum(ownItems.map((it) => it.poAmount)) : wp.totalBudget;
  const ownPrev =
    items.length > 0 ? sum(ownItems.map((it) => it.previousInvoiced)) : pkg.previouslyBilled;
  const otherBudget = sum(otherItems.map((it) => it.poAmount));
  const otherPrev = sum(otherItems.map((it) => it.previousInvoiced));
  const gOwn = decompose(ownBudget, true);
  const iOwn = decompose(ownPrev, true);
  const gOther = decompose(otherBudget, false);
  const iOther = decompose(otherPrev, false);
  setVal(cost, "G13", gOwn.laborRow);
  setFormula(cost, "G14", "ROUND(G13*C14,2)");
  setVal(cost, "G39", gOwn.feeRow);
  setFormula(cost, "G43", "ROUND(G13*D43,2)");
  setVal(cost, "I13", round2(iOwn.laborRow));
  setVal(cost, "I14", iOwn.ohRow);
  setVal(cost, "I39", iOwn.feeRow);
  setVal(cost, "I43", iOwn.fccmRow);
  setVal(cost, "G11", gOther.laborRow);
  setVal(cost, "G12", gOther.ohRow);
  setVal(cost, "G37", gOther.feeRow);
  setVal(cost, "I11", iOther.laborRow);
  setVal(cost, "I12", iOther.ohRow);
  setVal(cost, "I37", iOther.feeRow);
  clearCell(cost, "D38");
  for (const addr of ["G38", "I32", "I38", "I41"]) setVal(cost, addr, 0);
  const scopeLabel = (list: typeof items, fallback: string) => {
    const codes = [...new Set(list.map((it) => (it.workScopeNo || "").trim()).filter(Boolean))];
    return codes.length ? codes.join(" / ") : fallback;
  };
  const ownLabel = scopeLabel(ownItems, wp.code);
  const otherLabel = scopeLabel(otherItems, "");
  setVal(cost, "A13", `Field ${ownLabel}`);
  setVal(cost, "A14", `${ownLabel}_Field OH`);
  setVal(cost, "A39", ownLabel);
  setVal(cost, "A11", otherLabel ? `Field ${otherLabel}` : "Field");
  setVal(cost, "A12", otherLabel ? `${otherLabel}_Field OH` : "Field OH");
  setVal(cost, "A37", otherLabel);
  setVal(cost, "A38", otherLabel);
  // H14 must follow the injected OH rate even for zero G rows.
  setFormula(cost, "H14", "ROUND(H13*C14,2)");
  setFormula(cost, "H43", "H13*D43");

  // -- 6. Labor Attachment. Rows 19/20 mirror the reference's rate split:
  // D19='Master File'!I17 and D20='Master File'!I18 are template formulas we
  // keep. With one rate, all hours land on row 19; with a mid-period rate
  // change, row 19 carries the old-rate hours and row 20 the remainder
  // ('Master File'!$G$9-C19), exactly as Julie's workbook does.
  // All contributors are named on the labor line: the hours totals include
  // every contributor's billable hours.
  const laborNames = persons
    .filter((p) => p.name)
    .map((p) => `${p.name}, ${p.classification}`)
    .join("; ");
  setVal(labor, "A17", `${wp.code} - Project ${wp.bartProjectNumbers || ""}`.trim());
  setVal(labor, "A18", laborNames);
  if (segments.length === 2) {
    setVal(labor, "C19", segments[0].hours);
    setFormula(labor, "C20", "'Master File'!$G$9-C19");
    const eff = segments[1].firstWeekStart;
    setVal(
      labor,
      "B20",
      eff ? `Labor - new rate effective ${eff.getMonth() + 1}/${eff.getDate()}` : "Labor - new rate",
    );
  } else {
    setFormula(labor, "C19", "+'Master File'!G9");
    setVal(labor, "C20", 0);
    clearCell(labor, "B20");
  }
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
