import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, classificationsTable } from "@workspace/db";
import {
  CreateClassificationBody,
  UpdateClassificationBody,
  ListClassificationsResponse,
  CreateClassificationResponse,
  UpdateClassificationResponse,
} from "@workspace/api-zod";
import { recordAudit } from "../lib/audit";

const router: IRouter = Router();

function toApi(c: typeof classificationsTable.$inferSelect) {
  return {
    id: c.id,
    code: c.code,
    description: c.description,
    regularRate: c.regularRate,
    otRate: c.otRate,
    dtRate: c.dtRate,
    location: c.location,
    effectiveDate: c.effectiveDate,
  };
}

router.get("/classifications", async (_req, res): Promise<void> => {
  const rows = await db.select().from(classificationsTable).orderBy(classificationsTable.code);
  res.json(ListClassificationsResponse.parse(rows.map(toApi)));
});

router.post("/classifications", async (req, res): Promise<void> => {
  const parsed = CreateClassificationBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [row] = await db.insert(classificationsTable).values(parsed.data).returning();
  await recordAudit({ action: "created", entityType: "classification", entityId: row.id, description: row.code });
  res.status(201).json(CreateClassificationResponse.parse(toApi(row)));
});

router.patch("/classifications/:id", async (req, res): Promise<void> => {
  const id = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  const parsed = UpdateClassificationBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [row] = await db.update(classificationsTable).set(parsed.data).where(eq(classificationsTable.id, id)).returning();
  if (!row) {
    res.status(404).json({ error: "Classification not found" });
    return;
  }
  await recordAudit({ action: "updated", entityType: "classification", entityId: id, description: row.code });
  res.json(UpdateClassificationResponse.parse(toApi(row)));
});

router.delete("/classifications/:id", async (req, res): Promise<void> => {
  const id = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  const [row] = await db.delete(classificationsTable).where(eq(classificationsTable.id, id)).returning();
  if (!row) {
    res.status(404).json({ error: "Classification not found" });
    return;
  }
  await recordAudit({ action: "deleted", entityType: "classification", entityId: id, description: row.code });
  res.sendStatus(204);
});

export default router;
