import { db, auditLogsTable } from "@workspace/db";
import { auditContext } from "./auditContext";

export async function recordAudit(entry: {
  userName?: string;
  userId?: string | null;
  action: string;
  entityType: string;
  entityId?: number | null;
  description?: string | null;
}): Promise<void> {
  // Fall back to the acting user from the request context when the caller
  // didn't pass an explicit identity (e.g. approvedBy on invoice approval).
  const identity = auditContext.getStore();
  await db.insert(auditLogsTable).values({
    userName: entry.userName ?? identity?.userName ?? "System",
    userId: entry.userId ?? identity?.userId ?? null,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId ?? null,
    description: entry.description ?? null,
  });
}
