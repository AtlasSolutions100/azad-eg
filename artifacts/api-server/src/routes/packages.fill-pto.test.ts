import { afterAll, describe, expect, it, vi } from "vitest";
import { inArray, eq, and } from "drizzle-orm";

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
const { db, packagesTable, packageWeeksTable, timesheetEntriesTable, workPlansTable, auditLogsTable } =
  await import("@workspace/db");

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

/** A package with one week (Mon 2026-06-01 … Sun 2026-06-07) and given entries. */
async function seedPackage(
  entries: Array<Partial<typeof timesheetEntriesTable.$inferInsert>>,
  period = { start: "2026-06-01", end: "2026-06-30" },
) {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const [wp] = await db
    .insert(workPlansTable)
    .values({
      code: `PTO-WP-${suffix}`,
      title: "PTO Fill Plan",
      client: "Client",
      jobNumber: `PTO-JOB-${suffix}`,
      totalBudget: 100000,
    })
    .returning();
  createdWorkPlanIds.push(wp.id);

  const [pkg] = await db
    .insert(packagesTable)
    .values({
      workPlanId: wp.id,
      payPeriodStart: period.start,
      payPeriodEnd: period.end,
      invoiceNumber: `PTO-INV-${suffix}`,
    })
    .returning();
  createdPackageIds.push(pkg.id);

  const [week] = await db
    .insert(packageWeeksTable)
    .values({
      packageId: pkg.id,
      label: "Week 1",
      weekStart: "2026-06-01",
      weekEnd: "2026-06-07",
      sortOrder: 1,
    })
    .returning();

  for (const e of entries) {
    await db.insert(timesheetEntriesTable).values({
      packageId: pkg.id,
      weekId: week.id,
      employeeName: "Travis Johnson",
      classification: "Project Manager",
      category: "regular",
      location: "field",
      rate: 92.5,
      ...e,
    });
  }
  return { pkg, week };
}

