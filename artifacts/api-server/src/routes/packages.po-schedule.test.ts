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
const { db, packagesTable, workPlansTable, packageWeeksTable, timesheetEntriesTable } = await import(
  "@workspace/db"
);

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
async function seedPackage(
  procasProject: string,
  previouslyBilled: number,
  rates: { fringeRate?: number; overheadRate?: number; fixedFeeRate?: number; fccmRate?: number } = {},
): Promise<number> {
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
      ...rates,
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

const HER_BURDEN = { fringeRate: 0, overheadRate: 120.58, fixedFeeRate: 8, fccmRate: 0.39 };

describe("a package whose Prime was left blank", () => {
  it("still says which prime's form it is on", async () => {
    // The wizard's Prime is optional; the work plan decides the form.
    const id = await seedPackage("10014", 0);
    const res = await request(app).get(`/api/packages/${id}`);
    expect(res.status).toBe(200);
    expect(res.body.package.prime).toBe("T.Y. Lin");
  });
});

describe("WSP A.03.01 on screen", () => {
  it("shows each PO line the amount its own BART project's hours come to", async () => {
    const id = await seedPackage("10013.TO01", 775362.94, HER_BURDEN);
    const [week] = await db
      .insert(packageWeeksTable)
      .values({ packageId: id, label: "Week 1", weekStart: "2026-08-03", weekEnd: "2026-08-09", sortOrder: 0 })
      .returning();
    // Her June hours by project, from invoice A.03.01-23.
    await db.insert(timesheetEntriesTable).values(
      [
        ["15EJRRC", 48],
        ["15EJRRK", 52],
        ["49GH006", 68],
      ].map(([taskNo, hours]) => ({
        packageId: id,
        weekId: week.id,
        employeeName: "Rashad, De'Andre",
        classification: "Warehouse Specialist",
        category: "regular",
        location: "field",
        hoursMon: hours as number,
        rate: 74,
        source: "procas",
        taskNo: taskNo as string,
      })),
    );

    const res = await request(app).get(`/api/packages/${id}`);
    expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
    const lines = res.body.billedLineItems as Array<{ bartProjectNo: string; currentInvoiced: number }>;
    // The figures on her invoice's cover, not a 37.5 / 37.5 / 25 share of the total.
    expect(lines.map((l) => [l.bartProjectNo, l.currentInvoiced])).toEqual([
      ["15EJRRC", 8475.65],
      ["15EJRRK", 9181.96],
      ["49GH006", 12007.18],
    ]);
    expect(res.body.billingSummary.currentInvoicedTotal).toBe(29664.79);
    expect(res.body.package.totalThisPeriod).toBeCloseTo(29664.79, 1);

    const list = await request(app).get(`/api/packages/${id}/billed-line-items`);
    expect(list.body.items.map((l: { currentInvoiced: number }) => l.currentInvoiced)).toEqual([
      8475.65, 9181.96, 12007.18,
    ]);
  });
});

describe("a work plan that has drifted from the burden on her invoices", () => {
  const rateFlags = async (id: number) => {
    const res = await request(app).get(`/api/packages/${id}/validations`);
    expect(res.status).toBe(200);
    return (res.body.flags as Array<{ field?: string; severity: string; message: string }>).filter(
      (f) => f.field === "rates",
    );
  };

  it("is flagged: AECOM at Procas's 2024 rates bills about 5% short", async () => {
    const id = await seedPackage("10007", 1202002.26, {
      fringeRate: 0,
      overheadRate: 109,
      fixedFeeRate: 8,
      fccmRate: 0,
    });
    const flags = await rateFlags(id);
    expect(flags).toHaveLength(1);
    expect(flags[0].severity).toBe("warning");
    expect(flags[0].message).toContain("109.00% burden");
    expect(flags[0].message).toContain("120.58% burden");
    expect(flags[0].message).toContain("-5.4%");
  });

  it("is not flagged once the rates match", async () => {
    expect(await rateFlags(await seedPackage("10007", 1202002.26, HER_BURDEN))).toHaveLength(0);
    // The same burden filed under fringe instead of overhead is the same burden.
    expect(
      await rateFlags(
        await seedPackage("10013.TO02", 0, { fringeRate: 120.58, overheadRate: 0, fixedFeeRate: 8, fccmRate: 0.39 }),
      ),
    ).toHaveLength(0);
  });
});
