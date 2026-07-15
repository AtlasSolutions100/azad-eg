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

  it("records an audit entry on each downstream invoice auto-updated by an upstream change", async () => {
    const wpId = await createWorkPlan({ overheadRate: null, fccmRate: null });

    const janId = await createInvoice(wpId, "approved", {
      periodStart: "2026-01-01",
      periodEnd: "2026-01-31",
    });
    await addLineItem(janId, { hours: 10, rate: 100 });

    const febRes = await request(app)
      .post("/api/invoices")
      .send({
        workPlanId: wpId,
        invoiceNumber: `TEST-INV-FEBD-${Date.now()}`,
        invoiceDate: "2026-02-15",
        periodStart: "2026-02-01",
        periodEnd: "2026-02-28",
      });
    const febId = febRes.body.id as number;
    createdInvoiceIds.push(febId);
    expect(febRes.body.previouslyBilled).toBe(2200);

    // Edit January so February's carry-over auto-updates from 2200 → 4400.
    await request(app)
      .post(`/api/invoices/${janId}/line-items`)
      .send({ employeeName: "Extra", classification: "Engineer", category: "regular", location: "home", hours: 10, rate: 100 });

    const feb = await request(app).get(`/api/invoices/${febId}`);
    expect(feb.body.previouslyBilled).toBe(4400);

    // A "carry-over recalculated" audit entry must exist for February (the
    // downstream invoice) but not for January (the invoice that was edited).
    const audits = await db
      .select()
      .from(auditLogsTable)
      .where(inArray(auditLogsTable.entityId, [janId, febId]));
    const recalcs = audits.filter((a) => a.action === "carry-over recalculated");
    expect(recalcs.some((a) => a.entityId === febId)).toBe(true);
    expect(recalcs.some((a) => a.entityId === janId)).toBe(false);
    const febRecalc = recalcs.find((a) => a.entityId === febId);
    expect(febRecalc?.description).toContain("2,200.00");
    expect(febRecalc?.description).toContain("4,400.00");
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

describe("carry-over recompute across multi-invoice chains", () => {
  // Builds N sequential approved invoices on one work plan, each with 10h @ 100
  // (this period 2200) so total-to-date climbs by 2200 per period. The stored
  // previouslyBilled values are seeded to the correct chain values; recompute
  // should leave them untouched until an upstream invoice changes.
  async function buildApprovedChain(
    wpId: number,
    months: { start: string; end: string }[],
  ): Promise<number[]> {
    const ids: number[] = [];
    let carry = 0;
    for (const m of months) {
      const id = await createInvoice(wpId, "approved", {
        periodStart: m.start,
        periodEnd: m.end,
        previouslyBilled: carry,
      });
      await addLineItem(id, { hours: 10, rate: 100 });
      ids.push(id);
      carry += 2200; // this period total, becomes the next invoice's carry-over
    }
    return ids;
  }

  const MONTHS = [
    { start: "2026-01-01", end: "2026-01-31" },
    { start: "2026-02-01", end: "2026-02-28" },
    { start: "2026-03-01", end: "2026-03-31" },
    { start: "2026-04-01", end: "2026-04-30" },
  ];

  it("cascades a first-invoice edit through every later invoice in the chain", async () => {
    const wpId = await createWorkPlan({ overheadRate: null, fccmRate: null });
    const [janId, febId, marId, aprId] = await buildApprovedChain(wpId, MONTHS);

    // Sanity: chain starts at 0 / 2200 / 4400 / 6600.
    expect((await request(app).get(`/api/invoices/${febId}`)).body.previouslyBilled).toBe(2200);
    expect((await request(app).get(`/api/invoices/${marId}`)).body.previouslyBilled).toBe(4400);
    expect((await request(app).get(`/api/invoices/${aprId}`)).body.previouslyBilled).toBe(6600);

    // Edit January: add another 10h @ 100 → this period 4400, total-to-date 4400.
    const addRes = await request(app)
      .post(`/api/invoices/${janId}/line-items`)
      .send({ employeeName: "Extra", classification: "Engineer", category: "regular", location: "home", hours: 10, rate: 100 });
    expect(addRes.status).toBe(201);

    // The new January total (4400) must cascade through all three later periods.
    const feb = await request(app).get(`/api/invoices/${febId}`);
    const mar = await request(app).get(`/api/invoices/${marId}`);
    const apr = await request(app).get(`/api/invoices/${aprId}`);
    expect(feb.body.previouslyBilled).toBe(4400);
    expect(feb.body.totalToDate).toBe(6600);
    expect(mar.body.previouslyBilled).toBe(6600);
    expect(mar.body.totalToDate).toBe(8800);
    expect(apr.body.previouslyBilled).toBe(8800);
    expect(apr.body.totalToDate).toBe(11000);
  });

  it("only changes invoices after the one edited in the middle of the chain", async () => {
    const wpId = await createWorkPlan({ overheadRate: null, fccmRate: null });
    const [janId, febId, marId, aprId] = await buildApprovedChain(wpId, MONTHS);

    // Edit February (the middle): add 10h @ 100 → this period 4400.
    const addRes = await request(app)
      .post(`/api/invoices/${febId}/line-items`)
      .send({ employeeName: "Extra", classification: "Engineer", category: "regular", location: "home", hours: 10, rate: 100 });
    expect(addRes.status).toBe(201);

    const jan = await request(app).get(`/api/invoices/${janId}`);
    const feb = await request(app).get(`/api/invoices/${febId}`);
    const mar = await request(app).get(`/api/invoices/${marId}`);
    const apr = await request(app).get(`/api/invoices/${aprId}`);

    // January precedes the edit, so it is untouched.
    expect(jan.body.previouslyBilled).toBe(0);
    expect(jan.body.totalToDate).toBe(2200);
    // February's own carry-over still comes from January (unchanged at 2200),
    // but its total-to-date grew to 6600 from the new line item.
    expect(feb.body.previouslyBilled).toBe(2200);
    expect(feb.body.totalToDate).toBe(6600);
    // Everything after February shifts up by the 2200 increase.
    expect(mar.body.previouslyBilled).toBe(6600);
    expect(apr.body.previouslyBilled).toBe(8800);
  });

  it("keeps a manually-pinned middle invoice fixed while later invoices follow its total", async () => {
    const wpId = await createWorkPlan({ overheadRate: null, fccmRate: null });

    // January: approved, auto carry-over 0, this period 2200.
    const janId = await createInvoice(wpId, "approved", {
      periodStart: "2026-01-01",
      periodEnd: "2026-01-31",
      previouslyBilled: 0,
    });
    await addLineItem(janId, { hours: 10, rate: 100 });

    // February: approved with a manually-pinned carry-over of 5000 (not the
    // 2200 the chain would derive). This period 2200 → total-to-date 7200.
    const febId = await createInvoice(wpId, "approved", {
      periodStart: "2026-02-01",
      periodEnd: "2026-02-28",
      previouslyBilled: 5000,
      carryOverManual: true,
    });
    await addLineItem(febId, { hours: 10, rate: 100 });

    // March and April: approved, seeded from February's total-to-date.
    const marId = await createInvoice(wpId, "approved", {
      periodStart: "2026-03-01",
      periodEnd: "2026-03-31",
      previouslyBilled: 7200,
    });
    await addLineItem(marId, { hours: 10, rate: 100 });
    const aprId = await createInvoice(wpId, "approved", {
      periodStart: "2026-04-01",
      periodEnd: "2026-04-30",
      previouslyBilled: 9400,
    });
    await addLineItem(aprId, { hours: 10, rate: 100 });

    // Edit January: add 10h @ 100 → January's total-to-date becomes 4400.
    const addRes = await request(app)
      .post(`/api/invoices/${janId}/line-items`)
      .send({ employeeName: "Extra", classification: "Engineer", category: "regular", location: "home", hours: 10, rate: 100 });
    expect(addRes.status).toBe(201);

    // February's pinned carry-over must NOT move with January's change, and
    // since February's own total-to-date is unchanged (5000 + 2200 = 7200),
    // March and April must also stay put.
    const feb = await request(app).get(`/api/invoices/${febId}`);
    const mar = await request(app).get(`/api/invoices/${marId}`);
    const apr = await request(app).get(`/api/invoices/${aprId}`);
    expect(feb.body.previouslyBilled).toBe(5000);
    expect(feb.body.totalToDate).toBe(7200);
    expect(mar.body.previouslyBilled).toBe(7200);
    expect(mar.body.totalToDate).toBe(9400);
    expect(apr.body.previouslyBilled).toBe(9400);
    expect(apr.body.totalToDate).toBe(11600);
  });

  it("cascades a manual invoice's own edits to later invoices without unpinning it", async () => {
    const wpId = await createWorkPlan({ overheadRate: null, fccmRate: null });

    const janId = await createInvoice(wpId, "approved", {
      periodStart: "2026-01-01",
      periodEnd: "2026-01-31",
      previouslyBilled: 0,
    });
    await addLineItem(janId, { hours: 10, rate: 100 });

    // February pinned at 5000, this period 2200 → total-to-date 7200.
    const febId = await createInvoice(wpId, "approved", {
      periodStart: "2026-02-01",
      periodEnd: "2026-02-28",
      previouslyBilled: 5000,
      carryOverManual: true,
    });
    await addLineItem(febId, { hours: 10, rate: 100 });

    const marId = await createInvoice(wpId, "approved", {
      periodStart: "2026-03-01",
      periodEnd: "2026-03-31",
      previouslyBilled: 7200,
    });
    await addLineItem(marId, { hours: 10, rate: 100 });
    const aprId = await createInvoice(wpId, "approved", {
      periodStart: "2026-04-01",
      periodEnd: "2026-04-30",
      previouslyBilled: 9400,
    });
    await addLineItem(aprId, { hours: 10, rate: 100 });

    // Edit February itself: add 10h @ 100 → this period 4400,
    // total-to-date 5000 + 4400 = 9400.
    const addRes = await request(app)
      .post(`/api/invoices/${febId}/line-items`)
      .send({ employeeName: "Extra", classification: "Engineer", category: "regular", location: "home", hours: 10, rate: 100 });
    expect(addRes.status).toBe(201);

    // February stays pinned at 5000, but its new total-to-date (9400) must
    // flow into March, and March's new total into April.
    const feb = await request(app).get(`/api/invoices/${febId}`);
    const mar = await request(app).get(`/api/invoices/${marId}`);
    const apr = await request(app).get(`/api/invoices/${aprId}`);
    expect(feb.body.previouslyBilled).toBe(5000);
    expect(feb.body.totalToDate).toBe(9400);
    expect(mar.body.previouslyBilled).toBe(9400);
    expect(mar.body.totalToDate).toBe(11600);
    expect(apr.body.previouslyBilled).toBe(11600);
    expect(apr.body.totalToDate).toBe(13800);
  });

  it("re-derives the rest of the chain after a middle invoice is deleted", async () => {
    const wpId = await createWorkPlan({ overheadRate: null, fccmRate: null });
    const [janId, febId, marId, aprId] = await buildApprovedChain(wpId, MONTHS);

    // Delete February from the middle of the chain.
    const delRes = await request(app).delete(`/api/invoices/${febId}`);
    expect(delRes.status).toBe(204);

    const jan = await request(app).get(`/api/invoices/${janId}`);
    const mar = await request(app).get(`/api/invoices/${marId}`);
    const apr = await request(app).get(`/api/invoices/${aprId}`);

    // January is unaffected; March now carries from January, April from March.
    expect(jan.body.previouslyBilled).toBe(0);
    expect(mar.body.previouslyBilled).toBe(2200);
    expect(mar.body.totalToDate).toBe(4400);
    expect(apr.body.previouslyBilled).toBe(4400);
    expect(apr.body.totalToDate).toBe(6600);
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
