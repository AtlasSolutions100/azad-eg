import { describe, expect, it } from "vitest";
import type { LineItemRow, WorkPlan } from "@workspace/db";
import { computeFinancials } from "./financials";

function lineItem(overrides: Partial<LineItemRow>): LineItemRow {
  return {
    id: 1,
    invoiceId: 1,
    employeeId: null,
    employeeName: "Test Employee",
    classification: "Engineer",
    category: "regular",
    location: "home",
    hours: 0,
    rate: 0,
    amount: 0,
    taskNo: null,
    notes: null,
    ...overrides,
  };
}

function workPlan(overrides: Partial<WorkPlan> = {}): Pick<
  WorkPlan,
  "totalBudget" | "fringeRate" | "overheadRate" | "fixedFeeRate" | "fccmRate"
> {
  return {
    totalBudget: 100000,
    fringeRate: 100,
    overheadRate: 50,
    fixedFeeRate: 10,
    fccmRate: 5,
    ...overrides,
  };
}

describe("computeFinancials", () => {
  it("computes a full invoice with regular, OT and DT labor", () => {
    const items = [
      lineItem({ category: "regular", hours: 10, rate: 100 }),
      lineItem({ category: "ot", hours: 10, rate: 100 }),
      lineItem({ category: "dt", hours: 10, rate: 100 }),
    ];
    const f = computeFinancials(items, workPlan(), {
      previouslyBilled: 1000,
      otherDirectCosts: 200,
    });

    // Straight-time labor counts the base hours of every category.
    expect(f.laborTotal).toBe(3000);
    // Fringe at 100% of straight labor.
    expect(f.fringeTotal).toBe(3000);
    // Overhead at 50% of (labor + fringe) = 6000.
    expect(f.overheadTotal).toBe(3000);
    // Fixed fee at 10% of (labor + fringe + overhead) = 9000.
    expect(f.fixedFee).toBe(900);
    // FCCM at 5% of the same base of 9000.
    expect(f.fccm).toBe(450);
    // OT premium 0.5x (500) + DT premium 1.0x (1000) = 1500.
    expect(f.otdtPremium).toBe(1500);
    expect(f.otherDirectCosts).toBe(200);
    expect(f.totalThisPeriod).toBe(12050);
    expect(f.previouslyBilled).toBe(1000);
    expect(f.totalToDate).toBe(13050);
    expect(f.remainingBalance).toBe(86950);
    expect(f.percentExpended).toBe(13.05);
    expect(f.budgetUsedPercent).toBe(13.05);
  });

  it("omits overhead and FCCM lines when those rates are unset", () => {
    const items = [lineItem({ hours: 10, rate: 100 })];
    const f = computeFinancials(items, workPlan({ overheadRate: null, fccmRate: null }), {
      previouslyBilled: 0,
      otherDirectCosts: 0,
    });

    expect(f.overheadTotal).toBe(0);
    expect(f.fccm).toBe(0);
    expect(f.financials.some((l) => l.label.startsWith("Overhead"))).toBe(false);
    expect(f.financials.some((l) => l.label.startsWith("FCCM"))).toBe(false);
    // Default-style chain with no overhead/fccm: labor 1000, fringe 1000,
    // fixed fee at 10% of 2000 = 200.
    expect(f.fixedFee).toBe(200);
    expect(f.totalThisPeriod).toBe(2200);
  });

  it("rounds monetary results to two decimals", () => {
    const items = [lineItem({ hours: 3, rate: 33.33 })];
    const f = computeFinancials(items, workPlan({ fringeRate: 120.58, overheadRate: null, fixedFeeRate: 8, fccmRate: null }), {
      previouslyBilled: 0,
      otherDirectCosts: 0,
    });

    // base = 99.99; fringe = 99.99 * 1.2058 = 120.567... -> 120.57
    expect(f.laborTotal).toBe(99.99);
    expect(f.fringeTotal).toBe(120.57);
    // fixed fee = 8% of (99.99 + 120.57) = 17.6448 -> 17.64
    expect(f.fixedFee).toBe(17.64);
    expect(f.totalThisPeriod).toBe(238.2);
  });

  it("reports zero percent expended when the budget is zero", () => {
    const items = [lineItem({ hours: 10, rate: 100 })];
    const f = computeFinancials(items, workPlan({ totalBudget: 0 }), {
      previouslyBilled: 0,
      otherDirectCosts: 0,
    });

    expect(f.percentExpended).toBe(0);
    expect(f.budgetUsedPercent).toBe(0);
    // Remaining balance is negative (budget minus what was spent).
    expect(f.remainingBalance).toBe(-f.totalToDate);
  });

  it("carries the previously-billed amount into total-to-date", () => {
    const items = [lineItem({ hours: 10, rate: 100 })];
    const f = computeFinancials(items, workPlan({ overheadRate: null, fccmRate: null }), {
      previouslyBilled: 5000,
      otherDirectCosts: 0,
    });

    expect(f.totalThisPeriod).toBe(2200);
    expect(f.previouslyBilled).toBe(5000);
    expect(f.totalToDate).toBe(7200);
    expect(f.remainingBalance).toBe(100000 - 7200);
  });

  it("treats no line items as a zero-value invoice", () => {
    const f = computeFinancials([], workPlan(), { previouslyBilled: 0, otherDirectCosts: 0 });

    expect(f.laborTotal).toBe(0);
    expect(f.fringeTotal).toBe(0);
    expect(f.totalThisPeriod).toBe(0);
    expect(f.totalToDate).toBe(0);
    expect(f.remainingBalance).toBe(100000);
  });
});
