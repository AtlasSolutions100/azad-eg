import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { inArray } from "drizzle-orm";
import fs from "node:fs";
import path from "node:path";
import { uploadsDir } from "../lib/paths";

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
const { db, packagesTable, employeesTable, workPlansTable } = await import("@workspace/db");

const createdPackageIds: number[] = [];
const createdWorkPlanIds: number[] = [];
const createdEmployeeIds: number[] = [];
const writtenFiles: string[] = [];

async function seedPackage(): Promise<number> {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const [emp] = await db
    .insert(employeesTable)
    .values({ name: `UploadErr Emp ${suffix}`, classification: "Engineer", homeRate: 100, fieldRate: 120 })
    .returning();
  createdEmployeeIds.push(emp.id);

  const [wp] = await db
    .insert(workPlansTable)
    .values({
      code: `UPERR-WP-${suffix}`,
      title: "Upload Error Work Plan",
      client: "Test Client",
      jobNumber: "UPERR-JOB",
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
      invoiceNumber: `UPERR-PKG-${suffix}`,
      invoiceDate: "2026-01-20",
      status: "draft",
    })
    .returning();
  createdPackageIds.push(pkg.id);
  return pkg.id;
}

beforeEach(() => {
  authState.userId = "test-user";
});

afterAll(async () => {
  for (const abs of writtenFiles) {
    if (fs.existsSync(abs)) fs.unlinkSync(abs);
  }
  if (createdPackageIds.length > 0) {
    await db.delete(packagesTable).where(inArray(packagesTable.id, createdPackageIds));
  }
  if (createdWorkPlanIds.length > 0) {
    await db.delete(workPlansTable).where(inArray(workPlansTable.id, createdWorkPlanIds));
  }
  if (createdEmployeeIds.length > 0) {
    await db.delete(employeesTable).where(inArray(employeesTable.id, createdEmployeeIds));
  }
});

// Real magic bytes so accepted uploads pass the content check.
const REAL_PDF = Buffer.from("%PDF-1.7\nfake body\n", "utf8");
// Plain text bytes: fails detectDocument regardless of the claimed extension.
const NOT_A_DOCUMENT = Buffer.from("#!/bin/sh\necho definitely not a document\n", "utf8");

describe("POST /api/packages/:id/progress-report/upload error codes", () => {
  it("returns code NO_FILE when no file is attached", async () => {
    const id = await seedPackage();
    const res = await request(app).post(`/api/packages/${id}/progress-report/upload`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("NO_FILE");
  });

  it("returns code UNSUPPORTED_EXTENSION for a disallowed extension", async () => {
    const id = await seedPackage();
    const res = await request(app)
      .post(`/api/packages/${id}/progress-report/upload`)
      .attach("file", NOT_A_DOCUMENT, { filename: "notes.txt", contentType: "text/plain" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("UNSUPPORTED_EXTENSION");
  });

  it("returns code CONTENT_MISMATCH when bytes don't match the extension", async () => {
    const id = await seedPackage();
    const res = await request(app)
      .post(`/api/packages/${id}/progress-report/upload`)
      .attach("file", NOT_A_DOCUMENT, {
        filename: "report.xlsx",
        contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("CONTENT_MISMATCH");
    expect(res.body.error).toMatch(/does not match its extension/i);
  });

  it("returns code CONTENT_MISMATCH when a PDF is renamed to .xlsx", async () => {
    const id = await seedPackage();
    const res = await request(app)
      .post(`/api/packages/${id}/progress-report/upload`)
      .attach("file", REAL_PDF, {
        filename: "report.xlsx",
        contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("CONTENT_MISMATCH");
  });

  it("returns code FILE_TOO_LARGE when the file exceeds the 25 MB limit", async () => {
    const id = await seedPackage();
    const big = Buffer.alloc(26 * 1024 * 1024, 0x41);
    big.set(Buffer.from("%PDF-1.7\n", "utf8"), 0);
    const res = await request(app)
      .post(`/api/packages/${id}/progress-report/upload`)
      .attach("file", big, { filename: "huge.pdf", contentType: "application/pdf" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("FILE_TOO_LARGE");
  });

  it("accepts a genuine PDF", async () => {
    const id = await seedPackage();
    const res = await request(app)
      .post(`/api/packages/${id}/progress-report/upload`)
      .attach("file", REAL_PDF, { filename: "report.pdf", contentType: "application/pdf" });
    expect(res.status).toBe(200);
    expect(res.body.uploadedFileName).toBe("report.pdf");
    const filename = path.basename(decodeURIComponent(res.body.uploadedFileUrl as string));
    writtenFiles.push(path.resolve(uploadsDir, filename));
  });
});