describe("POST /packages/:id/fill-pto", () => {
  it("tops short weekdays up to eight hours with one PTO row", async () => {
    // Julie's example: 6h/day for five days = 30h worked.
    const { pkg, week } = await seedPackage([
      { hoursMon: 6, hoursTue: 6, hoursWed: 6, hoursThu: 6, hoursFri: 6 },
    ]);

    const res = await request(app).post(`/api/packages/${pkg.id}/fill-pto`).send({});
    expect(res.status).toBe(200);
    expect(res.body.rowsCreated).toBe(1);
    expect(res.body.hoursAdded).toBe(10); // 30 worked + 10 PTO = 40

    const rows = await db
      .select()
      .from(timesheetEntriesTable)
      .where(eq(timesheetEntriesTable.weekId, week.id));
    const pto = rows.find((r) => r.category === "pto");
    expect(pto).toBeDefined();
    expect(pto?.source).toBe("auto_pto");
    expect(pto?.rate).toBe(0); // PTO bills at $0 — never changes the invoice
    expect(pto?.hoursMon).toBe(2);
    expect(pto?.hoursFri).toBe(2);
  });

  it("previews without writing anything", async () => {
    const { pkg, week } = await seedPackage([{ hoursMon: 4 }]);

    const res = await request(app)
      .post(`/api/packages/${pkg.id}/fill-pto`)
      .send({ preview: true });
    expect(res.status).toBe(200);
    expect(res.body.preview).toBe(true);
    expect(res.body.rowsCreated).toBe(1);
    expect(res.body.hoursAdded).toBe(4);

    const rows = await db
      .select()
      .from(timesheetEntriesTable)
      .where(eq(timesheetEntriesTable.weekId, week.id));
    expect(rows.some((r) => r.category === "pto")).toBe(false);
  });

  it("is idempotent — a second run updates the same row instead of stacking", async () => {
    const { pkg, week } = await seedPackage([{ hoursMon: 5, hoursTue: 5 }]);

    const first = await request(app).post(`/api/packages/${pkg.id}/fill-pto`).send({});
    expect(first.body.rowsCreated).toBe(1);

    const second = await request(app).post(`/api/packages/${pkg.id}/fill-pto`).send({});
    expect(second.body.rowsCreated).toBe(0);
    expect(second.body.rowsUpdated).toBe(1);
    expect(second.body.hoursAdded).toBe(first.body.hoursAdded);

    const rows = await db
      .select()
      .from(timesheetEntriesTable)
      .where(eq(timesheetEntriesTable.weekId, week.id));
    expect(rows.filter((r) => r.category === "pto")).toHaveLength(1);
  });

  // The auto-fill row must not count toward its own eight hours, or a later
  // correction to the real hours could never shrink it — an 8h day plus a
  // stale 3h fill would silently show as 11.
  it("clears a stale fill once the real hours cover the day", async () => {
    const { pkg, week } = await seedPackage([{ hoursMon: 5 }]);

    const first = await request(app).post(`/api/packages/${pkg.id}/fill-pto`).send({});
    expect(first.body.hoursAdded).toBe(3);

    // A Procas re-pull corrects Monday to a full day.
    await db
      .update(timesheetEntriesTable)
      .set({ hoursMon: 8 })
      .where(
        and(
          eq(timesheetEntriesTable.weekId, week.id),
          eq(timesheetEntriesTable.category, "regular"),
        ),
      );

    const second = await request(app).post(`/api/packages/${pkg.id}/fill-pto`).send({});
    expect(second.body.rowsRemoved).toBe(1);

    const rows = await db
      .select()
      .from(timesheetEntriesTable)
      .where(eq(timesheetEntriesTable.weekId, week.id));
    expect(rows.some((r) => r.source === "auto_pto")).toBe(false);
  });

  it("shrinks an existing fill when hours grow", async () => {
    const { pkg, week } = await seedPackage([{ hoursTue: 2 }]);

    const first = await request(app).post(`/api/packages/${pkg.id}/fill-pto`).send({});
    expect(first.body.hoursAdded).toBe(6);

    await db
      .update(timesheetEntriesTable)
      .set({ hoursTue: 6 })
      .where(
        and(
          eq(timesheetEntriesTable.weekId, week.id),
          eq(timesheetEntriesTable.category, "regular"),
        ),
      );

    const second = await request(app).post(`/api/packages/${pkg.id}/fill-pto`).send({});
    expect(second.body.rowsUpdated).toBe(1);
    expect(second.body.hoursAdded).toBe(2);

    const rows = await db
      .select()
      .from(timesheetEntriesTable)
      .where(eq(timesheetEntriesTable.weekId, week.id));
    expect(rows.find((r) => r.source === "auto_pto")?.hoursTue).toBe(2);
  });

  it("skips weekdays with nothing charged to this project unless asked", async () => {
    // Two full days here; the rest of the week was worked on another job.
    const { pkg } = await seedPackage([{ hoursMon: 8, hoursTue: 8 }]);

    const conservative = await request(app).post(`/api/packages/${pkg.id}/fill-pto`).send({});
    expect(conservative.body.rowsCreated).toBe(0);
    expect(conservative.body.warnings.join(" ")).toMatch(/no hours charged to this project/i);

    const eager = await request(app)
      .post(`/api/packages/${pkg.id}/fill-pto`)
      .send({ fillEmptyDays: true });
    expect(eager.body.hoursAdded).toBe(24); // Wed/Thu/Fri
  });

  it("counts an existing holiday row toward the eight hours", async () => {
    const { pkg } = await seedPackage([
      { category: "regular", hoursMon: 4 },
      { category: "holiday", hoursMon: 4 },
    ]);

    const res = await request(app).post(`/api/packages/${pkg.id}/fill-pto`).send({});
    expect(res.body.rowsCreated).toBe(0);
    expect(res.body.hoursAdded).toBe(0);
  });

  it("fills each employee's own short days", async () => {
    const { pkg } = await seedPackage([
      { employeeName: "Travis Johnson", hoursMon: 6 },
      { employeeName: "Dana Lee", hoursMon: 3 },
    ]);

    const res = await request(app).post(`/api/packages/${pkg.id}/fill-pto`).send({});
    expect(res.body.rowsCreated).toBe(2);
    expect(res.body.hoursAdded).toBe(7); // 2 for Travis + 5 for Dana
    const names = res.body.weeks.map((w: { employeeName: string }) => w.employeeName).sort();
    expect(names).toEqual(["Dana Lee", "Travis Johnson"]);
  });

  it("never fills days outside the pay period", async () => {
    // Period opens Thursday, so Mon-Wed belong to the previous invoice.
    const { pkg, week } = await seedPackage([{ hoursThu: 5, hoursFri: 5 }], {
      start: "2026-06-04",
      end: "2026-06-30",
    });

    const res = await request(app).post(`/api/packages/${pkg.id}/fill-pto`).send({});
    expect(res.body.hoursAdded).toBe(6);

    const rows = await db
      .select()
      .from(timesheetEntriesTable)
      .where(eq(timesheetEntriesTable.weekId, week.id));
    const pto = rows.find((r) => r.category === "pto");
    expect(pto?.hoursMon).toBe(0);
    expect(pto?.hoursThu).toBe(3);
    expect(pto?.hoursFri).toBe(3);
  });

  it("404s for a package that doesn't exist", async () => {
    const res = await request(app).post("/api/packages/99999999/fill-pto").send({});
    expect(res.status).toBe(404);
  });
});
