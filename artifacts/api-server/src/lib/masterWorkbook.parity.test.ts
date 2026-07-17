import { describe, expect, it } from "vitest";
import type ExcelJS from "exceljs";
import { buildMasterWorkbook } from "./masterWorkbook";
import { buildPackageRollup } from "./packageMappers";
import type { PackageDocContext } from "./packageDocs";
import type { TimesheetEntryRow } from "@workspace/db";

/**
 * Screen-vs-export drift guard.
 *
 * The on-screen rollup (buildPackageRollup) and the reference-workbook export
 * engine (masterWorkbook) implement the same burdened-rate model separately.
 * This suite builds the actual export workbook from the same inputs and
 * recomputes its This Period / Total to Date exactly the way Excel would —
 * from the literal values the engine injects (week-tab billable hours, the
 * Overview rate cells, the Sub Calc rate fractions, the ODC literal and the
 * previously-billed literal) through the sheet's own formula chain
 * (Total = labor × (1+OH) × (1+fee) + labor × FCCM + ODCs). A regression in
 * either implementation breaks the cent-exact comparison and fails loudly.
 */

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function entry(partial: Partial<TimesheetEntryRow>): TimesheetEntryRow {
  return {
    id: 0,
    packageId: 430,
    weekId: 0,
    employeeId: 7,
    employeeName: "Travis Johnson",
    classification: "Project Manager",
    category: "regular",
    location: "field",
    hoursMon: 0,
    hoursTue: 0,
    hoursWed: 0,
    hoursThu: 0,
    hoursFri: 0,
    hoursSat: 0,
    hoursSun: 0,
    rate: 0,
    taskNo: null,
    notes: null,
    createdAt: new Date(),
    ...partial,
  } as TimesheetEntryRow;
}

const workPlanRates = {
  totalBudget: 1_381_971.85,
  fringeRate: 120.58,
  overheadRate: 120.58,
  fixedFeeRate: 8,
  fccmRate: 0.39,
};

function makeCtx(
  entries: TimesheetEntryRow[],
  opts: { previouslyBilled: number; otherDirectCosts: number },
): PackageDocContext {
  const weeks = [1, 2, 3, 4, 5].map(
    (n) =>
      ({
        id: n,
        packageId: 430,
        label: `Week ${n}`,
        weekStart: `2026-06-0${n}`,
        weekEnd: `2026-06-0${n}`,
        sortOrder: n,
      }) as unknown as PackageDocContext["weeks"][number],
  );
  return {
    pkg: {
      id: 430,
      employeeId: 7,
      workPlanId: 1,
      payPeriodStart: "2026-05-30",
      payPeriodEnd: "2026-06-30",
      invoiceNumber: "B.50-01-30",
      invoiceDate: "2026-07-08",
      previouslyBilled: opts.previouslyBilled,
      otherDirectCosts: opts.otherDirectCosts,
      approvedBy: "Mahsa Azad, President",
    } as unknown as PackageDocContext["pkg"],
    employee: { name: "Travis Johnson", classification: "Project Manager" },
    workPlan: {
      id: 1,
      code: "B.50-03",
      title: "B.50-03",
      client: "AECOM",
      jobNumber: "6M8142-B50",
      agreementNo: "6M8142",
      ...workPlanRates,
    } as unknown as PackageDocContext["workPlan"],
    weeks,
    entries,
    progress: null,
    overrides: [],
    signatureImagePath: null,
    billedLineItems: [] as unknown as PackageDocContext["billedLineItems"],
  } as PackageDocContext;
}

/**
 * Recomputes the workbook's headline figures by evaluating the reference
 * formula chain over the literal cells the export engine wrote. ExcelJS does
 * not calculate formulas, so this walks the same chain Excel does on open:
 *
 *   week tabs row 9 (billable hours) → Overview G9 total hours
 *   → Labor Attachment rate split (C19 at Overview I17, remainder at I18)
 *   → Sub Calc: OH = labor × C14, fee = (labor + OH) × E39,
 *     FCCM = labor × D43, ODCs = H27 → This Period
 *   → Total to Date = This Period + Overview E23 (previously billed).
 */
