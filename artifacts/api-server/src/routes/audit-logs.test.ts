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

describe("GET /audit-logs/count", () => {
  it("returns the total matching count with and without entity filters", async () => {
    // Seed rows under a dedicated entity type so counts are exact even on a
    // shared dev DB: 3 for one invoice, 2 for another.
    const countEntityType = `count-${suffix}`;
    const values = [
      ...Array.from({ length: 3 }, (_, i) => ({
        userName: `Counter ${i}`,
        action: "update",
        entityType: countEntityType,
        entityId: targetInvoiceId,
        description: `count target entry ${i}`,
        createdAt: new Date(`2032-01-01T10:0${i}:00.000Z`),
      })),
      ...Array.from({ length: 2 }, (_, i) => ({
        userName: `Counter other ${i}`,
        action: "update",
        entityType: countEntityType,
        entityId: otherInvoiceId,
        description: `count other entry ${i}`,
        createdAt: new Date(`2032-01-01T11:0${i}:00.000Z`),
      })),
    ];
    const inserted = await db.insert(auditLogsTable).values(values).returning();
    for (const row of inserted) createdIds.push(row.id);

    // entityType filter alone: all 5 seeded rows.
    const byType = await request(app)
      .get("/api/audit-logs/count")
      .query({ entityType: countEntityType });
    expect(byType.status).toBe(200);
    expect(byType.body).toEqual({ count: 5 });

    // entityType + entityId: only the target invoice's 3 rows.
    const byTypeAndId = await request(app)
      .get("/api/audit-logs/count")
      .query({ entityType: countEntityType, entityId: targetInvoiceId });
    expect(byTypeAndId.status).toBe(200);
    expect(byTypeAndId.body).toEqual({ count: 3 });

    // A filter matching nothing returns zero.
    const none = await request(app)
      .get("/api/audit-logs/count")
      .query({ entityType: `${countEntityType}-missing` });
    expect(none.status).toBe(200);
    expect(none.body).toEqual({ count: 0 });

    // Unfiltered: total across all rows is at least our 5 seeded rows, and is
    // not capped by the 200-row page size semantics of the list endpoint.
    const unfiltered = await request(app).get("/api/audit-logs/count");
    expect(unfiltered.status).toBe(200);
    expect(typeof unfiltered.body.count).toBe("number");
    expect(unfiltered.body.count).toBeGreaterThanOrEqual(5);

    // The count matches what paging would eventually return for the filter:
    // a filtered list returns exactly `count` rows.
    const list = await request(app)
      .get("/api/audit-logs")
      .query({ entityType: countEntityType, limit: 200 });
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(byType.body.count);
  });
});

describe("GET /audit-logs server-side search/date/override filters", () => {
  const filterEntityType = `filter-${suffix}`;

  async function seedFilterRows() {
    const inserted = await db
      .insert(auditLogsTable)
      .values([
        {
          userName: "Hank Searcher",
          action: "create",
          entityType: filterEntityType,
          entityId: 42,
          description: "unique-needle-alpha entry",
          createdAt: new Date("2032-03-01T10:00:00.000Z"),
        },
        {
          userName: "Iris Other",
          action: "update",
          entityType: filterEntityType,
          entityId: 43,
          description: "plain entry",
          createdAt: new Date("2032-03-05T10:00:00.000Z"),
        },
        {
          userName: "Jack Override",
          action: "approved over budget",
          entityType: filterEntityType,
          entityId: 44,
          description: "override entry",
          createdAt: new Date("2032-03-10T10:00:00.000Z"),
        },
      ])
      .returning();
    for (const row of inserted) createdIds.push(row.id);
    return inserted;
  }

  it("matches search text against user, description, and entity regardless of paging", async () => {
    await seedFilterRows();

    const byDescription = await request(app)
      .get("/api/audit-logs")
      .query({ entityType: filterEntityType, search: "unique-needle-alpha" });
    expect(byDescription.status).toBe(200);
    expect(byDescription.body).toHaveLength(1);
    expect(byDescription.body[0].userName).toBe("Hank Searcher");

    const byUser = await request(app)
      .get("/api/audit-logs")
      .query({ entityType: filterEntityType, search: "iris" });
    expect(byUser.status).toBe(200);
    expect(byUser.body).toHaveLength(1);
    expect(byUser.body[0].userName).toBe("Iris Other");

    const byEntity = await request(app)
      .get("/api/audit-logs")
      .query({ search: `${filterEntityType} #44` });
    expect(byEntity.status).toBe(200);
    expect(byEntity.body).toHaveLength(1);
    expect(byEntity.body[0].entityId).toBe(44);
  });

  it("filters by date range with from/to", async () => {
    const res = await request(app).get("/api/audit-logs").query({
      entityType: filterEntityType,
      from: "2032-03-04T00:00:00.000Z",
      to: "2032-03-06T23:59:59.999Z",
    });
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].userName).toBe("Iris Other");
  });

  it("filters to budget overrides only", async () => {
    const res = await request(app)
      .get("/api/audit-logs")
      .query({ entityType: filterEntityType, overridesOnly: "true" });
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].action).toBe("approved over budget");
  });

  it("counts matching entries via /audit-logs/count", async () => {
    const all = await request(app)
      .get("/api/audit-logs/count")
      .query({ entityType: filterEntityType });
    expect(all.status).toBe(200);
    expect(all.body.count).toBe(3);

    const filtered = await request(app)
      .get("/api/audit-logs/count")
      .query({ entityType: filterEntityType, search: "unique-needle-alpha" });
    expect(filtered.status).toBe(200);
    expect(filtered.body.count).toBe(1);

    const overrides = await request(app)
      .get("/api/audit-logs/count")
      .query({ entityType: filterEntityType, overridesOnly: "true" });
    expect(overrides.status).toBe(200);
    expect(overrides.body.count).toBe(1);
  });
});
