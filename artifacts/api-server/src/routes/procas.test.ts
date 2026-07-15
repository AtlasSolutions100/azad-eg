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
  procasSchedulerRunsTable,
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
  await db.delete(procasSchedulerRunsTable);
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

type Row = Record<string, unknown>;

function odataResponse(rows: Row[]): Response {
  return new Response(JSON.stringify({ value: rows }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function tableFromUrl(url: string): string {
  // .../ProcasData/v1/{COMPANY}/{Table}?...
  const path = url.split("?")[0];
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? "";
}

// Installs a fetch mock that speaks OData. The handler receives the table name
// and the DECODED url (so filters like "TransDate ge 2026-01-01T00:00:00Z" can
// be matched as plain text) and returns either rows or a full Response.
// Unhandled approved tables default to an empty feed.
function mockOData(handler: (table: string, url: string) => Row[] | Response | undefined): void {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: string | URL | Request) => {
    const rawUrl = String(input);
    const url = decodeURIComponent(rawUrl.replace(/\+/g, " "));
    const table = tableFromUrl(url);
    const out = handler(table, url);
    if (out instanceof Response) return out;
    return odataResponse(out ?? []);
  });
}

const GOOD_CREDS = { companyCode: "AZAD", username: "julie", password: "secret-pass" };

async function connectProcas(): Promise<void> {
  await request(app).post("/api/procas/connect").send(GOOD_CREDS).expect(200);
}

describe("procas integration", () => {
  it("defaults to upload mode when never connected", async () => {
    const res = await request(app).get("/api/procas/status");
    expect(res.status).toBe(200);
    expect(res.body.connected).toBe(false);
    expect(res.body.mode).toBe("upload");
  });

  it("rejects connect when the credentials are unauthorized", async () => {
    mockOData((table) => {
      expect(table).toBe("Item"); // ping validates against a small approved table
      return new Response(null, { status: 401 });
    });
    const res = await request(app).post("/api/procas/connect").send(GOOD_CREDS);
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/unauthorized|username or password/i);

    const status = await request(app).get("/api/procas/status");
    expect(status.body.connected).toBe(false);
  });

  it("rejects connect when the company code is unknown (404)", async () => {
    mockOData(() => new Response(null, { status: 404 }));
    const res = await request(app).post("/api/procas/connect").send(GOOD_CREDS);
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/company code/i);
  });

  it("connects when credentials validate, then disconnects", async () => {
    let sawBasicAuth = false;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      if (typeof headers.Authorization === "string" && headers.Authorization.startsWith("Basic ")) {
        sawBasicAuth = true;
      }
      expect(String(input)).toContain("/AZAD/Item");
      return odataResponse([{ LCItem: "ENG" }]);
    });
    const connect = await request(app).post("/api/procas/connect").send(GOOD_CREDS);
    expect(connect.status).toBe(200);
    expect(connect.body.connected).toBe(true);
    expect(connect.body.mode).toBe("live");
    expect(connect.body.companyCode).toBe("AZAD");
    expect(connect.body.username).toBe("julie");
    expect(sawBasicAuth).toBe(true);

    // The password must be encrypted at rest, never readable plaintext in the DB.
    const [stored] = await db
      .select()
      .from(procasConnectionTable)
      .where(eq(procasConnectionTable.id, 1));
    expect(stored?.password).toBeTruthy();
    expect(stored?.password).not.toBe(GOOD_CREDS.password);
    expect(stored?.password).not.toContain(GOOD_CREDS.password);
    expect(stored?.password?.startsWith("enc:")).toBe(true);

    const disconnect = await request(app).post("/api/procas/disconnect");
    expect(disconnect.status).toBe(200);
    expect(disconnect.body.connected).toBe(false);
    expect(disconnect.body.mode).toBe("upload");
  });

  it("pulls finalized Labor Journal hours and imports them as line items with Procas billing rates", async () => {
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

    mockOData((table, url) => {
      if (table === "GLDetail") {
        // Period bounds and project must be part of the OData filter.
        expect(url).toContain("TransDate ge 2026-01-01T00:00:00Z");
        expect(url).toContain("TransDate le 2026-01-15T23:59:59Z");
        expect(url).toContain("Project eq 'JOB'");
        return [
          // Two regular days aggregate into one line.
          { TransDate: "2026-01-05T00:00:00Z", Project: "JOB", LCItem: "ENG", LCItemDesc: "Engineer", Organization: "E1", OrganizationDesc: emp.name, PayCode: "REG", PayCodeDesc: "Regular", GLQty: 8 },
          { TransDate: "2026-01-06T00:00:00Z", Project: "JOB", LCItem: "ENG", LCItemDesc: "Engineer", Organization: "E1", OrganizationDesc: emp.name, PayCode: "REG", PayCodeDesc: "Regular", GLQty: 32 },
          // OT has no BillingItem rate → falls back to the employee's local rate.
          { TransDate: "2026-01-07T00:00:00Z", Project: "JOB", LCItem: "ENG-OT", LCItemDesc: "Engineer OT", Organization: "E1", OrganizationDesc: emp.name, PayCode: "OT", PayCodeDesc: "Overtime", GLQty: 5 },
        ];
      }
      if (table === "BillingItem") {
        return [
          { Project: "JOB", LCItem: "ENG", BillingRate: 155, BillingDateBeginning: "2025-01-01T00:00:00Z", BillingDateEnding: null },
        ];
      }
      if (table === "BillingHistory") return [];
      return [];
    });

    await connectProcas();

    const sync = await request(app).post(`/api/invoices/${inv.id}/procas-sync`);
    expect(sync.status).toBe(200);
    expect(sync.body.source).toBe("procas");
    expect(sync.body.importedCount).toBe(2); // aggregated per person/LC/category

    const items = await db.select().from(lineItemsTable).where(eq(lineItemsTable.invoiceId, inv.id));
    expect(items).toHaveLength(2);
    const regRow = items.find((i) => i.category === "regular");
    expect(regRow?.hours).toBe(40); // 8 + 32 aggregated
    expect(regRow?.rate).toBe(155); // Billing Setup rate wins over local rate
    const otRow = items.find((i) => i.category === "ot");
    expect(otRow?.hours).toBe(5);
    expect(otRow?.rate).toBe(150); // no Procas rate → local home rate fallback
    // A warning surfaces the missing Procas rate.
    expect(sync.body.warnings.some((w: string) => /No Procas billing rate/i.test(w))).toBe(true);

    const status = await request(app).get("/api/procas/status");
    expect(status.body.lastSyncAt).toBeTruthy();
  });

  it("falls back to raw Timesheet hours with a warning when the Labor Journal is empty", async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const [emp] = await db
      .insert(employeesTable)
      .values({ name: `TS Emp ${suffix}`, classification: "Engineer", homeRate: 100 })
      .returning();
    createdEmployeeIds.push(emp.id);
    const [wp] = await db
      .insert(workPlansTable)
      .values({ code: `TS-WP-${suffix}`, title: "TS WP", client: "Client", jobNumber: "JOB", poNumber: "PO", totalBudget: 100000 })
      .returning();
    createdWorkPlanIds.push(wp.id);
    const [inv] = await db
      .insert(invoicesTable)
      .values({
        workPlanId: wp.id,
        invoiceNumber: `TS-INV-${suffix}`,
        invoiceDate: "2026-02-01",
        periodStart: "2026-01-01",
        periodEnd: "2026-01-15",
      })
      .returning();
    createdInvoiceIds.push(inv.id);

    mockOData((table, url) => {
      if (table === "GLDetail") return [];
      if (table === "Timesheet") {
        expect(url).toContain("WorkDate ge 2026-01-01T00:00:00Z");
        return [
          { Personnel: "E9", PersonnelName: emp.name, Project: "JOB", LCItem: "ENG", LCItemDesc: "Engineer", PayCode: "REG", PayCodeDesc: "Regular", WorkDate: "2026-01-05T00:00:00Z", HoursWorked: 8 },
        ];
      }
      return [];
    });

    await connectProcas();
    const sync = await request(app).post(`/api/invoices/${inv.id}/procas-sync`);
    expect(sync.status).toBe(200);
    expect(sync.body.importedCount).toBe(1);
    expect(sync.body.warnings.some((w: string) => /Timesheet hours/i.test(w))).toBe(true);
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
      .values({ code: `RESYNC-WP-${suffix}`, title: "Resync WP", client: "Client", jobNumber: "JOB", poNumber: "PO", totalBudget: 100000 })
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

    // The same period returns the same two categories on every pull.
    mockOData((table) => {
      if (table === "GLDetail") {
        return [
          { TransDate: "2026-01-05T00:00:00Z", Project: "JOB", LCItem: "ENG", LCItemDesc: "Engineer", OrganizationDesc: emp.name, PayCodeDesc: "Regular", GLQty: 40 },
          { TransDate: "2026-01-06T00:00:00Z", Project: "JOB", LCItem: "ENG", LCItemDesc: "Engineer", OrganizationDesc: emp.name, PayCodeDesc: "Overtime", GLQty: 5 },
        ];
      }
      if (table === "BillingItem") {
        return [{ Project: "JOB", LCItem: "ENG", BillingRate: 150, BillingDateBeginning: null, BillingDateEnding: null }];
      }
      return [];
    });

    await connectProcas();

    const first = await request(app).post(`/api/invoices/${inv.id}/procas-sync`);
    expect(first.status).toBe(200);
    expect(first.body.importedCount).toBe(2);
    expect(first.body.replacedCount).toBe(0);

    // Second sync of the same period must replace, not stack.
    const second = await request(app).post(`/api/invoices/${inv.id}/procas-sync`);
    expect(second.status).toBe(200);
    expect(second.body.importedCount).toBe(2);
    expect(second.body.replacedCount).toBe(2);
    expect(second.body.warnings.some((w: string) => /Replaced 2 previously imported/i.test(w))).toBe(true);

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
      .values({ code: `RESYNC-MIX-WP-${suffix}`, title: "Resync Mixed WP", client: "Client", jobNumber: "JOB", poNumber: "PO", totalBudget: 100000 })
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

    mockOData((table) => {
      if (table === "GLDetail") {
        return [
          { TransDate: "2026-01-05T00:00:00Z", Project: "JOB", LCItem: "ENG", LCItemDesc: "Engineer", OrganizationDesc: emp.name, PayCodeDesc: "Regular", GLQty: 8 },
        ];
      }
      if (table === "BillingItem") {
        return [{ Project: "JOB", LCItem: "ENG", BillingRate: 100, BillingDateBeginning: null, BillingDateEnding: null }];
      }
      return [];
    });

    await connectProcas();

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

  it("defaults an invoice's Previously Billed from BillingHistory but never overrides a manual value", async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const [emp] = await db
      .insert(employeesTable)
      .values({ name: `PB Emp ${suffix}`, classification: "Engineer", homeRate: 100 })
      .returning();
    createdEmployeeIds.push(emp.id);
    const [wp] = await db
      .insert(workPlansTable)
      .values({ code: `PB-WP-${suffix}`, title: "PB WP", client: "Client", jobNumber: "JOB", poNumber: "PO", totalBudget: 100000 })
      .returning();
    createdWorkPlanIds.push(wp.id);
    const [inv] = await db
      .insert(invoicesTable)
      .values({
        workPlanId: wp.id,
        invoiceNumber: `PB-INV-${suffix}`,
        invoiceDate: "2026-02-01",
        periodStart: "2026-01-01",
        periodEnd: "2026-01-15",
      })
      .returning();
    createdInvoiceIds.push(inv.id);

    mockOData((table, url) => {
      if (table === "GLDetail") {
        return [
          { TransDate: "2026-01-05T00:00:00Z", Project: "JOB", LCItem: "ENG", LCItemDesc: "Engineer", OrganizationDesc: emp.name, PayCodeDesc: "Regular", GLQty: 8 },
        ];
      }
      if (table === "BillingItem") {
        return [{ Project: "JOB", LCItem: "ENG", BillingRate: 100, BillingDateBeginning: null, BillingDateEnding: null }];
      }
      if (table === "BillingHistory") {
        expect(url).toContain("IsVoided eq false");
        expect(url).toContain("InvoiceDate lt 2026-01-01T00:00:00Z");
        return [
          { Project: "JOB", InvoiceNumber: "OLD-1", InvoiceDate: "2025-11-01T00:00:00Z", TotalBillingAmount: 1200.5, IsVoided: false },
          { Project: "JOB", InvoiceNumber: "OLD-2", InvoiceDate: "2025-12-01T00:00:00Z", TotalBillingAmount: 800, IsVoided: false },
        ];
      }
      return [];
    });

    await connectProcas();
    const sync = await request(app).post(`/api/invoices/${inv.id}/procas-sync`);
    expect(sync.status).toBe(200);

    const [after] = await db.select().from(invoicesTable).where(eq(invoicesTable.id, inv.id));
    expect(after?.previouslyBilled).toBeCloseTo(2000.5, 2);
    expect(sync.body.warnings.some((w: string) => /Previously Billed set to \$2000\.50/i.test(w))).toBe(true);

    // Now the user sets a manual value; a re-sync must not clobber it.
    await db
      .update(invoicesTable)
      .set({ previouslyBilled: 9999, carryOverManual: true })
      .where(eq(invoicesTable.id, inv.id));
    await request(app).post(`/api/invoices/${inv.id}/procas-sync`).expect(200);
    const [afterManual] = await db.select().from(invoicesTable).where(eq(invoicesTable.id, inv.id));
    expect(afterManual?.previouslyBilled).toBe(9999);
  });

  it("reference sync creates and updates employees from Personnel with approved fields only", async () => {
    const { syncReferenceFromProcas } = await import("../lib/procasSync");
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const newName = `Ref New Emp ${suffix}`;
    const existingName = `Ref Existing Emp ${suffix}`;
    const [existing] = await db
      .insert(employeesTable)
      .values({ name: existingName, classification: "Old Class", homeRate: 90, active: true })
      .returning();
    createdEmployeeIds.push(existing.id);

    mockOData((table) => {
      if (table === "Personnel") {
        return [
          { Personnel: "P1", PersonnelName: newName, PersonnelLaborCategory: "ENG", PersonnelLaborCategoryDesc: "Engineer II", PersonnelJobTitle: "Engineer", IsActivePersonnel: true },
          { Personnel: "P2", PersonnelName: existingName, PersonnelLaborCategory: "SR", PersonnelLaborCategoryDesc: "Senior Engineer", PersonnelJobTitle: "Sr Engineer", IsActivePersonnel: false },
        ];
      }
      if (table === "PayRateInfo") {
        return [
          { Personnel: "P1", EffectiveDate: "2026-01-01T00:00:00Z", PayRate: 62.5, IsActivePayRateInfo: true },
        ];
      }
      if (table === "Item") {
        return [{ LCItem: "ENG", LCItemDesc: "Engineer II", DefaultBillingRate: 145, IsActiveLCItem: true, IsLaborCategory: true }];
      }
      return [];
    });

    const result = await syncReferenceFromProcas(GOOD_CREDS);
    expect(result.employeesCreated).toBe(1);
    expect(result.employeesUpdated).toBe(1);

    const created = await db.select().from(employeesTable).where(eq(employeesTable.name, newName));
    expect(created).toHaveLength(1);
    createdEmployeeIds.push(created[0].id);
    expect(created[0].classification).toBe("Engineer II");
    expect(created[0].homeRate).toBe(145); // Item default billing rate
    expect(created[0].payRate).toBe(62.5);

    const [updated] = await db.select().from(employeesTable).where(eq(employeesTable.id, existing.id));
    expect(updated.classification).toBe("Senior Engineer");
    expect(updated.active).toBe(false);
  });

  it("reference sync refreshes work plan rates from BillingAccount by job number", async () => {
    const { syncReferenceFromProcas } = await import("../lib/procasSync");
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const job = `RATE-JOB-${suffix}`;
    const [wp] = await db
      .insert(workPlansTable)
      .values({ code: `RATE-WP-${suffix}`, title: "Rate WP", client: "Client", jobNumber: job, poNumber: "PO", totalBudget: 50000, fringeRate: 100 })
      .returning();
    createdWorkPlanIds.push(wp.id);

    mockOData((table) => {
      if (table === "Project") return [{ Project: job, ProjectDesc: "Rate Project", ContractNumber: "CN-1" }];
      if (table === "BillingAccount") {
        return [{ Project: job, FringePercent: 120.58, OverheadPercent: 15.5, FeePercent: 8 }];
      }
      return [];
    });

    const result = await syncReferenceFromProcas(GOOD_CREDS);
    expect(result.workPlansUpdated).toBe(1);
    const [after] = await db.select().from(workPlansTable).where(eq(workPlansTable.id, wp.id));
    expect(after.fringeRate).toBeCloseTo(120.58, 2);
    expect(after.overheadRate).toBeCloseTo(15.5, 2);
    expect(after.fixedFeeRate).toBeCloseTo(8, 2);
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
      .values({ code: `SCHED-WP-${suffix}`, title: "Sched WP", client: "Client", jobNumber: "JOB", poNumber: "PO", totalBudget: 100000 })
      .returning();
    createdWorkPlanIds.push(wp.id);

    // A far-future period unique to this test: the global cycle pulls every
    // open invoice, but only this period's filter returns rows.
    const periodStart = "2099-01-01";

    const [draftInv] = await db
      .insert(invoicesTable)
      .values({
        workPlanId: wp.id,
        invoiceNumber: `SCHED-DRAFT-${suffix}`,
        invoiceDate: "2099-02-01",
        periodStart,
        periodEnd: "2099-01-15",
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
        periodEnd: "2099-01-15",
        status: "approved",
      })
      .returning();
    createdInvoiceIds.push(approvedInv.id);

    mockOData((table, url) => {
      if (table === "GLDetail" && url.includes(`TransDate ge ${periodStart}T00:00:00Z`)) {
        return [
          { TransDate: "2099-01-05T00:00:00Z", Project: "JOB", LCItem: "ENG", LCItemDesc: "Engineer", OrganizationDesc: emp.name, PayCodeDesc: "Regular", GLQty: 8 },
        ];
      }
      if (table === "BillingItem") {
        return [{ Project: "JOB", LCItem: "ENG", BillingRate: 120, BillingDateBeginning: null, BillingDateEnding: null }];
      }
      return [];
    });

    await connectProcas();

    const result = await runProcasSyncCycle();
    expect(result.skipped).toBe(false);
    expect(result.synced).toBe(1);

    // Only the open (draft) invoice was pulled.
    const draftItems = await db.select().from(lineItemsTable).where(eq(lineItemsTable.invoiceId, draftInv.id));
    expect(draftItems).toHaveLength(1);
    const approvedItems = await db.select().from(lineItemsTable).where(eq(lineItemsTable.invoiceId, approvedInv.id));
    expect(approvedItems).toHaveLength(0);

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

    const tooSmall = await request(app).put("/api/procas/scheduler").send({ intervalMs: 1000 });
    expect(tooSmall.status).toBe(400);

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
      .values({ code: `REFRESH-WP-${suffix}`, title: "Refresh WP", client: "Client", jobNumber: "JOB", poNumber: "PO", totalBudget: 100000 })
      .returning();
    createdWorkPlanIds.push(wp.id);

    const periodStart = "2098-01-01";
    const [draftInv] = await db
      .insert(invoicesTable)
      .values({
        workPlanId: wp.id,
        invoiceNumber: `REFRESH-DRAFT-${suffix}`,
        invoiceDate: "2098-02-01",
        periodStart,
        periodEnd: "2098-01-15",
        status: "draft",
      })
      .returning();
    createdInvoiceIds.push(draftInv.id);

    mockOData((table, url) => {
      if (table === "GLDetail" && url.includes(`TransDate ge ${periodStart}T00:00:00Z`)) {
        return [
          { TransDate: "2098-01-05T00:00:00Z", Project: "JOB", LCItem: "ENG", LCItemDesc: "Engineer", OrganizationDesc: emp.name, PayCodeDesc: "Regular", GLQty: 8 },
        ];
      }
      if (table === "BillingItem") {
        return [{ Project: "JOB", LCItem: "ENG", BillingRate: 120, BillingDateBeginning: null, BillingDateEnding: null }];
      }
      return [];
    });

    await connectProcas();

    const res = await request(app).post("/api/procas/refresh");
    expect(res.status).toBe(200);
    expect(res.body.lastSkipped).toBe(false);
    expect(res.body.lastSynced).toBeGreaterThanOrEqual(1);
    expect(res.body.lastRunAt).toBeTruthy();
    expect(res.body.connected).toBe(true);

    const items = await db.select().from(lineItemsTable).where(eq(lineItemsTable.invoiceId, draftInv.id));
    expect(items).toHaveLength(1);

    const status = await request(app).get("/api/procas/scheduler");
    expect(status.body.lastSynced).toBeGreaterThanOrEqual(1);
    expect(status.body.lastRunAt).toBeTruthy();
  });

  it("records each completed cycle as its own history row, newest first", async () => {
    // Two skipped cycles (not connected) should produce two distinct rows.
    await request(app).post("/api/procas/refresh").expect(200);
    await request(app).post("/api/procas/refresh").expect(200);

    const res = await request(app).get("/api/procas/scheduler/runs");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(2);
    for (const run of res.body) {
      expect(run.skipped).toBe(true);
      expect(run.synced).toBe(0);
      expect(run.failed).toBe(0);
      expect(run.ranAt).toBeTruthy();
    }
    // Newest first.
    const times = res.body.map((r: { ranAt: string }) => new Date(r.ranAt).getTime());
    expect(times[0]).toBeGreaterThanOrEqual(times[1]);
  });

  it("caps run history at MAX_RUN_HISTORY rows and the endpoint returns at most 10", async () => {
    const { MAX_RUN_HISTORY } = await import("../lib/procasScheduler");
    const base = Date.now() - 1000 * 60 * 60;
    await db.insert(procasSchedulerRunsTable).values(
      Array.from({ length: MAX_RUN_HISTORY + 5 }, (_, i) => ({
        ranAt: new Date(base + i * 1000),
        synced: i,
        failed: 0,
        skipped: false,
      })),
    );

    // Any recorded cycle triggers pruning down to the cap.
    await request(app).post("/api/procas/refresh").expect(200);

    const rows = await db.select().from(procasSchedulerRunsTable);
    expect(rows).toHaveLength(MAX_RUN_HISTORY);
    // The oldest rows were pruned; the newest (the refresh itself) survives.
    const oldest = new Date(base + 5 * 1000).getTime();
    for (const row of rows) {
      expect(row.ranAt.getTime()).toBeGreaterThanOrEqual(oldest);
    }

    const res = await request(app).get("/api/procas/scheduler/runs");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(10);
    // Newest first: the on-demand refresh (skipped, not connected) leads.
    expect(res.body[0].skipped).toBe(true);
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
      .values({ code: `FAIL-WP-${suffix}`, title: "Fail WP", client: "Client", jobNumber: "JOB", poNumber: "PO", totalBudget: 100000 })
      .returning();
    createdWorkPlanIds.push(wp.id);

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

    mockOData((table, url) => {
      if (table === "GLDetail") {
        // The bad invoice's period returns a 502 → fetch_failed for that invoice.
        if (url.includes(`TransDate ge ${badStart}T00:00:00Z`)) return new Response(null, { status: 502 });
        if (url.includes(`TransDate ge ${goodStart}T00:00:00Z`)) {
          return [
            { TransDate: "2096-01-05T00:00:00Z", Project: "JOB", LCItem: "ENG", LCItemDesc: "Engineer", OrganizationDesc: emp.name, PayCodeDesc: "Regular", GLQty: 8 },
          ];
        }
        return [];
      }
      if (table === "BillingItem") {
        return [{ Project: "JOB", LCItem: "ENG", BillingRate: 110, BillingDateBeginning: null, BillingDateEnding: null }];
      }
      return [];
    });

    await connectProcas();

    const result = await runProcasSyncCycle();
    expect(result.skipped).toBe(false);
    expect(result.failed).toBe(1);
    expect(result.synced).toBe(1);

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
      .values({ code: `EMPTY-WP-${suffix}`, title: "Empty WP", client: "Client", jobNumber: "JOB", poNumber: "PO", totalBudget: 100000 })
      .returning();
    createdWorkPlanIds.push(wp.id);

    const [inv] = await db
      .insert(invoicesTable)
      .values({
        workPlanId: wp.id,
        invoiceNumber: `EMPTY-DRAFT-${suffix}`,
        invoiceDate: "2095-02-01",
        periodStart: "2095-01-01",
        periodEnd: "2095-01-15",
        status: "draft",
      })
      .returning();
    createdInvoiceIds.push(inv.id);

    // Every table (GLDetail, Timesheet, reference tables) returns empty.
    mockOData(() => []);

    await connectProcas();

    const result = await runProcasSyncCycle();
    expect(result.skipped).toBe(false);
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
      .values({ code: `OVL-WP-${suffix}`, title: "Overlap WP", client: "Client", jobNumber: "JOB", poNumber: "PO", totalBudget: 100000 })
      .returning();
    createdWorkPlanIds.push(wp.id);

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

    // The first GLDetail fetch parks on this gate, holding the cycle open so a
    // second tick arrives mid-flight. All feeds resolve empty (no imports).
    let releaseGate: () => void = () => {};
    const gate = new Promise<void>((res) => {
      releaseGate = res;
    });
    let glCalls = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: string | URL | Request) => {
      const url = decodeURIComponent(String(input).replace(/\+/g, " "));
      if (tableFromUrl(url) === "GLDetail") {
        glCalls += 1;
        await gate;
      }
      return odataResponse([]);
    });

    await connectProcas();

    const first = tick();
    for (let i = 0; i < 100 && glCalls < 1; i += 1) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(glCalls).toBe(1);

    // A second tick while the first is running must be a no-op.
    await tick();
    expect(glCalls).toBe(1);

    releaseGate();
    await first;
  });

  it("refuses to sync when Procas is not connected", async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const [wp] = await db
      .insert(workPlansTable)
      .values({ code: `PC-WP2-${suffix}`, title: "Procas WP2", client: "Client", jobNumber: "JOB", poNumber: "PO", totalBudget: 100000 })
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

    const connSpy = vi
      .spyOn(procasModule, "getProcasConnection")
      .mockRejectedValueOnce(new Error("database hiccup while loading open invoices"));

    await expect(scheduler.tick()).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalled();

    const afterThrow = await scheduler.getSchedulerState();
    expect(afterThrow.running).toBe(false);

    connSpy.mockRestore();
    await expect(scheduler.tick()).resolves.toBeUndefined();
  });

  it("tick resolves without throwing when both the cycle and the result recording fail", async () => {
    const scheduler = await import("../lib/procasScheduler");
    const procasModule = await import("../lib/procas");
    const { logger } = await import("../lib/logger");

    const errorSpy = vi.spyOn(logger, "error").mockImplementation((() => logger) as never);

    const connSpy = vi
      .spyOn(procasModule, "getProcasConnection")
      .mockRejectedValue(new Error("database down during cycle"));
    // Recording the failure also fails: every UPDATE against the scheduler row throws.
    const updateSpy = vi.spyOn(db, "update").mockImplementation(() => {
      throw new Error("database still down while persisting result");
    });

    try {
      await expect(scheduler.tick()).resolves.toBeUndefined();
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      connSpy.mockRestore();
      updateSpy.mockRestore();
      errorSpy.mockRestore();
    }

    // The running guard reset, so a subsequent tick runs normally.
    const state = await scheduler.getSchedulerState();
    expect(state.running).toBe(false);
    await expect(scheduler.tick()).resolves.toBeUndefined();
  });

  it("flags scheduler results as stale after repeated persistence failures and resets once a write succeeds", async () => {
    const scheduler = await import("../lib/procasScheduler");
    const procasModule = await import("../lib/procas");
    const { logger } = await import("../lib/logger");

    scheduler.resetPersistFailuresForTest();
    const errorSpy = vi.spyOn(logger, "error").mockImplementation((() => logger) as never);
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation((() => logger) as never);

    // Every cycle fails, and persisting the outcome fails too.
    const connSpy = vi
      .spyOn(procasModule, "getProcasConnection")
      .mockRejectedValue(new Error("database down during cycle"));
    const updateSpy = vi.spyOn(db, "update").mockImplementation(() => {
      throw new Error("database still down while persisting result");
    });

    try {
      for (let i = 0; i < scheduler.PERSIST_FAILURE_WARN_THRESHOLD; i++) {
        await scheduler.tick();
      }
    } finally {
      updateSpy.mockRestore();
    }

    const stale = await scheduler.getSchedulerState();
    expect(stale.persistFailures).toBe(scheduler.PERSIST_FAILURE_WARN_THRESHOLD);
    expect(stale.resultsStale).toBe(true);

    // The status endpoint surfaces the indicator (restore the connection mock
    // first — the payload also reads the Procas connection).
    connSpy.mockRestore();
    const res = await request(app).get("/api/procas/scheduler");
    expect(res.status).toBe(200);
    expect(res.body.persistFailures).toBe(scheduler.PERSIST_FAILURE_WARN_THRESHOLD);
    expect(res.body.resultsStale).toBe(true);

    // Once persistence works again, the counter resets automatically.
    errorSpy.mockRestore();
    warnSpy.mockRestore();
    await scheduler.tick();
    const recovered = await scheduler.getSchedulerState();
    expect(recovered.persistFailures).toBe(0);
    expect(recovered.resultsStale).toBe(false);
  });

  it("skips a concurrent cycle cleanly when another instance holds the cross-instance sync lock", async () => {
    const { tick, getSchedulerState } = await import("../lib/procasScheduler");
    const { pool } = await import("@workspace/db");
    // Must match SYNC_LOCK_KEY in procasScheduler.ts.
    const SYNC_LOCK_KEY = 0x70726373; // "prcs"

    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const [emp] = await db
      .insert(employeesTable)
      .values({ name: `Lock Emp ${suffix}`, classification: "Engineer", homeRate: 120, fieldRate: 140 })
      .returning();
    createdEmployeeIds.push(emp.id);
    const [wp] = await db
      .insert(workPlansTable)
      .values({ code: `LOCK-WP-${suffix}`, title: "Lock WP", client: "Client", jobNumber: "JOB", poNumber: "PO", totalBudget: 100000 })
      .returning();
    createdWorkPlanIds.push(wp.id);

    const periodStart = "2093-01-01";
    const [draftInv] = await db
      .insert(invoicesTable)
      .values({
        workPlanId: wp.id,
        invoiceNumber: `LOCK-DRAFT-${suffix}`,
        invoiceDate: "2093-02-01",
        periodStart,
        periodEnd: "2093-01-15",
        status: "draft",
      })
      .returning();
    createdInvoiceIds.push(draftInv.id);

    let glCalls = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: string | URL | Request) => {
      const url = decodeURIComponent(String(input).replace(/\+/g, " "));
      const table = tableFromUrl(url);
      if (table === "GLDetail") {
        glCalls += 1;
        if (url.includes(`TransDate ge ${periodStart}T00:00:00Z`)) {
          return odataResponse([
            { TransDate: "2093-01-05T00:00:00Z", Project: "JOB", LCItem: "ENG", LCItemDesc: "Engineer", OrganizationDesc: emp.name, PayCodeDesc: "Regular", GLQty: 8 },
          ]);
        }
        return odataResponse([]);
      }
      if (table === "BillingItem") {
        return odataResponse([{ Project: "JOB", LCItem: "ENG", BillingRate: 120, BillingDateBeginning: null, BillingDateEnding: null }]);
      }
      return odataResponse([]);
    });

    await connectProcas();

    const holder = await pool.connect();
    try {
      const held = await holder.query<{ locked: boolean }>(
        "SELECT pg_try_advisory_lock($1) AS locked",
        [SYNC_LOCK_KEY],
      );
      expect(held.rows[0]?.locked).toBe(true);

      await tick();
      expect(glCalls).toBe(0);

      const itemsWhileLocked = await db
        .select()
        .from(lineItemsTable)
        .where(eq(lineItemsTable.invoiceId, draftInv.id));
      expect(itemsWhileLocked).toHaveLength(0);

      const state = await getSchedulerState();
      expect(state.lastRunAt).toBeNull();
      expect(state.lastError).toBeNull();
      expect(state.lastSynced).toBe(0);
    } finally {
      await holder.query("SELECT pg_advisory_unlock($1)", [SYNC_LOCK_KEY]);
      holder.release();
    }

    await tick();
    expect(glCalls).toBeGreaterThanOrEqual(1);
    const itemsAfterRelease = await db
      .select()
      .from(lineItemsTable)
      .where(eq(lineItemsTable.invoiceId, draftInv.id));
    expect(itemsAfterRelease).toHaveLength(1);
  });

  it("tick skips cleanly with a warning when the pool connection for the sync lock times out", async () => {
    const scheduler = await import("../lib/procasScheduler");
    const { pool } = await import("@workspace/db");
    const { logger } = await import("../lib/logger");

    const prev = process.env["PROCAS_LOCK_CONNECT_TIMEOUT_MS"];
    process.env["PROCAS_LOCK_CONNECT_TIMEOUT_MS"] = "50";

    const warnSpy = vi.spyOn(logger, "warn").mockImplementation((() => logger) as never);
    // Simulate an exhausted pool for the FIRST checkout only (the dedicated
    // lock connection); later checkouts (drizzle queries) work normally.
    let resolveLate: ((client: unknown) => void) | undefined;
    const released: unknown[] = [];
    const hungConnect = new Promise((resolve) => {
      resolveLate = resolve;
    });
    const realConnect = pool.connect.bind(pool);
    let firstCall = true;
    const connectSpy = vi.spyOn(pool, "connect").mockImplementation(((...args: unknown[]) => {
      if (firstCall && args.length === 0) {
        firstCall = false;
        return hungConnect;
      }
      return (realConnect as (...a: unknown[]) => unknown)(...args);
    }) as never);

    try {
      await expect(scheduler.tick()).resolves.toBeUndefined();

      // The tick must have given up on the lock connection and logged a warning.
      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({ timeoutMs: 50 }),
        expect.stringMatching(/timed out waiting for a database connection/i),
      );

      // No cycle ran, so the persisted scheduler state stays untouched.
      connectSpy.mockRestore();
      const state = await scheduler.getSchedulerState();
      expect(state.running).toBe(false);
      expect(state.lastRunAt).toBeNull();
      expect(state.lastError).toBeNull();

      // If the checkout completes after the timeout, the client is handed
      // straight back to the pool rather than leaked.
      resolveLate?.({ release: () => released.push("released") });
      await new Promise((r) => setTimeout(r, 0));
      expect(released).toEqual(["released"]);

      // The loop stays healthy: a later tick with a working pool proceeds
      // normally (no connection, so the cycle records a clean skip).
      await expect(scheduler.tick()).resolves.toBeUndefined();
      const after = await scheduler.getSchedulerState();
      expect(after.lastRunAt).not.toBeNull();
      expect(after.lastSkipped).toBe(true);
    } finally {
      if (prev === undefined) delete process.env["PROCAS_LOCK_CONNECT_TIMEOUT_MS"];
      else process.env["PROCAS_LOCK_CONNECT_TIMEOUT_MS"] = prev;
    }
  });

  it("startProcasScheduler is idempotent and honors PROCAS_SYNC_INTERVAL_MS with a default fallback", async () => {
    const { startProcasScheduler, stopProcasScheduler } = await import("../lib/procasScheduler");
    const prev = process.env["PROCAS_SYNC_INTERVAL_MS"];
    const DEFAULT_INTERVAL_MS = 15 * 60 * 1000;
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");

    try {
      process.env["PROCAS_SYNC_INTERVAL_MS"] = String(5 * 60 * 1000);
      await startProcasScheduler();
      await startProcasScheduler();
      expect(setIntervalSpy).toHaveBeenCalledTimes(1);
      expect(setIntervalSpy.mock.calls[0]?.[1]).toBe(5 * 60 * 1000);
      stopProcasScheduler();

      setIntervalSpy.mockClear();
      process.env["PROCAS_SYNC_INTERVAL_MS"] = "not-a-number";
      await startProcasScheduler();
      expect(setIntervalSpy).toHaveBeenCalledTimes(1);
      expect(setIntervalSpy.mock.calls[0]?.[1]).toBe(DEFAULT_INTERVAL_MS);
      stopProcasScheduler();

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
