import { eq, and, inArray, desc, asc } from "drizzle-orm";
import {
  db,
  packagesTable,
  billedLineItemsTable,
  type BilledLineItemRow,
  type InsertBilledLineItem,
} from "@workspace/db";

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export interface ApiBilledLineItem {
  id: number;
  packageId: number;
  workScopeNo: string;
  poNo: string | null;
  lineNo: number | null;
  bartProjectNo: string | null;
  poAmount: number;
  previousInvoiced: number;
  currentInvoiced: number;
  totalInvoiced: number;
  remainingBalance: number;
  sortOrder: number;
  source: string;
}

export interface BillingSummary {
  poAmountTotal: number;
  previousInvoicedTotal: number;
  currentInvoicedTotal: number;
  totalInvoicedTotal: number;
  remainingBalanceTotal: number;
  percentExpended: number;
}

export function toApiBilledLineItem(row: BilledLineItemRow): ApiBilledLineItem {
  const totalInvoiced = round2(row.previousInvoiced + row.currentInvoiced);
  return {
    id: row.id,
    packageId: row.packageId,
    workScopeNo: row.workScopeNo,
    poNo: row.poNo,
    lineNo: row.lineNo,
    bartProjectNo: row.bartProjectNo,
    poAmount: row.poAmount,
    previousInvoiced: row.previousInvoiced,
    currentInvoiced: row.currentInvoiced,
    totalInvoiced,
    remainingBalance: round2(row.poAmount - totalInvoiced),
    sortOrder: row.sortOrder,
    source: row.source,
  };
}

/** Billing Summary totals — mirrors the reference Cover BILLING SUMMARY block. */
export function computeBillingSummary(rows: BilledLineItemRow[]): BillingSummary {
  const poAmountTotal = round2(rows.reduce((s, r) => s + r.poAmount, 0));
  const previousInvoicedTotal = round2(rows.reduce((s, r) => s + r.previousInvoiced, 0));
  const currentInvoicedTotal = round2(rows.reduce((s, r) => s + r.currentInvoiced, 0));
  const totalInvoicedTotal = round2(previousInvoicedTotal + currentInvoicedTotal);
  return {
    poAmountTotal,
    previousInvoicedTotal,
    currentInvoicedTotal,
    totalInvoicedTotal,
    remainingBalanceTotal: round2(poAmountTotal - totalInvoicedTotal),
    percentExpended: poAmountTotal > 0 ? round2((totalInvoicedTotal / poAmountTotal) * 100) : 0,
  };
}

export async function listBilledLineItems(packageId: number): Promise<BilledLineItemRow[]> {
  return db
    .select()
    .from(billedLineItemsTable)
    .where(eq(billedLineItemsTable.packageId, packageId))
    .orderBy(asc(billedLineItemsTable.sortOrder), asc(billedLineItemsTable.id));
}

/**
 * Automatic per-line carry-forward: seeds a new package's Billed Line Items
 * from the most recent approved/exported package of the same work plan. Each
 * carried line's Previous Invoiced becomes the prior line's Total Invoiced
 * (previous + current) and Current Invoiced resets to 0 — exactly how Julie
 * rolls the Cover table forward month over month.
 */
export async function seedBilledLineItemsFromLastApproved(
  packageId: number,
  workPlanId: number,
): Promise<BilledLineItemRow[]> {
  const priorPkgs = await db
    .select({ id: packagesTable.id })
    .from(packagesTable)
    .where(
      and(
        eq(packagesTable.workPlanId, workPlanId),
        inArray(packagesTable.status, ["approved", "exported"]),
      ),
    )
    .orderBy(desc(packagesTable.payPeriodEnd), desc(packagesTable.id));

  for (const prior of priorPkgs) {
    if (prior.id === packageId) continue;
    const priorItems = await listBilledLineItems(prior.id);
    if (priorItems.length === 0) continue;
    const values: InsertBilledLineItem[] = priorItems.map((it, idx) => ({
      packageId,
      workScopeNo: it.workScopeNo,
      poNo: it.poNo,
      lineNo: it.lineNo,
      bartProjectNo: it.bartProjectNo,
      poAmount: it.poAmount,
      previousInvoiced: round2(it.previousInvoiced + it.currentInvoiced),
      currentInvoiced: 0,
      sortOrder: it.sortOrder ?? idx,
      source: "carry_forward",
    }));
    return db.insert(billedLineItemsTable).values(values).returning();
  }
  return [];
}

export interface BilledLineItemInput {
  workScopeNo: string;
  poNo?: string;
  lineNo?: number;
  bartProjectNo?: string;
  poAmount?: number;
  previousInvoiced?: number;
  currentInvoiced?: number;
  sortOrder?: number;
}

/** Bulk replace: the editor saves the whole table at once. */
export async function replaceBilledLineItems(
  packageId: number,
  items: BilledLineItemInput[],
): Promise<BilledLineItemRow[]> {
  return db.transaction(async (tx) => {
    await tx.delete(billedLineItemsTable).where(eq(billedLineItemsTable.packageId, packageId));
    if (items.length === 0) return [];
    const values: InsertBilledLineItem[] = items.map((it, idx) => ({
      packageId,
      workScopeNo: it.workScopeNo,
      poNo: it.poNo ?? null,
      lineNo: it.lineNo ?? null,
      bartProjectNo: it.bartProjectNo ?? null,
      poAmount: it.poAmount ?? 0,
      previousInvoiced: it.previousInvoiced ?? 0,
      currentInvoiced: it.currentInvoiced ?? 0,
      sortOrder: it.sortOrder ?? idx,
      source: "manual",
    }));
    return tx.insert(billedLineItemsTable).values(values).returning();
  });
}
