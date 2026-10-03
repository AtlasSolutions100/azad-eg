import { eq, and, inArray, desc, asc } from "drizzle-orm";
import {
  db,
  packagesTable,
  billedLineItemsTable,
  type BilledLineItemRow,
  type InsertBilledLineItem,
} from "@workspace/db";

import { allocateAcrossPoLines, allocateCurrent, knownPoSchedule } from "./poSchedule";

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

/**
 * The Billed Line Items a package should SHOW — on screen and on the invoice.
 *
 * Stored rows are only ever typed in or carried forward from the last approved
 * package, with Current Invoiced reset to 0 for the biller to fill by hand.
 * Two cases left the cover's table empty or half-empty:
 *
 *  - no rows at all (a work plan with no approved package yet) — the table
 *    printed blank, with dashes for its total;
 *  - carried-forward rows nobody had typed a current amount into — the table
 *    printed last month's figures and a Current Invoiced column of zeros.
 *
 * The split is arithmetic on Julie's side (see poSchedule.ts), so it is
 * computed here rather than asked for. Rows a biller has edited are never
 * touched: once a row is "manual" the stored figures are the figures.
 */
export function effectiveBilledLineItems(
  rows: BilledLineItemRow[],
  opts: {
    packageId: number;
    scheduleKeys: Array<string | null | undefined>;
    previouslyBilled: number;
    totalThisPeriod: number;
  },
): BilledLineItemRow[] {
  if (rows.length === 0) {
    const schedule = knownPoSchedule(...opts.scheduleKeys);
    if (!schedule) return rows;
    return allocateAcrossPoLines(schedule, opts.previouslyBilled, opts.totalThisPeriod).map(
      (line, i) => ({
        // Negative ids mark rows that exist only as a computation; saving the
        // table from the editor replaces them with real ones.
        id: -(i + 1),
        packageId: opts.packageId,
        workScopeNo: line.workScopeNo,
        poNo: line.poNo,
        lineNo: line.lineNo,
        bartProjectNo: line.bartProjectNo,
        poAmount: line.poAmount,
        previousInvoiced: line.previousInvoiced,
        currentInvoiced: line.currentInvoiced,
        sortOrder: i,
        source: "po_schedule",
      }),
    );
  }
  const untouched =
    rows.every((r) => r.source === "carry_forward") && rows.every((r) => r.currentInvoiced === 0);
  if (!untouched || opts.totalThisPeriod <= 0) return rows;
  const current = allocateCurrent(rows, opts.totalThisPeriod);
  return rows.map((r, i) => ({ ...r, currentInvoiced: current[i] }));
}
