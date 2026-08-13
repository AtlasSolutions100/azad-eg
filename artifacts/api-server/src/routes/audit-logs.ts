import { Router, type IRouter } from "express";
import { and, desc, eq, gte, ilike, lte, or, sql, count, type SQL } from "drizzle-orm";
import { db, auditLogsTable } from "@workspace/db";
import { ListAuditLogsResponse, CountAuditLogsResponse } from "@workspace/api-zod";

const router: IRouter = Router();

const OVERRIDE_ACTION = "approved over budget";

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

function buildConditions(query: Record<string, unknown>): SQL[] {
  const conditions: SQL[] = [];

  const entityType = query.entityType;
  if (typeof entityType === "string" && entityType.length > 0) {
    conditions.push(eq(auditLogsTable.entityType, entityType));
  }

  const entityId = Number(query.entityId);
  if (Number.isInteger(entityId)) {
    conditions.push(eq(auditLogsTable.entityId, entityId));
  }

  const search = query.search;
  if (typeof search === "string" && search.trim().length > 0) {
    const pattern = `%${search.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const searchCondition = or(
      ilike(auditLogsTable.userName, pattern),
      ilike(auditLogsTable.action, pattern),
      ilike(auditLogsTable.description, pattern),
      ilike(
        sql`(${auditLogsTable.entityType} || coalesce(' #' || ${auditLogsTable.entityId}::text, ''))`,
        pattern,
      ),
    );
    if (searchCondition) conditions.push(searchCondition);
  }

  const from = query.from;
  if (typeof from === "string" && from.length > 0) {
    const fromDate = new Date(from);
    if (!Number.isNaN(fromDate.getTime())) {
      conditions.push(gte(auditLogsTable.createdAt, fromDate));
    }
  }

  const to = query.to;
  if (typeof to === "string" && to.length > 0) {
    const toDate = new Date(to);
    if (!Number.isNaN(toDate.getTime())) {
      conditions.push(lte(auditLogsTable.createdAt, toDate));
    }
  }

  if (query.overridesOnly === "true") {
    conditions.push(eq(auditLogsTable.action, OVERRIDE_ACTION));
  }

  return conditions;
}

router.get("/audit-logs", async (req, res): Promise<void> => {
  const conditions = buildConditions(req.query as Record<string, unknown>);

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
  const conditions = buildConditions(req.query as Record<string, unknown>);

  const [row] = await db
    .select({ count: count() })
    .from(auditLogsTable)
    .where(conditions.length > 0 ? and(...conditions) : undefined);
  res.json(CountAuditLogsResponse.parse({ count: row?.count ?? 0 }));
});

// ---------------------------------------------------------------------------
// CSV export — all rows matching the current filters, no pagination cap
// ---------------------------------------------------------------------------

function escapeCsvField(v: unknown): string {
  const s = v == null ? "" : String(v);
  if (s.includes(",") || s.includes('"') || s.includes("\n") || s.includes("\r")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

router.get("/audit-logs/export", async (req, res): Promise<void> => {
  const conditions = buildConditions(req.query as Record<string, unknown>);

  const rows = await db
    .select()
    .from(auditLogsTable)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(auditLogsTable.createdAt), desc(auditLogsTable.id));

  const header = ["Timestamp", "User", "Action", "Entity Type", "Entity ID", "Description"];
  const lines = [
    header.map(escapeCsvField).join(","),
    ...rows.map((r) =>
      [
        r.createdAt.toISOString(),
        r.userName,
        r.action,
        r.entityType,
        r.entityId ?? "",
        r.description ?? "",
      ]
        .map(escapeCsvField)
        .join(","),
    ),
  ];
  const csv = lines.join("\r\n");

  const date = new Date().toISOString().slice(0, 10);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="audit-log-${date}.csv"`);
  res.send(csv);
});

export default router;
