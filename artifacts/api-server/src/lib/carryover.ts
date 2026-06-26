import { eq, inArray } from "drizzle-orm";
import {
  db,
  invoicesTable,
  workPlansTable,
  lineItemsTable,
  type InvoiceRow,
  type LineItemRow,
} from "@workspace/db";
import { computeFinancials } from "./financials";

const BILLED_STATUSES = new Set(["approved", "exported"]);

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * Re-derives the carried-forward ("previously billed") total for every invoice
 * on a work plan, in chronological order, so that downstream invoices stay
 * correct after an earlier invoice changes (line items added/removed, rates
 * corrected, status changed, etc.).
 *
 * Each invoice's carry-over equals the total-to-date of the most recent
 * *billed* (approved/exported) invoice that precedes it. Invoices whose
 * carry-over was supplied explicitly (`carryOverManual`) keep their stored
 * value but still contribute their total-to-date to the chain.
 *
 * Returns the ids of invoices whose stored previouslyBilled was changed.
 */
export async function recomputeCarryOver(workPlanId: number): Promise<number[]> {
  const [workPlan] = await db
    .select()
    .from(workPlansTable)
    .where(eq(workPlansTable.id, workPlanId));
  if (!workPlan) return [];

  const invoices = await db
    .select()
    .from(invoicesTable)
    .where(eq(invoicesTable.workPlanId, workPlanId));
  if (invoices.length === 0) return [];

  const liRows = await db
    .select()
    .from(lineItemsTable)
    .where(inArray(lineItemsTable.invoiceId, invoices.map((i) => i.id)));
  const liByInvoice = new Map<number, LineItemRow[]>();
  for (const li of liRows) {
    const arr = liByInvoice.get(li.invoiceId) ?? [];
    arr.push(li);
    liByInvoice.set(li.invoiceId, arr);
  }

  // Process chronologically so the running "latest billed" pointer mirrors the
  // ordering used when carry-over is first derived at invoice creation.
  const ordered = [...invoices].sort(
    (a, b) =>
      a.periodEnd.localeCompare(b.periodEnd) ||
      a.createdAt.getTime() - b.createdAt.getTime() ||
      a.id - b.id,
  );

  const changed: number[] = [];
  let lastBilledTotalToDate = 0;

  for (const inv of ordered) {
    const lineItems = liByInvoice.get(inv.id) ?? [];
    const previouslyBilled = inv.carryOverManual
      ? round2(inv.previouslyBilled)
      : round2(lastBilledTotalToDate);

    const totalToDate = computeFinancials(lineItems, workPlan, {
      previouslyBilled,
      otherDirectCosts: inv.otherDirectCosts,
    }).totalToDate;

    if (!inv.carryOverManual && previouslyBilled !== round2(inv.previouslyBilled)) {
      await db
        .update(invoicesTable)
        .set({ previouslyBilled })
        .where(eq(invoicesTable.id, inv.id));
      changed.push(inv.id);
    }

    if (BILLED_STATUSES.has(inv.status)) {
      lastBilledTotalToDate = totalToDate;
    }
  }

  return changed;
}

/**
 * Derives the carry-over for a brand-new invoice (the latest period) without
 * writing anything: the total-to-date of the most recent billed invoice on the
 * work plan, or 0 when none exists.
 */
export function deriveCarryOverFromPriors(
  priors: InvoiceRow[],
  lineItemsByInvoice: Map<number, LineItemRow[]>,
  workPlan: Parameters<typeof computeFinancials>[1],
): number {
  const billed = priors
    .filter((p) => BILLED_STATUSES.has(p.status))
    .sort(
      (a, b) =>
        b.periodEnd.localeCompare(a.periodEnd) ||
        b.createdAt.getTime() - a.createdAt.getTime(),
    );
  if (billed.length === 0) return 0;
  const latest = billed[0];
  return computeFinancials(lineItemsByInvoice.get(latest.id) ?? [], workPlan, {
    previouslyBilled: latest.previouslyBilled,
    otherDirectCosts: latest.otherDirectCosts,
  }).totalToDate;
}
