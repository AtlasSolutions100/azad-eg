import { Router, type IRouter } from "express";
import { desc } from "drizzle-orm";
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

router.get("/audit-logs", async (_req, res): Promise<void> => {
  const rows = await db.select().from(auditLogsTable).orderBy(desc(auditLogsTable.createdAt)).limit(200);
  res.json(ListAuditLogsResponse.parse(rows.map(toApiAudit)));
});

export default router;
