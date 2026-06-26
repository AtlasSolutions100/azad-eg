import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { parseTimeFile } from "../../lib/timeimport";

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
  employeesTable,
  auditLogsTable,
} = await import("@workspace/db");

const createdInvoiceIds: number[] = [];
const createdWorkPlanIds: number[] = [];
const createdEmployeeIds: number[] = [];

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

async function createInvoice(workPlanId: number, status = "draft"): Promise<number> {
  const [inv] = await db
    .insert(invoicesTable)
    .values({
      workPlanId,
      invoiceNumber: `TEST-INV-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      invoiceDate: "2026-01-15",
      periodStart: "2026-01-01",
      periodEnd: "2026-01-31",
      status,
    })
    .returning();
  createdInvoiceIds.push(inv.id);
  return inv.id;
}

async function createEmployee(
  overrides: Partial<typeof employeesTable.$inferInsert> = {},
): Promise<typeof employeesTable.$inferSelect> {
  const [emp] = await db
    .insert(employeesTable)
    .values({
      name: `Test Emp ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      classification: "Engineer",
      homeRate: 100,
      ...overrides,
    })
    .returning();
  createdEmployeeIds.push(emp.id);
  return emp;
}

function csvBuffer(rows: string[][]): Buffer {
  return Buffer.from(rows.map((r) => r.join(",")).join("\n"), "utf8");
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
  if (createdEmployeeIds.length > 0) {
    await db.delete(employeesTable).where(inArray(employeesTable.id, createdEmployeeIds));
  }
});

describe("parseTimeFile", () => {
  it("parses a basic CSV and normalizes category and location", async () => {
    const buf = csvBuffer([
      ["Employee", "Classification", "Category", "Location", "Hours", "Rate"],
      ["Jane Doe", "Senior Engineer", "Overtime", "Field", "8", "150"],
      ["John Roe", "Engineer", "Regular", "Home", "40", "100"],
    ]);
    const result = await parseTimeFile(buf, "timesheet.csv");

    expect(result.lines).toHaveLength(2);
    expect(result.lines[0]).toMatchObject({
      employeeName: "Jane Doe",
      classification: "Senior Engineer",
      category: "ot",
      location: "field",
      hours: 8,
      rate: 150,
    });
    expect(result.lines[1]).toMatchObject({
      employeeName: "John Roe",
      category: "regular",
      location: "home",
      hours: 40,
      rate: 100,
    });
  });

  it("matches header aliases and strips currency symbols from rate", async () => {
    const buf = csvBuffer([
      ["Worker", "Bill Rate", "Hrs"],
      ["Sam Smith", "$125.50", "10"],
    ]);
    const result = await parseTimeFile(buf, "timesheet.csv");

    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]).toMatchObject({
      employeeName: "Sam Smith",
      rate: 125.5,
      hours: 10,
    });
  });

  it("normalizes double-time and pto categories", async () => {
    const buf = csvBuffer([
      ["Name", "Type", "Hours", "Rate"],
      ["A", "Double Time", "2", "50"],
      ["B", "Vacation", "8", "50"],
      ["C", "Holiday", "8", "50"],
    ]);
    const result = await parseTimeFile(buf, "t.csv");
    expect(result.lines.map((l) => l.category)).toEqual(["dt", "pto", "holiday"]);
  });

  it("warns and skips rows with missing or zero hours", async () => {
    const buf = csvBuffer([
      ["Name", "Hours", "Rate"],
      ["Has Hours", "5", "100"],
      ["Zero Hours", "0", "100"],
      ["No Hours", "", "100"],
    ]);
    const result = await parseTimeFile(buf, "t.csv");

    expect(result.lines).toHaveLength(1);
    expect(result.lines[0].employeeName).toBe("Has Hours");
    expect(result.warnings.some((w) => w.includes("Zero Hours") && w.includes("zero hours"))).toBe(true);
  });

  it("warns and skips rows with a missing employee name", async () => {
    const buf = csvBuffer([
      ["Name", "Hours", "Rate"],
      ["", "5", "100"],
    ]);
    const result = await parseTimeFile(buf, "t.csv");

    expect(result.lines).toHaveLength(0);
    expect(result.warnings.some((w) => w.includes("missing employee name"))).toBe(true);
  });

  it("defaults rate to 0 and warns when no numeric rate is found", async () => {
    const buf = csvBuffer([
      ["Name", "Hours", "Rate"],
      ["No Rate", "5", "TBD"],
    ]);
    const result = await parseTimeFile(buf, "t.csv");

    expect(result.lines).toHaveLength(1);
    expect(result.lines[0].rate).toBe(0);
    expect(result.warnings.some((w) => w.includes("No Rate") && w.includes("no rate found"))).toBe(true);
  });

  it("warns when no header row with employee and hours can be located", async () => {
    const buf = csvBuffer([
      ["Some", "Unrelated", "Columns"],
      ["a", "b", "c"],
    ]);
    const result = await parseTimeFile(buf, "t.csv");

    expect(result.lines).toHaveLength(0);
    expect(result.warnings.some((w) => w.includes("Could not locate a header row"))).toBe(true);
  });
});

