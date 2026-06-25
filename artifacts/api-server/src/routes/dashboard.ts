import { Router, type IRouter } from "express";
import { desc } from "drizzle-orm";
import {
  db,
  invoicesTable,
  workPlansTable,
  lineItemsTable,
  auditLogsTable,
  type LineItemRow,
} from "@workspace/db";
import { GetDashboardSummaryResponse } from "@workspace/api-zod";
import { buildInvoice } from "../lib/mappers";

const router: IRouter = Router();

router.get("/dashboard/summary", async (_req, res): Promise<void> => {
  const [invoices, workPlans, liRows, activity] = await Promise.all([
    db.select().from(invoicesTable),
    db.select().from(workPlansTable),
    db.select().from(lineItemsTable),
    db.select().from(auditLogsTable).orderBy(desc(auditLogsTable.createdAt)).limit(10),
  ]);

  const wpMap = new Map(workPlans.map((w) => [w.id, w]));
  const liByInvoice = new Map<number, LineItemRow[]>();
  for (const li of liRows) {
    const arr = liByInvoice.get(li.invoiceId) ?? [];
    arr.push(li);
    liByInvoice.set(li.invoiceId, arr);
  }

  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  let totalBilledThisMonth = 0;
  let totalBilledToDate = 0;
  const statusCounts = new Map<string, number>();
  const billedByWp = new Map<number, number>();

  for (const inv of invoices) {
    const wp = wpMap.get(inv.workPlanId);
    if (!wp) continue;
    const built = buildInvoice(inv, wp, liByInvoice.get(inv.id) ?? []);
    statusCounts.set(inv.status, (statusCounts.get(inv.status) ?? 0) + 1);
    totalBilledToDate += built.financials.totalThisPeriod;
    billedByWp.set(inv.workPlanId, (billedByWp.get(inv.workPlanId) ?? 0) + built.financials.totalThisPeriod);
    if (new Date(inv.invoiceDate) >= monthStart) {
      totalBilledThisMonth += built.financials.totalThisPeriod;
    }
  }

  const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
  const activeWorkPlans = workPlans.filter((w) => w.status === "active");
  const totalRemainingBudget = round2(
    activeWorkPlans.reduce((sum, w) => sum + (w.totalBudget - (billedByWp.get(w.id) ?? 0)), 0),
  );

  res.json(
    GetDashboardSummaryResponse.parse({
      totalInvoices: invoices.length,
      draftCount: statusCounts.get("draft") ?? 0,
      approvedCount: statusCounts.get("approved") ?? 0,
      totalBilledThisMonth: round2(totalBilledThisMonth),
      totalBilledToDate: round2(totalBilledToDate),
      totalRemainingBudget,
      activeWorkPlans: activeWorkPlans.length,
      invoicesByStatus: [...statusCounts.entries()].map(([status, count]) => ({ status, count })),
      billingByWorkPlan: workPlans.map((w) => ({
        workPlanCode: w.code,
        billed: round2(billedByWp.get(w.id) ?? 0),
        budget: w.totalBudget,
      })),
      recentActivity: activity.map((a) => ({
        id: a.id,
        userId: a.userId,
        userName: a.userName,
        action: a.action,
        entityType: a.entityType,
        entityId: a.entityId,
        description: a.description,
        createdAt: a.createdAt.toISOString(),
      })),
    }),
  );
});

export default router;
