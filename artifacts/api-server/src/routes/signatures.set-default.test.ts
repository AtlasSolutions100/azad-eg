import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, inArray } from "drizzle-orm";

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

async function uploadSignature(name: string): Promise<number> {
  const res = await request(app)
    .post("/api/signatures")
    .field("name", name)
    .attach("file", PNG, { filename: "sig.png", contentType: "image/png" });
  expect(res.status).toBe(201);
  const id = (res.body as { id: number }).id;
  createdSignatureIds.push(id);
  return id;
}

describe("POST /api/signatures/:id/default", () => {
  it("marks the signature as default and clears any other default", async () => {
    const a = await uploadSignature(`Default Sig A ${Date.now()}`);
    const b = await uploadSignature(`Default Sig B ${Date.now()}`);

    const resA = await request(app).post(`/api/signatures/${a}/default`);
    expect(resA.status).toBe(200);
    expect(resA.body.isDefault).toBe(true);

    const resB = await request(app).post(`/api/signatures/${b}/default`);
    expect(resB.status).toBe(200);
    expect(resB.body.isDefault).toBe(true);

    const rows = await db
      .select()
      .from(signaturesTable)
      .where(inArray(signaturesTable.id, [a, b]));
    const rowA = rows.find((r) => r.id === a);
    const rowB = rows.find((r) => r.id === b);
    expect(rowA?.isDefault).toBe(false);
    expect(rowB?.isDefault).toBe(true);
  });

  it("returns 404 for a missing signature", async () => {
    const res = await request(app).post(`/api/signatures/999999999/default`);
    expect(res.status).toBe(404);
  });
});
