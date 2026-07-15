import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import ExcelJS from "exceljs";
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

async function xlsxBuffer(rows: unknown[][]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Sheet1");
  for (const r of rows) ws.addRow(r);
  const ab = await wb.xlsx.writeBuffer();
  return Buffer.from(ab as ArrayBuffer);
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

  it("parses a real .xlsx workbook the same way as the CSV path", async () => {
    const rows = [
      ["Employee", "Classification", "Category", "Location", "Hours", "Rate"],
      ["Jane Doe", "Senior Engineer", "Overtime", "Field", 8, 150],
      ["John Roe", "Engineer", "Regular", "Home", 40, 100],
    ];
    const xlsx = await parseTimeFile(await xlsxBuffer(rows), "timesheet.xlsx");
    const csv = await parseTimeFile(
      csvBuffer(rows.map((r) => r.map((c) => String(c)))),
      "timesheet.csv",
    );

    expect(xlsx.lines).toEqual(csv.lines);
    expect(xlsx.warnings).toEqual(csv.warnings);
    expect(xlsx.lines).toHaveLength(2);
    expect(xlsx.lines[0]).toMatchObject({
      employeeName: "Jane Doe",
      classification: "Senior Engineer",
      category: "ot",
      location: "field",
      hours: 8,
      rate: 150,
    });
    expect(xlsx.lines[1]).toMatchObject({
      employeeName: "John Roe",
      category: "regular",
      location: "home",
      hours: 40,
      rate: 100,
    });
  });

  it("reads a formula-result cell as its computed value from an .xlsx workbook", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Sheet1");
    ws.addRow(["Name", "Hours", "Rate"]);
    const row = ws.addRow(["Formula Worker", 0, 100]);
    // Hours cell holds a formula whose computed result is 12.
    row.getCell(2).value = { formula: "6*2", result: 12 };
    const buf = Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer);

    const result = await parseTimeFile(buf, "timesheet.xlsx");

    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]).toMatchObject({
      employeeName: "Formula Worker",
      hours: 12,
      rate: 100,
    });
  });

  it("aggregates line items across all worksheets with per-sheet header detection", async () => {
    const wb = new ExcelJS.Workbook();
    const week1 = wb.addWorksheet("Week 1");
    week1.addRow(["Employee", "Category", "Location", "Hours", "Rate"]);
    week1.addRow(["Jane Doe", "Regular", "Home", 40, 100]);
    // Second sheet uses a different column layout and order.
    const week2 = wb.addWorksheet("Week 2");
    week2.addRow(["Some banner text"]);
    week2.addRow(["Hrs", "Bill Rate", "Worker"]);
    week2.addRow([8, 150, "John Roe"]);
    const week3 = wb.addWorksheet("Week 3");
    week3.addRow(["Name", "Hours", "Rate"]);
    week3.addRow(["Sam Smith", 12, 125]);
    const buf = Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer);

    const result = await parseTimeFile(buf, "multi-week.xlsx");

    expect(result.lines).toHaveLength(3);
    expect(result.lines[0]).toMatchObject({ employeeName: "Jane Doe", hours: 40, rate: 100 });
    expect(result.lines[1]).toMatchObject({ employeeName: "John Roe", hours: 8, rate: 150 });
    expect(result.lines[2]).toMatchObject({ employeeName: "Sam Smith", hours: 12, rate: 125 });
  });

  it("prefixes warnings with the sheet name and notes sheets without data", async () => {
    const wb = new ExcelJS.Workbook();
    const crew = wb.addWorksheet("Crew A");
    crew.addRow(["Name", "Hours", "Rate"]);
    crew.addRow(["Good Row", 5, 100]);
    crew.addRow(["Zero Person", 0, 100]);
    const notes = wb.addWorksheet("Notes");
    notes.addRow(["Just some", "notes here"]);
    const buf = Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer);

    const result = await parseTimeFile(buf, "multi.xlsx");

    expect(result.lines).toHaveLength(1);
    expect(result.warnings.some((w) => w.includes('Sheet "Crew A"') && w.includes("Zero Person"))).toBe(true);
    expect(result.warnings.some((w) => w.includes('Sheet "Notes"') && w.includes("Could not locate a header row"))).toBe(true);
    expect(result.warnings.some((w) => w.includes("1 of 2 sheets contained timesheet data"))).toBe(true);
  });

  it("warns when the same employee appears on multiple sheets with combined hours", async () => {
    const wb = new ExcelJS.Workbook();
    const week1 = wb.addWorksheet("Week 1");
    week1.addRow(["Name", "Hours", "Rate"]);
    week1.addRow(["Jane Doe", 40, 100]);
    week1.addRow(["Solo Person", 8, 100]);
    const week2 = wb.addWorksheet("Week 2");
    week2.addRow(["Name", "Hours", "Rate"]);
    week2.addRow(["JANE DOE", 16, 100]);
    const buf = Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer);

    const result = await parseTimeFile(buf, "multi.xlsx");

    expect(result.lines).toHaveLength(3);
    expect(
      result.warnings.some((w) => w.includes("Jane Doe appears on 2 sheets") && w.includes("56 total hours")),
    ).toBe(true);
    expect(result.warnings.some((w) => w.includes("Solo Person appears"))).toBe(false);
  });

  it("does not emit a multi-sheet warning for single-sheet or CSV imports", async () => {
    const rows = [
      ["Name", "Hours", "Rate"],
      ["Jane Doe", "40", "100"],
      ["Jane Doe", "16", "100"],
    ];
    const csv = await parseTimeFile(csvBuffer(rows), "t.csv");
    const xlsx = await parseTimeFile(
      await xlsxBuffer(rows.map((r) => [...r])),
      "t.xlsx",
    );

    expect(csv.lines).toHaveLength(2);
    expect(csv.warnings.some((w) => w.includes("appears on"))).toBe(false);
    expect(xlsx.lines).toHaveLength(2);
    expect(xlsx.warnings.some((w) => w.includes("appears on"))).toBe(false);
  });

  it("warns once when no sheet in a multi-sheet workbook has valid rows", async () => {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet("A").addRow(["Unrelated", "Stuff"]);
    wb.addWorksheet("B").addRow(["More", "Junk"]);
    const buf = Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer);

    const result = await parseTimeFile(buf, "junk.xlsx");

    expect(result.lines).toHaveLength(0);
    expect(result.warnings.filter((w) => w.includes("No valid line items"))).toHaveLength(1);
  });

  it("warns when an .xlsx workbook has no sheets", async () => {
    const wb = new ExcelJS.Workbook();
    const buf = Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer);

    const result = await parseTimeFile(buf, "empty.xlsx");

    expect(result.lines).toHaveLength(0);
    expect(result.warnings).toContain("The workbook has no sheets.");
  });
});

