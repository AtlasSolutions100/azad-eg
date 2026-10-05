import { formPrime } from "./knownInvoiceHeaders";
import type {
  PackageRow,
  PackageWeekRow,
  TimesheetEntryRow,
  PackageProgressReportRow,
  LaborOverrideRow,
  WorkPlan,
  Employee,
} from "@workspace/db";
import { evaluateBudgetStatus } from "./financials";
import { cappedBillRate } from "./billingProfile";

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export function entryTotalHours(e: TimesheetEntryRow): number {
  return (
    e.hoursMon + e.hoursTue + e.hoursWed + e.hoursThu + e.hoursFri + e.hoursSat + e.hoursSun
  );
}

export function toApiTimesheetEntry(e: TimesheetEntryRow) {
  const totalHours = round2(entryTotalHours(e));
  return {
    id: e.id,
    packageId: e.packageId,
    weekId: e.weekId,
    employeeId: e.employeeId,
    employeeName: e.employeeName,
    classification: e.classification,
    category: e.category,
    location: e.location,
    hoursMon: e.hoursMon,
    hoursTue: e.hoursTue,
    hoursWed: e.hoursWed,
    hoursThu: e.hoursThu,
    hoursFri: e.hoursFri,
    hoursSat: e.hoursSat,
    hoursSun: e.hoursSun,
    totalHours,
    rate: e.rate,
    amount: round2(totalHours * e.rate),
    source: e.source,
    // Whether the Procas hours behind this entry are approved. Unapproved rows
    // are rendered in red in the UI and block final export. Display-only: has no
    // effect on billing math.
    approved: e.approved,
    taskNo: e.taskNo,
    notes: e.notes,
  };
}

export function toApiWeek(w: PackageWeekRow) {
  return {
    id: w.id,
    packageId: w.packageId,
    label: w.label,
    weekStart: w.weekStart,
    weekEnd: w.weekEnd,
    sortOrder: w.sortOrder,
    createdAt: w.createdAt.toISOString(),
  };
}

export function toApiProgressReport(r: PackageProgressReportRow) {
  return {
    id: r.id,
    packageId: r.packageId,
    percentComplete: r.percentComplete,
    summary: r.summary,
    workPerformed: r.workPerformed,
    concerns: r.concerns,
    correctiveAction: r.correctiveAction,
    scheduleComment: r.scheduleComment,
    costForecast: r.costForecast,
    preparedBy: r.preparedBy,
    reportDate: r.reportDate,
    uploadedFileUrl: r.uploadedFileUrl,
    uploadedFileName: r.uploadedFileName,
  };
}

export function toApiOverride(o: LaborOverrideRow) {
  return {
    id: o.id,
    packageId: o.packageId,
    cellKey: o.cellKey,
    value: o.value,
    editedBy: o.editedBy,
    editedAt: o.editedAt.toISOString(),
  };
}

/**
 * Rolls a package's timesheet entries up into per-line labor and computed
 * financials using the BART indirect build-up model, validated to the cent
 * against Julie's reference workbooks (WSP `Sub Calc _revised`, AECOM master):
 *
 *   Direct Labor  = Σ(hours × base rate)              // OT/DT hours at base rate
 *   Fringe        = labor × fringeRate                // the 120.58% indirect layer
 *   Overhead      = (labor + fringe) × overheadRate   // optional 2nd layer (usually 0)
 *   Fixed Fee     = (labor + fringe + overhead) × feeRate   // capped: no fee on burden > 150% of labor
 *   FCCM          = labor × fccmRate                  // on direct labor only
 *   OT/DT premium = 0.5×base×otHrs + 1.0×base×dtHrs   // added UNBURDENED (no OH/fee) as an ODC line
 *   This Period   = labor + fringe + overhead + fee + FCCM + OT/DT premium + ODCs
 *
 * Entry rates are BASE labor rates (e.g. Procas Billing Item "Billing Rate"),
 * NOT pre-burdened — the indirect layers above are what turn them into the
 * billed amount. PTO/holiday hours bill at rate 0 and are excluded from Total
 * Hours, matching the reference workbook's billable row.
 */
