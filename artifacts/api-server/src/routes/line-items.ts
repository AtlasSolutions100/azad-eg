import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, lineItemsTable, invoicesTable } from "@workspace/db";
import {
  CreateLineItemBody,
  UpdateLineItemBody,
  ListLineItemsResponse,
  CreateLineItemResponse,
  UpdateLineItemResponse,
} from "@workspace/api-zod";
import { toApiLineItem } from "../lib/mappers";
import { recomputeCarryOverWithAudit } from "../lib/carryover";
import { recordAudit } from "../lib/audit";

const router: IRouter = Router();

// Manual line-item edits are stamped on the invoice so the UI can flag
// persisted import warnings as possibly outdated (edit after lastImportAt).
async function markLineItemsEdited(invoiceId: number): Promise<void> {
  await db
    .update(invoicesTable)
    .set({ lineItemsEditedAt: new Date() })
    .where(eq(invoicesTable.id, invoiceId));
}

router.get("/invoices/:id/line-items", async (req, res): Promise<void> => {
  const invoiceId = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  const rows = await db.select().from(lineItemsTable).where(eq(lineItemsTable.invoiceId, invoiceId)).orderBy(lineItemsTable.id);
  res.json(ListLineItemsResponse.parse(rows.map(toApiLineItem)));
});

router.post("/invoices/:id/line-items", async (req, res): Promise<void> => {
  const invoiceId = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  const [inv] = await db.select().from(invoicesTable).where(eq(invoicesTable.id, invoiceId));
  if (!inv) {
    res.status(404).json({ error: "Invoice not found" });
    return;
  }
  const parsed = CreateLineItemBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const amount = parsed.data.hours * parsed.data.rate;
  const [row] = await db.insert(lineItemsTable).values({ ...parsed.data, invoiceId, amount }).returning();
  await markLineItemsEdited(invoiceId);
  await recomputeCarryOverWithAudit(inv.workPlanId, {
    invoiceId,
    invoiceNumber: inv.invoiceNumber,
    reason: "a line-item change on",
  });
  await recordAudit({ action: "added line item", entityType: "invoice", entityId: invoiceId, description: row.employeeName });
  res.status(201).json(CreateLineItemResponse.parse(toApiLineItem(row)));
});

router.patch("/line-items/:id", async (req, res): Promise<void> => {
  const id = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  const parsed = UpdateLineItemBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [existing] = await db.select().from(lineItemsTable).where(eq(lineItemsTable.id, id));
  if (!existing) {
    res.status(404).json({ error: "Line item not found" });
    return;
  }
  const hours = parsed.data.hours ?? existing.hours;
  const rate = parsed.data.rate ?? existing.rate;
  const [row] = await db
    .update(lineItemsTable)
    .set({ ...parsed.data, amount: hours * rate })
    .where(eq(lineItemsTable.id, id))
    .returning();
  await markLineItemsEdited(row.invoiceId);
  const [inv] = await db.select().from(invoicesTable).where(eq(invoicesTable.id, row.invoiceId));
  if (inv)
    await recomputeCarryOverWithAudit(inv.workPlanId, {
      invoiceId: inv.id,
      invoiceNumber: inv.invoiceNumber,
      reason: "a line-item change on",
    });
  res.json(UpdateLineItemResponse.parse(toApiLineItem(row)));
});

router.delete("/line-items/:id", async (req, res): Promise<void> => {
  const id = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  const [row] = await db.delete(lineItemsTable).where(eq(lineItemsTable.id, id)).returning();
  if (!row) {
    res.status(404).json({ error: "Line item not found" });
    return;
  }
  await markLineItemsEdited(row.invoiceId);
  const [inv] = await db.select().from(invoicesTable).where(eq(invoicesTable.id, row.invoiceId));
  if (inv)
    await recomputeCarryOverWithAudit(inv.workPlanId, {
      invoiceId: inv.id,
      invoiceNumber: inv.invoiceNumber,
      reason: "a line-item change on",
    });
  res.sendStatus(204);
});

export default router;
