import ExcelJS from "exceljs";
import path from "node:path";
import fs from "node:fs";
import { templatesDir, generatedDir, ensureDirs } from "./paths";
import {
  deletedRefTokens,
  dropDeadDefinedNames,
  fitSheetsToOnePage,
  freezeUnstableFormulas,
  removeSheet,
  reviveModelDates,
  scrubInternalMarks,
  stripBrokenDefinedNames,
} from "./excel";
import { buildPackageRollup, contributorKey } from "./packageMappers";
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
 *  - package data is injected at the reference cell addresses as VALUES.
 *
 * That last point is the load-bearing one. The engine originally kept the
 * template's roll-up chain live (week tab O totals → Overview B9:F9 → Labor
 * C19 → Sub Calc H44 → Invoice M21 / Billing Summary) on the assumption that
 * something downstream would evaluate it. Nothing does: ExcelJS writes formula
 * text without computing it, and LibreOffice defaults to "never recalculate"
 * for xlsx, so each cell rendered the cached result stored in Julie's reference
 * invoice. Clients received her *previous* invoice's hours, rates, dates and
 * totals wearing this period's header. Every figure on a client-facing sheet is
 * now written as a value, and a test asserts no formula survives on one.
 *
 * Deleting a sheet orphans every formula and defined name that pointed at it,
 * and Excel answers an uncompilable reference with the "We found a problem with
 * some content…" repair prompt. So after each round of removals — and once more
 * after the renames — any straggler is frozen to its cached value and any dead
 * defined name is dropped (see lib/excel.ts, shared with the other three
 * engines). The engine already overwrites the cells that matter with
 * authoritative literals, so this only ever catches incidental cells.
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

/**
 * Reference tokens for the sheets that are always deleted. Unused week tabs are
 * only known once the package's week count is, so they are appended later.
 */
const INTERNAL_REF_TOKENS = deletedRefTokens(INTERNAL_SHEETS);

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** Parse a YYYY-MM-DD calendar day at local noon (avoids TZ rollover). */
function toDate(value: string): Date {
  const [y, m, d] = value.split("-").map((n) => parseInt(n, 10));
  return new Date(y, (m || 1) - 1, d || 1, 12, 0, 0);
}