export function buildPackageRollup(
  entries: TimesheetEntryRow[],
  workPlan: Pick<WorkPlan, "totalBudget" | "fringeRate" | "overheadRate" | "fixedFeeRate" | "fccmRate"> & {
    maxBillRate?: number | null;
  },
  opts: { previouslyBilled: number; otherDirectCosts: number },
) {
  const laborLines = entries.map((e) => {
    const hours = round2(entryTotalHours(e));
    // PTO/holiday rows are non-billable: their amount is always $0 no matter
    // what rate is stored on the entry, so every consumer of laborLines
    // (rollup totals, labor attachment, sub calc) stays consistent.
    const nonBillable = e.category === "pto" || e.category === "holiday";
    // Apply the work plan's Max Bill Rate cap so on-screen totals match the
    // capped amounts the export bills.
    const rate = cappedBillRate(e.rate, workPlan.maxBillRate);
    return {
      employeeName: e.employeeName,
      classification: e.classification,
      category: e.category,
      location: e.location,
      hours,
      rate,
      amount: nonBillable ? 0 : round2(hours * rate),
    };
  });

  // Billable hours only: PTO/holiday rows are non-billable in the reference
  // workbook (they live on rows 11/12 and never roll into O9).
  const totalHours = round2(
    laborLines.reduce(
      (s, l) => (l.category === "pto" || l.category === "holiday" ? s : s + l.hours),
      0,
    ),
  );

  // Straight-time labor at BASE rates. OT/DT hours are billed here at their
  // straight/base rate; the OT/DT *premium* (0.5×base for OT, 1.0×base for DT)
  // is accumulated separately and added later UNBURDENED — the BART rule is
  // that no overhead or fee applies to the premium portion.
  let straightLabor = 0;
  let otdtPremiumRaw = 0;
  for (const l of laborLines) {
    // PTO/holiday amounts are already zeroed above, so they contribute no
    // labor dollars here (mirrors the reference workbook rows 11/12).
    if (l.category === "pto" || l.category === "holiday") continue;
    const base = l.hours * l.rate;
    straightLabor += base;
    if (l.category === "ot") otdtPremiumRaw += base * 0.5;
    else if (l.category === "dt") otdtPremiumRaw += base * 1.0;
  }
  const otdtPremium = round2(otdtPremiumRaw);
  const laborTotal = round2(straightLabor);

  const fringeRate = (workPlan.fringeRate ?? 0) / 100;
  const overheadRate = (workPlan.overheadRate ?? 0) / 100;
  const fixedFeeRate = (workPlan.fixedFeeRate ?? 0) / 100;
  const fccmRate = (workPlan.fccmRate ?? 0) / 100;

  // Indirect build-up on straight-time labor only (never on the OT/DT premium).
  // Rounding mirrors the reference workbook to the cent: fringe/overhead/fee are
  // kept at full precision and only FCCM is rounded per-line (Julie's sheet
  // wraps only its FCCM cell in ROUND); the period total is rounded once.
  const fringeRaw = straightLabor * fringeRate;
  const laborPlusFringe = straightLabor + fringeRaw;
  const overheadRaw = laborPlusFringe * overheadRate;
  // Fee cap: no fixed fee on indirect burden exceeding 150% of direct labor.
  const cappedBurdenRaw = Math.min(fringeRaw + overheadRaw, straightLabor * 1.5);
  const fixedFeeRaw = (straightLabor + cappedBurdenRaw) * fixedFeeRate;
  // FCCM is charged on direct labor only (matches the reference workbook).
  const fccm = round2(straightLabor * fccmRate);
  const otherDirectCosts = round2(opts.otherDirectCosts ?? 0);

  // Rounded per-line values for display.
  const fringeTotal = round2(fringeRaw);
  const overheadTotal = round2(overheadRaw);
  const fixedFee = round2(fixedFeeRaw);

  const totalThisPeriod = round2(
    straightLabor + fringeRaw + overheadRaw + fixedFeeRaw + fccm + otdtPremiumRaw + otherDirectCosts,
  );
  const previouslyBilled = round2(opts.previouslyBilled ?? 0);
  const totalToDate = round2(totalThisPeriod + previouslyBilled);
  // Budget <= 0 means "no budget tracked" (e.g. a package started before its
  // work plan exists): remaining/percent stay neutral instead of going
  // negative against a phantom $0 ceiling.
  const budget = workPlan.totalBudget;
  const hasBudget = budget > 0;
  const remainingBalance = hasBudget ? round2(budget - totalToDate) : 0;
  const percentExpended = hasBudget ? round2((totalToDate / budget) * 100) : 0;

  const financials: {
    label: string;
    amount: number;
    note?: string | null;
    emphasis?: boolean | null;
  }[] = [{ label: "Direct Labor", amount: laborTotal }];
  if (fringeRate > 0) {
    financials.push({
      label: `Fringe/Overhead (${workPlan.fringeRate}%)`,
      amount: fringeTotal,
    });
  }
  if (overheadRate > 0) {
    financials.push({
      label: `Overhead (${workPlan.overheadRate}%)`,
      amount: overheadTotal,
    });
  }
  financials.push({ label: `Fixed Fee (${workPlan.fixedFeeRate ?? 0}%)`, amount: fixedFee });
  if (fccmRate > 0) {
    financials.push({ label: `FCCM (${workPlan.fccmRate}%)`, amount: fccm });
  }
  if (otdtPremium > 0) {
    financials.push({
      label: "OT/DT Premium",
      amount: otdtPremium,
      note: "No overhead or fee applied",
    });
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
    note: hasBudget ? `${percentExpended}% of budget expended` : "No budget tracked",
    emphasis: true,
  });

  return {
    laborLines,
    financials,
    totalHours,
    laborTotal,
    fringeTotal,
    overheadTotal,
    fixedFee,
    fccm,
    otdtPremium,
    otherDirectCosts,
    totalThisPeriod,
    previouslyBilled,
    totalToDate,
    // Explicit budget (0 = none tracked) so the UI never has to derive it.
    budget: round2(budget),
    remainingBalance,
    percentExpended,
    // Shared budget signal so package-level UI stays in sync with the
    // per-invoice workspace (same evaluateBudgetStatus thresholds).
    budgetStatus: evaluateBudgetStatus({ percentExpended, remainingBalance }),
  };
}

