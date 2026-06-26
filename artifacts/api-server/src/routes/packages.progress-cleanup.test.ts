import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { inArray } from "drizzle-orm";
import fs from "node:fs";
import path from "node:path";
import { uploadsDir, ensureDirs } from "../lib/paths";

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
  packageProgressReportsTable,
  employeesTable,
  workPlansTable,
  auditLogsTable,
} = await import("@workspace/db");

const createdPackageIds: number[] = [];
const createdWorkPlanIds: number[] = [];
const createdEmployeeIds: number[] = [];

async function seedPackage(): Promise<number> {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const [emp] = await db
    .insert(employeesTable)
    .values({ name: `Cleanup Emp ${suffix}`, classification: "Engineer", homeRate: 100, fieldRate: 120 })
    .returning();
  createdEmployeeIds.push(emp.id);

  const [wp] = await db
    .insert(workPlansTable)
    .values({
      code: `CLEAN-WP-${suffix}`,
      title: "Cleanup Work Plan",
      client: "Test Client",
      jobNumber: "CLEAN-JOB",
      poNumber: "PO-123",
      totalBudget: 500000,
    })
    .returning();
  createdWorkPlanIds.push(wp.id);

  const [pkg] = await db
    .insert(packagesTable)
    .values({
      employeeId: emp.id,
      workPlanId: wp.id,
      payPeriodStart: "2026-01-05",
      payPeriodEnd: "2026-01-18",
      invoiceNumber: `CLEAN-PKG-${suffix}`,
      invoiceDate: "2026-01-20",
      status: "draft",
    })
    .returning();
  createdPackageIds.push(pkg.id);
  return pkg.id;
}

/** Writes a placeholder upload file and returns [filename, publicUrl]. */
function writeUpload(pkgId: number): { filename: string; url: string; abs: string } {
  ensureDirs();
  const filename = `progress_${pkgId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.xlsx`;
  const abs = path.resolve(uploadsDir, filename);
  fs.writeFileSync(abs, "placeholder");
  return { filename, url: `/api/files/${encodeURIComponent(filename)}`, abs };
}

beforeEach(() => {
  authState.userId = "test-user";
});

afterAll(async () => {
  if (createdPackageIds.length > 0) {
    await db.delete(packageProgressReportsTable).where(inArray(packageProgressReportsTable.packageId, createdPackageIds));
    await db.delete(auditLogsTable).where(inArray(auditLogsTable.entityId, createdPackageIds));
    await db.delete(packagesTable).where(inArray(packagesTable.id, createdPackageIds));
  }
  if (createdWorkPlanIds.length > 0) {
    await db.delete(workPlansTable).where(inArray(workPlansTable.id, createdWorkPlanIds));
  }
  if (createdEmployeeIds.length > 0) {
    await db.delete(employeesTable).where(inArray(employeesTable.id, createdEmployeeIds));
  }
});

describe("PUT /api/packages/:id/progress-report attachment cleanup", () => {
  it("deletes the previous file when the attachment is replaced", async () => {
    const pkgId = await seedPackage();
    const oldFile = writeUpload(pkgId);
    await db.insert(packageProgressReportsTable).values({
      packageId: pkgId,
      percentComplete: 50,
      summary: "first",
      uploadedFileUrl: oldFile.url,
      uploadedFileName: "old.xlsx",
    });

    const newFile = writeUpload(pkgId);
    const res = await request(app)
      .put(`/api/packages/${pkgId}/progress-report`)
      .send({ uploadedFileUrl: newFile.url, uploadedFileName: "new.xlsx" });

    expect(res.status).toBe(200);
    expect(res.body.uploadedFileUrl).toBe(newFile.url);
    expect(fs.existsSync(oldFile.abs)).toBe(false);
    expect(fs.existsSync(newFile.abs)).toBe(true);
    fs.rmSync(newFile.abs, { force: true });
  });

  it("deletes the file when the attachment is cleared", async () => {
    const pkgId = await seedPackage();
    const oldFile = writeUpload(pkgId);
    await db.insert(packageProgressReportsTable).values({
      packageId: pkgId,
      percentComplete: 50,
      summary: "first",
      uploadedFileUrl: oldFile.url,
      uploadedFileName: "old.xlsx",
    });

    const res = await request(app)
      .put(`/api/packages/${pkgId}/progress-report`)
      .send({ uploadedFileUrl: "", uploadedFileName: "" });

    expect(res.status).toBe(200);
    expect(fs.existsSync(oldFile.abs)).toBe(false);
  });

  it("keeps the file when other fields change but the URL is unchanged", async () => {
    const pkgId = await seedPackage();
    const file = writeUpload(pkgId);
    await db.insert(packageProgressReportsTable).values({
      packageId: pkgId,
      percentComplete: 10,
      summary: "first",
      uploadedFileUrl: file.url,
      uploadedFileName: "keep.xlsx",
    });

    const res = await request(app)
      .put(`/api/packages/${pkgId}/progress-report`)
      .send({ summary: "updated", uploadedFileUrl: file.url, uploadedFileName: "keep.xlsx" });

    expect(res.status).toBe(200);
    expect(fs.existsSync(file.abs)).toBe(true);
    fs.rmSync(file.abs, { force: true });
  });
});

describe("DELETE /api/packages/:id attachment cleanup", () => {
  it("removes the attached progress-report file on cascade delete", async () => {
    const pkgId = await seedPackage();
    const file = writeUpload(pkgId);
    await db.insert(packageProgressReportsTable).values({
      packageId: pkgId,
      percentComplete: 50,
      summary: "first",
      uploadedFileUrl: file.url,
      uploadedFileName: "doomed.xlsx",
    });

    const res = await request(app).delete(`/api/packages/${pkgId}`);
    expect(res.status).toBe(204);
    expect(fs.existsSync(file.abs)).toBe(false);
  });
});
