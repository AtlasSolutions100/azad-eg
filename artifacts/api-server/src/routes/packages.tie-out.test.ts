import { afterAll, describe, expect, it, vi } from "vitest";
import { inArray } from "drizzle-orm";

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

// Procas state controlled per test: connection presence and the BillingHistory
// total (or an error) returned for the tie-out comparison.
const procasState = vi.hoisted(() => ({
  connected: true,
  billed: 0,
  error: null as Error | null,
}));

vi.mock("../lib/procas", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/procas")>();
  return {
    ...actual,
    getProcasConnection: async () =>
      procasState.connected
        ? { connected: true, username: "u", password: "p" }
        : null,
    credsFromConnection: () => ({ username: "u", password: "p" }),
  };
});

vi.mock("../lib/procasSync", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/procasSync")>();
  return {
    ...actual,
    fetchPreviouslyBilledFromProcas: async () => {
      if (procasState.error) throw procasState.error;
      return procasState.billed;
    },
  };
});

const request = (await import("supertest")).default;
const app = (await import("../app")).default;
const { db, packagesTable, workPlansTable, auditLogsTable } = await import("@workspace/db");

const createdPackageIds: number[] = [];
const createdWorkPlanIds: number[] = [];

afterAll(async () => {
  if (createdPackageIds.length) {
    await db.delete(auditLogsTable).where(inArray(auditLogsTable.entityId, createdPackageIds));
    await db.delete(packagesTable).where(inArray(packagesTable.id, createdPackageIds));
  }
  if (createdWorkPlanIds.length) {
    await db.delete(workPlansTable).where(inArray(workPlansTable.id, createdWorkPlanIds));
  }
});

async function makePackage(previouslyBilled: number): Promise<number> {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const [wp] = await db
    .insert(workPlansTable)
    .values({
      code: `TIEOUT-WP-${suffix}`,
      title: "Tie-out Test Work Plan",
      client: "Test Client",
      jobNumber: "TIEOUT-JOB",
      poNumber: "PO-1",
      totalBudget: 100000,
    })
    .returning();
  createdWorkPlanIds.push(wp.id);
  const [pkg] = await db
    .insert(packagesTable)
    .values({
      workPlanId: wp.id,
      payPeriodStart: "2026-03-01",
      payPeriodEnd: "2026-03-31",
      previouslyBilled,
      previouslyBilledSource: "manual",
    })
    .returning();
  createdPackageIds.push(pkg.id);
  return pkg.id;
}

describe("POST /packages/:id/procas-tie-out", () => {
  it("reports a match when Previously Billed agrees with Procas BillingHistory", async () => {
    const id = await makePackage(12500.5);
    procasState.connected = true;
    procasState.error = null;
    procasState.billed = 12500.5;

    const res = await request(app).post(`/api/packages/${id}/procas-tie-out`);
    expect(res.status).toBe(200);
    expect(res.body.matches).toBe(true);
    expect(res.body.previouslyBilled).toBe(12500.5);
    expect(res.body.procasBilled).toBe(12500.5);
    expect(res.body.difference).toBe(0);
    expect(res.body.source).toBe("manual");
  });

  it("reports a mismatch with the signed difference", async () => {
    const id = await makePackage(10000);
    procasState.billed = 9000;
    procasState.error = null;

    const res = await request(app).post(`/api/packages/${id}/procas-tie-out`);
    expect(res.status).toBe(200);
    expect(res.body.matches).toBe(false);
    expect(res.body.procasBilled).toBe(9000);
    expect(res.body.difference).toBe(1000);
  });

  it("treats within-a-cent differences as a match, beyond a cent as a mismatch", async () => {
    const id = await makePackage(100.0);
    procasState.error = null;

    procasState.billed = 100.01; // exactly one cent apart — still ties out
    let res = await request(app).post(`/api/packages/${id}/procas-tie-out`);
    expect(res.status).toBe(200);
    expect(res.body.matches).toBe(true);

    procasState.billed = 100.02; // two cents apart — mismatch
    res = await request(app).post(`/api/packages/${id}/procas-tie-out`);
    expect(res.status).toBe(200);
    expect(res.body.matches).toBe(false);
  });

  it("returns 409 when Procas is not connected", async () => {
    const id = await makePackage(0);
    procasState.connected = false;

    const res = await request(app).post(`/api/packages/${id}/procas-tie-out`);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/not connected/i);
    procasState.connected = true;
  });

  it("returns 502 when Procas is unreachable", async () => {
    const id = await makePackage(0);
    procasState.error = new Error("network down");

    const res = await request(app).post(`/api/packages/${id}/procas-tie-out`);
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/billing history/i);
    procasState.error = null;
  });

  it("returns 404 for a missing package", async () => {
    const res = await request(app).post(`/api/packages/999999999/procas-tie-out`);
    expect(res.status).toBe(404);
  });
});
