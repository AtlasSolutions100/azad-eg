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
  // A biller editing a Procas-imported plan's display fields takes ownership:
  // flip source to "manual" so future library imports never stomp the edit.
  const editsProcasOwnedFields =
    parsed.data.title !== undefined ||
    parsed.data.client !== undefined ||
    parsed.data.status !== undefined;
  const [row] = await db
    .update(workPlansTable)
    .set(editsProcasOwnedFields ? { ...parsed.data, source: "manual" } : parsed.data)
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