/** Formats a Date as "M/D/YYYY" for the cover's Period of Service line. */
function formatMDY(date: Date): string {
  return `${date.getMonth() + 1}/${date.getDate()}/${date.getFullYear()}`;
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

/** Current numeric value of a cell (0 for blanks, text, or formulas). */
function numOf(ws: ExcelJS.Worksheet, address: string): number {
  const v = ws.getCell(address).value;
  return typeof v === "number" ? v : 0;
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

interface WeekSheet {
  week: PackageWeekRow;
  /** Renamed tab names for this week (one per contributor). */
  tabNames: string[];
  /** Billable (row 9) hours for this week, summed across contributors. */
  billableHours: number;
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

/** Day columns on a week tab: H=Sat, I=Sun … N=Fri. */
const DAY_COLS = ["H", "I", "J", "K", "L", "M", "N"] as const;

/** Hour rows on a week tab (9 = billable, 11 = holiday, 12 = PTO). */
const WEEK_HOUR_ROWS = [9, 10, 11, 12, 13, 14] as const;

/** The week tab's "TOTAL HOURS" row, below the hour rows. */
const WEEK_TOTAL_ROW = 15;

/**
 * Fills one reference-layout week tab for one contributor. Columns H..N are
 * Sat..Fri; our weeks start Monday, so the tab's Saturday (H6) is
 * weekStart − 2 days. Row 9 is the billable row the Overview pulls (O9).
 *
 * Returns the per-row weekly totals so the Overview can be written as values.
 */
function fillWeekTab(
  ws: ExcelJS.Worksheet,
  week: PackageWeekRow,
  ctx: PackageDocContext,
  person: { key: string; name: string; classification: string },
): Record<number, number> {
  setVal(ws, "D5", person.name);
  // H6 is the tab's Saturday: snap to the Saturday on/before weekStart.
  const start = toDate(week.weekStart);
  const saturday = addDays(start, -((start.getDay() + 1) % 7));
  // Write all seven day headers as literal dates. The template ships I6..N6 as
  // shared formulas (=H6+1, =I6+1, …), and leaving them alone looked safe — but
  // `freezeSharedFormulas` later replaces every shared formula with its CACHED
  // result, which is the date from the reference workbook (June 2026). The tab
  // then showed a correct Saturday followed by six stale June days, which is
  // what Julie saw as "the week ending month shows June".
  DAY_COLS.forEach((col, i) => setVal(ws, `${col}6`, addDays(saturday, i)));
  // "Week Ending" ships as `=N6`. A plain (non-shared) formula survives the
  // freeze, so a viewer that does not recalculate shows its cached result — the
  // reference workbook's date — right next to a correct day row.
  setVal(ws, "J5", addDays(saturday, 6));

  // Clear sample content: contract/description labels, all day-hour cells, and
  // the weekly total in O. O was previously left alone on the assumption that
  // its `=SUM(H:N)` would recalculate, but it is a shared formula that gets
  // frozen to the reference workbook's cached total — so it has to be cleared
  // and rewritten as a value like every other number in the deliverable.
  for (let r = 9; r <= 14; r++) {
    for (const col of [...DAY_COLS, "B", "D", "O"]) clearCell(ws, `${col}${r}`);
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
  const rowTotals: Record<number, number> = {};
  for (const r of WEEK_HOUR_ROWS) {
    const a = acc.get(r);
    let total = 0;
    for (const col of DAY_COLS) {
      const v = round2(a?.[col] ?? 0);
      if (v > 0) setVal(ws, `${col}${r}`, v);
      total += v;
    }
    total = round2(total);
    rowTotals[r] = total;
    if (total > 0) setVal(ws, `O${r}`, total);
  }

  // TOTAL HOURS (row 15) is a band of shared `=SUM(H9:H14)` formulas whose
  // cached results are the reference workbook's 8/8/8/8/8/40. Rewrite the whole
  // row as values so the printed total matches the hours above it.
  let grand = 0;
  for (const col of DAY_COLS) {
    const colTotal = round2(
      WEEK_HOUR_ROWS.reduce((sum, r) => sum + (acc.get(r)?.[col] ?? 0), 0),
    );
    setVal(ws, `${col}${WEEK_TOTAL_ROW}`, colTotal);
    grand += colTotal;
  }
  setVal(ws, `O${WEEK_TOTAL_ROW}`, round2(grand));

  return rowTotals;
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

  // -- 1. Replace the ODC roll-up with a literal, then drop internal sheets and
  // sever anything that still pointed at them. `Cost!H27` is the one meaningful
  // cross-sheet cell (`=ODCs!D22`) and it is overwritten just above; the freeze
  // is what keeps that from being load-bearing, so a new formula into a deleted
  // sheet can't reach the client as an uncompilable reference.
  setVal(cost, "H27", round2(pkg.otherDirectCosts));
  for (const name of INTERNAL_SHEETS) removeSheet(wb, name);
  freezeUnstableFormulas(wb, INTERNAL_REF_TOKENS);
  dropDeadDefinedNames(wb, INTERNAL_REF_TOKENS, "master");

  // -- 2. Week tabs: one per package week per contributor (row 9 feeds the
  // Overview). Weeks are cloned from a pristine TJ Week 1 model when the
  // package needs more tabs than the template carries.
  const weeks = [...ctx.weeks].sort((a, b) => a.sortOrder - b.sortOrder);
  const people = contributors(ctx);
  const persons = people.length > 0 ? people : [{ key: "name:", name: "", classification: "" }];
  const pristine = JSON.parse(JSON.stringify(wb.getWorksheet("TJ Week 1")!.model));

  const renames = new Map<string, string>(RENAMES);
  // Reserve the deleted sheets' names too: a week labelled "ODCs" would
  // otherwise take a name the dead-reference tokens still match, and the freeze
  // below would blank live formulas pointing at that brand-new tab.
  const usedNames = new Set<string>([
    ...RENAMES.map(([, n]) => n.toLowerCase()),
    ...WEEK_TABS.map((n) => n.toLowerCase()),
    ...INTERNAL_SHEETS.map((n) => n.toLowerCase()),
  ]);
  const weekSheets: WeekSheet[] = [];
  let templateIdx = 0;
  for (let i = 0; i < weeks.length; i++) {
    const week = weeks[i];
    const tabNames: string[] = [];
    let billableHours = 0;
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
        // JSON round-tripping flattens Date objects to ISO strings, which
        // exceljs can choke on when writing (`d.getTime is not a function`) and
        // which otherwise ship as raw text instead of dates. The current
        // template doesn't trip either case — `pristine` is already flattened
        // above, and the tab's date cells survive — but the other three engines
        // all revive their clones, and a template edit that adds a cached date
        // result to a week tab would silently break this path.
        reviveModelDates(cloned);
        cloned.id = ws.id;
        cloned.name = name;
        ws.model = cloned;
        ws.name = name;
      }
      templateIdx += 1;
      const rowTotals = fillWeekTab(ws, week, ctx, person);
      billableHours = round2(billableHours + (rowTotals[9] ?? 0));
      tabNames.push(name);
    }
    weekSheets.push({ week, tabNames, billableHours });
  }
  // Unused template week tabs never ship. Their neighbours chain off them
  // (`TJ Week 3!H6 = SUM('TJ Week 2'!N6)+1`), so freeze the stragglers here
  // too — fillWeekTab happens to overwrite every H6 today, which is the only
  // reason a short package does not already ship a dangling week reference.
  const removedWeekTabs = WEEK_TABS.slice(templateIdx);
  for (const name of removedWeekTabs) removeSheet(wb, name);
  const deadRefTokens = [...INTERNAL_REF_TOKENS, ...deletedRefTokens(removedWeekTabs)];
  freezeUnstableFormulas(wb, deadRefTokens);
  dropDeadDefinedNames(wb, deadRefTokens, "master");

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
  // W1..F5 roll-up: the billable (row 9) hours of every tab of that week.
  //
  // These used to be written as live formulas (`='Week 1'!O9+'Week 2'!O9`)
  // pointing at cells that were themselves shared `=SUM(H9:N9)` formulas. That
  // chain is never evaluated by a writer that only emits formula text, and the
  // frozen O9 cells it pointed at held the reference workbook's cached numbers,
  // so the Overview arrived blank or stale — Julie's "it's still not pulling in
  // any data for this page". Everything else in the deliverable is a computed
  // value; the Overview is now no exception.
  const weekCols = ["B", "C", "D", "E", "F"];
  for (let i = 0; i < weekCols.length; i++) {
    setVal(master, `${weekCols[i]}9`, weekSheets[i]?.billableHours ?? 0);
  }
  // G9 is the grand total across every week, including any beyond the 5-column
  // Overview grid (which have no column of their own).
  setVal(
    master,
    "G9",
    round2(weekSheets.reduce((sum, wsx) => sum + wsx.billableHours, 0)),
  );

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
    const invoicedToDate = round2(it.currentInvoiced + it.previousInvoiced);
    setVal(cover, `S${r}`, invoicedToDate);
    const remaining = round2(it.poAmount - invoicedToDate);
    setVal(cover, `V${r}`, Math.abs(remaining) < 0.01 ? 0 : remaining);
  });

  // Cover header cells the template drives by formula. Their cached results
  // are the reference invoice's, so the client saw the wrong invoice number,
  // an empty Period of Service (the cached IF resolved to blank) and a
  // signature date three weeks off the invoice date.
  setVal(cover, "U4", pkg.invoiceNumber || "");
  const agreementLine = wp.agreementNo
    ? `${wp.agreementNo} ${wp.title || ""}`.trim()
    : wp.title || "";
  setVal(cover, "F16", agreementLine);
  setVal(
    cover,
    "F18",
    `${formatMDY(toDate(pkg.payPeriodStart))} to ${formatMDY(toDate(pkg.payPeriodEnd))}`,
  );
  if (pkg.invoiceDate) setVal(cover, "P48", toDate(pkg.invoiceDate));
  // Billed Line Items column totals (row 35) and the Billing Summary below it.
  const sumItems = (pick: (it: (typeof items)[number]) => number) =>
    round2(items.reduce((a, it) => a + pick(it), 0));
  const poTotal = sumItems((it) => it.poAmount);
  const prevTotal = sumItems((it) => it.previousInvoiced);
  const currentTotal = sumItems((it) => it.currentInvoiced);
  const toDateTotal = round2(prevTotal + currentTotal);
  setVal(cover, "J35", poTotal);
  setVal(cover, "M35", prevTotal);
  setVal(cover, "P35", currentTotal);
  setVal(cover, "S35", toDateTotal);
  setVal(cover, "V35", round2(poTotal - toDateTotal));
  setVal(cover, "O38", poTotal);
  setVal(cover, "O39", prevTotal);
  setVal(cover, "O40", toDateTotal);
  setVal(cover, "O41", round2(poTotal - toDateTotal));
  setVal(cover, "O42", poTotal > 0 ? toDateTotal / poTotal : 0);
  // Julie's reconciliation scratch, parked in columns AC/AE but inside the
  // cover's print area (A1:AG58), so it printed alongside the invoice.
  for (const addr of ["AC6", "AC7", "AC8", "AC9", "AE42"]) clearCell(cover, addr);

  // -- 5. Sub Calc (Cost). Rates come from the work plan; work-plan rates are
  // stored as percentages (e.g. 120.58) while the reference cells hold
  // fractions (1.2058). Missing/zero rates are written as 0 — never left
  // as-is, or Julie's template rates would silently leak in.
  // The BART indirect burden (~120.58%) is stored in fringeRate on real work
  // plans; overheadRate is an optional second layer and the Sub Calc carries a
  // single OH cell, so combine them. Reading only overheadRate (as before)
  // silently dropped the fringe layer whenever it was left null — a ~120%
  // under-bill.
  const oh = ((wp.fringeRate ?? 0) + (wp.overheadRate ?? 0)) / 100;
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
  // When the work plan carries an explicit per-category decomposition
  // (entered from Julie's reference sheet), those figures win over the
  // back-solve and are written literally — including the OH/FCCM rows the
  // back-solve derives by formula.
  const budgetSplit =
    wp.budgetLabor != null ||
    wp.budgetOverhead != null ||
    wp.budgetFixedFee != null ||
    wp.budgetFccm != null;
  const prevSplit =
    wp.prevBilledLabor != null ||
    wp.prevBilledOverhead != null ||
    wp.prevBilledFixedFee != null ||
    wp.prevBilledFccm != null;
  const gOwn = decompose(ownBudget, true);
  const iOwn = decompose(ownPrev, true);
  const gOther = decompose(otherBudget, false);
  const iOther = decompose(otherPrev, false);
  if (budgetSplit) {
    setVal(cost, "G13", round2(wp.budgetLabor ?? 0));
    setVal(cost, "G14", round2(wp.budgetOverhead ?? 0));
    setVal(cost, "G39", round2(wp.budgetFixedFee ?? 0));
    setVal(cost, "G43", round2(wp.budgetFccm ?? 0));
  } else {
    setVal(cost, "G13", gOwn.laborRow);
    setVal(cost, "G14", gOwn.ohRow);
    setVal(cost, "G39", gOwn.feeRow);
    setVal(cost, "G43", gOwn.fccmRow);
  }
  if (prevSplit) {
    setVal(cost, "I13", round2(wp.prevBilledLabor ?? 0));
    setVal(cost, "I14", round2(wp.prevBilledOverhead ?? 0));
    setVal(cost, "I39", round2(wp.prevBilledFixedFee ?? 0));
    setVal(cost, "I43", round2(wp.prevBilledFccm ?? 0));
  } else {
    setVal(cost, "I13", round2(iOwn.laborRow));
    setVal(cost, "I14", iOwn.ohRow);
    setVal(cost, "I39", iOwn.feeRow);
    setVal(cost, "I43", iOwn.fccmRow);
  }
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
  // Budget / previously-billed subtotals as values. G16/G20/G42/G44/G45 and
  // I16/I20/I42/I44 are SUBTOTAL formulas whose cached results are the
  // reference workbook's own $1.28M budget and $1.05M previously billed.
  const g13 = numOf(cost, "G13");
  const g14 = numOf(cost, "G14");
  const g39 = numOf(cost, "G39");
  const g43 = numOf(cost, "G43");
  const gTotalLabor = round2(gOther.laborRow + gOther.ohRow + g13 + g14);
  const gTotalFee = round2(gOther.feeRow + g39);
  setVal(cost, "G16", gTotalLabor);
  setVal(cost, "G19", 0);
  setVal(cost, "G20", gTotalLabor);
  for (const addr of ["G22", "G24", "G27", "G29", "G32", "G34"]) setVal(cost, addr, 0);
  // The last three template formulas on these sheets: the Overview's contract
  // total and the two zero-budget leaves (home overhead, subconsultant fee).
  setVal(master, "F18", round2(numOf(master, "B18") + numOf(master, "D18") + numOf(master, "E18")));
  setVal(cost, "G18", 0);
  setVal(cost, "G40", 0);
  setVal(cost, "G42", gTotalFee);
  const gTotal = round2(gTotalLabor + gTotalFee + g43);
  setVal(cost, "G44", gTotal);

  const i13 = numOf(cost, "I13");
  const i14 = numOf(cost, "I14");
  const i39 = numOf(cost, "I39");
  const i43 = numOf(cost, "I43");
  const iTotalLabor = round2(iOther.laborRow + iOther.ohRow + i13 + i14);
  const iTotalFee = round2(iOther.feeRow + i39);
  setVal(cost, "I16", iTotalLabor);
  setVal(cost, "I19", 0);
  setVal(cost, "I20", iTotalLabor);
  for (const addr of ["I22", "I24", "I27", "I29", "I34"]) setVal(cost, addr, 0);
  setVal(cost, "I42", iTotalFee);
  const iTotal = round2(iTotalLabor + iTotalFee + i43);
  setVal(cost, "I44", iTotal);

  // -- 5b. Sub Calc "Amount This Period" (H) and "Amount To Date" (J).
  //
  // The H column was left as the template's formula chain, rooted in
  // `'Labor Attachment'!E24` — itself a SUBTOTAL of formulas reaching back to
  // the Overview. Nothing evaluated it, so every figure on the client's Sub
  // Calc was the reference workbook's, and the J/K columns (Amount To Date,
  // % Expended) still showed $2.09M and 84.5% against a package that had
  // billed a fraction of that. The whole build-up is now written as values
  // from the same rollup the review screen uses.
  const rollup = buildPackageRollup(ctx.entries, wp, {
    previouslyBilled: pkg.previouslyBilled,
    otherDirectCosts: pkg.otherDirectCosts,
  });
  const hLabor = rollup.laborTotal;
  const hOh = round2(rollup.fringeTotal + rollup.overheadTotal);
  const hTotalLabor = round2(hLabor + hOh);
  setVal(cost, "H11", 0);
  setVal(cost, "H12", 0);
  setVal(cost, "H13", hLabor);
  setVal(cost, "H14", hOh);
  setVal(cost, "H16", hTotalLabor);
  setVal(cost, "H17", 0);
  setVal(cost, "H18", 0);
  setVal(cost, "H19", 0);
  setVal(cost, "H20", hTotalLabor);
  setVal(cost, "H22", rollup.otdtPremium);
  setVal(cost, "H24", rollup.otdtPremium);
  setVal(cost, "H29", rollup.otherDirectCosts);
  setVal(cost, "H32", 0);
  setVal(cost, "H34", 0);
  setVal(cost, "H37", 0);
  setVal(cost, "H38", 0);
  setVal(cost, "H39", rollup.fixedFee);
  setVal(cost, "H40", 0);
  setVal(cost, "H41", 0);
  setVal(cost, "H42", rollup.fixedFee);
  setVal(cost, "H43", rollup.fccm);
  setVal(cost, "H44", rollup.totalThisPeriod);

  // Amount To Date = this period + previously billed, row by row.
  const amountToDate = (h: string, i: string) => round2(numOf(cost, h) + numOf(cost, i));
  for (const r of [11, 12, 13, 14, 16, 17, 18, 19, 20, 22, 24, 27, 29, 32, 34, 37, 38, 39, 40, 41, 42, 43]) {
    setVal(cost, `J${r}`, amountToDate(`H${r}`, `I${r}`));
  }
  const jTotal = round2(rollup.totalThisPeriod + iTotal);
  setVal(cost, "J44", jTotal);
  // % Expended, and the balance left on the work plan.
  const pct = (num: number, den: number) => (den > 0 ? num / den : 0);
  setVal(cost, "K20", pct(numOf(cost, "J20"), gTotalLabor));
  setVal(cost, "K42", pct(numOf(cost, "J42"), gTotalFee));
  setVal(cost, "K44", pct(jTotal, gTotal));
  setVal(cost, "G45", round2(gTotal - jTotal));

  // Hours to Date row (Current / Previous / To Date), also formula-driven.
  setVal(cost, "D10", rollup.totalHours);
  setVal(cost, "E10", 0);
  setVal(cost, "F10", rollup.totalHours);

  // Julie's scratch inside the print area (A1:M60): a stray "z" in M1 and two
  // `=318240+100577.44+4595.61` reconciliation cells parked below the form.
  for (const addr of ["M1", "H52", "F60"]) clearCell(cost, addr);

  // -- 6. Labor Attachment. Rows 19/20 mirror the reference's rate split: with
  // one rate every hour lands on row 19; with a mid-period rate change, row 19
  // carries the old-rate hours and row 20 the remainder.
  //
  // Every cell here used to be a formula reaching back through the Overview
  // (`C19 = +'Master File'!G9`, `D19 = Overview!I17`, `E19 = ROUND(C19*D19,2)`,
  // and SUBTOTALs on rows 22/24). None of them are evaluated by a writer that
  // only emits formula text, so a viewer reading cached results printed the
  // reference workbook's own figures instead — which is why Julie's August
  // invoice showed 144 hours (the reference month's total) all at $90.11 (the
  // superseded rate), rather than her hours at $92.50. Both of her Labor
  // Attachment notes are that one substitution. Values only, from here down.
  //
  // All contributors are named on the labor line: the hours totals include
  // every contributor's billable hours.
  const laborNames = persons
    .filter((p) => p.name)
    .map((p) => `${p.name}, ${p.classification}`)
    .join("; ");
  setVal(labor, "A17", `${wp.code} - Project ${wp.bartProjectNumbers || ""}`.trim());
  setVal(labor, "A18", laborNames);
  const totalBillableHours = round2(
    weekSheets.reduce((sum, wsx) => sum + wsx.billableHours, 0),
  );
  const hours1 = segments.length === 2 ? round2(segments[0].hours) : totalBillableHours;
  const hours2 = round2(totalBillableHours - hours1);
  setVal(labor, "C19", hours1);
  setVal(labor, "D19", rate1);
  setVal(labor, "E19", round2(hours1 * rate1));
  setVal(labor, "C20", hours2);
  setVal(labor, "D20", hours2 > 0 ? rate2 : "--");
  setVal(labor, "E20", round2(hours2 * rate2));
  if (segments.length === 2) {
    const eff = segments[1].firstWeekStart;
    setVal(
      labor,
      "B20",
      eff ? `Labor - new rate effective ${eff.getMonth() + 1}/${eff.getDate()}` : "Labor - new rate",
    );
  } else {
    clearCell(labor, "B20");
  }
  const laborThisPeriod = round2(hours1 * rate1 + hours2 * rate2);
  setVal(labor, "C22", totalBillableHours);
  setVal(labor, "E22", laborThisPeriod);
  setVal(labor, "C24", totalBillableHours);
  setVal(labor, "E24", laborThisPeriod);
  // Rows 12-15 are the reference roster (a $88 Project Manager line and a
  // $90.11 Labor line) plus scratch columns Julie worked in — "Total hours
  // Travis", "hours to put", a 15CQ002/15TC002 percentage split. All of it sat
  // inside the print area (A1:Q37) and printed on the client's attachment.
  for (let lr = 11; lr <= 16; lr++) {
    for (const col of ["A", "B", "C", "D", "E"]) clearCell(labor, `${col}${lr}`);
  }
  for (let lr = 9; lr <= 37; lr++) {
    for (const col of ["G", "H", "I", "J", "K", "L", "M", "N", "O", "P", "Q"]) {
      clearCell(labor, `${col}${lr}`);
    }
  }
  // Below the last total (row 33) the template keeps a "TT" marker in D35.
  for (let lr = 34; lr <= 37; lr++) {
    for (const col of ["A", "B", "C", "D", "E", "F"]) clearCell(labor, `${col}${lr}`);
  }
  setVal(labor, "A22", `${wp.code} - Subtotal `);
  // Overtime premium block (rows 26-31) and the grand total below it.
  for (const lr of [26, 27, 28, 29]) {
    setVal(labor, `C${lr}`, 0);
    setVal(labor, `E${lr}`, 0);
  }
  setVal(labor, "C26", 0);
  setVal(labor, "E26", rollup.otdtPremium);
  setVal(labor, "E31", rollup.otdtPremium);
  setVal(labor, "E33", round2(laborThisPeriod + rollup.otdtPremium));
  clearCell(labor, "E36");

  // -- 6b. Cross-sheet header cells. Every sheet pulls its invoice number, date
  // and period from the Invoice/Overview by formula. None of those are
  // evaluated on the way out, so each attachment printed the reference
  // workbook's cached header — a July date and the old invoice number on an
  // August invoice — and the Progress Report's "% has been billed" line quoted
  // the reference's own budget burn.
  const invDate = pkg.invoiceDate ? toDate(pkg.invoiceDate) : null;
  const invNo = pkg.invoiceNumber || "";
  const periodStr = `${formatMDY(toDate(pkg.payPeriodStart))} to ${formatMDY(toDate(pkg.payPeriodEnd))}`;

  // Invoice face: TOTAL AMOUNT DUE THIS INVOICE (a merged band M21:T21).
  for (const col of ["M", "N", "O", "P", "Q", "R", "S", "T"]) {
    setVal(cover, `${col}21`, rollup.totalThisPeriod);
  }
  // Overview "Total Billing to This Period" (hours / cost).
  setVal(master, "D20", totalBillableHours);
  setVal(master, "E20", rollup.totalThisPeriod);
  for (const col of ["D", "E", "F"]) setVal(master, `${col}16`, agreementLine);

  // Sub Calc header.
  if (invDate) for (const a of ["J5", "K5"]) setVal(cost, a, invDate);
  for (const a of ["J6", "K6"]) setVal(cost, a, invNo);

  // Labor Attachment header.
  setVal(labor, "A5", "Azad Engineering PC");
  if (invDate) setVal(labor, "E6", invDate);
  setVal(labor, "E7", invNo);

  // Progress Report header + billing summary.
  if (invDate) {
    setVal(report, "H5", invDate);
    setVal(report, "H81", invDate);
  }
  setVal(report, "H6", invNo);
  for (const a of ["D8", "E8"]) setVal(report, a, wp.bartProjectNumbers || "");
  setVal(report, "H8", wp.agreementNo || "");
  for (const a of ["D9", "E9"]) setVal(report, a, wp.title || "");
  setVal(report, "H9", periodStr);
  setVal(report, "E69", gTotal);
  setVal(report, "E70", jTotal);
  setVal(
    report,
    "G70",
    gTotal > 0 ? `${((jTotal / gTotal) * 100).toFixed(2)}% has been billed.` : "",
  );
  setVal(report, "D76", laborNames);

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
  // Final sweep, after the renames: steps 3-7 write formulas of their own, and
  // the deleted names are never rename targets, so the same tokens still apply.
  freezeUnstableFormulas(wb, deadRefTokens);
  dropDeadDefinedNames(wb, deadRefTokens, "master");
  stripBrokenDefinedNames(wb);
  fitSheetsToOnePage(wb);
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
