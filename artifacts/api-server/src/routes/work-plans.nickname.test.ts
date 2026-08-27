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
const { db, workPlansTable, auditLogsTable } = await import("@workspace/db");

const createdWorkPlanIds: number[] = [];

afterAll(async () => {
  if (createdWorkPlanIds.length) {
    await db.delete(auditLogsTable).where(inArray(auditLogsTable.entityId, createdWorkPlanIds));
    await db.delete(workPlansTable).where(inArray(workPlansTable.id, createdWorkPlanIds));
  }
});

// Julie's demo feedback: the Procas library import makes the work-plan picker
// far too long to scan. A nickname gives each plan a short label, and archiving
// drops the ones she no longer bills out of the picker entirely.
describe("work plan nickname and archive round-trip", () => {
  it("persists nickname through create, get, list and patch", async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const created = await request(app)
      .post("/api/work-plans")
      .send({
        code: `TEST-NICK-${suffix}`,
        title: "A Very Long Work Plan Title Nobody Can Scan Quickly",
        nickname: "BART On-Call",
        client: "Test Client",
        jobNumber: `TEST-JOB-${suffix}`,
        totalBudget: 50000,
        billingCycle: "whole_month",
      });
    expect(created.status).toBe(201);
    createdWorkPlanIds.push(created.body.id);
    expect(created.body.nickname).toBe("BART On-Call");

    const got = await request(app).get(`/api/work-plans/${created.body.id}`);
    expect(got.status).toBe(200);
    expect(got.body.nickname).toBe("BART On-Call");

    const list = await request(app).get("/api/work-plans");
    const listed = (list.body.items ?? list.body).find(
      (w: { id: number }) => w.id === created.body.id,
    );
    expect(listed.nickname).toBe("BART On-Call");

    const patched = await request(app)
      .patch(`/api/work-plans/${created.body.id}`)
      .send({ nickname: "BART On-Call (2026)" });
    expect(patched.status).toBe(200);
    expect(patched.body.nickname).toBe("BART On-Call (2026)");
  });

  it("defaults nickname to null and round-trips the archived status", async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const created = await request(app)
      .post("/api/work-plans")
      .send({
        code: `TEST-ARCH-${suffix}`,
        title: "Archivable Plan",
        client: "Test Client",
        jobNumber: `TEST-JOB-${suffix}`,
        totalBudget: 1000,
        billingCycle: "whole_month",
      });
    expect(created.status).toBe(201);
    createdWorkPlanIds.push(created.body.id);
    expect(created.body.nickname).toBeNull();
    expect(created.body.status).toBe("active");

    const patched = await request(app)
      .patch(`/api/work-plans/${created.body.id}`)
      .send({ status: "archived" });
    expect(patched.status).toBe(200);
    expect(patched.body.status).toBe("archived");
  });

  // maxBillRate was accepted by PATCH but missing from the response mapper, so
  // a saved rate cap never rendered back into the edit form.
  it("returns maxBillRate so a saved rate cap renders back in the editor", async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const created = await request(app)
      .post("/api/work-plans")
      .send({
        code: `TEST-CAP-${suffix}`,
        title: "Rate Capped Plan",
        client: "Test Client",
        jobNumber: `TEST-JOB-${suffix}`,
        totalBudget: 1000,
        billingCycle: "whole_month",
        maxBillRate: 115,
      });
    expect(created.status).toBe(201);
    createdWorkPlanIds.push(created.body.id);
    expect(created.body.maxBillRate).toBe(115);

    const got = await request(app).get(`/api/work-plans/${created.body.id}`);
    expect(got.body.maxBillRate).toBe(115);

    const patched = await request(app)
      .patch(`/api/work-plans/${created.body.id}`)
      .send({ maxBillRate: 125 });
    expect(patched.body.maxBillRate).toBe(125);
  });
});
