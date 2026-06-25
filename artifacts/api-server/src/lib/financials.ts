import type { LineItemRow, WorkPlan } from "@workspace/db";

export interface FinancialLine {
  label: string;
  amount: number;
  note?: string | null;
  emphasis?: boolean | null;
}

export interface ComputedFinancials {
  laborTotal: number;
  fringeTotal: number;
  overheadTotal: number;
  fixedFee: number;
  fccm: number;
  otdtPremium: number;
  otherDirectCosts: number;
  totalThisPeriod: number;
  previouslyBilled: number;
  totalToDate: number;
  remainingBalance: number;
  percentExpended: number;
  budgetUsedPercent: number;
  financials: FinancialLine[];
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * Computes invoice financials from line items and the parent work plan.
 *
 * Order of operations (BART Work Plan model):
 *   1. Straight-time labor = sum of (regular/holiday/pto base hours * base rate).
 *   2. OT/DT premium = the premium portion above straight time for OT (0.5x)
 *      and DT (1.0x) categories.
 *   3. Fringe applied to straight-time labor (default 120.58%).
 *   4. Overhead applied to (labor + fringe) when an overhead rate is set.
 *   5. Fixed fee (default 8%) applied to (labor + fringe + overhead).
 *   6. FCCM applied to (labor + fringe + overhead) when an FCCM rate is set.
 */
export function computeFinancials(
  lineItems: LineItemRow[],
  workPlan: Pick<WorkPlan, "totalBudget" | "fringeRate" | "overheadRate" | "fixedFeeRate" | "fccmRate">,
  opts: { previouslyBilled: number; otherDirectCosts: number },
): ComputedFinancials {
  let straightLabor = 0;
  let otdtPremium = 0;

  for (const li of lineItems) {
    const base = li.hours * li.rate;
    if (li.category === "ot") {
      straightLabor += base;
      otdtPremium += base * 0.5;
    } else if (li.category === "dt") {
      straightLabor += base;
      otdtPremium += base * 1.0;
    } else {
      straightLabor += base;
    }
  }

  const fringeRate = workPlan.fringeRate ?? 0;
  const overheadRate = workPlan.overheadRate ?? 0;
  const fixedFeeRate = workPlan.fixedFeeRate ?? 0;
  const fccmRate = workPlan.fccmRate ?? 0;

  const laborTotal = round2(straightLabor);
  const fringeTotal = round2(straightLabor * (fringeRate / 100));
  const laborPlusFringe = laborTotal + fringeTotal;
  const overheadTotal = round2(laborPlusFringe * (overheadRate / 100));
  const baseForFee = laborPlusFringe + overheadTotal;
  const fixedFee = round2(baseForFee * (fixedFeeRate / 100));
  const fccm = round2(baseForFee * (fccmRate / 100));
  const otdt = round2(otdtPremium);
  const otherDirectCosts = round2(opts.otherDirectCosts ?? 0);

  const totalThisPeriod = round2(
    laborTotal + fringeTotal + overheadTotal + fixedFee + fccm + otdt + otherDirectCosts,
  );
  const previouslyBilled = round2(opts.previouslyBilled ?? 0);
  const totalToDate = round2(totalThisPeriod + previouslyBilled);
  const remainingBalance = round2(workPlan.totalBudget - totalToDate);
  const percentExpended = workPlan.totalBudget > 0 ? round2((totalToDate / workPlan.totalBudget) * 100) : 0;
  const budgetUsedPercent = percentExpended;

  const financials: FinancialLine[] = [
    { label: "Direct Labor", amount: laborTotal },
    { label: `Fringe Benefits (${fringeRate}%)`, amount: fringeTotal },
  ];
  if (overheadRate > 0) {
    financials.push({ label: `Overhead (${overheadRate}%)`, amount: overheadTotal });
  }
  financials.push({ label: `Fixed Fee (${fixedFeeRate}%)`, amount: fixedFee });
  if (fccmRate > 0) {
    financials.push({ label: `FCCM (${fccmRate}%)`, amount: fccm });
  }
  if (otdt > 0) {
    financials.push({ label: "OT / DT Premium", amount: otdt });
  }
  if (otherDirectCosts > 0) {
    financials.push({ label: "Other Direct Costs", amount: otherDirectCosts });
  }
  financials.push({ label: "Total This Period", amount: totalThisPeriod, emphasis: true });
  financials.push({ label: "Previously Billed", amount: previouslyBilled, note: "Carried forward" });
  financials.push({ label: "Total Billed To Date", amount: totalToDate, emphasis: true });
  financials.push({
    label: "Remaining Balance",
    amount: remainingBalance,
    note: `${percentExpended}% of budget expended`,
    emphasis: true,
  });

  return {
    laborTotal,
    fringeTotal,
    overheadTotal,
    fixedFee,
    fccm,
    otdtPremium: otdt,
    otherDirectCosts,
    totalThisPeriod,
    previouslyBilled,
    totalToDate,
    remainingBalance,
    percentExpended,
    budgetUsedPercent,
    financials,
  };
}
