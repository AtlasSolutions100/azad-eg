import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
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

async function seedPackage(status = "approved", opts: { withWeeks?: boolean } = {}): Promise<number> {
  const withWeeks = opts.withWeeks ?? true;
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

  if (!withWeeks) return pkg.id;

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
 * Seeds a package whose timesheet entries come from two different employees
 * that share the exact same name (distinct employeeId). Person A works 40h at
 * $100 (home) and person B works 8h at $120 (field), so their contributions
 * are distinguishable by hours/cost even though the names are identical.
 */
async function seedSharedNamePackage(): Promise<{
  pkgId: number;
  sharedName: string;
  empAId: number;
  empBId: number;
}> {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const sharedName = `Jordan Same ${suffix}`;
  const [empA] = await db
    .insert(employeesTable)
    .values({ name: sharedName, classification: "Engineer", homeRate: 100, fieldRate: 120 })
    .returning();
  const [empB] = await db
    .insert(employeesTable)
    .values({ name: sharedName, classification: "Inspector", homeRate: 110, fieldRate: 120 })
    .returning();
  createdEmployeeIds.push(empA.id, empB.id);

  const [wp] = await db
    .insert(workPlansTable)
    .values({
      code: `TEST-WP-${suffix}`,
      title: "Shared Name Work Plan",
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
      employeeId: empA.id,
      workPlanId: wp.id,
      payPeriodStart: "2026-01-05",
      payPeriodEnd: "2026-01-18",
      invoiceNumber,
      invoiceDate: "2026-01-20",
      status: "draft",
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
      employeeId: empA.id,
      employeeName: sharedName,
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
      employeeId: empB.id,
      employeeName: sharedName,
      classification: "Inspector",
      category: "regular",
      location: "field",
      hoursMon: 4,
      hoursTue: 4,
      rate: 120,
    },
  ]);

  return { pkgId: pkg.id, sharedName, empAId: empA.id, empBId: empB.id };
}

/**
 * Reads the authoritative entry count from the ZIP End Of Central Directory
 * record (signature PK\x05\x06; total-entries is a uint16 LE at offset +10).
 * Scanning local-header signatures is unreliable because compressed payloads
 * (xlsx files are themselves ZIPs) can coincidentally contain those bytes.
 */
function findEocd(buf: Buffer): number {
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf[i] === 0x50 && buf[i + 1] === 0x4b && buf[i + 2] === 0x05 && buf[i + 3] === 0x06) {
      return i;
    }
  }
  return -1;
}

function countZipEntries(zipPath: string): number {
  const buf = fs.readFileSync(zipPath);
  const eocd = findEocd(buf);
  return eocd >= 0 ? buf.readUInt16LE(eocd + 10) : -1;
}

/**
 * Extracts one entry (matched by filename suffix) from a ZIP by walking the
 * central directory. Intermediate xlsx/pdf files are deleted after zipping,
 * so tests must read the combined documents out of the ZIP itself.
 */
