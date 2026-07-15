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

// Multer's fileSize limit is 25 MB; build a payload just past it so rejection
// is purely about size, not content sniffing.
const OVERSIZED_FILE = Buffer.alloc(25 * 1024 * 1024 + 1024, 0x41);

function listRuleSheetFiles(): string[] {
  if (!fs.existsSync(uploadsDir)) return [];
  return fs.readdirSync(uploadsDir).filter((f) => f.startsWith("billing_rule_"));
}

beforeEach(() => {
  authState.userId = "test-user";
});

describe("POST /api/billing-rule-sheets file size limit", () => {
  it("rejects a file over 25MB with a clean 400 and writes nothing to storage", async () => {
    const before = listRuleSheetFiles();

    const res = await request(app)
      .post("/api/billing-rule-sheets")
      .field("title", `Oversized Sheet ${Date.now()}`)
      .attach("file", OVERSIZED_FILE, { filename: "huge.xlsx" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/too large/i);
    expect(res.body.code).toBe("FILE_TOO_LARGE");
    // Nothing must be written to storage for a rejected upload.
    expect(listRuleSheetFiles()).toEqual(before);
  });
});
