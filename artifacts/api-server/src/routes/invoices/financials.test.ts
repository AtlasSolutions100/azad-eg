import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
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
const app = (await import("../../app")).default;
const { db, invoicesTable, workPlansTable, lineItemsTable, auditLogsTable } = await import("@workspace/db");

const createdInvoiceIds: number[] = [];
const createdWorkPlanIds: number[] = [];

async function createWorkPlan(
  overrides: Partial<typeof workPlansTable.$inferInsert> = {},
): Promise<number> {
  const [wp] = await db
    .insert(workPlansTable)
    .values({
      code: `TEST-WP-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      title: "Test Work Plan",
      client: "Test Client",
      jobNumber: "TEST-JOB",
      totalBudget: 100000,
      fringeRate: 100,
      overheadRate: 50,
      fixedFeeRate: 10,
      fccmRate: 5,
      ...overrides,
    })
    .returning();
  createdWorkPlanIds.push(wp.id);
  return wp.id;
}

async function createInvoice(
  workPlanId: number,
  status: string,
  overrides: Partial<typeof invoicesTable.$inferInsert> = {},
): Promise<number> {
  const [inv] = await db
    .insert(invoicesTable)
    .values({
      workPlanId,
      invoiceNumber: `TEST-INV-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      invoiceDate: "2026-01-15",
      periodStart: "2026-01-01",
      periodEnd: "2026-01-31",
      status,
      ...overrides,
    })
    .returning();
  createdInvoiceIds.push(inv.id);
  return inv.id;
}

async function addLineItem(
  invoiceId: number,
  overrides: Partial<typeof lineItemsTable.$inferInsert> = {},
): Promise<void> {
  const hours = overrides.hours ?? 10;
  const rate = overrides.rate ?? 100;
  await db.insert(lineItemsTable).values({
    invoiceId,
    employeeName: "Test Employee",
    classification: "Engineer",
    hours,
    rate,
    amount: hours * rate,
    ...overrides,
  });
}

beforeAll(() => {
  authState.userId = "test-user";
});

afterEach(() => {
  authState.userId = "test-user";
});

afterAll(async () => {
  if (createdInvoiceIds.length > 0) {
    await db.delete(lineItemsTable).where(inArray(lineItemsTable.invoiceId, createdInvoiceIds));
    await db.delete(auditLogsTable).where(inArray(auditLogsTable.entityId, createdInvoiceIds));
    await db.delete(invoicesTable).where(inArray(invoicesTable.id, createdInvoiceIds));
  }
  if (createdWorkPlanIds.length > 0) {
    await db.delete(workPlansTable).where(inArray(workPlansTable.id, createdWorkPlanIds));
  }
});

describe("POST /api/invoices carry-over billing", () => {
  it("derives previouslyBilled from the latest approved invoice's total-to-date", async () => {
    const wpId = await createWorkPlan({ overheadRate: null, fccmRate: null });
    const priorId = await createInvoice(wpId, "approved");
    await addLineItem(priorId, { hours: 10, rate: 100 });

    // Prior invoice's total-to-date: labor 1000 + fringe 1000 + fixed fee 200 = 2200.
    const prior = await request(app).get(`/api/invoices/${priorId}`);
    expect(prior.body.totalToDate).toBe(2200);

    const res = await request(app)
      .post("/api/invoices")
      .send({
        workPlanId: wpId,
        invoiceNumber: `TEST-INV-CARRY-${Date.now()}`,
        invoiceDate: "2026-02-15",
        periodStart: "2026-02-01",
        periodEnd: "2026-02-28",
      });

    expect(res.status).toBe(201);
    createdInvoiceIds.push(res.body.id);
    expect(res.body.previouslyBilled).toBe(2200);
  });

  it("picks the most recent billed period when several priors exist", async () => {
    const wpId = await createWorkPlan({ overheadRate: null, fccmRate: null });

    const janId = await createInvoice(wpId, "approved", {
      periodStart: "2026-01-01",
      periodEnd: "2026-01-31",
    });
    await addLineItem(janId, { hours: 10, rate: 100 }); // total-to-date 2200

    const febId = await createInvoice(wpId, "exported", {
      periodStart: "2026-02-01",
      periodEnd: "2026-02-28",
      previouslyBilled: 2200,
    });
    await addLineItem(febId, { hours: 20, rate: 100 }); // this period 4400, total-to-date 6600

    const res = await request(app)
      .post("/api/invoices")
      .send({
        workPlanId: wpId,
        invoiceNumber: `TEST-INV-MAR-${Date.now()}`,
        invoiceDate: "2026-03-15",
        periodStart: "2026-03-01",
        periodEnd: "2026-03-31",
      });

    expect(res.status).toBe(201);
    createdInvoiceIds.push(res.body.id);
    // The exported February invoice is the latest billed period: 4400 + 2200 = 6600.
    expect(res.body.previouslyBilled).toBe(6600);
  });

  it("ignores draft and in_review invoices when carrying over", async () => {
    const wpId = await createWorkPlan({ overheadRate: null, fccmRate: null });
    const draftId = await createInvoice(wpId, "draft");
    await addLineItem(draftId, { hours: 50, rate: 100 });
    const reviewId = await createInvoice(wpId, "in_review");
    await addLineItem(reviewId, { hours: 50, rate: 100 });

    const res = await request(app)
      .post("/api/invoices")
      .send({
        workPlanId: wpId,
        invoiceNumber: `TEST-INV-NOCARRY-${Date.now()}`,
        invoiceDate: "2026-02-15",
        periodStart: "2026-02-01",
        periodEnd: "2026-02-28",
      });

    expect(res.status).toBe(201);
    createdInvoiceIds.push(res.body.id);
    expect(res.body.previouslyBilled).toBe(0);
  });

  it("respects an explicitly supplied previouslyBilled over carry-over", async () => {
    const wpId = await createWorkPlan({ overheadRate: null, fccmRate: null });
    const priorId = await createInvoice(wpId, "approved");
    await addLineItem(priorId, { hours: 10, rate: 100 });

    const res = await request(app)
      .post("/api/invoices")
      .send({
        workPlanId: wpId,
        invoiceNumber: `TEST-INV-EXPLICIT-${Date.now()}`,
        invoiceDate: "2026-02-15",
        periodStart: "2026-02-01",
        periodEnd: "2026-02-28",
        previouslyBilled: 999,
      });

    expect(res.status).toBe(201);
    createdInvoiceIds.push(res.body.id);
    expect(res.body.previouslyBilled).toBe(999);
  });
});

