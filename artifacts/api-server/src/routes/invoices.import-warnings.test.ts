import { afterAll, describe, expect, it, vi } from "vitest";
import { inArray } from "drizzle-orm";

vi.mock("@clerk/express", () => ({
  clerkMiddleware:
    () =>
    (_req: unknown, _res: unknown, next: () => void): void =>
      next(),
  getAuth: () => ({ userId: "test-user", sessionClaims: { name: "Test User" } }),
}));

const request = (await import("supertest")).default;
const app = (await import("../app")).default;
const { db, invoicesTable, workPlansTable, employeesTable, lineItemsTable } = await import("@workspace/db");

const createdInvoiceIds: number[] = [];
const createdWorkPlanIds: number[] = [];
const createdEmployeeIds: number[] = [];

afterAll(async () => {
  if (createdInvoiceIds.length) {
    await db.delete(lineItemsTable).where(inArray(lineItemsTable.invoiceId, createdInvoiceIds));
    await db.delete(invoicesTable).where(inArray(invoicesTable.id, createdInvoiceIds));
  }
  if (createdWorkPlanIds.length) {
    await db.delete(workPlansTable).where(inArray(workPlansTable.id, createdWorkPlanIds));
  }
  if (createdEmployeeIds.length) {
    await db.delete(employeesTable).where(inArray(employeesTable.id, createdEmployeeIds));
  }
});

async function makeInvoice(): Promise<number> {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const [wp] = await db
    .insert(workPlansTable)
    .values({ code: `IW-WP-${suffix}`, title: "IW WP", client: "Client", jobNumber: "JOB", poNumber: "PO", totalBudget: 100000 })
    .returning();
  createdWorkPlanIds.push(wp.id);
  const [inv] = await db
    .insert(invoicesTable)
    .values({
      workPlanId: wp.id,
      invoiceNumber: `IW-INV-${suffix}`,
      invoiceDate: "2026-02-01",
      periodStart: "2026-01-01",
      periodEnd: "2026-01-15",
    })
    .returning();
  createdInvoiceIds.push(inv.id);
  return inv.id;
}

function csvUpload(id: number, csv: string) {
  return request(app)
    .post(`/api/invoices/${id}/time-import`)
    .field("source", "procas")
    .attach("file", Buffer.from(csv, "utf8"), "hours.csv");
}

describe("import warnings persistence", () => {
  it("stores the last import's warnings on the invoice and returns them on GET", async () => {
    const id = await makeInvoice();

    // Unknown employee with no rate → produces a warning.
    const csv = "Employee,Classification,Hours,Rate\nGhost Person,Engineer,10,\nReal Person,Engineer,5,120\n";
    const res = await csvUpload(id, csv);
    expect(res.status).toBe(200);
    expect(res.body.warnings.length).toBeGreaterThan(0);

    const get = await request(app).get(`/api/invoices/${id}`);
    expect(get.status).toBe(200);
    expect(get.body.importWarnings).toEqual(res.body.warnings);
    expect(get.body.lastImportSource).toBe("upload");
    expect(typeof get.body.lastImportAt).toBe("string");
    expect(Number.isNaN(Date.parse(get.body.lastImportAt))).toBe(false);
  });

  it("replaces the stored warnings when a new import runs", async () => {
    const id = await makeInvoice();

    const withWarnings = "Employee,Classification,Hours,Rate\nGhost Person,Engineer,10,\n";
    const first = await csvUpload(id, withWarnings);
    expect(first.status).toBe(200);
    expect(first.body.warnings.some((w: string) => /no rate/i.test(w))).toBe(true);

    const clean = "Employee,Classification,Hours,Rate\nReal Person,Engineer,5,120\n";
    const second = await csvUpload(id, clean);
    expect(second.status).toBe(200);

    const get = await request(app).get(`/api/invoices/${id}`);
    expect(get.status).toBe(200);
    expect(get.body.importWarnings).toEqual(second.body.warnings);
    expect((get.body.importWarnings as string[]).some((w) => /no rate/i.test(w))).toBe(false);
  });

  it("dismisses stored warnings and records the dismissal in the audit log", async () => {
    const id = await makeInvoice();

    const withWarnings = "Employee,Classification,Hours,Rate\nGhost Person,Engineer,10,\n";
    const imported = await csvUpload(id, withWarnings);
    expect(imported.status).toBe(200);
    expect(imported.body.warnings.length).toBeGreaterThan(0);

    const dismiss = await request(app).delete(`/api/invoices/${id}/import-warnings`);
    expect(dismiss.status).toBe(200);
    expect(dismiss.body.importWarnings ?? []).toEqual([]);

    const get = await request(app).get(`/api/invoices/${id}`);
    expect(get.status).toBe(200);
    expect(get.body.importWarnings ?? []).toEqual([]);

    const audit = await request(app).get(`/api/audit-logs?entityType=invoice&entityId=${id}`);
    expect(audit.status).toBe(200);
    const entries = Array.isArray(audit.body) ? audit.body : audit.body.logs ?? audit.body.items ?? [];
    expect(
      entries.some((e: { action: string }) => e.action === "dismissed import warnings"),
    ).toBe(true);
  });

  it("stamps lineItemsEditedAt when line items are edited after an import", async () => {
    const id = await makeInvoice();

    const csv = "Employee,Classification,Hours,Rate\nGhost Person,Engineer,10,\n";
    const imported = await csvUpload(id, csv);
    expect(imported.status).toBe(200);

    const before = await request(app).get(`/api/invoices/${id}`);
    expect(before.status).toBe(200);
    expect(before.body.lineItemsEditedAt ?? null).toBeNull();

    const add = await request(app)
      .post(`/api/invoices/${id}/line-items`)
      .send({
        employeeName: "Manual Person",
        classification: "Engineer",
        category: "regular",
        location: "home",
        hours: 2,
        rate: 100,
      });
    expect(add.status).toBe(201);

    const after = await request(app).get(`/api/invoices/${id}`);
    expect(after.status).toBe(200);
    expect(typeof after.body.lineItemsEditedAt).toBe("string");
    expect(Date.parse(after.body.lineItemsEditedAt)).toBeGreaterThanOrEqual(
      Date.parse(after.body.lastImportAt),
    );
  });

  it("returns 409 when there are no warnings to dismiss", async () => {
    const id = await makeInvoice();
    const dismiss = await request(app).delete(`/api/invoices/${id}/import-warnings`);
    expect(dismiss.status).toBe(409);
  });

  it("returns 404 for a missing invoice", async () => {
    const dismiss = await request(app).delete(`/api/invoices/999999999/import-warnings`);
    expect(dismiss.status).toBe(404);
  });
});
