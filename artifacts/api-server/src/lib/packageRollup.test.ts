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
  // The 120.58% indirect burden lives in fringeRate (as real work plans store
  // it); overheadRate is a separate optional layer, 0 for this contract.
  fringeRate: 120.58,
  overheadRate: 0,
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

  it("labor total = hours × base rate (unburdened)", () => {
    expect(rollup.laborTotal).toBe(13_281.76);
  });

  it("This Period = labor + fringe + fee + FCCM (fringe from fringeRate)", () => {
    expect(rollup.totalThisPeriod).toBe(31_692.46);
  });

  it("Total to Date, Remaining, % Expended match the reference", () => {
    expect(rollup.totalToDate).toBe(1_167_569.95);
    expect(rollup.remainingBalance).toBe(214_401.9);
    expect(rollup.percentExpended).toBe(84.49);
  });

  it("applies the 120.58% fringe/overhead layer to direct labor", () => {
    expect(rollup.fringeTotal).toBe(16_015.15);
  });

  it("budget status stays consistent with evaluateBudgetStatus consumers", () => {
    expect(rollup.budgetStatus.level).toBe("ok");
    expect(rollup.budgetStatus.overBudget).toBe(false);
    expect(rollup.budgetStatus.percentExpended).toBe(84.49);
  });
});

/**
 * Ground-truth parity with Julie's real WSP invoice
 * (SAMPLE INVOICE ...WSP-A.04.01...Jordy Peralta): 144 field hrs @ $76.22 with
 * the 120.58% fringe, 8% fee and 0.39% field FCCM must bill $26,189.78 —
 * exactly Invoice!L27 / Sub Calc _revised!H51 in that workbook.
 */
describe("buildPackageRollup — WSP/Jordy reference invoice", () => {
  const wspPlan = {
    totalBudget: 156_185.34,
    fringeRate: 120.58,
    overheadRate: 0,
    fixedFeeRate: 8,
    fccmRate: 0.39,
  };
  const entries: TimesheetEntryRow[] = [
    entry({ weekId: 1, employeeName: "Jordy Peralta", classification: "ARE", location: "field", hoursMon: 144, rate: 76.22 }),
  ];
  const rollup = buildPackageRollup(entries, wspPlan, { previouslyBilled: 152_693.26, otherDirectCosts: 0 });

  it("hours and unburdened labor", () => {
    expect(rollup.totalHours).toBe(144);
    expect(rollup.laborTotal).toBe(10_975.68);
    expect(rollup.fringeTotal).toBe(13_234.47);
  });

  it("Total This Period matches the reference workbook to the cent", () => {
    expect(rollup.totalThisPeriod).toBe(26_189.78);
  });
});

/**
 * BART overtime rule (verified against Julie's overtime workbook): OT hours are
 * billed at the STRAIGHT rate inside labor (so they receive fringe + fee), and
 * the premium (0.5×base for OT, 1.0×base for DT) is added as a separate line
 * with NO overhead and NO fee applied to it.
 */
describe("buildPackageRollup — overtime/doubletime premium is unburdened", () => {
  const plan = { totalBudget: 1_000_000, fringeRate: 120.58, overheadRate: 0, fixedFeeRate: 8, fccmRate: 0 };

  it("OT premium = 0.5 × base × hours, excluded from fringe and fee base", () => {
    const rollup = buildPackageRollup(
      [entry({ weekId: 1, category: "ot", hoursMon: 24, rate: 83 })],
      plan,
      { previouslyBilled: 0, otherDirectCosts: 0 },
    );
    // Straight labor = 24×83 = 1992; premium = 1992×0.5 = 996.
    expect(rollup.laborTotal).toBe(1_992);
    expect(rollup.otdtPremium).toBe(996);
    // Fringe on labor only (1992×1.2058); fee on labor+fringe only — NOT on premium.
    expect(rollup.fringeTotal).toBe(2_401.95);
    expect(rollup.fixedFee).toBe(351.52);
    // Total = labor + fringe + fee + premium (premium carries no burden).
    expect(rollup.totalThisPeriod).toBe(5_741.47);
  });

  it("caps an employee's billing rate at the work plan's Max Bill Rate", () => {
    const capped = { totalBudget: 1_000_000, fringeRate: 120.58, overheadRate: 0, fixedFeeRate: 8, fccmRate: 0, maxBillRate: 115 };
    // 10 hrs @ $150 would be $1,500 of labor, but the $115 cap makes it $1,150.
    const rollup = buildPackageRollup(
      [entry({ weekId: 1, category: "regular", hoursMon: 10, rate: 150 })],
      capped,
      { previouslyBilled: 0, otherDirectCosts: 0 },
    );
    expect(rollup.laborTotal).toBe(1_150);
    // A rate under the cap is untouched.
    const under = buildPackageRollup(
      [entry({ weekId: 1, category: "regular", hoursMon: 10, rate: 90 })],
      capped,
      { previouslyBilled: 0, otherDirectCosts: 0 },
    );
    expect(under.laborTotal).toBe(900);
  });

  it("DT premium = 1.0 × base × hours, also unburdened", () => {
    const rollup = buildPackageRollup(
      [entry({ weekId: 1, category: "dt", hoursMon: 10, rate: 100 })],
      plan,
      { previouslyBilled: 0, otherDirectCosts: 0 },
    );
    expect(rollup.laborTotal).toBe(1_000);
    expect(rollup.otdtPremium).toBe(1_000);
    expect(rollup.totalThisPeriod).toBe(3_382.26);
  });
});