export interface EmployeeContribution {
  employeeId: number | null;
  employeeName: string;
  hours: number;
  laborCost: number;
}

export function contributorKey(entry: Pick<TimesheetEntryRow, "employeeId" | "employeeName">): string {
  // Key by employee identity when known so two people sharing a name stay
  // separate; fall back to normalized name for legacy rows without an ID.
  return entry.employeeId != null ? `id:${entry.employeeId}` : `name:${entry.employeeName.trim().toLowerCase()}`;
}

/**
 * Aggregates a package's timesheet entries into per-employee contributions
 * (hours + straight-time labor cost), ordered by descending labor cost.
 */
export function buildEmployeeContributions(entries: TimesheetEntryRow[]): EmployeeContribution[] {
  const byKey = new Map<string, EmployeeContribution>();
  for (const e of entries) {
    const key = contributorKey(e);
    const acc = byKey.get(key) ?? {
      employeeId: e.employeeId ?? null,
      employeeName: e.employeeName.trim(),
      hours: 0,
      laborCost: 0,
    };
    const hours = entryTotalHours(e);
    acc.hours += hours;
    acc.laborCost += hours * e.rate;
    byKey.set(key, acc);
  }
  return [...byKey.values()]
    .map((c) => ({ ...c, hours: round2(c.hours), laborCost: round2(c.laborCost) }))
    .sort((a, b) => b.laborCost - a.laborCost || a.employeeName.localeCompare(b.employeeName));
}

