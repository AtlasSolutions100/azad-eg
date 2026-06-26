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
const {
  db,
  procastConnectionTable,
  procastSchedulerTable,
  invoicesTable,
  workPlansTable,
  employeesTable,
  lineItemsTable,
} = await import("@workspace/db");

const createdInvoiceIds: number[] = [];
const createdWorkPlanIds: number[] = [];
const createdEmployeeIds: number[] = [];

async function resetConnection(): Promise<void> {
  await db.delete(procastConnectionTable);
  await db.delete(procastSchedulerTable);
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

    // The API key must be encrypted at rest, never readable plaintext in the DB.
    const [stored] = await db
      .select()
      .from(procastConnectionTable)
      .where(eq(procastConnectionTable.id, 1));
    expect(stored?.apiKey).toBeTruthy();
    expect(stored?.apiKey).not.toBe("good");
    expect(stored?.apiKey).not.toContain("good");
    expect(stored?.apiKey?.startsWith("enc:")).toBe(true);

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

  it("scheduled cycle skips entirely when Procast is in upload mode", async () => {
    const { runProcastSyncCycle } = await import("../lib/procastScheduler");
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const result = await runProcastSyncCycle();
    expect(result.skipped).toBe(true);
    expect(result.synced).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("scheduled cycle pulls open invoices and skips finalized ones", async () => {
    const { runProcastSyncCycle } = await import("../lib/procastScheduler");
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const [emp] = await db
      .insert(employeesTable)
      .values({ name: `Sched Emp ${suffix}`, classification: "Engineer", homeRate: 120, fieldRate: 140 })
      .returning();
    createdEmployeeIds.push(emp.id);
    const [wp] = await db
      .insert(workPlansTable)
      .values({
        code: `SCHED-WP-${suffix}`,
        title: "Sched WP",
        client: "Client",
        jobNumber: "JOB",
        poNumber: "PO",
        totalBudget: 100000,
      })
      .returning();
    createdWorkPlanIds.push(wp.id);

    // Use a far-future period unique to this test so the global scheduled cycle
    // (which pulls every open invoice in the DB, including seed data) only
    // imports rows for THIS invoice — other open invoices fall on other periods
    // and get an empty feed.
    const periodStart = "2099-01-01";
    const periodEnd = "2099-01-15";

    const [draftInv] = await db
      .insert(invoicesTable)
      .values({
        workPlanId: wp.id,
        invoiceNumber: `SCHED-DRAFT-${suffix}`,
        invoiceDate: "2099-02-01",
        periodStart,
        periodEnd,
        status: "draft",
      })
      .returning();
    createdInvoiceIds.push(draftInv.id);

    const [approvedInv] = await db
      .insert(invoicesTable)
      .values({
        workPlanId: wp.id,
        invoiceNumber: `SCHED-APPROVED-${suffix}`,
        invoiceDate: "2099-02-01",
        periodStart,
        periodEnd,
        status: "approved",
      })
      .returning();
    createdInvoiceIds.push(approvedInv.id);

    mockFetch((url) => {
      if (url.includes("/health")) return new Response(null, { status: 200 });
      if (url.includes("/timesheets")) {
        const rows = url.includes(`start=${periodStart}`)
          ? [{ Employee: emp.name, Hours: "8", Rate: "120", Category: "Regular", Location: "Home" }]
          : [];
        return new Response(JSON.stringify({ timesheets: rows }), { status: 200 });
      }
      return new Response(null, { status: 404 });
    });

    await request(app)
      .post("/api/procast/connect")
      .send({ baseUrl: "https://procast.example.com", apiKey: "good" })
      .expect(200);

    const result = await runProcastSyncCycle();
    expect(result.skipped).toBe(false);
    expect(result.synced).toBe(1);

    // Only the open (draft) invoice was pulled.
    const draftItems = await db.select().from(lineItemsTable).where(eq(lineItemsTable.invoiceId, draftInv.id));
    expect(draftItems).toHaveLength(1);
    const approvedItems = await db.select().from(lineItemsTable).where(eq(lineItemsTable.invoiceId, approvedInv.id));
    expect(approvedItems).toHaveLength(0);

    // Last-synced reflects the scheduled pull.
    const status = await request(app).get("/api/procast/status");
    expect(status.body.lastSyncAt).toBeTruthy();
  });

  it("reports scheduler status with the default interval before any cycle runs", async () => {
    const res = await request(app).get("/api/procast/scheduler");
    expect(res.status).toBe(200);
    expect(res.body.connected).toBe(false);
    expect(res.body.intervalMs).toBeGreaterThan(0);
    expect(res.body.lastRunAt).toBeNull();
    expect(res.body.lastSynced).toBe(0);
  });

  it("updates the refresh interval and rejects out-of-range values", async () => {
    const ok = await request(app)
      .put("/api/procast/scheduler")
      .send({ intervalMs: 5 * 60 * 1000 });
    expect(ok.status).toBe(200);
    expect(ok.body.intervalMs).toBe(5 * 60 * 1000);

    const persisted = await request(app).get("/api/procast/scheduler");
    expect(persisted.body.intervalMs).toBe(5 * 60 * 1000);

    // Too small (< 1 minute) is rejected.
    const tooSmall = await request(app)
      .put("/api/procast/scheduler")
      .send({ intervalMs: 1000 });
    expect(tooSmall.status).toBe(400);

    // Too large (> 24 hours) is rejected.
    const tooLarge = await request(app)
      .put("/api/procast/scheduler")
      .send({ intervalMs: 48 * 60 * 60 * 1000 });
    expect(tooLarge.status).toBe(400);
  });

  it("on-demand refresh skips when not connected", async () => {
    const res = await request(app).post("/api/procast/refresh");
    expect(res.status).toBe(200);
    expect(res.body.lastSkipped).toBe(true);
    expect(res.body.lastRunAt).toBeTruthy();
    expect(res.body.lastSynced).toBe(0);
  });

  it("on-demand refresh pulls open invoices and records the result", async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const [emp] = await db
      .insert(employeesTable)
      .values({ name: `Refresh Emp ${suffix}`, classification: "Engineer", homeRate: 120, fieldRate: 140 })
      .returning();
    createdEmployeeIds.push(emp.id);
    const [wp] = await db
      .insert(workPlansTable)
      .values({
        code: `REFRESH-WP-${suffix}`,
        title: "Refresh WP",
        client: "Client",
        jobNumber: "JOB",
        poNumber: "PO",
        totalBudget: 100000,
      })
      .returning();
    createdWorkPlanIds.push(wp.id);

    const periodStart = "2098-01-01";
    const periodEnd = "2098-01-15";
    const [draftInv] = await db
      .insert(invoicesTable)
      .values({
        workPlanId: wp.id,
        invoiceNumber: `REFRESH-DRAFT-${suffix}`,
        invoiceDate: "2098-02-01",
        periodStart,
        periodEnd,
        status: "draft",
      })
      .returning();
    createdInvoiceIds.push(draftInv.id);

    mockFetch((url) => {
      if (url.includes("/health")) return new Response(null, { status: 200 });
      if (url.includes("/timesheets")) {
        const rows = url.includes(`start=${periodStart}`)
          ? [{ Employee: emp.name, Hours: "8", Rate: "120", Category: "Regular", Location: "Home" }]
          : [];
        return new Response(JSON.stringify({ timesheets: rows }), { status: 200 });
      }
      return new Response(null, { status: 404 });
    });

    await request(app)
      .post("/api/procast/connect")
      .send({ baseUrl: "https://procast.example.com", apiKey: "good" })
      .expect(200);

    const res = await request(app).post("/api/procast/refresh");
    expect(res.status).toBe(200);
    expect(res.body.lastSkipped).toBe(false);
    expect(res.body.lastSynced).toBeGreaterThanOrEqual(1);
    expect(res.body.lastRunAt).toBeTruthy();
    expect(res.body.connected).toBe(true);

    const items = await db.select().from(lineItemsTable).where(eq(lineItemsTable.invoiceId, draftInv.id));
    expect(items).toHaveLength(1);

    // The scheduler status endpoint reflects the recorded cycle.
    const status = await request(app).get("/api/procast/scheduler");
    expect(status.body.lastSynced).toBeGreaterThanOrEqual(1);
    expect(status.body.lastRunAt).toBeTruthy();
  });

  it("isolates a single invoice's Procast failure so the rest of the cycle still syncs", async () => {
    const { runProcastSyncCycle } = await import("../lib/procastScheduler");
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const [emp] = await db
      .insert(employeesTable)
      .values({ name: `Fail Emp ${suffix}`, classification: "Engineer", homeRate: 110, fieldRate: 130 })
      .returning();
    createdEmployeeIds.push(emp.id);
    const [wp] = await db
      .insert(workPlansTable)
      .values({
        code: `FAIL-WP-${suffix}`,
        title: "Fail WP",
        client: "Client",
        jobNumber: "JOB",
        poNumber: "PO",
        totalBudget: 100000,
      })
      .returning();
    createdWorkPlanIds.push(wp.id);

    // Two open invoices on distinct far-future periods so the global cycle's
    // feed can be branched per-invoice: one period errors, the other succeeds.
    const badStart = "2097-01-01";
    const goodStart = "2096-01-01";

    const [badInv] = await db
      .insert(invoicesTable)
      .values({
        workPlanId: wp.id,
        invoiceNumber: `FAIL-BAD-${suffix}`,
        invoiceDate: "2097-02-01",
        periodStart: badStart,
        periodEnd: "2097-01-15",
        status: "draft",
      })
      .returning();
    createdInvoiceIds.push(badInv.id);

    const [goodInv] = await db
      .insert(invoicesTable)
      .values({
        workPlanId: wp.id,
        invoiceNumber: `FAIL-GOOD-${suffix}`,
        invoiceDate: "2096-02-01",
        periodStart: goodStart,
        periodEnd: "2096-01-15",
        status: "draft",
      })
      .returning();
    createdInvoiceIds.push(goodInv.id);

    mockFetch((url) => {
      if (url.includes("/health")) return new Response(null, { status: 200 });
      if (url.includes("/timesheets")) {
        // The bad invoice's pull returns a 502 → fetch_failed for that invoice.
        if (url.includes(`start=${badStart}`)) return new Response(null, { status: 502 });
        // The good invoice's pull returns valid rows → it still syncs.
        if (url.includes(`start=${goodStart}`)) {
          return new Response(
            JSON.stringify({
              timesheets: [{ Employee: emp.name, Hours: "8", Rate: "110", Category: "Regular", Location: "Home" }],
            }),
            { status: 200 },
          );
        }
        // Every other open invoice in the DB falls on some other period → empty feed.
        return new Response(JSON.stringify({ timesheets: [] }), { status: 200 });
      }
      return new Response(null, { status: 404 });
    });

    await request(app)
      .post("/api/procast/connect")
      .send({ baseUrl: "https://procast.example.com", apiKey: "good" })
      .expect(200);

    const result = await runProcastSyncCycle();
    expect(result.skipped).toBe(false);
    // Exactly one invoice errored, exactly one synced; empty feeds are no-ops.
    expect(result.failed).toBe(1);
    expect(result.synced).toBe(1);

    // The failed invoice imported nothing; the healthy one still got its row.
    const badItems = await db.select().from(lineItemsTable).where(eq(lineItemsTable.invoiceId, badInv.id));
    expect(badItems).toHaveLength(0);
    const goodItems = await db.select().from(lineItemsTable).where(eq(lineItemsTable.invoiceId, goodInv.id));
    expect(goodItems).toHaveLength(1);
  });

  it("treats an empty Procast feed as a no-op, not a failure", async () => {
    const { runProcastSyncCycle } = await import("../lib/procastScheduler");
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const [wp] = await db
      .insert(workPlansTable)
      .values({
        code: `EMPTY-WP-${suffix}`,
        title: "Empty WP",
        client: "Client",
        jobNumber: "JOB",
        poNumber: "PO",
        totalBudget: 100000,
      })
      .returning();
    createdWorkPlanIds.push(wp.id);

    const periodStart = "2095-01-01";
    const [inv] = await db
      .insert(invoicesTable)
      .values({
        workPlanId: wp.id,
        invoiceNumber: `EMPTY-DRAFT-${suffix}`,
        invoiceDate: "2095-02-01",
        periodStart,
        periodEnd: "2095-01-15",
        status: "draft",
      })
      .returning();
    createdInvoiceIds.push(inv.id);

    // All invoices (including ours) get an empty feed for this cycle.
    mockFetch((url) => {
      if (url.includes("/health")) return new Response(null, { status: 200 });
      if (url.includes("/timesheets")) return new Response(JSON.stringify({ timesheets: [] }), { status: 200 });
      return new Response(null, { status: 404 });
    });

    await request(app)
      .post("/api/procast/connect")
      .send({ baseUrl: "https://procast.example.com", apiKey: "good" })
      .expect(200);

    const result = await runProcastSyncCycle();
    expect(result.skipped).toBe(false);
    // Empty feeds are not failures and produce no imports.
    expect(result.failed).toBe(0);
    expect(result.synced).toBe(0);

    const items = await db.select().from(lineItemsTable).where(eq(lineItemsTable.invoiceId, inv.id));
    expect(items).toHaveLength(0);
  });

  it("skips an overlapping cycle while a previous one is still running", async () => {
    const { tick } = await import("../lib/procastScheduler");
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const [wp] = await db
      .insert(workPlansTable)
      .values({
        code: `OVL-WP-${suffix}`,
        title: "Overlap WP",
        client: "Client",
        jobNumber: "JOB",
        poNumber: "PO",
        totalBudget: 100000,
      })
      .returning();
    createdWorkPlanIds.push(wp.id);

    // Guarantee at least one open invoice so the cycle actually enters its loop
    // (and therefore reaches the gated fetch below).
    const [inv] = await db
      .insert(invoicesTable)
      .values({
        workPlanId: wp.id,
        invoiceNumber: `OVL-DRAFT-${suffix}`,
        invoiceDate: "2094-02-01",
        periodStart: "2094-01-01",
        periodEnd: "2094-01-15",
        status: "draft",
      })
      .returning();
    createdInvoiceIds.push(inv.id);

    // The first /timesheets fetch parks on this gate, holding the cycle open so
    // a second tick arrives mid-flight. All feeds resolve empty (no imports).
    let releaseGate: () => void = () => {};
    const gate = new Promise<void>((res) => {
      releaseGate = res;
    });
    let timesheetCalls = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/health")) return new Response(null, { status: 200 });
      if (url.includes("/timesheets")) {
        timesheetCalls += 1;
        await gate;
        return new Response(JSON.stringify({ timesheets: [] }), { status: 200 });
      }
      return new Response(null, { status: 404 });
    });

    await request(app)
      .post("/api/procast/connect")
      .send({ baseUrl: "https://procast.example.com", apiKey: "good" })
      .expect(200);

    // Start the first cycle (do not await) — it will park on the gate.
    const first = tick();
    // Wait until the in-flight cycle has actually issued its first fetch.
    for (let i = 0; i < 100 && timesheetCalls < 1; i += 1) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(timesheetCalls).toBe(1);

    // A second tick while the first is still running must be a no-op: the guard
    // returns immediately and issues no additional fetch.
    await tick();
    expect(timesheetCalls).toBe(1);

    // Let the first cycle drain to completion so the running flag resets.
    releaseGate();
    await first;
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
