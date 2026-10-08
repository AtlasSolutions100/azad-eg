import { describe, expect, it } from "vitest";
import {
  budgetInForce,
  parseBudgetHistory,
  serializeBudgetHistory,
  withBudgetVersion,
  withCurrentBudget,
  withoutBudgetVersion,
  type BudgetVersion,
} from "./budgetHistory";
import { effectiveWorkPlan } from "./billingProfile";
import type { WorkPlan } from "@workspace/db";

/**
 * Julie: "Is there way to also state on what date the budget increased? For
 * example, I edited the budget for this invoice for the October invoice, and I
 * see it changed the invoice amount for the September invoice."
 */

const version = (from: string | null, total: number, parts: Partial<BudgetVersion> = {}): BudgetVersion => ({
  from,
  total,
  labor: null,
  overhead: null,
  fixedFee: null,
  fccm: null,
  ...parts,
});

const plan = (history: BudgetVersion[] | null, totalBudget = 850000) => ({
  totalBudget,
  budgetLabor: null,
  budgetOverhead: null,
  budgetFixedFee: null,
  budgetFccm: null,
  budgetHistory: history ? serializeBudgetHistory(history) : null,
});

describe("budgetInForce", () => {
  it("is the work plan's own budget when no change has been dated", () => {
    expect(budgetInForce(plan(null), "2026-09-25").total).toBe(850000);
    expect(budgetInForce(plan(null)).total).toBe(850000);
  });

  it("keeps September on the old budget after October's increase", () => {
    const wp = plan([version(null, 850000), version("2026-09-26", 900000)], 900000);
    // September's period ended the day before the increase.
    expect(budgetInForce(wp, "2026-09-25").total).toBe(850000);
    // October's period (9/26 – 10/30) is under way by then.
    expect(budgetInForce(wp, "2026-10-30").total).toBe(900000);
    // Anything read without a period in mind is the current budget.
    expect(budgetInForce(wp).total).toBe(900000);
  });

  it("applies a change from the period it falls in, not the one after", () => {
    // A budget raised mid-period covers the invoice for that period.
    const wp = plan([version(null, 100), version("2026-10-15", 200)], 200);
    expect(budgetInForce(wp, "2026-10-30").total).toBe(200);
    expect(budgetInForce(wp, "2026-10-14").total).toBe(100);
  });

  it("gives a period before every dated version the earliest one", () => {
    const wp = plan([version("2026-06-01", 100), version("2026-09-01", 200)], 200);
    expect(budgetInForce(wp, "2026-01-31").total).toBe(100);
  });

  it("treats an unreadable history as none", () => {
    expect(budgetInForce({ ...plan(null), budgetHistory: "not json" }, "2026-09-25").total).toBe(850000);
    expect(parseBudgetHistory('{"total": 5}')).toEqual([]);
    expect(parseBudgetHistory('[{"from": "soon", "total": 5}, {"total": "x"}]')).toEqual([version(null, 5)]);
  });
});

describe("withBudgetVersion", () => {
  it("restates the budget for every invoice when no date is given", () => {
    const next = withBudgetVersion(plan(null), version(null, 860000, { labor: 300000 }));
    expect(next.history).toEqual([]);
    expect(next.latest).toEqual(version(null, 860000, { labor: 300000 }));
  });

  it("keeps what the work plan held until now for the periods before a dated change", () => {
    const next = withBudgetVersion(plan(null), version("2026-09-26", 900000));
    expect(next.history).toEqual([version(null, 850000), version("2026-09-26", 900000)]);
    expect(next.latest.total).toBe(900000);
  });

  it("does not record a zero budget as the one before a first entry", () => {
    // A work plan with no budget yet: the first figure entered is its budget,
    // whatever date came with it.
    const next = withBudgetVersion(plan(null, 0), version("2026-09-26", 900000));
    expect(next.history).toEqual([]);
    expect(next.latest).toEqual(version(null, 900000));
  });

  it("replaces the version already starting on that day", () => {
    const wp = plan([version(null, 850000), version("2026-09-26", 900000)], 900000);
    const next = withBudgetVersion(wp, version("2026-09-26", 910000));
    expect(next.history).toEqual([version(null, 850000), version("2026-09-26", 910000)]);
  });

  it("leaves the current budget alone when an earlier one is corrected", () => {
    const wp = plan([version(null, 850000), version("2026-09-26", 900000)], 900000);
    const next = withBudgetVersion(wp, version(null, 840000));
    expect(next.history).toEqual([version(null, 840000), version("2026-09-26", 900000)]);
    expect(next.latest.total).toBe(900000);
  });
});

describe("withoutBudgetVersion", () => {
  it("takes a dated change back out", () => {
    const wp = plan([version(null, 850000), version("2026-09-26", 900000)], 900000);
    const next = withoutBudgetVersion(wp, "2026-09-26")!;
    // Only the undated budget is left, so there are no dates to track.
    expect(next.history).toEqual([]);
    expect(next.latest.total).toBe(850000);
    expect(withoutBudgetVersion(wp, "2026-01-01")).toBeNull();
  });
});

describe("withCurrentBudget", () => {
  it("puts a change from Procas or the Work Plan screen on the latest version only", () => {
    const wp = plan([version(null, 850000, { labor: 1 }), version("2026-09-26", 900000, { labor: 2 })], 900000);
    const next = withCurrentBudget(wp, { totalBudget: 950000 });
    expect(next).toEqual([version(null, 850000, { labor: 1 }), version("2026-09-26", 950000, { labor: 2 })]);
    expect(withCurrentBudget(plan(null), { totalBudget: 1 })).toEqual([]);
  });
});

describe("effectiveWorkPlan", () => {
  const wp = {
    ...plan(
      [
        version(null, 850000, { labor: 356000, overhead: 429000, fixedFee: 63000, fccm: 2000 }),
        version("2026-09-26", 900000, { labor: 377000, overhead: 454500, fixedFee: 66500, fccm: 2000 }),
      ],
      900000,
    ),
    budgetLabor: 377000,
    budgetOverhead: 454500,
    budgetFixedFee: 66500,
    budgetFccm: 2000,
    code: "A.05-01",
    title: "MOCC & LMA HVAC",
    client: "WSP",
    jobNumber: "10013.TO02",
    source: "manual",
  } as unknown as WorkPlan;
  const pkg = (payPeriodStart: string, payPeriodEnd: string) => ({
    procasProject: null,
    clientName: null,
    totalBudget: null,
    fringeRate: null,
    overheadRate: null,
    fixedFeeRate: null,
    fccmRate: null,
    payPeriodStart,
    payPeriodEnd,
  });

  it("states each package against the budget of its own period, total and rows", () => {
    const september = effectiveWorkPlan(pkg("2026-08-29", "2026-09-25"), wp);
    expect(september.totalBudget).toBe(850000);
    expect(september.budgetLabor).toBe(356000);
    expect(september.budgetOverhead).toBe(429000);
    const october = effectiveWorkPlan(pkg("2026-09-26", "2026-10-30"), wp);
    expect(october.totalBudget).toBe(900000);
    expect(october.budgetLabor).toBe(377000);
    expect(october.budgetFixedFee).toBe(66500);
  });
});
