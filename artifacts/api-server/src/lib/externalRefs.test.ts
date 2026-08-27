import { describe, it, expect } from "vitest";
import ExcelJS from "exceljs";
import { buildParsonsWorkbook } from "./parsonsWorkbook";
import { buildTylinWorkbook } from "./tylinWorkbook";
import { buildWspWorkbook } from "./wspWorkbook";
import type { PackageDocContext } from "./packageDocs";

/**
 * Guards the repair-prompt cause Julie hit: "We found a problem with some
 * content… Do you want us to try to recover as much as we can?"
 *
 * The Parsons and TYLin templates carry external-workbook references — formulas
 * like `'[2]JP Week 1'!M6+1` and `[3]Cover!B3`. ExcelJS drops the
 * `xl/externalLinks` parts and the `<externalReferences>` list when it rewrites
 * the file, but leaves those `[N]` index tokens behind in the formulas. Excel
 * then cannot resolve them and strips the records on open, which is exactly the
 * "Removed Records: Formula from /xl/worksheets/sheetN.xml" repair report.
 *
 * The engines must freeze any such formula to its cached value before writing.
 */

const wp: any = {
  code: "B.55",
  title: "Scheduling Support",
  client: "Parsons",
  jobNumber: "6M8146",
  agreementNo: "6M8146",
  poNumber: "N/A",
  totalBudget: 147407.67,
  fringeRate: 0,
  overheadRate: 120.58,
  fixedFeeRate: 8,
  fccmRate: 0.39,
  terms: "Net 30",
};

const weeks: any[] = [1, 2, 3, 4, 5].map((n) => ({
  id: n,
  packageId: 1,
  label: `Week ${n}`,
  weekStart: `2026-06-0${n}`,
  weekEnd: `2026-06-0${n}`,
  sortOrder: n,
}));

const entry = (weekId: number): any => ({
  id: weekId,
  packageId: 1,
  weekId,
  employeeId: 7,
  employeeName: "Hashmatullah Ahmadzai",
  classification: "Scheduler",
  category: "regular",
  location: "field",
  hoursMon: 8,
  hoursTue: 8,
  hoursWed: 8,
  hoursThu: 8,
  hoursFri: 8,
  hoursSat: 0,
  hoursSun: 0,
  rate: 66.56,
});

const ctx: PackageDocContext = {
  pkg: {
    id: 1,
    employeeId: 7,
    workPlanId: 1,
    payPeriodStart: "2026-06-01",
    payPeriodEnd: "2026-06-30",
    invoiceNumber: "B.55-11",
    invoiceDate: "2026-07-08",
    previouslyBilled: 107453.11,
    otherDirectCosts: 0,
    approvedBy: "Mahsa Azad, President",
  } as any,
  employee: { name: "Hashmatullah Ahmadzai", classification: "Scheduler" },
  workPlan: wp,
  weeks,
  entries: weeks.map((w) => entry(w.id)),
  progress: { workPerformed: "Scheduling support", concerns: null, correctiveAction: null } as any,
  overrides: [],
  signatureImagePath: null,
  billedLineItems: [] as any,
};

/** Formula cells still carrying an unresolvable `[N]` external-workbook token. */
function externalRefFormulas(wb: ExcelJS.Workbook): string[] {
  const found: string[] = [];
  for (const ws of wb.worksheets) {
    ws.eachRow({ includeEmpty: false }, (row) => {
      row.eachCell({ includeEmpty: false }, (cell, col) => {
        const v = cell.value;
        if (v && typeof v === "object" && "formula" in v && typeof v.formula === "string") {
          if (/\[\d+\]/.test(v.formula)) {
            found.push(`${ws.name}!${ws.getColumn(col).letter}${row.number} = ${v.formula}`);
          }
        }
      });
    });
  }
  return found;
}

describe("no unresolvable external references survive an export", () => {
  it("Parsons", async () => {
    const { wb } = await buildParsonsWorkbook(ctx);
    expect(externalRefFormulas(wb)).toEqual([]);
  }, 120000);

  it("TYLin", async () => {
    const { wb } = await buildTylinWorkbook({
      ...ctx,
      workPlan: { ...wp, client: "T.Y. Lin" } as any,
    });
    expect(externalRefFormulas(wb)).toEqual([]);
  }, 120000);

  it("WSP", async () => {
    const { wb } = await buildWspWorkbook({
      ...ctx,
      workPlan: { ...wp, client: "WSP" } as any,
    });
    expect(externalRefFormulas(wb)).toEqual([]);
  }, 120000);
});
