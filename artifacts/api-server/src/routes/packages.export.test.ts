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

describe("PATCH /api/packages/:id over-budget approval", () => {
  // Forces a seeded draft package over its work plan budget by shrinking the
  // budget below the timesheet-derived total, then returns its id.
  async function seedOverBudgetDraft(): Promise<number> {
    const pkgId = await seedPackage("draft");
    const [pkg] = await db.select().from(packagesTable).where(eq(packagesTable.id, pkgId));
    await db.update(workPlansTable).set({ totalBudget: 1 }).where(eq(workPlansTable.id, pkg.workPlanId));
    return pkgId;
  }

  it("blocks approving an over-budget package without an override (422)", async () => {
    const pkgId = await seedOverBudgetDraft();

    const res = await request(app)
      .patch(`/api/packages/${pkgId}`)
      .send({ status: "approved", approvedBy: "Approver" });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe("BUDGET_OVERRIDE_REQUIRED");

    const [row] = await db.select().from(packagesTable).where(eq(packagesTable.id, pkgId));
    expect(row.status).toBe("draft");
  });

  it("approves an over-budget package with an override and logs it", async () => {
    const pkgId = await seedOverBudgetDraft();

    const res = await request(app)
      .patch(`/api/packages/${pkgId}`)
      .send({ status: "approved", approvedBy: "Approver", budgetOverride: true, budgetOverrideReason: "client amendment" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("approved");

    const audits = await db.select().from(auditLogsTable).where(eq(auditLogsTable.entityId, pkgId));
    const override = audits.find((a) => a.action === "approved over budget");
    expect(override).toBeDefined();
    expect(override?.description).toContain("client amendment");
  });

  it("allows non-approval edits on an over-budget package without an override", async () => {
    const pkgId = await seedOverBudgetDraft();

    const res = await request(app)
      .patch(`/api/packages/${pkgId}`)
      .send({ invoiceNumber: "EDIT-OK" });

    expect(res.status).toBe(200);
    expect(res.body.invoiceNumber).toBe("EDIT-OK");
  });
});

// Human-friendly document labels embedded in every export filename. Mirrors
// DOC_LABELS in packageDocs.ts; duplicated here so the test fails loudly if a
// label is renamed without updating the regression guard.
const DOC_LABELS: Record<string, string> = {
  invoice: "Invoice",
  subcalc: "SubCalc",
  progress: "ProgressReport",
  labor: "LaborAttachment",
  timesheets: "Timesheets",
};

// Mirrors sanitizeFilePart in packageDocs.ts.
function sanitizeFilePart(value: string): string {
  return value
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
    .replace(/\s+/g, " ")
    .trim();
}

// Derives the expected `EmployeeName_Job#` filename base for a seeded package
// straight from the database, so the assertion tracks the real data.
async function expectedFileBase(pkgId: number): Promise<string> {
  const [pkg] = await db.select().from(packagesTable).where(eq(packagesTable.id, pkgId));
  const [emp] = await db.select().from(employeesTable).where(eq(employeesTable.id, pkg.employeeId));
  const [wp] = await db.select().from(workPlansTable).where(eq(workPlansTable.id, pkg.workPlanId));
  const parts = [emp.name, wp.jobNumber].map((p) => sanitizeFilePart(p ?? "")).filter((p) => p.length > 0);
  return parts.join("_") || `Package-${pkgId}`;
}

function downloadNameFromUrl(url: string): string | null {
  return new URL(url, "http://test.local").searchParams.get("download");
}

describe("export filenames follow EmployeeName_Job#_DocumentName", () => {
  it(
    "names every ZIP entry EmployeeName_Job#_DocumentName.ext",
    async () => {
      const pkgId = await seedPackage("approved");

      const res = await request(app).post(`/api/packages/${pkgId}/export`).send({});
      expect(res.status).toBe(200);

      const base = await expectedFileBase(pkgId);
      const docs = res.body.documents as { doc: string; filename: string; format: string }[];
      expect(docs.length).toBeGreaterThan(0);
      for (const d of docs) {
        expect(d.filename).toBe(`${base}_${DOC_LABELS[d.doc]}.${d.format}`);
      }
    },
    120000,
  );

  it(
    "names the single-document download EmployeeName_Job#_DocumentName.ext",
    async () => {
      const pkgId = await seedPackage("draft");

      const res = await request(app)
        .post(`/api/packages/${pkgId}/documents/labor/generate`)
        .send({ format: "xlsx" });
      expect(res.status).toBe(200);

      const base = await expectedFileBase(pkgId);
      expect(downloadNameFromUrl(res.body.url)).toBe(`${base}_LaborAttachment.xlsx`);
    },
    60000,
  );

  it(
    "falls back to the employee name alone when the job number is missing",
    async () => {
      const pkgId = await seedPackage("draft");
      const [pkg] = await db.select().from(packagesTable).where(eq(packagesTable.id, pkgId));
      await db.update(workPlansTable).set({ jobNumber: "" }).where(eq(workPlansTable.id, pkg.workPlanId));
      const [emp] = await db.select().from(employeesTable).where(eq(employeesTable.id, pkg.employeeId));

      const res = await request(app)
        .post(`/api/packages/${pkgId}/documents/invoice/generate`)
        .send({ format: "xlsx" });
      expect(res.status).toBe(200);

      const download = downloadNameFromUrl(res.body.url);
      expect(download).toBe(`${sanitizeFilePart(emp.name)}_Invoice.xlsx`);
      // No empty Job# segment should leak in as a doubled underscore.
      expect(download).not.toContain("__");
    },
    60000,
  );

  it(
    "falls back to Package-<id> when both employee name and job number are missing",
    async () => {
      const pkgId = await seedPackage("draft");
      const [pkg] = await db.select().from(packagesTable).where(eq(packagesTable.id, pkgId));
      await db.update(workPlansTable).set({ jobNumber: "" }).where(eq(workPlansTable.id, pkg.workPlanId));
      await db.update(employeesTable).set({ name: "" }).where(eq(employeesTable.id, pkg.employeeId));

      const res = await request(app)
        .post(`/api/packages/${pkgId}/documents/invoice/generate`)
        .send({ format: "xlsx" });
      expect(res.status).toBe(200);

      expect(downloadNameFromUrl(res.body.url)).toBe(`Package-${pkgId}_Invoice.xlsx`);
    },
    60000,
  );
});

describe("exported workbooks carry no repair-triggering defined names", () => {
  // Valid in-workbook named ranges the templates' formulas depend on. These
  // must survive the strip; only #REF!/external `[...]` names get removed.
  const VALID_NAMES: Record<string, string[]> = {
    subcalc: ["BALANCE", "FIXFEE"],
    labor: ["consultant", "_xlnm._FilterDatabase"],
  };

  it(
    "strips #REF!/external defined names while keeping valid in-workbook ranges",
    async () => {
      const ExcelJS = (await import("exceljs")).default;
      const pkgId = await seedPackage("draft");
      const kinds = ["invoice", "subcalc", "progress", "labor", "timesheets"] as const;

      for (const kind of kinds) {
        const res = await request(app)
          .post(`/api/packages/${pkgId}/documents/${kind}/generate`)
          .send({ format: "xlsx" });
        expect(res.status).toBe(200);

        const wb = new ExcelJS.Workbook();
        await wb.xlsx.readFile(path.resolve(generatedDir, res.body.filename));
        const names = wb.definedNames.model.map((dn) => dn.name);

        for (const dn of wb.definedNames.model) {
          for (const range of dn.ranges) {
            expect(range, `${kind}: defined name ${dn.name} targets #REF!`).not.toMatch(/#REF!/i);
            expect(range, `${kind}: defined name ${dn.name} targets external workbook`).not.toMatch(
              /\[[^\]]+\]/,
            );
          }
        }
        // The broken external INVOICE name shipped in every template must be gone.
        expect(names).not.toContain("INVOICE");
        // Valid ranges the templates' formulas rely on must remain.
        for (const required of VALID_NAMES[kind] ?? []) {
          expect(names, `${kind} should still contain ${required}`).toContain(required);
        }
      }
    },
    120000,
  );
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
