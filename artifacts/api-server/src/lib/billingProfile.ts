import type { PackageRow, WorkPlan } from "@workspace/db";
import { historicalBurden } from "./knownInvoiceHeaders";
import { budgetInForce } from "./budgetHistory";

/**
 * The billing profile a package actually bills with. Packages may exist
 * before their work plan does ("work plan pending"), and may carry their own
 * rate overrides; this helper is the single place where those layers resolve:
 *
 *   package override -> linked work plan -> default (0 / blank)
 *
 * The result is shaped like a WorkPlan so rollups, summaries, and document
 * generators keep working unchanged whether or not a real work plan exists.
 */
/**
 * The burden as the WSP and T.Y. Lin forms print it.
 *
 * Those forms carry the whole indirect burden on their "Fringe Benefits" line
 * (120.58%) and leave "Overhead Pool" at 0.00%. Procas files the very same
 * percentage under OverheadPercent, so a work plan synced from Procas printed
 * "Fringe Benefits 0.00% / Field Overhead Pool 120.58%" — the right total under
 * the wrong labels. When a work plan has no fringe of its own, its overhead is
 * the fringe line.
 */
export function burdenOnFringeLine(wp: {
  fringeRate?: number | null;
  overheadRate?: number | null;
}): { fringeFrac: number; overheadFrac: number } {
  const fringe = (wp.fringeRate ?? 0) / 100;
  const overhead = (wp.overheadRate ?? 0) / 100;
  return fringe === 0 && overhead > 0
    ? { fringeFrac: overhead, overheadFrac: 0 }
    : { fringeFrac: fringe, overheadFrac: overhead };
}

export type EffectiveWorkPlan = Pick<
  WorkPlan,
  | "code"
  | "title"
  | "client"
  | "jobNumber"
  | "totalBudget"
  | "fringeRate"
  | "overheadRate"
  | "fixedFeeRate"
  | "fccmRate"
  | "maxBillRate"
  | "procasProject"
  | "agreementNo"
  | "poNumber"
  | "wspProjectNo"
  | "supplierId"
  | "clientProjectNo"
  | "sendToCompany"
  | "sendToAddress1"
  | "sendToAddress2"
  | "contactPerson"
  | "bartProjectNumbers"
  | "terms"
  | "budgetLabor"
  | "budgetOverhead"
  | "budgetFixedFee"
  | "budgetFccm"
  | "prevBilledLabor"
  | "prevBilledOverhead"
  | "prevBilledFixedFee"
  | "prevBilledFccm"
  | "billingCycle"
>;

type PkgProfileFields = Pick<
  PackageRow,
  | "procasProject"
  | "clientName"
  | "totalBudget"
  | "fringeRate"
  | "overheadRate"
  | "fixedFeeRate"
  | "fccmRate"
> & {
  /** Lets a burden that applied to an earlier period be used for that period. */
  payPeriodStart?: string | null;
  /** Lets a budget that was in force for an earlier period be used for it. */
  payPeriodEnd?: string | null;
};

/**
 * Applies a work plan's Max Bill Rate cap to a raw hourly rate. When a cap is
 * set, an employee whose rate exceeds it is billed at the cap; otherwise the
 * rate passes through unchanged. Kept in one place so the on-screen rollup and
 * every export engine cap identically.
 */
export function cappedBillRate(rate: number, maxBillRate: number | null | undefined): number {
  return maxBillRate != null && maxBillRate > 0 && rate > maxBillRate ? maxBillRate : rate;
}

export function effectiveWorkPlan(
  pkg: PkgProfileFields,
  wp: WorkPlan | null | undefined,
): EffectiveWorkPlan {
  const job = (wp?.jobNumber ?? pkg.procasProject ?? "").trim();
  // A package for a month before a known burden change bills that month's
  // burden (see burdenBefore). A work plan whose rates a biller has taken over
  // is theirs for every period.
  const past =
    wp && wp.source !== "manual"
      ? historicalBurden([wp.procasProject, wp.jobNumber], pkg.payPeriodStart)
      : null;
  // …and the budget that was in force for this package's period, which is the
  // work plan's current one unless a later change was entered with its date.
  const budget = wp ? budgetInForce(wp, pkg.payPeriodEnd) : null;
  return {
    // Identity/display: real work plan wins; otherwise derive from the Procas
    // job so lists and audit lines still read sensibly.
    code: wp?.code ?? (job ? `Job ${job}` : "No work plan yet"),
    title: wp?.title ?? (job ? `Procas job ${job}` : "Work plan pending"),
    client: wp?.client ?? pkg.clientName ?? "Unassigned",
    jobNumber: job,
    procasProject: wp?.procasProject ?? pkg.procasProject ?? null,
    // Budget: package override wins so a known ceiling can be tracked before
    // the work plan arrives; 0 means "no budget tracked".
    totalBudget: pkg.totalBudget ?? budget?.total ?? 0,
    // Rates (percent): package override always wins over the work plan.
    fringeRate: pkg.fringeRate ?? past?.fringeRate ?? wp?.fringeRate ?? 0,
    overheadRate: pkg.overheadRate ?? past?.overheadRate ?? wp?.overheadRate ?? null,
    fixedFeeRate: pkg.fixedFeeRate ?? past?.fixedFeeRate ?? wp?.fixedFeeRate ?? 0,
    fccmRate: pkg.fccmRate ?? past?.fccmRate ?? wp?.fccmRate ?? null,
    // Max billable rate cap comes only from the work plan (no package override).
    maxBillRate: wp?.maxBillRate ?? null,
    // Contract/cover-page details only a real work plan can provide.
    agreementNo: wp?.agreementNo ?? null,
    poNumber: wp?.poNumber ?? null,
    wspProjectNo: wp?.wspProjectNo ?? null,
    supplierId: wp?.supplierId ?? null,
    clientProjectNo: wp?.clientProjectNo ?? null,
    sendToCompany: wp?.sendToCompany ?? null,
    sendToAddress1: wp?.sendToAddress1 ?? null,
    sendToAddress2: wp?.sendToAddress2 ?? null,
    contactPerson: wp?.contactPerson ?? null,
    bartProjectNumbers: wp?.bartProjectNumbers ?? null,
    terms: wp?.terms ?? null,
    budgetLabor: budget?.labor ?? null,
    budgetOverhead: budget?.overhead ?? null,
    budgetFixedFee: budget?.fixedFee ?? null,
    budgetFccm: budget?.fccm ?? null,
    prevBilledLabor: wp?.prevBilledLabor ?? null,
    prevBilledOverhead: wp?.prevBilledOverhead ?? null,
    prevBilledFixedFee: wp?.prevBilledFixedFee ?? null,
    prevBilledFccm: wp?.prevBilledFccm ?? null,
    billingCycle: wp?.billingCycle ?? "whole_month",
  };
}
