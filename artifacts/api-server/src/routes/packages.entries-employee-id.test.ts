import { afterAll, describe, expect, it, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";

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
const {
  db,
  packagesTable,
  packageWeeksTable,
  timesheetEntriesTable,
  employeesTable,
  workPlansTable,
} = await import("@workspace/db");
const { backfillTimesheetEmployeeIds } = await import("../lib/employeeResolve");

const createdPackageIds: number[] = [];
const createdWorkPlanIds: number[] = [];
const createdEmployeeIds: number[] = [];

afterAll(async () => {
  if (createdPackageIds.length > 0) {
    await db.delete(timesheetEntriesTable).where(inArray(timesheetEntriesTable.packageId, createdPackageIds));
    await db.delete(packageWeeksTable).where(inArray(packageWeeksTable.packageId, createdPackageIds));
    await db.delete(packagesTable).where(inArray(packagesTable.id, createdPackageIds));
  }
  if (createdWorkPlanIds.length > 0) {
    await db.delete(workPlansTable).where(inArray(workPlansTable.id, createdWorkPlanIds));
  }
  if (createdEmployeeIds.length > 0) {
    await db.delete(employeesTable).where(inArray(employeesTable.id, createdEmployeeIds));
  }
});

async function seedEmployee(name: string): Promise<number> {
  const [emp] = await db
    .insert(employeesTable)
    .values({ name, classification: "Engineer", homeRate: 100, fieldRate: 120 })
    .returning();
  createdEmployeeIds.push(emp.id);
  return emp.id;
}

async function seedPackageWithWeek(anchorEmployeeId: number): Promise<{ pkgId: number; weekId: number }> {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const [wp] = await db
    .insert(workPlansTable)
    .values({
      code: `TEST-WP-${suffix}`,
      title: "Entry Resolve Work Plan",
      client: "Test Client",
      jobNumber: "TEST-JOB",
      poNumber: "PO-123",
      totalBudget: 500000,
    })
    .returning();
  createdWorkPlanIds.push(wp.id);

  const [pkg] = await db
    .insert(packagesTable)
    .values({
      employeeId: anchorEmployeeId,
      workPlanId: wp.id,
      payPeriodStart: "2026-01-05",
      payPeriodEnd: "2026-01-18",
      invoiceNumber: `TEST-ENTRES-${suffix}`,
      invoiceDate: "2026-01-20",
      status: "draft",
    })
    .returning();
  createdPackageIds.push(pkg.id);

  const [week] = await db
    .insert(packageWeeksTable)
    .values({ packageId: pkg.id, label: "Week 1", weekStart: "2026-01-05", weekEnd: "2026-01-11", sortOrder: 0 })
    .returning();
  return { pkgId: pkg.id, weekId: week.id };
}

function entryBody(weekId: number, employeeName: string) {
  return {
    weekId,
    employeeName,
    classification: "Engineer",
    category: "regular",
    location: "home",
    hoursMon: 8,
    rate: 100,
  };
}

describe("timesheet entry employeeId resolution", () => {
  it("resolves and stores employeeId from a unique name when the client omits it", async () => {
    const suffix = Math.random().toString(36).slice(2, 8);
    const name = `Unique Resolve ${suffix}`;
    const empId = await seedEmployee(name);
    const { pkgId, weekId } = await seedPackageWithWeek(empId);

    const res = await request(app)
      .post(`/api/packages/${pkgId}/entries`)
      .send(entryBody(weekId, name))
      .expect(201);
    expect(res.body.employeeId).toBe(empId);
  });

  it("matches names case-insensitively and ignoring surrounding whitespace", async () => {
    const suffix = Math.random().toString(36).slice(2, 8);
    const name = `Case Resolve ${suffix}`;
    const empId = await seedEmployee(name);
    const { pkgId, weekId } = await seedPackageWithWeek(empId);

    const res = await request(app)
      .post(`/api/packages/${pkgId}/entries`)
      .send(entryBody(weekId, `  ${name.toUpperCase()} `))
      .expect(201);
    expect(res.body.employeeId).toBe(empId);
  });

  it("leaves employeeId null when two employees share the name (ambiguous)", async () => {
    const suffix = Math.random().toString(36).slice(2, 8);
    const name = `Ambiguous Resolve ${suffix}`;
    const empAId = await seedEmployee(name);
    await seedEmployee(name);
    const { pkgId, weekId } = await seedPackageWithWeek(empAId);

    const res = await request(app)
      .post(`/api/packages/${pkgId}/entries`)
      .send(entryBody(weekId, name))
      .expect(201);
    expect(res.body.employeeId).toBeNull();
  });

  it("keeps an explicitly supplied employeeId even when the name is shared", async () => {
    const suffix = Math.random().toString(36).slice(2, 8);
    const name = `Explicit Resolve ${suffix}`;
    const empAId = await seedEmployee(name);
    await seedEmployee(name);
    const { pkgId, weekId } = await seedPackageWithWeek(empAId);

    const res = await request(app)
      .post(`/api/packages/${pkgId}/entries`)
      .send({ ...entryBody(weekId, name), employeeId: empAId })
      .expect(201);
    expect(res.body.employeeId).toBe(empAId);
  });

  it("re-resolves employeeId when a rename changes who the entry belongs to", async () => {
    const suffix = Math.random().toString(36).slice(2, 8);
    const nameA = `Rename From ${suffix}`;
    const nameB = `Rename To ${suffix}`;
    const empAId = await seedEmployee(nameA);
    const empBId = await seedEmployee(nameB);
    const { pkgId, weekId } = await seedPackageWithWeek(empAId);

    const created = await request(app)
      .post(`/api/packages/${pkgId}/entries`)
      .send(entryBody(weekId, nameA))
      .expect(201);
    expect(created.body.employeeId).toBe(empAId);

    const updated = await request(app)
      .patch(`/api/packages/${pkgId}/entries/${created.body.id}`)
      .send({ employeeName: nameB })
      .expect(200);
    expect(updated.body.employeeId).toBe(empBId);
  });

  it("does not clear employeeId when a patch leaves the name unchanged", async () => {
    const suffix = Math.random().toString(36).slice(2, 8);
    const name = `Stable Patch ${suffix}`;
    const empId = await seedEmployee(name);
    const { pkgId, weekId } = await seedPackageWithWeek(empId);

    const created = await request(app)
      .post(`/api/packages/${pkgId}/entries`)
      .send(entryBody(weekId, name))
      .expect(201);

    const updated = await request(app)
      .patch(`/api/packages/${pkgId}/entries/${created.body.id}`)
      .send({ hoursTue: 4, employeeName: name })
      .expect(200);
    expect(updated.body.employeeId).toBe(empId);
  });

  it("backfills employeeId on legacy null rows but skips ambiguous names", async () => {
    const suffix = Math.random().toString(36).slice(2, 8);
    const uniqueName = `Backfill Unique ${suffix}`;
    const sharedName = `Backfill Shared ${suffix}`;
    const uniqueId = await seedEmployee(uniqueName);
    await seedEmployee(sharedName);
    await seedEmployee(sharedName);
    const { pkgId, weekId } = await seedPackageWithWeek(uniqueId);

    const [legacyUnique] = await db
      .insert(timesheetEntriesTable)
      .values({
        packageId: pkgId,
        weekId,
        employeeName: uniqueName,
        classification: "Engineer",
        category: "regular",
        location: "home",
        hoursMon: 8,
        rate: 100,
      })
      .returning();
    const [legacyShared] = await db
      .insert(timesheetEntriesTable)
      .values({
        packageId: pkgId,
        weekId,
        employeeName: sharedName,
        classification: "Engineer",
        category: "regular",
        location: "home",
        hoursMon: 8,
        rate: 100,
      })
      .returning();
    expect(legacyUnique.employeeId).toBeNull();
    expect(legacyShared.employeeId).toBeNull();

    const updated = await backfillTimesheetEmployeeIds();
    expect(updated).toBeGreaterThanOrEqual(1);

    const [afterUnique] = await db
      .select()
      .from(timesheetEntriesTable)
      .where(eq(timesheetEntriesTable.id, legacyUnique.id));
    const [afterShared] = await db
      .select()
      .from(timesheetEntriesTable)
      .where(eq(timesheetEntriesTable.id, legacyShared.id));
    expect(afterUnique.employeeId).toBe(uniqueId);
    expect(afterShared.employeeId).toBeNull();
  });
});
