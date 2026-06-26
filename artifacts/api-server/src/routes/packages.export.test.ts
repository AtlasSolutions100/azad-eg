import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import fs from "node:fs";
import path from "node:path";
import { generatedDir } from "../lib/paths";

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
  auditLogsTable,
} = await import("@workspace/db");

const createdPackageIds: number[] = [];
const createdWorkPlanIds: number[] = [];
const createdEmployeeIds: number[] = [];
const createdFilePrefixes: string[] = [];

async function seedPackage(status = "approved"): Promise<number> {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const [emp] = await db
    .insert(employeesTable)
    .values({ name: `Test Emp ${suffix}`, classification: "Engineer", homeRate: 100, fieldRate: 120 })
    .returning();
  createdEmployeeIds.push(emp.id);

  const [wp] = await db
    .insert(workPlansTable)
    .values({
      code: `TEST-WP-${suffix}`,
      title: "Test Work Plan",
      client: "Test Client",
      jobNumber: "TEST-JOB",
      poNumber: "PO-123",
      totalBudget: 500000,
    })
    .returning();
  createdWorkPlanIds.push(wp.id);

  const invoiceNumber = `TEST-PKG-${suffix}`;
  const [pkg] = await db
    .insert(packagesTable)
    .values({
      employeeId: emp.id,
      workPlanId: wp.id,
      payPeriodStart: "2026-01-05",
      payPeriodEnd: "2026-01-18",
      invoiceNumber,
      invoiceDate: "2026-01-20",
      status,
    })
    .returning();
  createdPackageIds.push(pkg.id);
  createdFilePrefixes.push(invoiceNumber);

  const [week] = await db
    .insert(packageWeeksTable)
    .values({
      packageId: pkg.id,
      label: "Week 1",
      weekStart: "2026-01-05",
      weekEnd: "2026-01-11",
      sortOrder: 0,
    })
    .returning();

  await db.insert(timesheetEntriesTable).values([
    {
      packageId: pkg.id,
      weekId: week.id,
      employeeName: emp.name,
      classification: "Engineer",
      category: "regular",
      location: "home",
      hoursMon: 8,
      hoursTue: 8,
      hoursWed: 8,
      hoursThu: 8,
      hoursFri: 8,
      rate: 100,
    },
    {
      packageId: pkg.id,
      weekId: week.id,
      employeeName: emp.name,
      classification: "Engineer",
      category: "regular",
      location: "field",
      hoursMon: 4,
      rate: 120,
    },
  ]);

  return pkg.id;
}

/**
 * Reads the authoritative entry count from the ZIP End Of Central Directory
 * record (signature PK\x05\x06; total-entries is a uint16 LE at offset +10).
 * Scanning local-header signatures is unreliable because compressed payloads
 * (xlsx files are themselves ZIPs) can coincidentally contain those bytes.
 */
function countZipEntries(zipPath: string): number {
  const buf = fs.readFileSync(zipPath);
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf[i] === 0x50 && buf[i + 1] === 0x4b && buf[i + 2] === 0x05 && buf[i + 3] === 0x06) {
      return buf.readUInt16LE(i + 10);
    }
  }
  return -1;
}

beforeAll(() => {
  authState.userId = "test-user";
});

afterAll(async () => {
  if (createdPackageIds.length > 0) {
    await db.delete(timesheetEntriesTable).where(inArray(timesheetEntriesTable.packageId, createdPackageIds));
    await db.delete(packageWeeksTable).where(inArray(packageWeeksTable.packageId, createdPackageIds));
    await db.delete(auditLogsTable).where(inArray(auditLogsTable.entityId, createdPackageIds));
    await db.delete(packagesTable).where(inArray(packagesTable.id, createdPackageIds));
  }
  if (createdWorkPlanIds.length > 0) {
    await db.delete(workPlansTable).where(inArray(workPlansTable.id, createdWorkPlanIds));
  }
  if (createdEmployeeIds.length > 0) {
    await db.delete(employeesTable).where(inArray(employeesTable.id, createdEmployeeIds));
  }
  // Remove generated files (xlsx/pdf/zip) produced for the seeded packages.
  if (createdFilePrefixes.length > 0 && fs.existsSync(generatedDir)) {
    for (const file of fs.readdirSync(generatedDir)) {
      if (createdFilePrefixes.some((p) => file.includes(p))) {
        fs.rmSync(path.resolve(generatedDir, file), { force: true });
      }
    }
  }
});

