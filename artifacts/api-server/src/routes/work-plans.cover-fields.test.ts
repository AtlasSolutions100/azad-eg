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

const request = (await import("supertest")).default;
const app = (await import("../app")).default;
const { db, workPlansTable, auditLogsTable } = await import("@workspace/db");

const createdWorkPlanIds: number[] = [];

afterAll(async () => {
  if (createdWorkPlanIds.length) {
    await db.delete(auditLogsTable).where(inArray(auditLogsTable.entityId, createdWorkPlanIds));
    await db.delete(workPlansTable).where(inArray(workPlansTable.id, createdWorkPlanIds));
  }
});

const coverFields = {
  supplierId: "0000123456",
  clientProjectNo: "15EK-110",
  sendToCompany: "AECOM Technical Services",
  sendToAddress1: "300 Lakeside Drive, Suite 400",
  sendToAddress2: "Oakland, CA 94612",
  contactPerson: "Jane Contact",
  bartProjectNumbers: "15EK011 / 15EK012",
  terms: "Net 30",
};

describe("work plan invoice-cover fields round-trip", () => {
  it("persists and returns all 8 cover fields through create, get, list and patch", async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const created = await request(app)
      .post("/api/work-plans")
      .send({
        code: `TEST-COVER-${suffix}`,
        title: "Cover Fields Work Plan",
        client: "Test Client",
        jobNumber: `TEST-JOB-${suffix}`,
        totalBudget: 50000,
        billingCycle: "whole_month",
        ...coverFields,
      });
    expect(created.status).toBe(201);
    createdWorkPlanIds.push(created.body.id);
    expect(created.body).toMatchObject(coverFields);

    const got = await request(app).get(`/api/work-plans/${created.body.id}`);
    expect(got.status).toBe(200);
    expect(got.body).toMatchObject(coverFields);

    const list = await request(app).get("/api/work-plans");
    expect(list.status).toBe(200);
    const listed = (list.body.items ?? list.body).find(
      (w: { id: number }) => w.id === created.body.id,
    );
    expect(listed).toMatchObject(coverFields);

    const patched = await request(app)
      .patch(`/api/work-plans/${created.body.id}`)
      .send({ terms: "Net 45", contactPerson: "New Contact" });
    expect(patched.status).toBe(200);
    expect(patched.body.terms).toBe("Net 45");
    expect(patched.body.contactPerson).toBe("New Contact");
    expect(patched.body.supplierId).toBe(coverFields.supplierId);
  });
});
