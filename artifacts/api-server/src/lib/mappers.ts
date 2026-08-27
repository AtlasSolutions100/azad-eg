import type { InvoiceRow, LineItemRow, WorkPlan } from "@workspace/db";
import { computeFinancials, type ComputedFinancials } from "./financials";

export function toApiWorkPlan(w: WorkPlan) {
  return {
    id: w.id,
    code: w.code,
    title: w.title,
    nickname: w.nickname,
    client: w.client,
    jobNumber: w.jobNumber,
    agreementNo: w.agreementNo,
    poNumber: w.poNumber,
    wspProjectNo: w.wspProjectNo,
    totalBudget: w.totalBudget,
    budgetLabor: w.budgetLabor,
    budgetOverhead: w.budgetOverhead,
    budgetFixedFee: w.budgetFixedFee,
    budgetFccm: w.budgetFccm,
    prevBilledLabor: w.prevBilledLabor,
    prevBilledOverhead: w.prevBilledOverhead,
    prevBilledFixedFee: w.prevBilledFixedFee,
    prevBilledFccm: w.prevBilledFccm,
    fringeRate: w.fringeRate,
    overheadRate: w.overheadRate,
    fixedFeeRate: w.fixedFeeRate,
    fccmRate: w.fccmRate,
    maxBillRate: w.maxBillRate,
    billingCycle: w.billingCycle,
    status: w.status,
    supplierId: w.supplierId,
    clientProjectNo: w.clientProjectNo,
    sendToCompany: w.sendToCompany,
    sendToAddress1: w.sendToAddress1,
    sendToAddress2: w.sendToAddress2,
    contactPerson: w.contactPerson,
    bartProjectNumbers: w.bartProjectNumbers,
    terms: w.terms,
    procasProject: w.procasProject,
    createdAt: w.createdAt.toISOString(),
  };
}

export function toApiLineItem(li: LineItemRow) {
  return {
    id: li.id,
    invoiceId: li.invoiceId,
    employeeId: li.employeeId,
    employeeName: li.employeeName,
    classification: li.classification,
    category: li.category,
    location: li.location,
    hours: li.hours,
    rate: li.rate,
    amount: li.amount,
    taskNo: li.taskNo,
    notes: li.notes,
    source: li.source,
  };
}

export function buildInvoice(invoice: InvoiceRow, workPlan: WorkPlan, lineItems: LineItemRow[]) {
  const f = computeFinancials(lineItems, workPlan, {
    previouslyBilled: invoice.previouslyBilled,
    otherDirectCosts: invoice.otherDirectCosts,
  });
  return {
    api: {
      id: invoice.id,
      workPlanId: invoice.workPlanId,
      workPlanCode: workPlan.code,
      client: workPlan.client,
      invoiceNumber: invoice.invoiceNumber,
      invoiceDate: invoice.invoiceDate,
      periodStart: invoice.periodStart,
      periodEnd: invoice.periodEnd,
      status: invoice.status,
      laborTotal: f.laborTotal,
      fringeTotal: f.fringeTotal,
      overheadTotal: f.overheadTotal,
      fixedFee: f.fixedFee,
      fccm: f.fccm,
      otdtPremium: f.otdtPremium,
      otherDirectCosts: f.otherDirectCosts,
      totalThisPeriod: f.totalThisPeriod,
      previouslyBilled: f.previouslyBilled,
      carryOverManual: invoice.carryOverManual,
      totalToDate: f.totalToDate,
      remainingBalance: f.remainingBalance,
      percentExpended: f.percentExpended,
      preparedBy: invoice.preparedBy,
      approvedBy: invoice.approvedBy,
      importWarnings: invoice.importWarnings,
      lastImportAt: invoice.lastImportAt ? invoice.lastImportAt.toISOString() : null,
      lastImportSource: invoice.lastImportSource,
      lineItemsEditedAt: invoice.lineItemsEditedAt ? invoice.lineItemsEditedAt.toISOString() : null,
      unlinkedCount: lineItems.filter((li) => li.employeeId == null).length,
      createdAt: invoice.createdAt.toISOString(),
      updatedAt: invoice.updatedAt.toISOString(),
    },
    financials: f as ComputedFinancials,
  };
}
