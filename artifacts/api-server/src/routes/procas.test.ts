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
  procasConnectionTable,
  procasSchedulerTable,
  invoicesTable,
  workPlansTable,
  employeesTable,
  lineItemsTable,
} = await import("@workspace/db");

const createdInvoiceIds: number[] = [];
const createdWorkPlanIds: number[] = [];
const createdEmployeeIds: number[] = [];

async function resetConnection(): Promise<void> {
  await db.delete(procasConnectionTable);
  await db.delete(procasSchedulerTable);
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

describe("procas integration", () => {
  it("defaults to upload mode when never connected", async () => {
    const res = await request(app).get("/api/procas/status");
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
      .post("/api/procas/connect")
      .send({ baseUrl: "https://procas.example.com", apiKey: "bad" });
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/unauthorized/i);

    const status = await request(app).get("/api/procas/status");
    expect(status.body.connected).toBe(false);
  });

  it("connects when credentials validate, then disconnects", async () => {
    mockFetch(() => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const connect = await request(app)
      .post("/api/procas/connect")
      .send({ baseUrl: "https://procas.example.com/v1/", apiKey: "good" });
    expect(connect.status).toBe(200);
    expect(connect.body.connected).toBe(true);
    expect(connect.body.mode).toBe("live");
    expect(connect.body.baseUrl).toBe("https://procas.example.com/v1");

    // The API key must be encrypted at rest, never readable plaintext in the DB.
    const [stored] = await db
      .select()
      .from(procasConnectionTable)
      .where(eq(procasConnectionTable.id, 1));
    expect(stored?.apiKey).toBeTruthy();
    expect(stored?.apiKey).not.toBe("good");
    expect(stored?.apiKey).not.toContain("good");
    expect(stored?.apiKey?.startsWith("enc:")).toBe(true);

    const disconnect = await request(app).post("/api/procas/disconnect");
    expect(disconnect.status).toBe(200);
    expect(disconnect.body.connected).toBe(false);
    expect(disconnect.body.mode).toBe("upload");
  });

  it("pulls timesheets live and imports them as line items", async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const [emp] = await db
      .insert(employeesTable)
      .values({ name: `Procas Emp ${suffix}`, classification: "Engineer", homeRate: 150, fieldRate: 175 })
      .returning();
    createdEmployeeIds.push(emp.id);
    const [wp] = await db
      .insert(workPlansTable)
      .values({
        code: `PC-WP-${suffix}`,
        title: "Procas WP",
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
      .post("/api/procas/connect")
      .send({ baseUrl: "https://procas.example.com", apiKey: "good" })
      .expect(200);

    const sync = await request(app).post(`/api/invoices/${inv.id}/procas-sync`);
    expect(sync.status).toBe(200);
    expect(sync.body.source).toBe("procas");
    expect(sync.body.importedCount).toBe(2);

    const items = await db.select().from(lineItemsTable).where(eq(lineItemsTable.invoiceId, inv.id));
    expect(items).toHaveLength(2);
    // OT row had no rate in the feed → falls back to the employee's field rate.
    const otRow = items.find((i) => i.category === "ot");
    expect(otRow?.rate).toBe(175);
    expect(otRow?.location).toBe("field");

    const status = await request(app).get("/api/procas/status");
    expect(status.body.lastSyncAt).toBeTruthy();
  });

  it("re-syncing the same period replaces line items instead of duplicating them", async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const [emp] = await db
      .insert(employeesTable)
      .values({ name: `Resync Emp ${suffix}`, classification: "Engineer", homeRate: 150, fieldRate: 175 })
      .returning();
    createdEmployeeIds.push(emp.id);
    const [wp] = await db
      .insert(workPlansTable)
      .values({
        code: `RESYNC-WP-${suffix}`,
        title: "Resync WP",
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
        invoiceNumber: `RESYNC-INV-${suffix}`,
        invoiceDate: "2026-02-01",
        periodStart: "2026-01-01",
        periodEnd: "2026-01-15",
      })
      .returning();
    createdInvoiceIds.push(inv.id);

    // The same period returns the same two rows on every pull.
    mockFetch((url) => {
      if (url.includes("/health")) return new Response(null, { status: 200 });
      if (url.includes("/timesheets")) {
        return new Response(
          JSON.stringify({
            timesheets: [
              { Employee: emp.name, Hours: "40", Rate: "150", Category: "Regular", Location: "Home" },
              { Employee: emp.name, Hours: "5", Rate: "175", Category: "Overtime", Location: "Field" },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response(null, { status: 404 });
    });

    await request(app)
      .post("/api/procas/connect")
      .send({ baseUrl: "https://procas.example.com", apiKey: "good" })
      .expect(200);

    // First sync imports both rows; nothing existed to replace.
    const first = await request(app).post(`/api/invoices/${inv.id}/procas-sync`);
    expect(first.status).toBe(200);
    expect(first.body.importedCount).toBe(2);
    expect(first.body.replacedCount).toBe(0);

    // Second sync of the same period must replace, not stack: the prior two
    // auto-imported rows are cleared and re-inserted, and replacedCount reports it.
    const second = await request(app).post(`/api/invoices/${inv.id}/procas-sync`);
    expect(second.status).toBe(200);
    expect(second.body.importedCount).toBe(2);
    expect(second.body.replacedCount).toBe(2);
    expect(second.body.warnings.some((w: string) => /Replaced 2 previously imported/i.test(w))).toBe(true);

    // Only the freshly pulled rows remain — no duplicate labor accumulated.
    const items = await db.select().from(lineItemsTable).where(eq(lineItemsTable.invoiceId, inv.id));
    expect(items).toHaveLength(2);
    expect(items.every((i) => i.source === "procas")).toBe(true);
  });

  it("preserves a manually-added row across a Procas re-sync", async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const [emp] = await db
      .insert(employeesTable)
      .values({ name: `Resync Mixed Emp ${suffix}`, classification: "Engineer", homeRate: 100 })
      .returning();
    createdEmployeeIds.push(emp.id);
    const [wp] = await db
      .insert(workPlansTable)
      .values({
        code: `RESYNC-MIX-WP-${suffix}`,
        title: "Resync Mixed WP",
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
        invoiceNumber: `RESYNC-MIX-INV-${suffix}`,
        invoiceDate: "2026-02-01",
        periodStart: "2026-01-01",
        periodEnd: "2026-01-15",
      })
      .returning();
    createdInvoiceIds.push(inv.id);

    mockFetch((url) => {
      if (url.includes("/health")) return new Response(null, { status: 200 });
      if (url.includes("/timesheets")) {
        return new Response(
          JSON.stringify({
            timesheets: [{ Employee: emp.name, Hours: "8", Rate: "100", Category: "Regular", Location: "Home" }],
          }),
          { status: 200 },
        );
      }
      return new Response(null, { status: 404 });
    });

    await request(app)
      .post("/api/procas/connect")
      .send({ baseUrl: "https://procas.example.com", apiKey: "good" })
      .expect(200);

    // A hand-entered row should survive every re-sync.
    const manual = await request(app)
      .post(`/api/invoices/${inv.id}/line-items`)
      .send({
        employeeName: "Hand Entered",
        classification: "Engineer",
        category: "regular",
        location: "home",
        hours: 4,
        rate: 50,
      });
    expect(manual.status).toBe(201);

    // Two syncs of the same period: the imported row is replaced each time, the
    // manual row is never touched.
    await request(app).post(`/api/invoices/${inv.id}/procas-sync`).expect(200);
    const second = await request(app).post(`/api/invoices/${inv.id}/procas-sync`);
    expect(second.status).toBe(200);
    expect(second.body.replacedCount).toBe(1);

    const items = await db.select().from(lineItemsTable).where(eq(lineItemsTable.invoiceId, inv.id));
    expect(items).toHaveLength(2);
    const manualRow = items.find((i) => i.source === "manual");
    const importedRow = items.find((i) => i.source === "procas");
    expect(manualRow?.employeeName).toBe("Hand Entered");
    expect(importedRow).toBeDefined();
  });

  it("scheduled cycle skips entirely when Procas is in upload mode", async () => {
    const { runProcasSyncCycle } = await import("../lib/procasScheduler");
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const result = await runProcasSyncCycle();
    expect(result.skipped).toBe(true);
    expect(result.synced).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("scheduled cycle pulls open invoices and skips finalized ones", async () => {
    const { runProcasSyncCycle } = await import("../lib/procasScheduler");
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
      .post("/api/procas/connect")
      .send({ baseUrl: "https://procas.example.com", apiKey: "good" })
      .expect(200);

    const result = await runProcasSyncCycle();
    expect(result.skipped).toBe(false);
    expect(result.synced).toBe(1);

    // Only the open (draft) invoice was pulled.
    const draftItems = await db.select().from(lineItemsTable).where(eq(lineItemsTable.invoiceId, draftInv.id));
    expect(draftItems).toHaveLength(1);
    const approvedItems = await db.select().from(lineItemsTable).where(eq(lineItemsTable.invoiceId, approvedInv.id));
    expect(approvedItems).toHaveLength(0);

    // Last-synced reflects the scheduled pull.
    const status = await request(app).get("/api/procas/status");
    expect(status.body.lastSyncAt).toBeTruthy();
  });

  it("reports scheduler status with the default interval before any cycle runs", async () => {
    const res = await request(app).get("/api/procas/scheduler");
    expect(res.status).toBe(200);
    expect(res.body.connected).toBe(false);
    expect(res.body.intervalMs).toBeGreaterThan(0);
    expect(res.body.lastRunAt).toBeNull();
    expect(res.body.lastSynced).toBe(0);
  });

  it("updates the refresh interval and rejects out-of-range values", async () => {
    const ok = await request(app)
      .put("/api/procas/scheduler")
      .send({ intervalMs: 5 * 60 * 1000 });
    expect(ok.status).toBe(200);
    expect(ok.body.intervalMs).toBe(5 * 60 * 1000);

    const persisted = await request(app).get("/api/procas/scheduler");
    expect(persisted.body.intervalMs).toBe(5 * 60 * 1000);

    // Too small (< 1 minute) is rejected.
    const tooSmall = await request(app)
      .put("/api/procas/scheduler")
      .send({ intervalMs: 1000 });
    expect(tooSmall.status).toBe(400);

    // Too large (> 24 hours) is rejected.
    const tooLarge = await request(app)
      .put("/api/procas/scheduler")
      .send({ intervalMs: 48 * 60 * 60 * 1000 });
    expect(tooLarge.status).toBe(400);
  });

  it("on-demand refresh skips when not connected", async () => {
    const res = await request(app).post("/api/procas/refresh");
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
      .post("/api/procas/connect")
      .send({ baseUrl: "https://procas.example.com", apiKey: "good" })
      .expect(200);

    const res = await request(app).post("/api/procas/refresh");
    expect(res.status).toBe(200);
    expect(res.body.lastSkipped).toBe(false);
    expect(res.body.lastSynced).toBeGreaterThanOrEqual(1);
    expect(res.body.lastRunAt).toBeTruthy();
    expect(res.body.connected).toBe(true);

    const items = await db.select().from(lineItemsTable).where(eq(lineItemsTable.invoiceId, draftInv.id));
    expect(items).toHaveLength(1);

    // The scheduler status endpoint reflects the recorded cycle.
    const status = await request(app).get("/api/procas/scheduler");
    expect(status.body.lastSynced).toBeGreaterThanOrEqual(1);
    expect(status.body.lastRunAt).toBeTruthy();
  });

  it("isolates a single invoice's Procas failure so the rest of the cycle still syncs", async () => {
    const { runProcasSyncCycle } = await import("../lib/procasScheduler");
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
      .post("/api/procas/connect")
      .send({ baseUrl: "https://procas.example.com", apiKey: "good" })
      .expect(200);

    const result = await runProcasSyncCycle();
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

  it("treats an empty Procas feed as a no-op, not a failure", async () => {
    const { runProcasSyncCycle } = await import("../lib/procasScheduler");
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
      .post("/api/procas/connect")
      .send({ baseUrl: "https://procas.example.com", apiKey: "good" })
      .expect(200);

    const result = await runProcasSyncCycle();
    expect(result.skipped).toBe(false);
    // Empty feeds are not failures and produce no imports.
    expect(result.failed).toBe(0);
    expect(result.synced).toBe(0);

    const items = await db.select().from(lineItemsTable).where(eq(lineItemsTable.invoiceId, inv.id));
    expect(items).toHaveLength(0);
  });

  it("skips an overlapping cycle while a previous one is still running", async () => {
    const { tick } = await import("../lib/procasScheduler");
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
      .post("/api/procas/connect")
      .send({ baseUrl: "https://procas.example.com", apiKey: "good" })
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

  it("refuses to sync when Procas is not connected", async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const [wp] = await db
      .insert(workPlansTable)
      .values({
        code: `PC-WP2-${suffix}`,
        title: "Procas WP2",
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

    const sync = await request(app).post(`/api/invoices/${inv.id}/procas-sync`);
    expect(sync.status).toBe(409);
    expect(sync.body.error).toMatch(/not connected/i);
  });

  it("tick logs and swallows an error when the cycle itself throws, then resets the running guard", async () => {
    const scheduler = await import("../lib/procasScheduler");
    const procasModule = await import("../lib/procas");
    const { logger } = await import("../lib/logger");

    const errorSpy = vi.spyOn(logger, "error").mockImplementation((() => logger) as never);

    // Force the whole cycle to blow up the way a database hiccup would: the
    // open-invoices read (reached right after the connection check) rejects.
    // This is an unexpected, top-level error — not a per-invoice Procas error.
    const connSpy = vi
      .spyOn(procasModule, "getProcasConnection")
      .mockRejectedValueOnce(new Error("database hiccup while loading open invoices"));

    // The top-level safety net must swallow the throw — tick resolves, it never
    // rejects, so a single bad cycle can't take the background loop down.
    await expect(scheduler.tick()).resolves.toBeUndefined();
    // ...and the failure is logged, not lost silently.
    expect(errorSpy).toHaveBeenCalled();

    // The in-instance running guard is reset afterward so the loop isn't wedged.
    const afterThrow = await scheduler.getSchedulerState();
    expect(afterThrow.running).toBe(false);

    // A later tick runs normally (here it skips cleanly because Procas is not
    // connected) instead of being permanently blocked by a stuck guard.
    connSpy.mockRestore();
    await expect(scheduler.tick()).resolves.toBeUndefined();
  });

  it("skips a concurrent cycle cleanly when another instance holds the cross-instance sync lock", async () => {
    const { tick, getSchedulerState } = await import("../lib/procasScheduler");
    const { pool } = await import("@workspace/db");
    // Must match SYNC_LOCK_KEY in procasScheduler.ts. A regression that changes
    // or removes this key would let two instances run a cycle at once.
    const SYNC_LOCK_KEY = 0x70726373; // "prcs"

    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const [emp] = await db
      .insert(employeesTable)
      .values({ name: `Lock Emp ${suffix}`, classification: "Engineer", homeRate: 120, fieldRate: 140 })
      .returning();
    createdEmployeeIds.push(emp.id);
    const [wp] = await db
      .insert(workPlansTable)
      .values({
        code: `LOCK-WP-${suffix}`,
        title: "Lock WP",
        client: "Client",
        jobNumber: "JOB",
        poNumber: "PO",
        totalBudget: 100000,
      })
      .returning();
    createdWorkPlanIds.push(wp.id);

    // Far-future period unique to this test so the global cycle only imports
    // rows for THIS invoice when it does run.
    const periodStart = "2093-01-01";
    const periodEnd = "2093-01-15";
    const [draftInv] = await db
      .insert(invoicesTable)
      .values({
        workPlanId: wp.id,
        invoiceNumber: `LOCK-DRAFT-${suffix}`,
        invoiceDate: "2093-02-01",
        periodStart,
        periodEnd,
        status: "draft",
      })
      .returning();
    createdInvoiceIds.push(draftInv.id);

    let timesheetCalls = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/health")) return new Response(null, { status: 200 });
      if (url.includes("/timesheets")) {
        timesheetCalls += 1;
        const rows = url.includes(`start=${periodStart}`)
          ? [{ Employee: emp.name, Hours: "8", Rate: "120", Category: "Regular", Location: "Home" }]
          : [];
        return new Response(JSON.stringify({ timesheets: rows }), { status: 200 });
      }
      return new Response(null, { status: 404 });
    });

    await request(app)
      .post("/api/procas/connect")
      .send({ baseUrl: "https://procas.example.com", apiKey: "good" })
      .expect(200);

    // Simulate a second autoscale instance already mid-cycle by holding the
    // cross-instance advisory lock on a separate pooled session.
    const holder = await pool.connect();
    try {
      const held = await holder.query<{ locked: boolean }>(
        "SELECT pg_try_advisory_lock($1) AS locked",
        [SYNC_LOCK_KEY],
      );
      expect(held.rows[0]?.locked).toBe(true);

      // A tick on THIS instance cannot acquire the lock, so it must skip cleanly:
      // the cycle body never runs (no timesheets fetch), no rows imported, no error.
      await tick();
      expect(timesheetCalls).toBe(0);

      const itemsWhileLocked = await db
        .select()
        .from(lineItemsTable)
        .where(eq(lineItemsTable.invoiceId, draftInv.id));
      expect(itemsWhileLocked).toHaveLength(0);

      // Persisted state is untouched (no cycle result recorded) and no error raised.
      const state = await getSchedulerState();
      expect(state.lastRunAt).toBeNull();
      expect(state.lastError).toBeNull();
      expect(state.lastSynced).toBe(0);
    } finally {
      // Release the lock so it does not leak into other specs.
      await holder.query("SELECT pg_advisory_unlock($1)", [SYNC_LOCK_KEY]);
      holder.release();
    }

    // Once the lock is free, a later tick acquires it and runs normally — proving
    // the earlier skip was caused purely by the held lock, not a broken cycle.
    await tick();
    expect(timesheetCalls).toBeGreaterThanOrEqual(1);
    const itemsAfterRelease = await db
      .select()
      .from(lineItemsTable)
      .where(eq(lineItemsTable.invoiceId, draftInv.id));
    expect(itemsAfterRelease).toHaveLength(1);
  });

  it("startProcasScheduler is idempotent and honors PROCAS_SYNC_INTERVAL_MS with a default fallback", async () => {
    const { startProcasScheduler, stopProcasScheduler } = await import("../lib/procasScheduler");
    const prev = process.env["PROCAS_SYNC_INTERVAL_MS"];
    const DEFAULT_INTERVAL_MS = 15 * 60 * 1000;
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");

    try {
      // A valid env interval is honored. No UI-configured row exists (beforeEach
      // clears the scheduler table), so the env value is what takes effect.
      process.env["PROCAS_SYNC_INTERVAL_MS"] = String(5 * 60 * 1000);
      await startProcasScheduler();
      // Calling it again is a no-op: a single timer stays active.
      await startProcasScheduler();
      expect(setIntervalSpy).toHaveBeenCalledTimes(1);
      expect(setIntervalSpy.mock.calls[0]?.[1]).toBe(5 * 60 * 1000);
      stopProcasScheduler();

      // An invalid (non-numeric) env value falls back to the built-in default.
      setIntervalSpy.mockClear();
      process.env["PROCAS_SYNC_INTERVAL_MS"] = "not-a-number";
      await startProcasScheduler();
      expect(setIntervalSpy).toHaveBeenCalledTimes(1);
      expect(setIntervalSpy.mock.calls[0]?.[1]).toBe(DEFAULT_INTERVAL_MS);
      stopProcasScheduler();

      // An unset env value also falls back to the default.
      setIntervalSpy.mockClear();
      delete process.env["PROCAS_SYNC_INTERVAL_MS"];
      await startProcasScheduler();
      expect(setIntervalSpy).toHaveBeenCalledTimes(1);
      expect(setIntervalSpy.mock.calls[0]?.[1]).toBe(DEFAULT_INTERVAL_MS);
      stopProcasScheduler();
    } finally {
      stopProcasScheduler();
      if (prev === undefined) delete process.env["PROCAS_SYNC_INTERVAL_MS"];
      else process.env["PROCAS_SYNC_INTERVAL_MS"] = prev;
    }
  });
});
