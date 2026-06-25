import { db, auditLogsTable } from "@workspace/db";

export async function recordAudit(entry: {
  userName?: string;
  userId?: string | null;
  action: string;
  entityType: string;
  entityId?: number | null;
  description?: string | null;
}): Promise<void> {
  await db.insert(auditLogsTable).values({
    userName: entry.userName ?? "System",
    userId: entry.userId ?? null,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId ?? null,
    description: entry.description ?? null,
  });
}
