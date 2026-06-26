import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import fs from "node:fs";
import path from "node:path";
import { generatedDir } from "../../lib/paths";

// Mutable auth state shared with the mocked Clerk module. Hoisted so the
// vi.mock factory (which is itself hoisted) can close over it.
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
const {
  db,
  invoicesTable,
  workPlansTable,
  lineItemsTable,
  auditLogsTable,
} = await import("@workspace/db");

const createdInvoiceIds: number[] = [];
const createdWorkPlanIds: number[] = [];
const createdInvoiceNumbers: string[] = [];

async function createWorkPlan(): Promise<number> {
  const [wp] = await db
    .insert(workPlansTable)
    .values({
      code: `TEST-WP-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      title: "Test Work Plan",
      client: "Test Client",
      jobNumber: "TEST-JOB",
      totalBudget: 100000,
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
  const invoiceNumber = `TEST-INV-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const [inv] = await db
    .insert(invoicesTable)
    .values({
      workPlanId,
      invoiceNumber,
      invoiceDate: "2026-01-15",
      periodStart: "2026-01-01",
      periodEnd: "2026-01-31",
      status,
      ...overrides,
    })
    .returning();
  createdInvoiceIds.push(inv.id);
  createdInvoiceNumbers.push(invoiceNumber);
  return inv.id;
}

async function addLineItem(invoiceId: number): Promise<void> {
  await db.insert(lineItemsTable).values({
    invoiceId,
    employeeName: "Test Employee",
    classification: "Engineer",
    hours: 10,
    rate: 100,
    amount: 1000,
  });
}

beforeAll(() => {
  authState.userId = "test-user";
});

afterEach(() => {
  // Restore authentication so one test's logout cannot leak into the next.
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
  // Remove any workbook files the generate route wrote for test invoices.
  if (createdInvoiceNumbers.length > 0 && fs.existsSync(generatedDir)) {
    for (const file of fs.readdirSync(generatedDir)) {
      if (createdInvoiceNumbers.some((num) => file.includes(num))) {
        fs.rmSync(path.resolve(generatedDir, file), { force: true });
      }
    }
  }
});

describe("PATCH /api/invoices/:id cannot change status", () => {
  it("ignores the status field on a generic edit", async () => {
    const wpId = await createWorkPlan();
    const invId = await createInvoice(wpId, "draft");

    const res = await request(app)
      .patch(`/api/invoices/${invId}`)
      .send({ status: "approved", preparedBy: "Someone" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("draft");
    expect(res.body.preparedBy).toBe("Someone");

    const [row] = await db.select().from(invoicesTable).where(eq(invoicesTable.id, invId));
    expect(row.status).toBe("draft");
  });

  it("does not promote an in_review invoice to exported via PATCH", async () => {
    const wpId = await createWorkPlan();
    const invId = await createInvoice(wpId, "in_review");

    const res = await request(app)
      .patch(`/api/invoices/${invId}`)
      .send({ status: "exported" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("in_review");
  });
});

describe("POST /api/invoices/:id/approve", () => {
  it("approves a draft invoice", async () => {
    const wpId = await createWorkPlan();
    const invId = await createInvoice(wpId, "draft");

    const res = await request(app)
      .post(`/api/invoices/${invId}/approve`)
      .send({ approvedBy: "Approver" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("approved");
  });

  it("approves an in_review invoice", async () => {
    const wpId = await createWorkPlan();
    const invId = await createInvoice(wpId, "in_review");

    const res = await request(app)
      .post(`/api/invoices/${invId}/approve`)
      .send({ approvedBy: "Approver" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("approved");
  });

  it("rejects approving an already-approved invoice with 409", async () => {
    const wpId = await createWorkPlan();
    const invId = await createInvoice(wpId, "approved");

    const res = await request(app)
      .post(`/api/invoices/${invId}/approve`)
      .send({ approvedBy: "Approver" });

    expect(res.status).toBe(409);

    const [row] = await db.select().from(invoicesTable).where(eq(invoicesTable.id, invId));
    expect(row.status).toBe("approved");
  });

  it("rejects approving an exported invoice with 409", async () => {
    const wpId = await createWorkPlan();
    const invId = await createInvoice(wpId, "exported");

    const res = await request(app)
      .post(`/api/invoices/${invId}/approve`)
      .send({ approvedBy: "Approver" });

    expect(res.status).toBe(409);

    const [row] = await db.select().from(invoicesTable).where(eq(invoicesTable.id, invId));
    expect(row.status).toBe("exported");
  });

  it("blocks approving an over-budget invoice without an override (422)", async () => {
    const wpId = await createWorkPlan();
    // previouslyBilled alone exceeds the 100000 budget, so any line item puts
    // total-to-date over 100% expended.
    const invId = await createInvoice(wpId, "draft", { previouslyBilled: 200000 });
    await addLineItem(invId);

    const res = await request(app)
      .post(`/api/invoices/${invId}/approve`)
      .send({ approvedBy: "Approver" });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe("BUDGET_OVERRIDE_REQUIRED");

    const [row] = await db.select().from(invoicesTable).where(eq(invoicesTable.id, invId));
    expect(row.status).toBe("draft");
  });

  it("approves an over-budget invoice with an override and logs it", async () => {
    const wpId = await createWorkPlan();
    const invId = await createInvoice(wpId, "draft", { previouslyBilled: 200000 });
    await addLineItem(invId);

    const res = await request(app)
      .post(`/api/invoices/${invId}/approve`)
      .send({ approvedBy: "Approver", budgetOverride: true, budgetOverrideReason: "PO amendment pending" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("approved");

    const audits = await db
      .select()
      .from(auditLogsTable)
      .where(eq(auditLogsTable.entityId, invId));
    const override = audits.find((a) => a.action === "approved over budget");
    expect(override).toBeDefined();
    expect(override?.description).toContain("PO amendment pending");
  });
});

describe("POST /api/invoices/:id/generate marks exported only when approved", () => {
  it("transitions an approved invoice to exported", async () => {
    const wpId = await createWorkPlan();
    const invId = await createInvoice(wpId, "approved");
    await addLineItem(invId);

    const res = await request(app)
      .post(`/api/invoices/${invId}/generate`)
      .send({ format: "xlsx" });

    expect(res.status).toBe(200);
    expect(res.body.format).toBe("xlsx");

    const [row] = await db.select().from(invoicesTable).where(eq(invoicesTable.id, invId));
    expect(row.status).toBe("exported");
  });

  it("leaves a draft invoice as draft (preview only)", async () => {
    const wpId = await createWorkPlan();
    const invId = await createInvoice(wpId, "draft");
    await addLineItem(invId);

    const res = await request(app)
      .post(`/api/invoices/${invId}/generate`)
      .send({ format: "xlsx" });

    expect(res.status).toBe(200);

    const [row] = await db.select().from(invoicesTable).where(eq(invoicesTable.id, invId));
    expect(row.status).toBe("draft");
  });

  it("leaves an in_review invoice as in_review (preview only)", async () => {
    const wpId = await createWorkPlan();
    const invId = await createInvoice(wpId, "in_review");
    await addLineItem(invId);

    const res = await request(app)
      .post(`/api/invoices/${invId}/generate`)
      .send({ format: "xlsx" });

    expect(res.status).toBe(200);

    const [row] = await db.select().from(invoicesTable).where(eq(invoicesTable.id, invId));
    expect(row.status).toBe("in_review");
  });
});

describe("auth boundary", () => {
  it("returns 401 for protected invoice routes when unauthenticated", async () => {
    authState.userId = null;
    const res = await request(app).get("/api/invoices");
    expect(res.status).toBe(401);
  });

  it("returns 401 for /api/files when unauthenticated", async () => {
    authState.userId = null;
    const res = await request(app).get("/api/files/anything.pdf");
    expect(res.status).toBe(401);
  });

  it("allows the public health route when unauthenticated", async () => {
    authState.userId = null;
    const res = await request(app).get("/api/healthz");
    expect(res.status).toBe(200);
  });
});