describe("POST /api/packages/:id/export", () => {
  it(
    "bundles all five documents plus three PDFs into a ZIP",
    async () => {
      const pkgId = await seedPackage("approved");

      const res = await request(app).post(`/api/packages/${pkgId}/export`).send({});

      expect(res.status).toBe(200);
      expect(res.body.filename).toMatch(/\.zip$/);
      expect(res.body.documentCount).toBe(8);
      expect(res.body.documents).toHaveLength(8);

      const xlsxDocs = res.body.documents.filter((d: { format: string }) => d.format === "xlsx");
      const pdfDocs = res.body.documents.filter((d: { format: string }) => d.format === "pdf");
      expect(xlsxDocs).toHaveLength(5);
      expect(pdfDocs).toHaveLength(3);

      const zipPath = path.resolve(generatedDir, res.body.filename);
      expect(fs.existsSync(zipPath)).toBe(true);
      expect(fs.statSync(zipPath).size).toBeGreaterThan(0);
      expect(countZipEntries(zipPath)).toBe(8);

      // An approved package transitions to exported and all doc statuses ready.
      const [row] = await db.select().from(packagesTable).where(eq(packagesTable.id, pkgId));
      expect(row.status).toBe("exported");
      expect(row.invoiceDocStatus).toBe("ready");
      expect(row.timesheetsDocStatus).toBe("ready");
    },
    120000,
  );

  it("returns 404 for a missing package", async () => {
    const res = await request(app).post(`/api/packages/99999999/export`).send({});
    expect(res.status).toBe(404);
  });

  it("returns 401 when unauthenticated", async () => {
    authState.userId = null;
    const res = await request(app).post(`/api/packages/1/export`).send({});
    expect(res.status).toBe(401);
    authState.userId = "test-user";
  });
});

describe("POST /api/packages/:id/documents/:doc/generate", () => {
  it(
    "generates a single xlsx document and marks its status ready",
    async () => {
      const pkgId = await seedPackage("draft");

      const res = await request(app)
        .post(`/api/packages/${pkgId}/documents/labor/generate`)
        .send({ format: "xlsx" });

      expect(res.status).toBe(200);
      expect(res.body.format).toBe("xlsx");
      expect(res.body.filename).toMatch(/\.xlsx$/);

      const [row] = await db.select().from(packagesTable).where(eq(packagesTable.id, pkgId));
      expect(row.laborAttachmentDocStatus).toBe("ready");
    },
    60000,
  );

  it("rejects an unknown document type with 400", async () => {
    const pkgId = await seedPackage("draft");
    const res = await request(app)
      .post(`/api/packages/${pkgId}/documents/bogus/generate`)
      .send({ format: "xlsx" });
    expect(res.status).toBe(400);
  });

  it(
    "injects authoritative SubCalc leaves while preserving roll-up formulas",
    async () => {
      const ExcelJS = (await import("exceljs")).default;
      const pkgId = await seedPackage("draft");

      const res = await request(app)
        .post(`/api/packages/${pkgId}/documents/subcalc/generate`)
        .send({ format: "xlsx" });
      expect(res.status).toBe(200);

      const wb = new ExcelJS.Workbook();
      await wb.xlsx.readFile(path.resolve(generatedDir, res.body.filename));
      const ws = wb.getWorksheet("Sub Calc _revised")!;
      const num = (addr: string): number => {
        const v = ws.getCell(addr).value as unknown;
        return typeof v === "number" ? v : Number((v as { result?: number })?.result ?? NaN);
      };
      const isFormula = (addr: string): boolean => {
        const v = ws.getCell(addr).value as unknown;
        return !!v && typeof v === "object" && "formula" in (v as object);
      };

      // Authoritative leaf cells injected as plain numbers.
      expect(num("H7")).toBeCloseTo(4000, 2); // home straight-time labor
      expect(num("H11")).toBeCloseTo(480, 2); // field straight-time labor
      expect(num("H24")).toBe(0); // no OT/DT premium seeded
      expect(num("H25")).toBe(0);
      // Headline total is force-set (authoritative cross-doc rollup).
      expect(num("H51")).toBeGreaterThan(4480);
      expect(isFormula("H51")).toBe(false);
      // Intermediate roll-up SUBTOTAL formulas are preserved, not clobbered.
      expect(isFormula("H31")).toBe(true);
      expect(isFormula("H20")).toBe(true);
    },
    60000,
  );
});
