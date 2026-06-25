import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, referenceEntriesTable, columnDefinitionsTable } from "@workspace/db";
import {
  UpdateReferenceDataBody,
  ListReferenceDataResponse,
  ListColumnDefinitionsResponse,
  UpdateReferenceDataResponse,
} from "@workspace/api-zod";
import { recordAudit } from "../lib/audit";

const router: IRouter = Router();

function toApiRef(r: typeof referenceEntriesTable.$inferSelect) {
  return {
    id: r.id,
    category: r.category,
    key: r.key,
    label: r.label,
    value: r.value,
    unit: r.unit,
    description: r.description,
    updatedAt: r.updatedAt ? r.updatedAt.toISOString() : null,
  };
}

router.get("/reference-data", async (_req, res): Promise<void> => {
  const rows = await db.select().from(referenceEntriesTable).orderBy(referenceEntriesTable.category, referenceEntriesTable.label);
  res.json(ListReferenceDataResponse.parse(rows.map(toApiRef)));
});

router.patch("/reference-data/:id", async (req, res): Promise<void> => {
  const id = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  const parsed = UpdateReferenceDataBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [row] = await db.update(referenceEntriesTable).set({ value: parsed.data.value }).where(eq(referenceEntriesTable.id, id)).returning();
  if (!row) {
    res.status(404).json({ error: "Reference entry not found" });
    return;
  }
  await recordAudit({ action: "updated", entityType: "reference", entityId: id, description: `${row.label} = ${row.value}` });
  res.json(UpdateReferenceDataResponse.parse(toApiRef(row)));
});

router.get("/column-definitions", async (_req, res): Promise<void> => {
  const rows = await db.select().from(columnDefinitionsTable).orderBy(columnDefinitionsTable.sheet, columnDefinitionsTable.id);
  res.json(
    ListColumnDefinitionsResponse.parse(
      rows.map((d) => ({
        id: d.id,
        sheet: d.sheet,
        column: d.column,
        field: d.field,
        source: d.source,
        formula: d.formula,
        description: d.description,
      })),
    ),
  );
});

export default router;