describe("POST /api/invoices/:id/time-import", () => {
  it("matches an employee by name (case-insensitive) and fills classification", async () => {
    const wpId = await createWorkPlan();
    const invId = await createInvoice(wpId);
    const emp = await createEmployee({
      name: `Matched Person ${Date.now()}`,
      classification: "Principal Engineer",
      homeRate: 200,
    });

    const buf = csvBuffer([
      ["Name", "Hours", "Rate"],
      [emp.name.toUpperCase(), "10", "175"],
    ]);

    const res = await request(app)
      .post(`/api/invoices/${invId}/time-import`)
      .attach("file", buf, "timesheet.csv");

    expect(res.status).toBe(200);
    expect(res.body.importedCount).toBe(1);
    const li = res.body.lineItems[0];
    expect(li.employeeId).toBe(emp.id);
    expect(li.classification).toBe("Principal Engineer");
    expect(li.rate).toBe(175);
    expect(li.amount).toBe(10 * 175);
  });

  it("falls back to the employee field rate for field work when the file has no rate", async () => {
    const wpId = await createWorkPlan();
    const invId = await createInvoice(wpId);
    const emp = await createEmployee({
      name: `Field Worker ${Date.now()}`,
      homeRate: 100,
      fieldRate: 130,
    });

    const buf = csvBuffer([
      ["Name", "Location", "Hours", "Rate"],
      [emp.name, "Field", "8", ""],
    ]);

    const res = await request(app)
      .post(`/api/invoices/${invId}/time-import`)
      .attach("file", buf, "timesheet.csv");

    expect(res.status).toBe(200);
    const li = res.body.lineItems[0];
    expect(li.location).toBe("field");
    expect(li.rate).toBe(130);
    expect(li.amount).toBe(8 * 130);
  });

  it("falls back to the employee home rate for home work when the file has no rate", async () => {
    const wpId = await createWorkPlan();
    const invId = await createInvoice(wpId);
    const emp = await createEmployee({
      name: `Home Worker ${Date.now()}`,
      homeRate: 95,
      fieldRate: 140,
    });

    const buf = csvBuffer([
      ["Name", "Location", "Hours", "Rate"],
      [emp.name, "Home", "20", ""],
    ]);

    const res = await request(app)
      .post(`/api/invoices/${invId}/time-import`)
      .attach("file", buf, "timesheet.csv");

    expect(res.status).toBe(200);
    const li = res.body.lineItems[0];
    expect(li.location).toBe("home");
    expect(li.rate).toBe(95);
    expect(li.amount).toBe(20 * 95);
  });

  it("falls back to the home rate for field work when the employee has no field rate", async () => {
    const wpId = await createWorkPlan();
    const invId = await createInvoice(wpId);
    const emp = await createEmployee({
      name: `No Field Rate ${Date.now()}`,
      homeRate: 110,
      fieldRate: null,
    });

    const buf = csvBuffer([
      ["Name", "Location", "Hours", "Rate"],
      [emp.name, "Field", "5", ""],
    ]);

    const res = await request(app)
      .post(`/api/invoices/${invId}/time-import`)
      .attach("file", buf, "timesheet.csv");

    expect(res.status).toBe(200);
    const li = res.body.lineItems[0];
    expect(li.location).toBe("field");
    expect(li.rate).toBe(110);
    expect(li.amount).toBe(5 * 110);
  });

  it("warns and stores a zero rate when no rate and no matching employee", async () => {
    const wpId = await createWorkPlan();
    const invId = await createInvoice(wpId);

    const buf = csvBuffer([
      ["Name", "Hours", "Rate"],
      [`Unknown Person ${Date.now()}`, "12", ""],
    ]);

    const res = await request(app)
      .post(`/api/invoices/${invId}/time-import`)
      .attach("file", buf, "timesheet.csv");

    expect(res.status).toBe(200);
    const li = res.body.lineItems[0];
    expect(li.rate).toBe(0);
    expect(li.amount).toBe(0);
    expect(res.body.warnings.some((w: string) => w.includes("no rate available"))).toBe(true);
  });

  it("persists line items whose amount equals hours times the resolved rate", async () => {
    const wpId = await createWorkPlan();
    const invId = await createInvoice(wpId);
    const emp = await createEmployee({
      name: `Persisted Worker ${Date.now()}`,
      homeRate: 100,
      fieldRate: 160,
    });

    const buf = csvBuffer([
      ["Name", "Location", "Hours", "Rate"],
      [emp.name, "Field", "6", ""],
    ]);

    const res = await request(app)
      .post(`/api/invoices/${invId}/time-import`)
      .attach("file", buf, "timesheet.csv");
    expect(res.status).toBe(200);

    const rows = await db.select().from(lineItemsTable).where(eq(lineItemsTable.invoiceId, invId));
    expect(rows).toHaveLength(1);
    expect(rows[0].rate).toBe(160);
    expect(rows[0].hours).toBe(6);
    expect(rows[0].amount).toBe(6 * 160);
  });

  it("returns 400 when no file is uploaded", async () => {
    const wpId = await createWorkPlan();
    const invId = await createInvoice(wpId);

    const res = await request(app).post(`/api/invoices/${invId}/time-import`).field("source", "timesheet");

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/No file uploaded/i);
  });

  it("returns 400 when the file contains no valid rows", async () => {
    const wpId = await createWorkPlan();
    const invId = await createInvoice(wpId);

    const buf = csvBuffer([
      ["Some", "Unrelated", "Columns"],
      ["a", "b", "c"],
    ]);

    const res = await request(app)
      .post(`/api/invoices/${invId}/time-import`)
      .attach("file", buf, "timesheet.csv");

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/No valid rows/i);
    expect(Array.isArray(res.body.warnings)).toBe(true);
  });
});
