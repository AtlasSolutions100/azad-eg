import { knownBurden, knownHeader, type DetailParts } from "./knownInvoiceHeaders";
import { burdenOnFringeLine } from "./billingProfile";
import type { PackageDocContext } from "./packageDocs";

/**
 * The Budget and Previously Billed columns of an invoice detail page, row by
 * row — shared by the forms that print one (T.Y. Lin's "Sub1 Inv", WSP's "Sub
 * Calc").
 *
 * Julie's detail pages fill four money columns on every row: Budget, Amount
 * This Period, Previously Billed, Amount To Date. Ours printed this period's
 * rows and only the TOTALS of the other three ("Not seeing any information
 * populated in the Budget, Previously billed or amount to date field"). Procas
 * knows the totals but not the rows, so in order of preference:
 *
 *  - what the biller has entered — the budget by cost category (the pencil on
 *    a package, or the Work Plan screen), and likewise a previously-billed
 *    split — which is exact;
 *  - the rows of the last invoice she sent, for whatever of the total that
 *    invoice accounts for;
 *  - arithmetic on the remainder, at the burden of the periods it belongs to.
 *    That puts everything on the labor, fringe, fee and FCCM rows: it cannot
 *    know how much of an amount was overtime premium or a direct cost.
 *
 * The column totals are exact in every case.
 */

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export const NO_PARTS: DetailParts = { labor: 0, fringe: 0, odc: 0, premium: 0, fee: 0, fccm: 0, total: 0 };

export interface DetailRates {
  fringeFrac: number;
  overheadFrac: number;
  feeFrac: number;
  fccmFrac: number;
}

/**
 * Splits a known total into the detail page's rows at the given burden: labor,
 * fringe on it, the fee on both, FCCM on the labor. Any cent of rounding is
 * left on the labor so the rows add up to the total.
 */
export function splitDetailTotal(total: number, r: DetailRates): DetailParts {
  const burden = r.fringeFrac + r.overheadFrac;
  const multiplier = (1 + burden) * (1 + r.feeFrac) + r.fccmFrac;
  if (!(total > 0) || multiplier <= 0) return { ...NO_PARTS };
  const labor = round2(total / multiplier);
  const fringe = round2(labor * burden);
  const fee = round2((labor + fringe) * r.feeFrac);
  const fccm = round2(labor * r.fccmFrac);
  const residue = round2(total - (labor + fringe + fee + fccm));
  return { labor: round2(labor + residue), fringe, odc: 0, premium: 0, fee, fccm, total: round2(total) };
}

export function addParts(a: DetailParts, b: DetailParts): DetailParts {
  return {
    labor: round2(a.labor + b.labor),
    fringe: round2(a.fringe + b.fringe),
    odc: round2(a.odc + b.odc),
    premium: round2(a.premium + b.premium),
    fee: round2(a.fee + b.fee),
    fccm: round2(a.fccm + b.fccm),
    total: round2(a.total + b.total),
  };
}

/** The day before a YYYY-MM-DD date: the last day of the previous period. */
export function priorDay(date: string): string {
  const [y, m, d] = date.split("-").map((n) => parseInt(n, 10));
  const day = new Date(y, (m || 1) - 1, (d || 1) - 1, 12);
  return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
}

/**
 * The burden in force just before this package's period — what the money
 * billed before it was billed at.
 */
export function ratesBefore(ctx: PackageDocContext, current: DetailRates): DetailRates {
  const wp = ctx.workPlan as PackageDocContext["workPlan"] & { procasProject?: string | null };
  const past = knownBurden([wp.procasProject, wp.jobNumber], priorDay(ctx.pkg.payPeriodStart));
  if (!past) return current;
  return {
    ...burdenOnFringeLine(past),
    feeFrac: past.fixedFeeRate / 100,
    fccmFrac: past.fccmRate / 100,
  };
}

export function detailColumns(
  ctx: PackageDocContext,
  fin: DetailRates & { previouslyBilled: number; budget: number },
  pastRates: DetailRates = ratesBefore(ctx, fin),
): { budget: DetailParts; previous: DetailParts; budgetIsEntered: boolean } {
  const wp = ctx.workPlan as PackageDocContext["workPlan"] & { procasProject?: string | null };
  const anchor = knownHeader(wp.procasProject, wp.jobNumber)?.detailAnchor;
  const near = (a: number, b: number) => Math.abs(a - b) < 0.005;

  const prev = round2(fin.previouslyBilled);
  let previous: DetailParts;
  if (
    wp.prevBilledLabor != null ||
    wp.prevBilledOverhead != null ||
    wp.prevBilledFixedFee != null ||
    wp.prevBilledFccm != null
  ) {
    previous = {
      labor: round2(wp.prevBilledLabor ?? 0),
      fringe: round2(wp.prevBilledOverhead ?? 0),
      odc: 0,
      premium: 0,
      fee: round2(wp.prevBilledFixedFee ?? 0),
      fccm: round2(wp.prevBilledFccm ?? 0),
      total: prev,
    };
  } else {
    const from =
      anchor && prev >= anchor.toDate.total - 0.005 && ctx.pkg.payPeriodStart > anchor.through
        ? anchor.toDate
        : NO_PARTS;
    previous = addParts(from, splitDetailTotal(round2(prev - from.total), pastRates));
    previous.total = prev;
  }

  const total = fin.budget;
  const entered =
    wp.budgetLabor != null || wp.budgetOverhead != null || wp.budgetFixedFee != null || wp.budgetFccm != null;
  let budget: DetailParts;
  if (entered) {
    budget = {
      labor: round2(wp.budgetLabor ?? 0),
      fringe: round2(wp.budgetOverhead ?? 0),
      odc: 0,
      premium: 0,
      fee: round2(wp.budgetFixedFee ?? 0),
      fccm: round2(wp.budgetFccm ?? 0),
      total,
    };
  } else if (anchor && near(total, anchor.budget.total)) {
    budget = anchor.budget;
  } else {
    budget = splitDetailTotal(total, fin);
  }
  return { budget, previous, budgetIsEntered: entered };
}
