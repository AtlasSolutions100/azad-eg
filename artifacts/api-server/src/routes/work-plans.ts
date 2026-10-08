import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, workPlansTable } from "@workspace/db";
import {
  CreateWorkPlanBody,
  UpdateWorkPlanBody,
  ListWorkPlansResponse,
  GetWorkPlanResponse,
  CreateWorkPlanResponse,
  UpdateWorkPlanResponse,
} from "@workspace/api-zod";
import { SyncWorkPlansFromProcasResponse } from "@workspace/api-zod";
import { toApiWorkPlan } from "../lib/mappers";
import { recordAudit } from "../lib/audit";
import { getProcasConnection, credsFromConnection } from "../lib/procas";
import { importWorkPlansFromProcas } from "../lib/procasSync";
import { parseBudgetHistory, serializeBudgetHistory, withCurrentBudget } from "../lib/budgetHistory";

const router: IRouter = Router();

// Pulls the complete Procas project library into the work-plans list so the
// Workplans tab (and the create-package wizard) always offers every plan
// Procas knows about.
router.post("/work-plans/sync-procas", async (_req, res): Promise<void> => {
  const conn = await getProcasConnection();
  const creds = conn?.connected ? credsFromConnection(conn) : null;
  if (!creds) {
    res.status(409).json({ error: "Procas is not connected." });
    return;
  }
  try {
    const result = await importWorkPlansFromProcas(creds);
    await recordAudit({
      action: "imported work plans from Procas",
      entityType: "workPlan",
      description: `Procas library import: ${result.created} added, ${result.updated} refreshed (${result.total} projects in Procas)`,
    });
    res.json(SyncWorkPlansFromProcasResponse.parse(result));
  } catch (e) {
    res.status(502).json({ error: e instanceof Error ? e.message : "Failed to import work plans from Procas." });
  }
});

router.get("/work-plans", async (_req, res): Promise<void> => {
  const rows = await db.select().from(workPlansTable).orderBy(workPlansTable.code);
  res.json(ListWorkPlansResponse.parse(rows.map(toApiWorkPlan)));
});

router.post("/work-plans", async (req, res): Promise<void> => {
  const parsed = CreateWorkPlanBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [row] = await db.insert(workPlansTable).values(parsed.data).returning();
  await recordAudit({ action: "created", entityType: "workPlan", entityId: row.id, description: `Work plan ${row.code}` });
  res.status(201).json(CreateWorkPlanResponse.parse(toApiWorkPlan(row)));
});

router.get("/work-plans/:id", async (req, res): Promise<void> => {
  const id = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  const [row] = await db.select().from(workPlansTable).where(eq(workPlansTable.id, id));
  if (!row) {
    res.status(404).json({ error: "Work plan not found" });
    return;
  }
  res.json(GetWorkPlanResponse.parse(toApiWorkPlan(row)));
});

router.patch("/work-plans/:id", async (req, res): Promise<void> => {
  const id = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  const parsed = UpdateWorkPlanBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  // A biller editing a Procas-imported plan's display fields OR its billing
  // rates takes ownership: flip source to "manual" so future Procas syncs never
  // stomp the edit. This is how a static overhead/fee/FCCM override is entered —
  // set the rate here and it sticks. (See syncReferenceFromProcas, which skips
  // non-"procas" plans.)
  const editsProcasOwnedFields =
    parsed.data.title !== undefined ||
    parsed.data.client !== undefined ||
    parsed.data.status !== undefined ||
    parsed.data.fringeRate !== undefined ||
    parsed.data.overheadRate !== undefined ||
    parsed.data.fixedFeeRate !== undefined ||
    parsed.data.fccmRate !== undefined ||
    parsed.data.billingCycle !== undefined;
  // A budget edited here is the work plan's current one. When earlier budgets
  // are on record with their dates, the edit belongs to the latest of them and
  // the earlier ones stay as they were.
  const editsBudget =
    parsed.data.totalBudget !== undefined ||
    parsed.data.budgetLabor !== undefined ||
    parsed.data.budgetOverhead !== undefined ||
    parsed.data.budgetFixedFee !== undefined ||
    parsed.data.budgetFccm !== undefined;
  let budgetHistory: string | null | undefined;
  if (editsBudget) {
    const [before] = await db.select().from(workPlansTable).where(eq(workPlansTable.id, id));
    if (before && parseBudgetHistory(before.budgetHistory).length > 0) {
      budgetHistory = serializeBudgetHistory(withCurrentBudget(before, parsed.data));
    }
  }
  const changes = {
    ...parsed.data,
    ...(editsProcasOwnedFields ? { source: "manual" } : {}),
    ...(budgetHistory !== undefined ? { budgetHistory } : {}),
  };
  const [row] = await db
    .update(workPlansTable)
    .set(changes)
    .where(eq(workPlansTable.id, id))
    .returning();
  if (!row) {
    res.status(404).json({ error: "Work plan not found" });
    return;
  }
  await recordAudit({ action: "updated", entityType: "workPlan", entityId: id, description: `Work plan ${row.code}` });
  res.json(UpdateWorkPlanResponse.parse(toApiWorkPlan(row)));
});

router.delete("/work-plans/:id", async (req, res): Promise<void> => {
  const id = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  const [row] = await db.delete(workPlansTable).where(eq(workPlansTable.id, id)).returning();
  if (!row) {
    res.status(404).json({ error: "Work plan not found" });
    return;
  }
  await recordAudit({ action: "deleted", entityType: "workPlan", entityId: id, description: `Work plan ${row.code}` });
  res.sendStatus(204);
});

export default router;
