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
const { db, packagesTable, employeesTable, workPlansTable } = await import("@workspace/db");

const createdPackageIds: number[] = [];
const createdWorkPlanIds: number[] = [];
const createdEmployeeIds: number[] = [];

afterAll(async () => {
  if (createdPackageIds.length > 0) {
    await db.delete(packagesTable).where(inArray(packagesTable.id, createdPackageIds));
  }
  if (createdWorkPlanIds.length > 0) {
    await db.delete(workPlansTable).where(inArray(workPlansTable.id, createdWorkPlanIds));
  }
  if (createdEmployeeIds.length > 0) {
    await db.delete(employeesTable).where(inArray(employeesTable.id, createdEmployeeIds));
  }
});

/**
 * Seeds a work plan with a fixed budget and a package whose previouslyBilled
 * drives Total To Date directly (no timesheet entries), so percentExpended is
 * exactly previouslyBilled / totalBudget * 100.
 */
async function seedPackage(totalBudget: number, previouslyBilled: number): Promise<number> {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const [emp] = await db
    .insert(employeesTable)
    .values({ name: `Budget Test ${suffix}`, classification: "Engineer", homeRate: 100, fieldRate: 120 })
    .returning();
  createdEmployeeIds.push(emp.id);

  const [wp] = await db
    .insert(workPlansTable)
    .values({
      code: `TEST-BUDGET-${suffix}`,
      title: "Budget Status Work Plan",
      client: "Test Client",
      jobNumber: "TEST-JOB",
      poNumber: "PO-123",
      totalBudget,
    })
    .returning();
  createdWorkPlanIds.push(wp.id);

  const [pkg] = await db
    .insert(packagesTable)
    .values({
      employeeId: emp.id,
      workPlanId: wp.id,
      payPeriodStart: "2026-01-05",
      payPeriodEnd: "2026-01-18",
      invoiceNumber: `TEST-BUDGET-${suffix}`,
      invoiceDate: "2026-01-20",
      status: "draft",
      previouslyBilled,
    })
    .returning();
  createdPackageIds.push(pkg.id);
  return pkg.id;
}

describe("package budgetStatus at the shared thresholds", () => {
  it("returns level 'ok' well under the approaching threshold", async () => {
    const pkgId = await seedPackage(100000, 50000);
    const res = await request(app).get(`/api/packages/${pkgId}/rollup`).expect(200);
    expect(res.body.budgetStatus.level).toBe("ok");
    expect(res.body.budgetStatus.overBudget).toBe(false);
    expect(res.body.budgetStatus.percentExpended).toBe(50);
  });

  it("returns level 'ok' at exactly 90% (threshold is exclusive)", async () => {
    const pkgId = await seedPackage(100000, 90000);
    const res = await request(app).get(`/api/packages/${pkgId}/rollup`).expect(200);
    expect(res.body.budgetStatus.level).toBe("ok");
  });

  it("returns level 'approaching' just above 90%", async () => {
    const pkgId = await seedPackage(100000, 95000);
    const res = await request(app).get(`/api/packages/${pkgId}/rollup`).expect(200);
    expect(res.body.budgetStatus.level).toBe("approaching");
    expect(res.body.budgetStatus.overBudget).toBe(false);
    expect(res.body.budgetStatus.remainingBalance).toBe(5000);
  });

  it("returns level 'approaching' at exactly 100% (over is exclusive)", async () => {
    const pkgId = await seedPackage(100000, 100000);
    const res = await request(app).get(`/api/packages/${pkgId}/rollup`).expect(200);
    expect(res.body.budgetStatus.level).toBe("approaching");
    expect(res.body.budgetStatus.overBudget).toBe(false);
  });

  it("returns level 'over' above 100% with a negative remaining balance", async () => {
    const pkgId = await seedPackage(100000, 120000);
    const res = await request(app).get(`/api/packages/${pkgId}/rollup`).expect(200);
    expect(res.body.budgetStatus.level).toBe("over");
    expect(res.body.budgetStatus.overBudget).toBe(true);
    expect(res.body.budgetStatus.percentExpended).toBe(120);
    expect(res.body.budgetStatus.remainingBalance).toBe(-20000);
  });

  it("includes the same budgetStatus in the package detail rollup", async () => {
    const pkgId = await seedPackage(100000, 120000);
    const res = await request(app).get(`/api/packages/${pkgId}`).expect(200);
    expect(res.body.rollup.budgetStatus.level).toBe("over");
    expect(res.body.rollup.budgetStatus.overBudget).toBe(true);

    const approachingId = await seedPackage(100000, 95000);
    const detail = await request(app).get(`/api/packages/${approachingId}`).expect(200);
    expect(detail.body.rollup.budgetStatus.level).toBe("approaching");
  });
});
