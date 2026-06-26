import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
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
const { db, signaturesTable, auditLogsTable } = await import("@workspace/db");

// A minimal but valid PNG: the 8-byte signature is all detectImage inspects.
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);

const createdSignatureIds: number[] = [];

beforeEach(() => {
  authState.userId = "test-user";
});

afterAll(async () => {
  if (createdSignatureIds.length > 0) {
    await db
      .delete(auditLogsTable)
      .where(and(eq(auditLogsTable.entityType, "signature"), inArray(auditLogsTable.entityId, createdSignatureIds)));
    await db.delete(signaturesTable).where(inArray(signaturesTable.id, createdSignatureIds));
  }
});

describe("DELETE /api/signatures/:id image cleanup", () => {
  it("removes the backing image file when the signature is deleted", async () => {
    const uploadRes = await request(app)
      .post("/api/signatures")
      .field("name", `Cleanup Sig ${Date.now()}`)
      .attach("file", PNG, { filename: "sig.png", contentType: "image/png" });

    expect(uploadRes.status).toBe(201);
    const { id, imageUrl } = uploadRes.body as { id: number; imageUrl: string };
    createdSignatureIds.push(id);

    const abs = path.resolve(uploadsDir, path.basename(decodeURIComponent(imageUrl)));
    expect(fs.existsSync(abs)).toBe(true);

    const deleteRes = await request(app).delete(`/api/signatures/${id}`);
    expect(deleteRes.status).toBe(204);
    expect(fs.existsSync(abs)).toBe(false);
  });
});
