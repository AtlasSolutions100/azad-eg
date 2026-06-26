import { Router, type IRouter } from "express";
import { and, desc, eq, type SQL } from "drizzle-orm";
import { db, auditLogsTable } from "@workspace/db";
import { ListAuditLogsResponse } from "@workspace/api-zod";

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

router.get("/audit-logs", async (req, res): Promise<void> => {
  const conditions: SQL[] = [];

  const entityType = req.query.entityType;
  if (typeof entityType === "string" && entityType.length > 0) {
    conditions.push(eq(auditLogsTable.entityType, entityType));
  }

  const entityId = Number(req.query.entityId);
  if (Number.isInteger(entityId)) {
    conditions.push(eq(auditLogsTable.entityId, entityId));
  }

  const rows = await db
    .select()
    .from(auditLogsTable)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(auditLogsTable.createdAt))
    .limit(200);
  res.json(ListAuditLogsResponse.parse(rows.map(toApiAudit)));
});

export default router;