function readZipEntry(zipPath: string, suffix: string): Buffer {
  const buf = fs.readFileSync(zipPath);
  const eocd = findEocd(buf);
  if (eocd < 0) throw new Error("EOCD not found");
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error("Bad central directory entry");
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString("utf8", off + 46, off + 46 + nameLen);
    if (name.endsWith(suffix)) {
      const lNameLen = buf.readUInt16LE(localOff + 26);
      const lExtraLen = buf.readUInt16LE(localOff + 28);
      const dataStart = localOff + 30 + lNameLen + lExtraLen;
      const data = buf.subarray(dataStart, dataStart + compSize);
      return method === 0 ? Buffer.from(data) : zlib.inflateRawSync(data);
    }
    off += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error(`Entry ending with "${suffix}" not found in ${path.basename(zipPath)}`);
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
    "bundles exactly one combined Excel workbook and one merged PDF into a ZIP",
    async () => {
      const pkgId = await seedPackage("approved");

      const res = await request(app).post(`/api/packages/${pkgId}/export`).send({});

      expect(res.status).toBe(200);
      expect(res.body.filename).toMatch(/\.zip$/);
      expect(res.body.documentCount).toBe(2);
      expect(res.body.documents).toHaveLength(2);

      const xlsxDocs = res.body.documents.filter((d: { format: string }) => d.format === "xlsx");
      const pdfDocs = res.body.documents.filter((d: { format: string }) => d.format === "pdf");
      expect(xlsxDocs).toHaveLength(1);
      expect(pdfDocs).toHaveLength(1);
      for (const d of res.body.documents) expect(d.doc).toBe("package");

      const zipPath = path.resolve(generatedDir, res.body.filename);
      expect(fs.existsSync(zipPath)).toBe(true);
      expect(fs.statSync(zipPath).size).toBeGreaterThan(0);
      expect(countZipEntries(zipPath)).toBe(2);

      // An approved package transitions to exported and all doc statuses ready.
      const [row] = await db.select().from(packagesTable).where(eq(packagesTable.id, pkgId));
      expect(row.status).toBe("exported");
      expect(row.invoiceDocStatus).toBe("ready");
      expect(row.timesheetsDocStatus).toBe("ready");
    },
    120000,
  );

  it(
    "combined workbook tabs are ordered Overview → Invoice → Sub Calc → Labor Attachment → Progress Report → weekly tabs",
    async () => {
      const ExcelJS = (await import("exceljs")).default;
      const pkgId = await seedPackage("approved");

      const before = new Set(fs.readdirSync(generatedDir));
      const res = await request(app).post(`/api/packages/${pkgId}/export`).send({});
      expect(res.status).toBe(200);

      // Intermediate combined files are deleted after zipping; only the ZIP remains.
      const fresh = fs.readdirSync(generatedDir).filter((f) => !before.has(f));
      expect(fresh.filter((f) => f.startsWith("InvoicePackage_"))).toHaveLength(0);

      const zipPath = path.resolve(generatedDir, res.body.filename);
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(readZipEntry(zipPath, "_InvoicePackage.xlsx") as unknown as Parameters<typeof wb.xlsx.load>[0]);
      const names = wb.worksheets.map((ws) => ws.name);
      expect(names.slice(0, 5)).toEqual([
        "Overview",
        "Invoice",
        "Sub Calc",
        "Labor Attachment",
        "Progress Report",
      ]);
      // Seeded package has exactly one week → exactly one weekly timesheet tab.
      expect(names).toHaveLength(6);
    },
    120000,
  );

  it(
    "a package with no weeks exports no timesheet tabs and no template placeholder",
    async () => {
      const ExcelJS = (await import("exceljs")).default;
      const { PDFDocument } = await import("pdf-lib");
      const pkgId = await seedPackage("approved", { withWeeks: false });

      const before = new Set(fs.readdirSync(generatedDir));
      const res = await request(app).post(`/api/packages/${pkgId}/export`).send({});
      expect(res.status).toBe(200);
      expect(res.body.documentCount).toBe(2);

      // Intermediate combined files are deleted after zipping; only the ZIP remains.
      const fresh = fs.readdirSync(generatedDir).filter((f) => !before.has(f));
      expect(fresh.filter((f) => f.startsWith("InvoicePackage_"))).toHaveLength(0);

      const zipPath = path.resolve(generatedDir, res.body.filename);
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(readZipEntry(zipPath, "_InvoicePackage.xlsx") as unknown as Parameters<typeof wb.xlsx.load>[0]);
      expect(wb.worksheets.map((ws) => ws.name)).toEqual([
        "Overview",
        "Invoice",
        "Sub Calc",
        "Labor Attachment",
        "Progress Report",
      ]);

      const pdf = await PDFDocument.load(readZipEntry(zipPath, "_InvoicePackage.pdf"));
      expect(pdf.getPageCount()).toBeGreaterThan(0);
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
    await db.update(workPlansTable).set({ totalBudget: 1 }).where(eq(workPlansTable.id, pkg.workPlanId!));
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

  it("rejects an override with a missing or blank reason (400)", async () => {
    const pkgId = await seedOverBudgetDraft();

    const missing = await request(app)
      .patch(`/api/packages/${pkgId}`)
      .send({ status: "approved", approvedBy: "Approver", budgetOverride: true });
    expect(missing.status).toBe(400);
    expect(missing.body.code).toBe("BUDGET_OVERRIDE_REASON_REQUIRED");

    const blank = await request(app)
      .patch(`/api/packages/${pkgId}`)
      .send({ status: "approved", approvedBy: "Approver", budgetOverride: true, budgetOverrideReason: "   " });
    expect(blank.status).toBe(400);
    expect(blank.body.code).toBe("BUDGET_OVERRIDE_REASON_REQUIRED");

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
  package: "InvoicePackage",
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
  const [emp] = await db.select().from(employeesTable).where(eq(employeesTable.id, pkg.employeeId!));
  const [wp] = await db.select().from(workPlansTable).where(eq(workPlansTable.id, pkg.workPlanId!));
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
      await db.update(workPlansTable).set({ jobNumber: "" }).where(eq(workPlansTable.id, pkg.workPlanId!));
      const [emp] = await db.select().from(employeesTable).where(eq(employeesTable.id, pkg.employeeId!));

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
      await db.update(workPlansTable).set({ jobNumber: "" }).where(eq(workPlansTable.id, pkg.workPlanId!));
      await db.update(employeesTable).set({ name: "" }).where(eq(employeesTable.id, pkg.employeeId!));
      // File names now derive contributor names from timesheet entries, so
      // blank those out too to exercise the ultimate Package-<id> fallback.
      await db.update(timesheetEntriesTable).set({ employeeName: "" }).where(eq(timesheetEntriesTable.packageId, pkgId));

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

describe("two contributors sharing a name stay separate", () => {
  it("lists both people in PackageSummary.employees[] keyed by employeeId", async () => {
    const { pkgId, sharedName, empAId, empBId } = await seedSharedNamePackage();

    const res = await request(app).get(`/api/packages/${pkgId}`);
    expect(res.status).toBe(200);

    const employees = res.body.package.employees as {
      employeeId: number | null;
      employeeName: string;
      hours: number;
      laborCost: number;
    }[];
    expect(employees).toHaveLength(2);
    expect(employees.map((e) => e.employeeId).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual(
      [empAId, empBId].sort((a, b) => a - b),
    );
    for (const e of employees) expect(e.employeeName).toBe(sharedName);

    const byId = new Map(employees.map((e) => [e.employeeId, e]));
    expect(byId.get(empAId)).toMatchObject({ hours: 40, laborCost: 4000 });
    expect(byId.get(empBId)).toMatchObject({ hours: 8, laborCost: 960 });

    // Sorted by descending labor cost, so the 40h person leads and the
    // contributor label reflects two distinct people.
    expect(employees[0].employeeId).toBe(empAId);
    expect(res.body.package.employeeName).toBe(`${sharedName} +1 more`);
  });

  it(
    "exports a separate weekly timesheet sheet per person",
    async () => {
      const ExcelJS = (await import("exceljs")).default;
      const { pkgId, sharedName } = await seedSharedNamePackage();

      const res = await request(app)
        .post(`/api/packages/${pkgId}/documents/timesheets/generate`)
        .send({ format: "xlsx" });
      expect(res.status).toBe(200);

      const wb = new ExcelJS.Workbook();
      await wb.xlsx.readFile(path.resolve(generatedDir, res.body.filename));

      // One week × two contributors → exactly two sheets, with unique names.
      expect(wb.worksheets).toHaveLength(2);
      const names = wb.worksheets.map((ws) => ws.name);
      expect(new Set(names.map((n) => n.toLowerCase())).size).toBe(2);

      // Each sheet carries exactly one person's hours: 40h regular (Mon-Fri
      // 8s) for person A, 8h regular (Mon+Tue 4s) for person B — never merged.
      const cell = (ws: import("exceljs").Worksheet, addr: string): number => {
        const v = ws.getCell(addr).value as unknown;
        return typeof v === "number" ? v : Number((v as { result?: number })?.result ?? 0) || 0;
      };
      const weekTotals = wb.worksheets.map((ws) => {
        expect(String(ws.getCell("C5").value ?? "")).toBe(sharedName);
        return (
          cell(ws, "I9") + cell(ws, "J9") + cell(ws, "K9") + cell(ws, "L9") + cell(ws, "M9") +
          cell(ws, "G9") + cell(ws, "H9")
        );
      });
      expect(weekTotals.sort((a, b) => a - b)).toEqual([8, 40]);
    },
    60000,
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
