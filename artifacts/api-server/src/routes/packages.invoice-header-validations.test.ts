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
const { db, packagesTable, workPlansTable, packageWeeksTable, timesheetEntriesTable } =
  await import("@workspace/db");

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
 * A work plan the way Procas imports one: a code, a title, rates — and none of
 * the invoice header fields, which only exist on the client's paperwork.
 */
async function seed(overrides: Record<string, unknown> = {}): Promise<number> {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const [wp] = await db
    .insert(workPlansTable)
    .values({
      code: `HDR-${suffix}`,
      title: "Header Validation Work Plan",
      client: "AECOM",
      jobNumber: "10007",
      totalBudget: 1_000_000,
      fixedFeeRate: 8,
      ...overrides,
    })
    .returning();
  createdWorkPlanIds.push(wp.id);
  const [pkg] = await db
    .insert(packagesTable)
    .values({
      workPlanId: wp.id,
      payPeriodStart: "2026-08-01",
      payPeriodEnd: "2026-08-31",
      invoiceNumber: "B.50-01-31",
      invoiceDate: "2026-09-01",
    })
    .returning();
  createdPackageIds.push(pkg.id);
  // A week of real hours, so the only flags left are the header ones under test.
  const [week] = await db
    .insert(packageWeeksTable)
    .values({
      packageId: pkg.id,
      label: "Week 1",
      weekStart: "2026-08-03",
      weekEnd: "2026-08-09",
      sortOrder: 1,
    })
    .returning();
  await db.insert(timesheetEntriesTable).values({
    packageId: pkg.id,
    weekId: week.id,
    employeeName: "Travis Johnson",
    classification: "Program Manager",
    category: "regular",
    location: "home",
    hoursMon: 8,
    hoursTue: 8,
    hoursWed: 8,
    hoursThu: 8,
    hoursFri: 8,
    rate: 92.5,
  });
  return pkg.id;
}

describe("GET /packages/:id/validations — invoice header readiness", () => {
  it("names every header field that will print blank, and where to fix it", async () => {
    const id = await seed();
    const res = await request(app).get(`/api/packages/${id}/validations`);
    expect(res.status).toBe(200);
    const flag = res.body.flags.find(
      (f: { field: string; message: string }) => f.field === "workPlan",
    );
    expect(flag, "expected a work-plan header warning").toBeTruthy();
    for (const label of [
      "Purchase Order No.",
      "Supplier ID",
      "AECOM Project No.",
      "Send To company",
      "Client Contact Person",
      "Agreement No.",
      "BART Project Number(s)",
    ]) {
      expect(flag.message, `missing "${label}"`).toContain(label);
    }
    // It must say where to go and why it matters, not just what is wrong.
    expect(flag.message).toContain("Work Plan screen");
    expect(flag.message).toContain("rejected by AP");
    // Header gaps do not block the export — Julie decides.
    expect(flag.severity).toBe("warning");
    expect(res.body.isValid).toBe(true);
  });

  it("stays quiet once the header is filled in", async () => {
    const id = await seed({
      poNumber: "1638681",
      supplierId: "SUP-1",
      clientProjectNo: "15TC002",
      sendToCompany: "AECOM",
      sendToAddress1: "300 Lakeside Dr",
      contactPerson: "Chris Berilla",
      agreementNo: "6M8142",
      bartProjectNumbers: "15TC002",
      terms: "Net 30 Days",
    });
    const res = await request(app).get(`/api/packages/${id}/validations`);
    expect(res.body.flags).toEqual([]);
  });

  it("warns that an unset budget empties the Billing Summary", async () => {
    const id = await seed({ totalBudget: 0 });
    const res = await request(app).get(`/api/packages/${id}/validations`);
    const flag = res.body.flags.find((f: { field: string }) => f.field === "totalBudget");
    expect(flag).toBeTruthy();
    expect(flag.message).toContain("Billing Summary");
    expect(flag.severity).toBe("warning");
  });

  it("notes that unset Terms falls back to the template's default", async () => {
    const id = await seed();
    const res = await request(app).get(`/api/packages/${id}/validations`);
    const flag = res.body.flags.find((f: { field: string }) => f.field === "terms");
    // Terms is the one header field that is NOT blank when unset, so it is an
    // informational note rather than a "will print blank" warning.
    expect(flag.severity).toBe("info");
    expect(flag.message).toContain("Net 30 Days");
  });
});
