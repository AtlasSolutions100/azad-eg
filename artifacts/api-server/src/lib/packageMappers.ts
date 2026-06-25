import type {
  PackageRow,
  PackageWeekRow,
  TimesheetEntryRow,
  PackageProgressReportRow,
  LaborOverrideRow,
  WorkPlan,
  Employee,
  LineItemRow,
} from "@workspace/db";
import { computeFinancials } from "./financials";

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
 * financials. Each entry's total weekly hours become a single labor line; we
 * reuse computeFinancials by mapping entries onto the line-item shape it reads
 * (hours, rate, category). The OT/DT premium logic therefore stays identical to
 * the existing invoice pipeline.
 */
export function buildPackageRollup(
  entries: TimesheetEntryRow[],
  workPlan: Pick<WorkPlan, "totalBudget" | "fringeRate" | "overheadRate" | "fixedFeeRate" | "fccmRate">,
  opts: { previouslyBilled: number; otherDirectCosts: number },
) {
  const laborLines = entries.map((e) => {
    const hours = round2(entryTotalHours(e));
    return {
      employeeName: e.employeeName,
      classification: e.classification,
      category: e.category,
      location: e.location,
      hours,
      rate: e.rate,
      amount: round2(hours * e.rate),
    };
  });

  const lineItemLike = entries.map((e) => ({
    hours: round2(entryTotalHours(e)),
    rate: e.rate,
    category: e.category,
  })) as unknown as LineItemRow[];

  const f = computeFinancials(lineItemLike, workPlan, opts);
  const totalHours = round2(laborLines.reduce((s, l) => s + l.hours, 0));

  return {
    laborLines,
    financials: f.financials,
    totalHours,
    laborTotal: f.laborTotal,
    fringeTotal: f.fringeTotal,
    overheadTotal: f.overheadTotal,
    fixedFee: f.fixedFee,
    fccm: f.fccm,
    otdtPremium: f.otdtPremium,
    otherDirectCosts: f.otherDirectCosts,
    totalThisPeriod: f.totalThisPeriod,
    previouslyBilled: f.previouslyBilled,
    totalToDate: f.totalToDate,
    remainingBalance: f.remainingBalance,
    percentExpended: f.percentExpended,
  };
}

export function toApiPackageSummary(
  pkg: PackageRow,
  employee: Pick<Employee, "name">,
  workPlan: Pick<WorkPlan, "code" | "jobNumber" | "client" | "totalBudget" | "fringeRate" | "overheadRate" | "fixedFeeRate" | "fccmRate">,
  weekCount: number,
  entries: TimesheetEntryRow[],
) {
  const rollup = buildPackageRollup(entries, workPlan, {
    previouslyBilled: pkg.previouslyBilled,
    otherDirectCosts: pkg.otherDirectCosts,
  });
  return {
    id: pkg.id,
    employeeId: pkg.employeeId,
    employeeName: employee.name,
    workPlanId: pkg.workPlanId,
    workPlanCode: workPlan.code,
    jobNumber: workPlan.jobNumber,
    client: workPlan.client,
    payPeriodStart: pkg.payPeriodStart,
    payPeriodEnd: pkg.payPeriodEnd,
    invoiceNumber: pkg.invoiceNumber,
    invoiceDate: pkg.invoiceDate,
    previouslyBilled: pkg.previouslyBilled,
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
    totalThisPeriod: rollup.totalThisPeriod,
    createdAt: pkg.createdAt.toISOString(),
    updatedAt: pkg.updatedAt.toISOString(),
  };
}