describe("carry-over recompute when an earlier invoice changes", () => {
  it("updates a downstream invoice's carry-over after the prior invoice is edited", async () => {
    const wpId = await createWorkPlan({ overheadRate: null, fccmRate: null });

    // January: approved invoice, 10h @ 100 → this period 2200, total-to-date 2200.
    const janId = await createInvoice(wpId, "approved", {
      periodStart: "2026-01-01",
      periodEnd: "2026-01-31",
    });
    await addLineItem(janId, { hours: 10, rate: 100 });

    // February: created via the API so its carry-over derives from January (2200).
    const febRes = await request(app)
      .post("/api/invoices")
      .send({
        workPlanId: wpId,
        invoiceNumber: `TEST-INV-FEB-${Date.now()}`,
        invoiceDate: "2026-02-15",
        periodStart: "2026-02-01",
        periodEnd: "2026-02-28",
      });
    expect(febRes.status).toBe(201);
    const febId = febRes.body.id as number;
    createdInvoiceIds.push(febId);
    expect(febRes.body.previouslyBilled).toBe(2200);

    // Edit January: add another 10h @ 100 → this period 4400, total-to-date 4400.
    const addRes = await request(app)
      .post(`/api/invoices/${janId}/line-items`)
      .send({ employeeName: "Extra", classification: "Engineer", category: "regular", location: "home", hours: 10, rate: 100 });
    expect(addRes.status).toBe(201);

    // February's carry-over must now reflect January's new total-to-date (4400).
    const feb = await request(app).get(`/api/invoices/${febId}`);
    expect(feb.body.previouslyBilled).toBe(4400);
    // total this period is 0 (no line items), so total-to-date == carry-over.
    expect(feb.body.totalToDate).toBe(4400);
  });

  it("re-derives carry-over when a prior invoice is approved (becomes billed)", async () => {
    const wpId = await createWorkPlan({ overheadRate: null, fccmRate: null });

    // January starts as a draft, so it is not yet part of the billed chain.
    const janId = await createInvoice(wpId, "draft", {
      periodStart: "2026-01-01",
      periodEnd: "2026-01-31",
    });
    await addLineItem(janId, { hours: 10, rate: 100 });

    const febRes = await request(app)
      .post("/api/invoices")
      .send({
        workPlanId: wpId,
        invoiceNumber: `TEST-INV-FEBB-${Date.now()}`,
        invoiceDate: "2026-02-15",
        periodStart: "2026-02-01",
        periodEnd: "2026-02-28",
      });
    const febId = febRes.body.id as number;
    createdInvoiceIds.push(febId);
    // No billed prior yet, so carry-over starts at 0.
    expect(febRes.body.previouslyBilled).toBe(0);

    await request(app).post(`/api/invoices/${janId}/approve`).send({ approvedBy: "Approver" });

    const feb = await request(app).get(`/api/invoices/${febId}`);
    expect(feb.body.previouslyBilled).toBe(2200);
  });

  it("preserves an explicitly-set carry-over across recompute", async () => {
    const wpId = await createWorkPlan({ overheadRate: null, fccmRate: null });

    const janId = await createInvoice(wpId, "approved", {
      periodStart: "2026-01-01",
      periodEnd: "2026-01-31",
    });
    await addLineItem(janId, { hours: 10, rate: 100 });

    // February explicitly pins its carry-over to 5000.
    const febRes = await request(app)
      .post("/api/invoices")
      .send({
        workPlanId: wpId,
        invoiceNumber: `TEST-INV-FEBC-${Date.now()}`,
        invoiceDate: "2026-02-15",
        periodStart: "2026-02-01",
        periodEnd: "2026-02-28",
        previouslyBilled: 5000,
      });
    const febId = febRes.body.id as number;
    createdInvoiceIds.push(febId);
    expect(febRes.body.previouslyBilled).toBe(5000);

    // Editing January must NOT overwrite February's manual carry-over.
    await request(app)
      .post(`/api/invoices/${janId}/line-items`)
      .send({ employeeName: "Extra", classification: "Engineer", category: "regular", location: "home", hours: 10, rate: 100 });

    const feb = await request(app).get(`/api/invoices/${febId}`);
    expect(feb.body.previouslyBilled).toBe(5000);
  });
});

