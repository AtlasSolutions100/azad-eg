import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";

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
const { db, packagesTable, workPlansTable } = await import("@workspace/db");

/**
 * The pencil beside a package's Budget. Julie: "we would just to add more
 * fields so the fields would be: Budget for labor, Budget for Overhead, Budget
 * for FCCM, Total budget. Is there way to also state on what date the budget
 * increased? For example, I edited the budget for this invoice for the October
 * invoice, and I see it changed the invoice amount for the September invoice."
 */

let workPlanId: number;
let september: number;
let october: number;
let unplanned: number;

beforeAll(async () => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const [wp] = await db
    .insert(workPlansTable)
    .values({
      code: `TEST-BUDGET-DATES-${suffix}`,
      title: "Budget dates",
      client: "Test Client",
      jobNumber: "TEST-JOB",
      totalBudget: 850000,
    })
    .returning();
  workPlanId = wp.id;
  const [sep] = await db
    .insert(packagesTable)
    .values({ workPlanId, payPeriodStart: "2026-08-29", payPeriodEnd: "2026-09-25", previouslyBilled: 600000 })
    .returning();
  const [oct] = await db
    .insert(packagesTable)
    .values({ workPlanId, payPeriodStart: "2026-09-26", payPeriodEnd: "2026-10-30", previouslyBilled: 625000 })
    .returning();
  const [none] = await db
    .insert(packagesTable)
    .values({ payPeriodStart: "2026-09-26", payPeriodEnd: "2026-10-30", procasProject: "TEST-NOPLAN" })
    .returning();
  september = sep.id;
  october = oct.id;
  unplanned = none.id;
});

afterAll(async () => {
  await db.delete(packagesTable).where(inArray(packagesTable.id, [september, october, unplanned]));
  await db.delete(workPlansTable).where(eq(workPlansTable.id, workPlanId));
});

const budgetOn = async (id: number): Promise<number> =>
  (await request(app).get(`/api/packages/${id}`)).body.rollup.budget;

describe("package budget", () => {
  it("shows the work plan's budget, with nothing dated yet", async () => {
    const res = await request(app).get(`/api/packages/${october}/budget`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      workPlanId,
      total: 850000,
      labor: null,
      effectiveFrom: null,
      periodStart: "2026-09-26",
      periodEnd: "2026-10-30",
      history: [],
    });
  });

  it("enters October's increase without restating September", async () => {
    const res = await request(app).put(`/api/packages/${october}/budget`).send({
      total: 900000,
      labor: 377000,
      overhead: 454500,
      fixedFee: 66500,
      fccm: 2000,
      effectiveFrom: "2026-09-26",
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ total: 900000, labor: 377000, fccm: 2000, effectiveFrom: "2026-09-26" });
    expect(res.body.history.map((v: { from: string | null; total: number }) => [v.from, v.total])).toEqual([
      [null, 850000],
      ["2026-09-26", 900000],
    ]);

    expect(await budgetOn(october)).toBe(900000);
    expect(await budgetOn(september)).toBe(850000);
    // September's own view of the budget is still the old one.
    const sep = await request(app).get(`/api/packages/${september}/budget`);
    expect(sep.body).toMatchObject({ total: 850000, labor: null, effectiveFrom: null });

    // The work plan itself carries the current budget.
    const [wp] = await db.select().from(workPlansTable).where(eq(workPlansTable.id, workPlanId));
    expect(wp.totalBudget).toBe(900000);
    expect(wp.budgetLabor).toBe(377000);
    expect(wp.budgetOverhead).toBe(454500);
  });

  it("corrects the earlier budget without touching the current one", async () => {
    const res = await request(app)
      .put(`/api/packages/${september}/budget`)
      .send({ total: 860000, labor: 360000, effectiveFrom: null });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ total: 860000, labor: 360000, effectiveFrom: null });
    expect(await budgetOn(september)).toBe(860000);
    expect(await budgetOn(october)).toBe(900000);
    const [wp] = await db.select().from(workPlansTable).where(eq(workPlansTable.id, workPlanId));
    expect(wp.totalBudget).toBe(900000);
  });

  it("puts a Work Plan screen edit on the current budget only", async () => {
    const res = await request(app).patch(`/api/work-plans/${workPlanId}`).send({ totalBudget: 925000 });
    expect(res.status).toBe(200);
    expect(await budgetOn(october)).toBe(925000);
    expect(await budgetOn(september)).toBe(860000);
  });

  it("rejects a date that is not a calendar day, and a negative budget", async () => {
    const bad = await request(app)
      .put(`/api/packages/${october}/budget`)
      .send({ total: 900000, effectiveFrom: "October" });
    expect(bad.status).toBe(400);
    const negative = await request(app).put(`/api/packages/${october}/budget`).send({ total: -1 });
    expect(negative.status).toBe(400);
    expect(await budgetOn(october)).toBe(925000);
  });

  it("removes a dated change, back to one budget for every invoice", async () => {
    const missing = await request(app).delete(`/api/packages/${october}/budget/2026-01-01`);
    expect(missing.status).toBe(404);
    const res = await request(app).delete(`/api/packages/${october}/budget/2026-09-26`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ total: 860000, labor: 360000, effectiveFrom: null, history: [] });
    expect(await budgetOn(october)).toBe(860000);
    expect(await budgetOn(september)).toBe(860000);
    const [wp] = await db.select().from(workPlansTable).where(eq(workPlansTable.id, workPlanId));
    expect(wp.totalBudget).toBe(860000);
    expect(wp.budgetHistory).toBeNull();
  });

  it("keeps the total on the package when there is no work plan to hold it", async () => {
    const res = await request(app)
      .put(`/api/packages/${unplanned}/budget`)
      .send({ total: 40000, labor: 1, effectiveFrom: "2026-09-26" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ workPlanId: null, total: 40000, labor: null, history: [] });
    expect(await budgetOn(unplanned)).toBe(40000);
  });

  it("404s for a package that does not exist", async () => {
    expect((await request(app).get("/api/packages/999999999/budget")).status).toBe(404);
    expect((await request(app).put("/api/packages/999999999/budget").send({ total: 1 })).status).toBe(404);
  });
});
