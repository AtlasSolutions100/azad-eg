import { afterAll, describe, expect, it, vi } from "vitest";
import { inArray } from "drizzle-orm";

// Mutable auth state shared with the mocked Clerk module (see rules.test.ts).
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
const { db, packagesTable, workPlansTable, auditLogsTable } = await import("@workspace/db");

const createdPackageIds: number[] = [];
const createdWorkPlanIds: number[] = [];

afterAll(async () => {
  if (createdPackageIds.length) {
    await db.delete(auditLogsTable).where(inArray(auditLogsTable.entityId, createdPackageIds));
    await db.delete(packagesTable).where(inArray(packagesTable.id, createdPackageIds));
  }
  if (createdWorkPlanIds.length) {
    await db.delete(workPlansTable).where(inArray(workPlansTable.id, createdWorkPlanIds));
  }
});

describe("one package per job (work plan) per pay period", () => {
  it("rejects a duplicate package for the same work plan and pay period with 409", async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const [wp] = await db
      .insert(workPlansTable)
      .values({
        code: `TEST-WP-${suffix}`,
        title: "Unique Test Work Plan",
        client: "Test Client",
        jobNumber: "TEST-JOB-UNIQ",
        poNumber: "PO-456",
        totalBudget: 100000,
      })
      .returning();
    createdWorkPlanIds.push(wp.id);

    const body = {
      workPlanId: wp.id,
      payPeriodStart: "2026-02-02",
      payPeriodEnd: "2026-02-15",
    };

    const first = await request(app).post("/api/packages").send(body);
    expect(first.status).toBe(201);
    createdPackageIds.push(first.body.id);
    // No primary employee was supplied — job-level package.
    expect(first.body.employeeId).toBeNull();

    const second = await request(app).post("/api/packages").send(body);
    expect(second.status).toBe(409);
    expect(second.body.error).toMatch(/already exists/i);
    if (second.body.id) createdPackageIds.push(second.body.id);
  });
});

describe("billingMonth derives the service period", () => {
  it("derives last_friday dates from billingMonth (matches Julie's WSP cycle)", async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const [wp] = await db
      .insert(workPlansTable)
      .values({
        code: `TEST-LF-${suffix}`,
        title: "Last-Friday WP",
        client: "BART",
        jobNumber: `TEST-LF-${suffix}`,
        totalBudget: 100000,
        billingCycle: "last_friday",
      })
      .returning();
    createdWorkPlanIds.push(wp.id);

    const res = await request(app)
      .post("/api/packages")
      .send({ workPlanId: wp.id, billingMonth: "2026-05" });
    expect(res.status).toBe(201);
    createdPackageIds.push(res.body.id);
    // April's last Friday is the 24th → start 25th; May's last Friday is the 29th.
    expect(res.body.payPeriodStart).toBe("2026-04-25");
    expect(res.body.payPeriodEnd).toBe("2026-05-29");
  });

  it("derives whole_month dates from billingMonth", async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const [wp] = await db
      .insert(workPlansTable)
      .values({
        code: `TEST-WM-${suffix}`,
        title: "Whole-Month WP",
        client: "BART",
        jobNumber: `TEST-WM-${suffix}`,
        totalBudget: 100000,
        billingCycle: "whole_month",
      })
      .returning();
    createdWorkPlanIds.push(wp.id);

    const res = await request(app)
      .post("/api/packages")
      .send({ workPlanId: wp.id, billingMonth: "2026-05" });
    expect(res.status).toBe(201);
    createdPackageIds.push(res.body.id);
    expect(res.body.payPeriodStart).toBe("2026-05-01");
    expect(res.body.payPeriodEnd).toBe("2026-05-31");
  });

  it("400s when neither explicit dates nor billingMonth are provided", async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const [wp] = await db
      .insert(workPlansTable)
      .values({
        code: `TEST-NP-${suffix}`,
        title: "No-Period WP",
        client: "BART",
        jobNumber: `TEST-NP-${suffix}`,
        totalBudget: 100000,
      })
      .returning();
    createdWorkPlanIds.push(wp.id);

    const res = await request(app).post("/api/packages").send({ workPlanId: wp.id });
    expect(res.status).toBe(400);
    if (res.body.id) createdPackageIds.push(res.body.id);
  });
});