/**
 * Display label for a package's contributors: single name, "A +N more" when
 * several employees contributed, or the legacy employee's name as fallback.
 */
export function contributorsLabel(
  contributions: EmployeeContribution[],
  legacyEmployee: Pick<Employee, "name"> | null | undefined,
): string | null {
  if (contributions.length === 1) return contributions[0].employeeName;
  if (contributions.length > 1) {
    return `${contributions[0].employeeName} +${contributions.length - 1} more`;
  }
  return legacyEmployee?.name ?? null;
}

export function toApiPackageSummary(
  pkg: PackageRow,
  employee: Pick<Employee, "name"> | null,
  workPlan: Pick<WorkPlan, "code" | "jobNumber" | "client" | "totalBudget" | "fringeRate" | "overheadRate" | "fixedFeeRate" | "fccmRate"> & {
    maxBillRate?: number | null;
  },
  weekCount: number,
  entries: TimesheetEntryRow[],
) {
  const rollup = buildPackageRollup(entries, workPlan, {
    previouslyBilled: pkg.previouslyBilled,
    otherDirectCosts: pkg.otherDirectCosts,
  });
  const employees = buildEmployeeContributions(entries);
  // Total hours across entries whose Procas status is not yet approved. Purely
  // a display/guard signal (drives the persistent "not yet approved" banner and
  // the export guard); it does NOT enter any billing calculation above.
  const unapprovedHours = round2(
    entries.reduce((s, e) => (e.approved ? s : s + entryTotalHours(e)), 0),
  );
  return {
    id: pkg.id,
    employeeId: pkg.employeeId,
    employeeName: contributorsLabel(employees, employee),
    employees,
    workPlanId: pkg.workPlanId,
    workPlanCode: workPlan.code,
    jobNumber: workPlan.jobNumber,
    client: workPlan.client,
    procasProject: pkg.procasProject,
    clientName: pkg.clientName,
    owner: pkg.owner,
    // The prime the documents will be built for (see formPrime), so a package
    // whose Prime was left blank still shows which form it is on.
    prime: formPrime({
      typed: pkg.prime,
      keys: [(workPlan as { procasProject?: string | null }).procasProject, workPlan.jobNumber],
      client: workPlan.client,
    }),
    totalBudget: pkg.totalBudget,
    fringeRate: pkg.fringeRate,
    overheadRate: pkg.overheadRate,
    fixedFeeRate: pkg.fixedFeeRate,
    fccmRate: pkg.fccmRate,
    payPeriodStart: pkg.payPeriodStart,
    payPeriodEnd: pkg.payPeriodEnd,
    invoiceNumber: pkg.invoiceNumber,
    invoiceDate: pkg.invoiceDate,
    previouslyBilled: pkg.previouslyBilled,
    previouslyBilledSource: pkg.previouslyBilledSource,
    otherDirectCosts: pkg.otherDirectCosts,
    signatureId: pkg.signatureId,
    preparedBy: pkg.preparedBy,
    approvedBy: pkg.approvedBy,
    status: pkg.status,
    invoiceDocStatus: pkg.invoiceDocStatus,
    subCalcDocStatus: pkg.subCalcDocStatus,
    progressReportDocStatus: pkg.progressReportDocStatus,
    laborAttachmentDocStatus: pkg.laborAttachmentDocStatus,
    timesheetsDocStatus: pkg.timesheetsDocStatus,
    weekCount,
    totalHours: rollup.totalHours,
    unapprovedHours,
    totalThisPeriod: rollup.totalThisPeriod,
    budgetStatus: rollup.budgetStatus,
    createdAt: pkg.createdAt.toISOString(),
    updatedAt: pkg.updatedAt.toISOString(),
  };
}
