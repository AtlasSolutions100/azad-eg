import { beforeEach, describe, expect, it, vi } from "vitest";

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
const app = (await import("../../app")).default;

// Multer's fileSize limit is 25 MB; build a payload just past it so rejection
// is purely about size, not content or invoice lookup. The size check runs in
// middleware before the invoice is loaded, so no real invoice is needed.
const OVERSIZED_FILE = Buffer.alloc(25 * 1024 * 1024 + 1024, 0x41);

beforeEach(() => {
  authState.userId = "test-user";
});

describe("POST /api/invoices/:id/time-import file size limit", () => {
  it("rejects a file over 25MB with a clean 400", async () => {
    const res = await request(app)
      .post("/api/invoices/999999/time-import")
      .attach("file", OVERSIZED_FILE, { filename: "huge.csv" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/too large/i);
    expect(res.body.code).toBe("FILE_TOO_LARGE");
  });
});