describe("POST /api/invoices/:id/time-import", () => {
  it("rejects an unsupported file extension", async () => {
    const wpId = await createWorkPlan();
    const invId = await createInvoice(wpId);
    const res = await request(app)
      .post(`/api/invoices/${invId}/time-import`)
      .attach("file", Buffer.from("hello"), "timesheet.exe");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Unsupported file type/);
  });

  it("rejects a binary document renamed to .csv", async () => {
    const wpId = await createWorkPlan();
    const invId = await createInvoice(wpId);
    const buf = await xlsxBuffer([["Name", "Hours"], ["Someone", 1]]);
    const res = await request(app)
      .post(`/api/invoices/${invId}/time-import`)
      .attach("file", buf, "timesheet.csv");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/does not match its extension/);
  });

  it("rejects plain text renamed to .xlsx", async () => {
    const wpId = await createWorkPlan();
    const invId = await createInvoice(wpId);
    const res = await request(app)
      .post(`/api/invoices/${invId}/time-import`)
      .attach("file", Buffer.from("Name,Hours\nA,1"), "timesheet.xlsx");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/does not match its extension/);
  });

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

  it("replaces prior auto-imported rows instead of duplicating on re-import", async () => {
    const wpId = await createWorkPlan();
    const invId = await createInvoice(wpId);
    const emp = await createEmployee({ name: `Reimport Worker ${Date.now()}`, homeRate: 100 });

    const buf = (): Buffer =>
      csvBuffer([
        ["Name", "Location", "Hours", "Rate"],
        [emp.name, "Home", "8", "100"],
      ]);

    const first = await request(app).post(`/api/invoices/${invId}/time-import`).attach("file", buf(), "timesheet.csv");
    expect(first.status).toBe(200);
    expect(first.body.importedCount).toBe(1);
    expect(first.body.replacedCount).toBe(0);

    const second = await request(app).post(`/api/invoices/${invId}/time-import`).attach("file", buf(), "timesheet.csv");
    expect(second.status).toBe(200);
    expect(second.body.importedCount).toBe(1);
    expect(second.body.replacedCount).toBe(1);
    expect(second.body.warnings.some((w: string) => /Replaced 1 previously imported/i.test(w))).toBe(true);

    const rows = await db.select().from(lineItemsTable).where(eq(lineItemsTable.invoiceId, invId));
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe("timesheet");
  });

  it("preserves manually-added rows when re-importing a period", async () => {
    const wpId = await createWorkPlan();
    const invId = await createInvoice(wpId);
    const emp = await createEmployee({ name: `Mixed Worker ${Date.now()}`, homeRate: 100 });

    // A hand-entered row should survive re-imports.
    const manual = await request(app)
      .post(`/api/invoices/${invId}/line-items`)
      .send({ employeeName: "Hand Entered", classification: "Engineer", category: "regular", location: "home", hours: 4, rate: 50 });
    expect(manual.status).toBe(201);

    const buf = (): Buffer =>
      csvBuffer([
        ["Name", "Location", "Hours", "Rate"],
        [emp.name, "Home", "8", "100"],
      ]);

    await request(app).post(`/api/invoices/${invId}/time-import`).attach("file", buf(), "timesheet.csv");
    const second = await request(app).post(`/api/invoices/${invId}/time-import`).attach("file", buf(), "timesheet.csv");
    expect(second.body.replacedCount).toBe(1);

    const rows = await db.select().from(lineItemsTable).where(eq(lineItemsTable.invoiceId, invId));
    expect(rows).toHaveLength(2);
    const manualRow = rows.find((r) => r.source === "manual");
    const importedRow = rows.find((r) => r.source === "timesheet");
    expect(manualRow?.employeeName).toBe("Hand Entered");
    expect(importedRow).toBeDefined();
  });

  // Real users upload binary .xlsx workbooks through the UI, so the full request
  // path (multipart upload of a binary workbook, employee matching, persistence)
  // must work for Excel exactly as it does for CSV.
  it("imports a real .xlsx workbook, matching an employee by name (case-insensitive)", async () => {
    const wpId = await createWorkPlan();
    const invId = await createInvoice(wpId);
    const emp = await createEmployee({
      name: `Xlsx Matched ${Date.now()}`,
      classification: "Principal Engineer",
      homeRate: 200,
    });

    const buf = await xlsxBuffer([
      ["Name", "Hours", "Rate"],
      [emp.name.toUpperCase(), 10, 175],
    ]);

    const res = await request(app)
      .post(`/api/invoices/${invId}/time-import`)
      .attach("file", buf, "timesheet.xlsx");

    expect(res.status).toBe(200);
    expect(res.body.importedCount).toBe(1);
    const li = res.body.lineItems[0];
    expect(li.employeeId).toBe(emp.id);
    expect(li.classification).toBe("Principal Engineer");
    expect(li.rate).toBe(175);
    expect(li.amount).toBe(10 * 175);
  });

  it("falls back to the employee field rate for an .xlsx upload with no rate", async () => {
    const wpId = await createWorkPlan();
    const invId = await createInvoice(wpId);
    const emp = await createEmployee({
      name: `Xlsx Field Worker ${Date.now()}`,
      homeRate: 100,
      fieldRate: 130,
    });

    const buf = await xlsxBuffer([
      ["Name", "Location", "Hours", "Rate"],
      [emp.name, "Field", 8, ""],
    ]);

    const res = await request(app)
      .post(`/api/invoices/${invId}/time-import`)
      .attach("file", buf, "timesheet.xlsx");

    expect(res.status).toBe(200);
    const li = res.body.lineItems[0];
    expect(li.location).toBe("field");
    expect(li.rate).toBe(130);
    expect(li.amount).toBe(8 * 130);
  });

  it("persists .xlsx-imported line items whose amount equals hours times the resolved rate", async () => {
    const wpId = await createWorkPlan();
    const invId = await createInvoice(wpId);
    const emp = await createEmployee({
      name: `Xlsx Persisted ${Date.now()}`,
      homeRate: 100,
      fieldRate: 160,
    });

    const buf = await xlsxBuffer([
      ["Name", "Location", "Hours", "Rate"],
      [emp.name, "Field", 6, ""],
    ]);

    const res = await request(app)
      .post(`/api/invoices/${invId}/time-import`)
      .attach("file", buf, "timesheet.xlsx");
    expect(res.status).toBe(200);

    const rows = await db.select().from(lineItemsTable).where(eq(lineItemsTable.invoiceId, invId));
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe("timesheet");
    expect(rows[0].rate).toBe(160);
    expect(rows[0].hours).toBe(6);
    expect(rows[0].amount).toBe(6 * 160);
  });

  it("imports multiple rows from a single .xlsx workbook with normalized categories", async () => {
    const wpId = await createWorkPlan();
    const invId = await createInvoice(wpId);

    const buf = await xlsxBuffer([
      ["Employee", "Classification", "Category", "Location", "Hours", "Rate"],
      [`Xlsx OT ${Date.now()}`, "Senior Engineer", "Overtime", "Field", 8, 150],
      [`Xlsx Reg ${Date.now()}`, "Engineer", "Regular", "Home", 40, 100],
    ]);

    const res = await request(app)
      .post(`/api/invoices/${invId}/time-import`)
      .attach("file", buf, "timesheet.xlsx");

    expect(res.status).toBe(200);
    expect(res.body.importedCount).toBe(2);
    const [ot, reg] = res.body.lineItems;
    expect(ot).toMatchObject({ category: "ot", location: "field", hours: 8, rate: 150, amount: 8 * 150 });
    expect(reg).toMatchObject({ category: "regular", location: "home", hours: 40, rate: 100, amount: 40 * 100 });

    const rows = await db.select().from(lineItemsTable).where(eq(lineItemsTable.invoiceId, invId));
    expect(rows).toHaveLength(2);
  });
});
