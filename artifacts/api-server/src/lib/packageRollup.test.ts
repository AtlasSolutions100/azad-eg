import { describe, expect, it } from "vitest";
import { buildPackageRollup } from "./packageMappers";
import type { TimesheetEntryRow } from "@workspace/db";

/**
 * Reference check: the seeded Travis Johnson BART/AECOM package must roll up
 * to exactly the numbers in Julie's reference workbook (which the export
 * engine reproduces to the cent).
 */

function entry(partial: Partial<TimesheetEntryRow>): TimesheetEntryRow {
  return {
    id: 0,
    packageId: 430,
    weekId: 0,
    employeeId: 1,
    employeeName: "Travis Johnson",
    classification: "Engineer",
    category: "regular",
    location: "home",
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

const workPlan = {
  totalBudget: 1_381_971.85,
  // Ignored by the rollup: entry rates are already fully burdened.
  fringeRate: 120.58,
  overheadRate: 120.58,
  fixedFeeRate: 8,
  fccmRate: 0.39,
};

describe("buildPackageRollup — reference workbook parity", () => {
  // W1: 16 hrs @ 90.11 + 24 hrs PTO @ 0; W2 40, W3 32, W4 40 @ 92.50; W5 16 @ 92.50.
  const entries: TimesheetEntryRow[] = [
    entry({ weekId: 1, hoursMon: 8, hoursTue: 8, rate: 90.11 }),
    entry({ weekId: 1, hoursWed: 8, hoursThu: 8, hoursFri: 8, rate: 0, category: "pto" }),
    entry({ weekId: 2, hoursMon: 8, hoursTue: 8, hoursWed: 8, hoursThu: 8, hoursFri: 8, rate: 92.5 }),
    entry({ weekId: 3, hoursMon: 8, hoursTue: 8, hoursWed: 8, hoursThu: 8, rate: 92.5 }),
    entry({ weekId: 4, hoursMon: 8, hoursTue: 8, hoursWed: 8, hoursThu: 8, hoursFri: 8, rate: 92.5 }),
    entry({ weekId: 5, hoursMon: 8, hoursTue: 8, rate: 92.5 }),
  ];

  const rollup = buildPackageRollup(entries, workPlan, {
    previouslyBilled: 1_135_877.49,
    otherDirectCosts: 0,
  });

  it("counts only billable hours (PTO/holiday excluded)", () => {
    expect(rollup.totalHours).toBe(144);
  });

  it("labor total at burdened entry rates", () => {
    expect(rollup.laborTotal).toBe(13_281.76);
  });

  it("This Period = labor × (1+OH) × (1+fee) + labor × FCCM", () => {
    expect(rollup.totalThisPeriod).toBe(31_692.46);
  });

  it("Total to Date, Remaining, % Expended match the reference", () => {
    expect(rollup.totalToDate).toBe(1_167_569.95);
    expect(rollup.remainingBalance).toBe(214_401.9);
    expect(rollup.percentExpended).toBe(84.49);
  });

  it("applies no extra fringe layer", () => {
    expect(rollup.fringeTotal).toBe(0);
  });

  it("budget status stays consistent with evaluateBudgetStatus consumers", () => {
    expect(rollup.budgetStatus.level).toBe("ok");
    expect(rollup.budgetStatus.overBudget).toBe(false);
    expect(rollup.budgetStatus.percentExpended).toBe(84.49);
  });
});