describe("GET /api/invoices/:id/validations", () => {
  it("flags an error when there are no line items", async () => {
    const wpId = await createWorkPlan();
    const invId = await createInvoice(wpId, "draft");

    const res = await request(app).get(`/api/invoices/${invId}/validations`);

    expect(res.status).toBe(200);
    expect(res.body.isValid).toBe(false);
    expect(res.body.flags).toContainEqual(
      expect.objectContaining({ severity: "error", field: "lineItems" }),
    );
  });

  it("flags a zero rate as an error", async () => {
    const wpId = await createWorkPlan();
    const invId = await createInvoice(wpId, "draft");
    await addLineItem(invId, { hours: 10, rate: 0 });

    const res = await request(app).get(`/api/invoices/${invId}/validations`);

    expect(res.status).toBe(200);
    expect(res.body.isValid).toBe(false);
    expect(res.body.flags).toContainEqual(
      expect.objectContaining({ severity: "error", field: "rate" }),
    );
  });

  it("flags a period inversion as an error", async () => {
    const wpId = await createWorkPlan();
    const invId = await createInvoice(wpId, "draft", {
      periodStart: "2026-02-28",
      periodEnd: "2026-02-01",
    });
    await addLineItem(invId, { hours: 10, rate: 100 });

    const res = await request(app).get(`/api/invoices/${invId}/validations`);

    expect(res.status).toBe(200);
    expect(res.body.isValid).toBe(false);
    expect(res.body.flags).toContainEqual(
      expect.objectContaining({ severity: "error", field: "periodEnd" }),
    );
  });

  it("warns when the budget is over 100% expended", async () => {
    const wpId = await createWorkPlan({ totalBudget: 1000, overheadRate: null, fccmRate: null });
    const invId = await createInvoice(wpId, "draft");
    await addLineItem(invId, { hours: 100, rate: 100 });

    const res = await request(app).get(`/api/invoices/${invId}/validations`);

    expect(res.status).toBe(200);
    const budgetFlag = res.body.flags.find(
      (f: { field?: string | null }) => f.field === "budget",
    );
    expect(budgetFlag).toBeDefined();
    expect(budgetFlag.severity).toBe("warning");
  });

  it("emits an info flag when the budget is near (>90%) but not over 100%", async () => {
    // labor 1000 + fringe 1000 + fixed fee 200 = 2200 total-to-date.
    // A 2300 budget puts expended at ~95.65%.
    const wpId = await createWorkPlan({ totalBudget: 2300, overheadRate: null, fccmRate: null });
    const invId = await createInvoice(wpId, "draft");
    await addLineItem(invId, { hours: 10, rate: 100 });

    const res = await request(app).get(`/api/invoices/${invId}/validations`);

    expect(res.status).toBe(200);
    const budgetFlag = res.body.flags.find(
      (f: { field?: string | null }) => f.field === "budget",
    );
    expect(budgetFlag).toBeDefined();
    expect(budgetFlag.severity).toBe("info");
  });

  it("is valid (no error flags) for a well-formed invoice within budget", async () => {
    const wpId = await createWorkPlan();
    const invId = await createInvoice(wpId, "draft");
    await addLineItem(invId, { hours: 10, rate: 100 });

    const res = await request(app).get(`/api/invoices/${invId}/validations`);

    expect(res.status).toBe(200);
    expect(res.body.isValid).toBe(true);
    expect(res.body.flags.some((f: { severity: string }) => f.severity === "error")).toBe(false);
  });
});
