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
const {
  db,
  packagesTable,
  workPlansTable,
  packageWeeksTable,
  timesheetEntriesTable,
  packageProgressReportsTable,
} = await import("@workspace/db");

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
      ...(() => {
        const { __invoiceNumber: _ignored, __noNarrative: _alsoIgnored, ...rest } = overrides;
        return rest;
      })(),
    })
    .returning();
  createdWorkPlanIds.push(wp.id);
  const [pkg] = await db
    .insert(packagesTable)
    .values({
      workPlanId: wp.id,
      payPeriodStart: "2026-08-01",
      payPeriodEnd: "2026-08-31",
      invoiceNumber:
        "__invoiceNumber" in overrides
          ? (overrides.__invoiceNumber as string | null)
          : "B.50-01-31",
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
  if (!("__noNarrative" in overrides)) {
    await db.insert(packageProgressReportsTable).values({
      packageId: pkg.id,
      workPerformed: "Performed routine reporting and participated in associated meetings.",
    });
  }
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

describe("GET /packages/:id/validations — invoice numbering", () => {
  it("tells the biller to seed the series on the first invoice of a work plan", async () => {
    const id = await seed({ __invoiceNumber: null });
    const res = await request(app).get(`/api/packages/${id}/validations`);
    const flag = res.body.flags.find((f: { field: string }) => f.field === "invoiceNumber");
    expect(flag).toBeTruthy();
    // "Invoice number is not set." on its own left Julie asking whether the
    // system was meant to derive it. Say which case this is and what happens next.
    expect(flag.message).toContain("first numbered invoice");
    expect(flag.message).toContain("B.50-01-30");
    expect(flag.message).toContain("increments the trailing number");
    expect(flag.severity).toBe("warning");
  });

  it("explains when the previous number had nothing to increment", async () => {
    const id = await seed({ __invoiceNumber: null });
    const [pkg] = await db
      .select()
      .from(packagesTable)
      .where(inArray(packagesTable.id, [id]));
    const [sibling] = await db
      .insert(packagesTable)
      .values({
        workPlanId: pkg.workPlanId,
        payPeriodStart: "2026-07-01",
        payPeriodEnd: "2026-07-31",
        invoiceNumber: "AZAD-FINAL",
      })
      .returning();
    createdPackageIds.push(sibling.id);
    const res = await request(app).get(`/api/packages/${id}/validations`);
    const flag = res.body.flags.find((f: { field: string }) => f.field === "invoiceNumber");
    expect(flag.message).toContain("AZAD-FINAL");
    expect(flag.message).toContain("no trailing number to increment");
  });
});

describe("GET /packages/:id/validations — billing rate drift", () => {
  it("flags a rate that jumps since the last invoice on the work plan", async () => {
    const id = await seed();
    const [pkg] = await db.select().from(packagesTable).where(inArray(packagesTable.id, [id]));
    // A prior invoice on the same work plan, billing the same person at the
    // rate Julie's reference workbook uses.
    const [prior] = await db
      .insert(packagesTable)
      .values({
        workPlanId: pkg.workPlanId,
        payPeriodStart: "2026-07-01",
        payPeriodEnd: "2026-07-31",
        invoiceNumber: "B.50-01-30",
      })
      .returning();
    createdPackageIds.push(prior.id);
    const [priorWeek] = await db
      .insert(packageWeeksTable)
      .values({
        packageId: prior.id,
        label: "Week 1",
        weekStart: "2026-07-06",
        weekEnd: "2026-07-12",
        sortOrder: 1,
      })
      .returning();
    await db.insert(timesheetEntriesTable).values({
      packageId: prior.id,
      weekId: priorWeek.id,
      employeeName: "Travis Johnson",
      classification: "Program Manager",
      category: "regular",
      location: "home",
      hoursMon: 8,
      hoursTue: 8,
      hoursWed: 8,
      hoursThu: 8,
      hoursFri: 8,
      rate: 40,
    });

    const res = await request(app).get(`/api/packages/${id}/validations`);
    const flag = res.body.flags.find(
      (f: { field: string; message: string }) =>
        f.field === "entries" && f.message.includes("changed sharply"),
    );
    expect(flag, "expected a rate-drift warning").toBeTruthy();
    expect(flag.message).toContain("Travis Johnson $40.00 → $92.50");
    expect(flag.message).toContain("Max Bill Rate");
    // A rate move is a question for the biller, not a blocked export.
    expect(flag.severity).toBe("warning");
    expect(res.body.isValid).toBe(true);
  });

  it("stays quiet when the rate holds steady", async () => {
    const id = await seed();
    const [pkg] = await db.select().from(packagesTable).where(inArray(packagesTable.id, [id]));
    const [prior] = await db
      .insert(packagesTable)
      .values({
        workPlanId: pkg.workPlanId,
        payPeriodStart: "2026-07-01",
        payPeriodEnd: "2026-07-31",
        invoiceNumber: "B.50-01-30",
      })
      .returning();
    createdPackageIds.push(prior.id);
    const [priorWeek] = await db
      .insert(packageWeeksTable)
      .values({
        packageId: prior.id,
        label: "Week 1",
        weekStart: "2026-07-06",
        weekEnd: "2026-07-12",
        sortOrder: 1,
      })
      .returning();
    await db.insert(timesheetEntriesTable).values({
      packageId: prior.id,
      weekId: priorWeek.id,
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
    const res = await request(app).get(`/api/packages/${id}/validations`);
    expect(
      res.body.flags.filter((f: { message: string }) => f.message.includes("changed sharply")),
    ).toEqual([]);
  });
});

describe("GET /packages/:id/validations — progress narrative", () => {
  it("warns that an empty Work Performed section prints as a blank box", async () => {
    const id = await seed({ __noNarrative: true });
    const res = await request(app).get(`/api/packages/${id}/validations`);
    const flag = res.body.flags.find((f: { field: string }) => f.field === "progress");
    expect(flag, "expected a progress-narrative warning").toBeTruthy();
    expect(flag.message).toContain("Work Performed");
    expect(flag.message).toContain("Progress tab");
    // A question for the biller, not a blocked export.
    expect(flag.severity).toBe("warning");
  });

  it("does not list Supplier ID as missing — her invoices print it as \"--\"", async () => {
    const id = await seed();
    const res = await request(app).get(`/api/packages/${id}/validations`);
    const flag = res.body.flags.find((f: { field: string }) => f.field === "workPlan");
    expect(flag.message).not.toContain("Supplier ID");
  });
});
