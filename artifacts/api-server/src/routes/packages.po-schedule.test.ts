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
const { db, packagesTable, workPlansTable } = await import("@workspace/db");

const createdPackageIds: number[] = [];
const createdWorkPlanIds: number[] = [];

afterAll(async () => {
  if (createdPackageIds.length > 0) {
    await db.delete(packagesTable).where(inArray(packagesTable.id, createdPackageIds));
  }
  if (createdWorkPlanIds.length > 0) {
    await db.delete(workPlansTable).where(inArray(workPlansTable.id, createdWorkPlanIds));
  }
});

/**
 * A package on a work plan whose PO schedule we hold, with no Billed Line
 * Items stored — the state every new AECOM package is in.
 */
async function seedPackage(procasProject: string, previouslyBilled: number): Promise<number> {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const [wp] = await db
    .insert(workPlansTable)
    .values({
      code: `TEST-PO-${suffix}`,
      title: "PO Schedule Work Plan",
      client: "Test Client",
      jobNumber: procasProject,
      procasProject,
      totalBudget: 1381971.85,
    })
    .returning();
  createdWorkPlanIds.push(wp.id);
  const [pkg] = await db
    .insert(packagesTable)
    .values({
      workPlanId: wp.id,
      payPeriodStart: "2026-08-01",
      payPeriodEnd: "2026-08-28",
      invoiceNumber: `TEST-PO-${suffix}`,
      invoiceDate: "2026-09-01",
      status: "draft",
      previouslyBilled,
    })
    .returning();
  createdPackageIds.push(pkg.id);
  return pkg.id;
}

/**
 * The Billed Line Items a package shows are computed from the PO schedule when
 * none are stored. Those rows are marked `source: "po_schedule"`, which the
 * response schema did not list — so the package page of every AECOM package
 * answered 500 ("no package found") while T.Y. Lin, which has no schedule,
 * opened fine. The export never noticed: it does not go through the schema.
 */
describe("a package whose line items come from the PO schedule", () => {
  it.each([
    ["10007", 10, 1230254.44],
    ["10013.TO01", 3, 805027.73],
  ])("opens: %s shows its %i PO lines", async (project, lines, previouslyBilled) => {
    const id = await seedPackage(project, previouslyBilled);

    const res = await request(app).get(`/api/packages/${id}`);
    expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
    expect(res.body.billedLineItems).toHaveLength(lines);
    expect(res.body.billedLineItems[0].source).toBe("po_schedule");
    expect(res.body.billingSummary.previousInvoicedTotal).toBe(previouslyBilled);

    const list = await request(app).get(`/api/packages/${id}/billed-line-items`);
    expect(list.status, JSON.stringify(list.body).slice(0, 300)).toBe(200);
    expect(list.body.items).toHaveLength(lines);

    // The other calls the package page makes when it opens.
    const checks = await request(app).get(`/api/packages/${id}/validations`);
    expect(checks.status, JSON.stringify(checks.body).slice(0, 300)).toBe(200);
    const all = await request(app).get("/api/packages");
    expect(all.status).toBe(200);
  });
});
