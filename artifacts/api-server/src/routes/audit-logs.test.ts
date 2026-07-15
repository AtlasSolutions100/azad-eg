import { afterAll, describe, expect, it, vi } from "vitest";
import { inArray } from "drizzle-orm";

const authState = vi.hoisted(() => ({ userId: "test-user" as string | null }));

vi.mock("@clerk/express", () => ({
  clerkMiddleware:
    () =>
    (_req: unknown, _res: unknown, next: () => void): void =>
      next(),
  getAuth: () => ({
    userId: authState.userId,
    sessionClaims: authState.userId ? { name: "Test User" } : undefined,
  }),
}));

const request = (await import("supertest")).default;
const app = (await import("../app")).default;
const { db, auditLogsTable } = await import("@workspace/db");

// Unique entity ids/types per run so these assertions never collide with the
// shared seeded dev DB or with other invoices' audit rows.
const suffix = Date.now();
const targetInvoiceId = 900000000 + (suffix % 1000000);
const otherInvoiceId = targetInvoiceId + 1;
const otherEntityType = `pkg-${suffix}`;

const createdIds: number[] = [];

afterAll(async () => {
  if (createdIds.length) {
    await db.delete(auditLogsTable).where(inArray(auditLogsTable.id, createdIds));
  }
});

describe("GET /audit-logs filtering", () => {
  it("returns only the requested invoice's entries in reverse-chronological order", async () => {
    // Two entries for the target invoice (distinct timestamps), plus decoy rows
    // for a different invoice and a different entity type that must NOT leak in.
    const inserted = await db
      .insert(auditLogsTable)
      .values([
        {
          userName: "Alice",
          action: "create",
          entityType: "invoice",
          entityId: targetInvoiceId,
          description: "older target entry",
          createdAt: new Date("2030-01-01T10:00:00.000Z"),
        },
        {
          userName: "Bob",
          action: "update",
          entityType: "invoice",
          entityId: targetInvoiceId,
          description: "newer target entry",
          createdAt: new Date("2030-01-01T11:00:00.000Z"),
        },
        {
          userName: "Carol",
          action: "update",
          entityType: "invoice",
          entityId: otherInvoiceId,
          description: "other invoice entry",
          createdAt: new Date("2030-01-01T12:00:00.000Z"),
        },
        {
          userName: "Dave",
          action: "create",
          entityType: otherEntityType,
          entityId: targetInvoiceId,
          description: "other entity-type entry",
          createdAt: new Date("2030-01-01T13:00:00.000Z"),
        },
      ])
      .returning();
    for (const row of inserted) createdIds.push(row.id);

    const res = await request(app)
      .get("/api/audit-logs")
      .query({ entityType: "invoice", entityId: targetInvoiceId });

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    // Every returned row belongs to the requested invoice only.
    for (const row of res.body) {
      expect(row.entityType).toBe("invoice");
      expect(row.entityId).toBe(targetInvoiceId);
    }
    // Reverse-chronological: newest first.
    expect(res.body[0].description).toBe("newer target entry");
    expect(res.body[1].description).toBe("older target entry");
    expect(new Date(res.body[0].createdAt).getTime()).toBeGreaterThan(
      new Date(res.body[1].createdAt).getTime(),
    );
  });

  it("returns the global list (capped at 200) spanning multiple entities when no filter is given", async () => {
    // Seed rows that span THREE distinct contexts (two different invoices and a
    // non-invoice entity type) with very recent timestamps so they land inside
    // the 200-row cap even on a busy shared dev DB.
    const base = Date.now();
    const inserted = await db
      .insert(auditLogsTable)
      .values([
        {
          userName: "Erin",
          action: "create",
          entityType: "invoice",
          entityId: targetInvoiceId,
          description: "global target invoice entry",
          createdAt: new Date(base + 1000),
        },
        {
          userName: "Frank",
          action: "update",
          entityType: "invoice",
          entityId: otherInvoiceId,
          description: "global other invoice entry",
          createdAt: new Date(base + 2000),
        },
        {
          userName: "Grace",
          action: "create",
          entityType: otherEntityType,
          entityId: targetInvoiceId,
          description: "global other entity-type entry",
          createdAt: new Date(base + 3000),
        },
      ])
      .returning();
    const seededIds = inserted.map((r) => r.id);
    for (const id of seededIds) createdIds.push(id);

    const res = await request(app).get("/api/audit-logs");

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeLessThanOrEqual(200);

    // The unfiltered list is NOT scoped to one invoice: all three decoy rows —
    // two different invoices plus a non-invoice entity type — must be present.
    const returnedById = new Map<number, { entityType: string; entityId: number | null }>(
      res.body.map((r: { id: number; entityType: string; entityId: number | null }) => [r.id, r]),
    );
    for (const id of seededIds) {
      expect(returnedById.has(id)).toBe(true);
    }
    const returnedTypes = new Set(seededIds.map((id) => returnedById.get(id)?.entityType));
    expect(returnedTypes).toContain("invoice");
    expect(returnedTypes).toContain(otherEntityType);
    const returnedInvoiceIds = new Set(
      seededIds
        .map((id) => returnedById.get(id))
        .filter((r) => r?.entityType === "invoice")
        .map((r) => r?.entityId),
    );
    expect(returnedInvoiceIds).toContain(targetInvoiceId);
    expect(returnedInvoiceIds).toContain(otherInvoiceId);

    // Globally ordered reverse-chronologically.
    for (let i = 1; i < res.body.length; i += 1) {
      expect(new Date(res.body[i - 1].createdAt).getTime()).toBeGreaterThanOrEqual(
        new Date(res.body[i].createdAt).getTime(),
      );
    }
  });

  it("pages through older entries with limit/offset", async () => {
    // Seed 5 entries for a dedicated entity type so paging assertions are
    // exact regardless of other rows in the shared dev DB.
    const pagingEntityType = `paging-${suffix}`;
    const total = 5;
    const values = Array.from({ length: total }, (_, i) => ({
      userName: `Pager ${i}`,
      action: "update",
      entityType: pagingEntityType,
      entityId: targetInvoiceId,
      description: `paging entry ${i}`,
      createdAt: new Date(`2031-01-01T10:0${i}:00.000Z`),
    }));
    const inserted = await db.insert(auditLogsTable).values(values).returning();
    for (const row of inserted) createdIds.push(row.id);

    const pageSize = 2;
    const seen: { id: number; description: string; createdAt: string }[] = [];
    for (let offset = 0; offset < total; offset += pageSize) {
      const res = await request(app)
        .get("/api/audit-logs")
        .query({ entityType: pagingEntityType, limit: pageSize, offset });
      expect(res.status).toBe(200);
      const expectedLen = Math.min(pageSize, total - offset);
      expect(res.body).toHaveLength(expectedLen);
      seen.push(...res.body);
    }

    // All 5 rows retrieved across 3 pages, no duplicates, newest first.
    expect(seen).toHaveLength(total);
    expect(new Set(seen.map((r) => r.id)).size).toBe(total);
    expect(seen.map((r) => r.description)).toEqual([
      "paging entry 4",
      "paging entry 3",
      "paging entry 2",
      "paging entry 1",
      "paging entry 0",
    ]);

    // Past the end returns an empty page.
    const past = await request(app)
      .get("/api/audit-logs")
      .query({ entityType: pagingEntityType, limit: pageSize, offset: total });
    expect(past.status).toBe(200);
    expect(past.body).toHaveLength(0);

    // Oversized limits are clamped to the 200-row cap rather than erroring.
    const clamped = await request(app)
      .get("/api/audit-logs")
      .query({ entityType: pagingEntityType, limit: 9999 });
    expect(clamped.status).toBe(200);
    expect(clamped.body).toHaveLength(total);
  });
});