async function workbookFigures(ctx: PackageDocContext): Promise<{
  totalThisPeriod: number;
  totalToDate: number;
  totalHours: number;
  laborTotal: number;
}> {
  const { wb, weekSheets } = await buildMasterWorkbook(ctx);
  const num = (ws: ExcelJS.Worksheet, addr: string): number => {
    const v = ws.getCell(addr).value;
    return typeof v === "number" ? v : 0;
  };

  // Overview B9:F9 pull each week tab's O9, which totals the billable row 9
  // day cells (H..N). Sum those literals — the only hour values the engine
  // writes to the billable row.
  let totalHours = 0;
  for (const wsx of weekSheets) {
    for (const tab of wsx.tabNames) {
      const ws = wb.getWorksheet(tab);
      expect(ws, `week tab ${tab} missing`).toBeTruthy();
      for (const col of ["H", "I", "J", "K", "L", "M", "N"]) {
        totalHours += num(ws!, `${col}9`);
      }
    }
  }

  const overview = wb.getWorksheet("Overview")!;
  const rate1 = num(overview, "I17");
  const rate2 = num(overview, "I18");
  const labor = wb.getWorksheet("Labor Attachment")!;
  // Two-rate split: C19 is a literal hour count at the old rate and C20 is
  // the formula G9−C19 at the new rate. Single rate: C19 is a formula
  // (=Overview G9) so every hour bills at rate1 (I18 mirrors I17).
  const c19 = labor.getCell("C19").value;
  const oldRateHours = typeof c19 === "number" ? c19 : totalHours;
  const laborTotal = round2(oldRateHours * rate1 + (totalHours - oldRateHours) * rate2);

  const cost = wb.getWorksheet("Sub Calc")!;
  const oh = num(cost, "C14");
  const fee = num(cost, "E39");
  const fccmRate = num(cost, "D43");
  const overhead = round2(laborTotal * oh);
  const fixedFee = round2((laborTotal + overhead) * fee);
  const fccm = round2(laborTotal * fccmRate);
  const odcs = num(cost, "H27");

  const totalThisPeriod = round2(laborTotal + overhead + fixedFee + fccm + odcs);
  const previouslyBilled = num(overview, "E23");
  const totalToDate = round2(totalThisPeriod + previouslyBilled);
  return { totalThisPeriod, totalToDate, totalHours, laborTotal };
}

describe("master workbook vs buildPackageRollup — drift guard", () => {
  it("matches the rollup to the cent for the seeded pkg 430 reference (mid-period rate change + PTO)", async () => {
    const entries: TimesheetEntryRow[] = [
      entry({ weekId: 1, hoursMon: 8, hoursTue: 8, rate: 90.11 }),
      entry({ weekId: 1, hoursWed: 8, hoursThu: 8, hoursFri: 8, rate: 0, category: "pto" }),
      entry({ weekId: 2, hoursMon: 8, hoursTue: 8, hoursWed: 8, hoursThu: 8, hoursFri: 8, rate: 92.5 }),
      entry({ weekId: 3, hoursMon: 8, hoursTue: 8, hoursWed: 8, hoursThu: 8, rate: 92.5 }),
      entry({ weekId: 4, hoursMon: 8, hoursTue: 8, hoursWed: 8, hoursThu: 8, hoursFri: 8, rate: 92.5 }),
      entry({ weekId: 5, hoursMon: 8, hoursTue: 8, rate: 92.5 }),
    ];
    const opts = { previouslyBilled: 1_135_877.49, otherDirectCosts: 0 };

    const rollup = buildPackageRollup(entries, workPlanRates, opts);
    const wbFigures = await workbookFigures(makeCtx(entries, opts));

    // Anchor both models to the reference workbook's known-good figures so a
    // simultaneous, identical drift in both cannot slip through.
    expect(rollup.totalThisPeriod).toBe(31_692.46);
    expect(rollup.totalToDate).toBe(1_167_569.95);

    expect(wbFigures.totalHours).toBe(rollup.totalHours);
    expect(wbFigures.laborTotal).toBeCloseTo(rollup.laborTotal, 2);
    expect(wbFigures.totalThisPeriod).toBeCloseTo(rollup.totalThisPeriod, 2);
    expect(wbFigures.totalToDate).toBeCloseTo(rollup.totalToDate, 2);
  });

  it("matches the rollup for a single-rate period with other direct costs", async () => {
    const entries: TimesheetEntryRow[] = [
      entry({ weekId: 1, hoursMon: 8, hoursTue: 8, hoursWed: 4.5, rate: 105.25 }),
      entry({ weekId: 2, hoursMon: 8, hoursTue: 8, hoursWed: 8, hoursThu: 8, hoursFri: 8, rate: 105.25 }),
      entry({ weekId: 3, hoursMon: 6, hoursFri: 2, rate: 105.25 }),
    ];
    const opts = { previouslyBilled: 250_000, otherDirectCosts: 1_234.56 };

    const rollup = buildPackageRollup(entries, workPlanRates, opts);
    const ctx = makeCtx(entries, opts);
    ctx.weeks = ctx.weeks.slice(0, 3);
    const wbFigures = await workbookFigures(ctx);

    expect(wbFigures.totalHours).toBe(rollup.totalHours);
    expect(wbFigures.laborTotal).toBeCloseTo(rollup.laborTotal, 2);
    expect(wbFigures.totalThisPeriod).toBeCloseTo(rollup.totalThisPeriod, 2);
    expect(wbFigures.totalToDate).toBeCloseTo(rollup.totalToDate, 2);
  });

  it("fails loudly if the two models diverge (sanity: perturbed rollup input breaks parity)", async () => {
    const entries: TimesheetEntryRow[] = [
      entry({ weekId: 1, hoursMon: 8, hoursTue: 8, rate: 92.5 }),
    ];
    const opts = { previouslyBilled: 0, otherDirectCosts: 0 };
    const wbFigures = await workbookFigures(makeCtx(entries, opts));
    const skewed = buildPackageRollup(entries, { ...workPlanRates, overheadRate: 100 }, opts);
    expect(Math.abs(wbFigures.totalThisPeriod - skewed.totalThisPeriod)).toBeGreaterThan(0.01);
  });
});
