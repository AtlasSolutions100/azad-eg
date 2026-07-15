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

// Valid magic bytes: detectImage inspects the PNG 8-byte signature / JPEG SOI marker.
const REAL_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
const REAL_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
// Not an image at all: plain text bytes renamed to .png with an image MIME type.
const FAKE_PNG = Buffer.from("#!/bin/sh\necho definitely not an image\n", "utf8");

const createdSignatureIds: number[] = [];

function listSignatureFiles(): string[] {
  if (!fs.existsSync(uploadsDir)) return [];
  return fs.readdirSync(uploadsDir).filter((f) => f.startsWith("signature_"));
}

beforeEach(() => {
  authState.userId = "test-user";
});

afterAll(async () => {
  if (createdSignatureIds.length > 0) {
    await db
      .delete(auditLogsTable)
      .where(and(eq(auditLogsTable.entityType, "signature"), inArray(auditLogsTable.entityId, createdSignatureIds)));
    const rows = await db
      .delete(signaturesTable)
      .where(inArray(signaturesTable.id, createdSignatureIds))
      .returning();
    for (const row of rows) {
      const abs = path.resolve(uploadsDir, path.basename(decodeURIComponent(row.imageUrl)));
      if (fs.existsSync(abs)) fs.unlinkSync(abs);
    }
  }
});

describe("POST /api/signatures content validation", () => {
  it("rejects a file whose bytes are not a real image, even with a .png name and image MIME", async () => {
    const before = listSignatureFiles();

    const res = await request(app)
      .post("/api/signatures")
      .field("name", `Fake Sig ${Date.now()}`)
      .attach("file", FAKE_PNG, { filename: "totally-real.png", contentType: "image/png" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not a valid PNG or JPEG/i);
    // Nothing must be written to storage for a rejected upload.
    expect(listSignatureFiles()).toEqual(before);
  });

  it("rejects a non-image MIME type outright (multer fileFilter drops the file)", async () => {
    const before = listSignatureFiles();

    const res = await request(app)
      .post("/api/signatures")
      .field("name", `Fake Sig ${Date.now()}`)
      .attach("file", FAKE_PNG, { filename: "notes.txt", contentType: "text/plain" });

    expect(res.status).toBe(400);
    expect(listSignatureFiles()).toEqual(before);
  });

  it("accepts a genuine PNG", async () => {
    const res = await request(app)
      .post("/api/signatures")
      .field("name", `Real PNG Sig ${Date.now()}`)
      .attach("file", REAL_PNG, { filename: "sig.png", contentType: "image/png" });

    expect(res.status).toBe(201);
    const { id, imageUrl } = res.body as { id: number; imageUrl: string };
    createdSignatureIds.push(id);
    expect(imageUrl).toMatch(/\.png$/);

    const abs = path.resolve(uploadsDir, path.basename(decodeURIComponent(imageUrl)));
    expect(fs.existsSync(abs)).toBe(true);
  });

  it("accepts a genuine JPEG and normalizes the extension server-side", async () => {
    const res = await request(app)
      .post("/api/signatures")
      .field("name", `Real JPEG Sig ${Date.now()}`)
      .attach("file", REAL_JPEG, { filename: "sig.jpeg", contentType: "image/jpeg" });

    expect(res.status).toBe(201);
    const { id, imageUrl } = res.body as { id: number; imageUrl: string };
    createdSignatureIds.push(id);
    expect(imageUrl).toMatch(/\.jpg$/);

    const abs = path.resolve(uploadsDir, path.basename(decodeURIComponent(imageUrl)));
    expect(fs.existsSync(abs)).toBe(true);
  });
});
