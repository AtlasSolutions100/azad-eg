import type { PackageRow, WorkPlan } from "@workspace/db";

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
>;

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
    totalBudget: pkg.totalBudget ?? wp?.totalBudget ?? 0,
    // Rates (percent): package override always wins over the work plan.
    fringeRate: pkg.fringeRate ?? wp?.fringeRate ?? 0,
    overheadRate: pkg.overheadRate ?? wp?.overheadRate ?? null,
    fixedFeeRate: pkg.fixedFeeRate ?? wp?.fixedFeeRate ?? 0,
    fccmRate: pkg.fccmRate ?? wp?.fccmRate ?? null,
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
    budgetLabor: wp?.budgetLabor ?? null,
    budgetOverhead: wp?.budgetOverhead ?? null,
    budgetFixedFee: wp?.budgetFixedFee ?? null,
    budgetFccm: wp?.budgetFccm ?? null,
    prevBilledLabor: wp?.prevBilledLabor ?? null,
    prevBilledOverhead: wp?.prevBilledOverhead ?? null,
    prevBilledFixedFee: wp?.prevBilledFixedFee ?? null,
    prevBilledFccm: wp?.prevBilledFccm ?? null,
    billingCycle: wp?.billingCycle ?? "whole_month",
  };
}
