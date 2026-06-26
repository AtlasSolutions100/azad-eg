import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";

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
const { db, procastConnectionTable, invoicesTable, workPlansTable, employeesTable, lineItemsTable } =
  await import("@workspace/db");

const createdInvoiceIds: number[] = [];
const createdWorkPlanIds: number[] = [];
const createdEmployeeIds: number[] = [];

async function resetConnection(): Promise<void> {
  await db.delete(procastConnectionTable);
}

beforeEach(async () => {
  await resetConnection();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  if (createdInvoiceIds.length) {
    await db.delete(lineItemsTable).where(inArray(lineItemsTable.invoiceId, createdInvoiceIds));
    await db.delete(invoicesTable).where(inArray(invoicesTable.id, createdInvoiceIds));
  }
  if (createdWorkPlanIds.length) {
    await db.delete(workPlansTable).where(inArray(workPlansTable.id, createdWorkPlanIds));
  }
  if (createdEmployeeIds.length) {
    await db.delete(employeesTable).where(inArray(employeesTable.id, createdEmployeeIds));
  }
  await resetConnection();
});

function mockFetch(handler: (url: string, init?: RequestInit) => Response): void {
  vi.spyOn(globalThis, "fetch").mockImplementation(
    async (input: string | URL | Request, init?: RequestInit) =>
      handler(String(input), init),
  );
}

describe("procast integration", () => {
  it("defaults to upload mode when never connected", async () => {
    const res = await request(app).get("/api/procast/status");
    expect(res.status).toBe(200);
    expect(res.body.connected).toBe(false);
    expect(res.body.mode).toBe("upload");
  });

  it("rejects connect when the API key is unauthorized", async () => {
    mockFetch((url) => {
      expect(url).toContain("/health");
      return new Response(null, { status: 401 });
    });
    const res = await request(app)
      .post("/api/procast/connect")
      .send({ baseUrl: "https://procast.example.com", apiKey: "bad" });
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/unauthorized/i);

    const status = await request(app).get("/api/procast/status");
    expect(status.body.connected).toBe(false);
  });

  it("connects when credentials validate, then disconnects", async () => {
    mockFetch(() => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const connect = await request(app)
      .post("/api/procast/connect")
      .send({ baseUrl: "https://procast.example.com/v1/", apiKey: "good" });
    expect(connect.status).toBe(200);
    expect(connect.body.connected).toBe(true);
    expect(connect.body.mode).toBe("live");
    expect(connect.body.baseUrl).toBe("https://procast.example.com/v1");

    const disconnect = await request(app).post("/api/procast/disconnect");
    expect(disconnect.status).toBe(200);
    expect(disconnect.body.connected).toBe(false);
    expect(disconnect.body.mode).toBe("upload");
  });

  it("pulls timesheets live and imports them as line items", async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const [emp] = await db
      .insert(employeesTable)
      .values({ name: `Procast Emp ${suffix}`, classification: "Engineer", homeRate: 150, fieldRate: 175 })
      .returning();
    createdEmployeeIds.push(emp.id);
    const [wp] = await db
      .insert(workPlansTable)
      .values({
        code: `PC-WP-${suffix}`,
        title: "Procast WP",
        client: "Client",
        jobNumber: "JOB",
        poNumber: "PO",
        totalBudget: 100000,
      })
      .returning();
    createdWorkPlanIds.push(wp.id);
    const [inv] = await db
      .insert(invoicesTable)
      .values({
        workPlanId: wp.id,
        invoiceNumber: `PC-INV-${suffix}`,
        invoiceDate: "2026-02-01",
        periodStart: "2026-01-01",
        periodEnd: "2026-01-15",
      })
      .returning();
    createdInvoiceIds.push(inv.id);

    mockFetch((url) => {
      if (url.includes("/health")) return new Response(null, { status: 200 });
      if (url.includes("/timesheets")) {
        expect(url).toContain("start=2026-01-01");
        expect(url).toContain("end=2026-01-15");
        return new Response(
          JSON.stringify({
            timesheets: [
              { Employee: emp.name, Hours: "40", Rate: "150", Category: "Regular", Location: "Home" },
              { Employee: emp.name, Hours: "5", Category: "Overtime", Location: "Field" },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response(null, { status: 404 });
    });

    await request(app)
      .post("/api/procast/connect")
      .send({ baseUrl: "https://procast.example.com", apiKey: "good" })
      .expect(200);

    const sync = await request(app).post(`/api/invoices/${inv.id}/procast-sync`);
    expect(sync.status).toBe(200);
    expect(sync.body.source).toBe("procast");
    expect(sync.body.importedCount).toBe(2);

    const items = await db.select().from(lineItemsTable).where(eq(lineItemsTable.invoiceId, inv.id));
    expect(items).toHaveLength(2);
    // OT row had no rate in the feed → falls back to the employee's field rate.
    const otRow = items.find((i) => i.category === "ot");
    expect(otRow?.rate).toBe(175);
    expect(otRow?.location).toBe("field");

    const status = await request(app).get("/api/procast/status");
    expect(status.body.lastSyncAt).toBeTruthy();
  });

  it("refuses to sync when Procast is not connected", async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const [wp] = await db
      .insert(workPlansTable)
      .values({
        code: `PC-WP2-${suffix}`,
        title: "Procast WP2",
        client: "Client",
        jobNumber: "JOB",
        poNumber: "PO",
        totalBudget: 100000,
      })
      .returning();
    createdWorkPlanIds.push(wp.id);
    const [inv] = await db
      .insert(invoicesTable)
      .values({
        workPlanId: wp.id,
        invoiceNumber: `PC-INV2-${suffix}`,
        invoiceDate: "2026-02-01",
        periodStart: "2026-01-01",
        periodEnd: "2026-01-15",
      })
      .returning();
    createdInvoiceIds.push(inv.id);

    const sync = await request(app).post(`/api/invoices/${inv.id}/procast-sync`);
    expect(sync.status).toBe(409);
    expect(sync.body.error).toMatch(/not connected/i);
  });
});
