import { beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
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

// Multer's fileSize limit is 25 MB; build a valid-looking PNG payload just past it
// so rejection is purely about size, not content sniffing.
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const OVERSIZED_PNG = Buffer.concat([PNG_MAGIC, Buffer.alloc(25 * 1024 * 1024 + 1024, 0)]);

function listSignatureFiles(): string[] {
  if (!fs.existsSync(uploadsDir)) return [];
  return fs.readdirSync(uploadsDir).filter((f) => f.startsWith("signature_"));
}

beforeEach(() => {
  authState.userId = "test-user";
});

describe("POST /api/signatures file size limit", () => {
  it("rejects a file over 25MB with a clean 400 and writes nothing to storage", async () => {
    const before = listSignatureFiles();

    const res = await request(app)
      .post("/api/signatures")
      .field("name", `Oversized Sig ${Date.now()}`)
      .attach("file", OVERSIZED_PNG, { filename: "huge.png", contentType: "image/png" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/too large/i);
    expect(res.body.code).toBe("FILE_TOO_LARGE");
    // Nothing must be written to storage for a rejected upload.
    expect(listSignatureFiles()).toEqual(before);
  });
});
