import { Router, type IRouter } from "express";
import { and, count, desc, eq, type SQL } from "drizzle-orm";
import { db, auditLogsTable } from "@workspace/db";
import { CountAuditLogsResponse, ListAuditLogsResponse } from "@workspace/api-zod";

const router: IRouter = Router();

export function toApiAudit(a: typeof auditLogsTable.$inferSelect) {
  return {
    id: a.id,
    userId: a.userId,
    userName: a.userName,
    action: a.action,
    entityType: a.entityType,
    entityId: a.entityId,
    description: a.description,
    createdAt: a.createdAt.toISOString(),
  };
}

function buildFilterConditions(query: Record<string, unknown>): SQL[] {
  const conditions: SQL[] = [];

  const entityType = query.entityType;
  if (typeof entityType === "string" && entityType.length > 0) {
    conditions.push(eq(auditLogsTable.entityType, entityType));
  }

  const entityId = Number(query.entityId);
  if (Number.isInteger(entityId)) {
    conditions.push(eq(auditLogsTable.entityId, entityId));
  }

  return conditions;
}

router.get("/audit-logs", async (req, res): Promise<void> => {
  const conditions = buildFilterConditions(req.query);

  const rawLimit = Number(req.query.limit);
  const limit =
    Number.isInteger(rawLimit) && rawLimit >= 1 ? Math.min(rawLimit, 200) : 200;
  const rawOffset = Number(req.query.offset);
  const offset = Number.isInteger(rawOffset) && rawOffset > 0 ? rawOffset : 0;

  const rows = await db
    .select()
    .from(auditLogsTable)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(auditLogsTable.createdAt), desc(auditLogsTable.id))
    .limit(limit)
    .offset(offset);
  res.json(ListAuditLogsResponse.parse(rows.map(toApiAudit)));
});

router.get("/audit-logs/count", async (req, res): Promise<void> => {
  const conditions = buildFilterConditions(req.query);

  const [row] = await db
    .select({ count: count() })
    .from(auditLogsTable)
    .where(conditions.length > 0 ? and(...conditions) : undefined);

  res.json(CountAuditLogsResponse.parse({ count: row?.count ?? 0 }));
});

export default router;
