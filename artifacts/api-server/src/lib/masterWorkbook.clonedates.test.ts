import { describe, it, expect } from "vitest";
import ExcelJS from "exceljs";
import { generateMasterWorkbookFile } from "./masterWorkbook";
import type { PackageDocContext } from "./packageDocs";

// The template ships five week tabs ("TJ Week 1".."TJ Week 5"). A package with
// several contributors, or a period longer than five weeks, needs more than
// that, and the extra tabs are cloned from a JSON-serialised copy of the first.
// That clone path had no direct coverage. The ISO-text assertion guards the
// known hazard of JSON round-tripping a sheet model: Date objects flatten to
// strings, which exceljs can refuse to write and which otherwise ship as raw
// text instead of dates.
const wp: any = {
  id: 1,
  code: "B.50-03",
  title: "B.50-03",
  client: "AECOM",
  jobNumber: "6M8142-B50",
  agreementNo: "6M8142",
  totalBudget: 1381971.85,
  overheadRate: 120.58,
  fixedFeeRate: 8,
  fccmRate: 0.39,
};

const mkEntry = (weekId: number, employeeName: string): any => ({
  id: weekId * 100 + employeeName.length,
  packageId: 1,
  weekId,
  employeeId: employeeName === "Travis Johnson" ? 7 : 8,
  employeeName,
  classification: "Project Manager",
  category: "regular",
  location: "field",
  hoursMon: 8,
  hoursTue: 8,
  hoursWed: 8,
  hoursThu: 8,
  hoursFri: 8,
  hoursSat: 0,
  hoursSun: 0,
  rate: 92.5,
});

function buildCtx(weekCount: number, people: string[]): PackageDocContext {
  const weeks = Array.from({ length: weekCount }, (_, i) => ({
    id: i + 1,
    packageId: 1,
    label: `Week ${i + 1}`,
    weekStart: `2026-06-${String(i * 7 + 1).padStart(2, "0")}`,
    weekEnd: `2026-06-${String(i * 7 + 7).padStart(2, "0")}`,
    sortOrder: i + 1,
  })) as any[];
  const entries = weeks.flatMap((w) => people.map((p) => mkEntry(w.id, p)));
  return {
    pkg: {
      id: 1,
      employeeId: 7,
      workPlanId: 1,
      payPeriodStart: "2026-06-01",
      payPeriodEnd: "2026-06-30",
      invoiceNumber: "B.50-01-30",
      invoiceDate: "2026-07-08",
      previouslyBilled: 0,
      otherDirectCosts: 0,
      approvedBy: "Mahsa Azad, President",
    } as any,
    employee: { name: people[0], classification: "Project Manager" },
    workPlan: wp,
    weeks,
    entries,
    progress: { workPerformed: "Routine reporting", concerns: null, correctiveAction: null } as any,
    overrides: [],
    signatureImagePath: null,
    billedLineItems: [] as any,
  };
}

/** ISO timestamps leaking into cells mean a clone was never revived. */
function isoTextCells(ws: ExcelJS.Worksheet): string[] {
  const bad: string[] = [];
  ws.eachRow({ includeEmpty: false }, (row) => {
    row.eachCell({ includeEmpty: false }, (cell, col) => {
      const probe = [cell.value, (cell.value as { result?: unknown })?.result];
      for (const v of probe) {
        if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(v)) {
          bad.push(`${ws.name}!${ws.getColumn(col).letter}${row.number}=${v}`);
        }
      }
    });
  });
  return bad;
}

describe("week tabs cloned past the template's five", () => {
  it("exports without error and keeps dates as dates, not ISO text", async () => {
    // Six weeks: five reuse template tabs, the sixth is cloned.
    const out = await generateMasterWorkbookFile(buildCtx(6, ["Travis Johnson"]));
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(out);

    const weekSheets = wb.worksheets.filter((ws) => /week/i.test(ws.name));
    expect(weekSheets.length).toBeGreaterThanOrEqual(6);

    const leaked = weekSheets.flatMap(isoTextCells);
    expect(leaked).toEqual([]);
  }, 120000);

  it("handles several contributors sharing the same weeks", async () => {
    // 3 weeks x 2 people = 6 tabs, so the last is cloned.
    const out = await generateMasterWorkbookFile(buildCtx(3, ["Travis Johnson", "Dana Lee"]));
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(out);

    const weekSheets = wb.worksheets.filter((ws) => /week/i.test(ws.name));
    expect(weekSheets.length).toBeGreaterThanOrEqual(6);
    expect(weekSheets.flatMap(isoTextCells)).toEqual([]);
  }, 120000);
});
