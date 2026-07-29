import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { inArray, eq } from "drizzle-orm";
import { db, workPlansTable } from "@workspace/db";
import { importWorkPlansFromProcas } from "./procasSync";
import type { ProcasCreds } from "./procas";

const creds: ProcasCreds = { companyCode: "AZADEN", username: "u", password: "p" };

function odataResponse(rows: unknown[]) {
  return new Response(JSON.stringify({ value: rows }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const PROJECT_ROWS = [
  {
    Project: "90001",
    ProjectDesc: "Transit Station Upgrade",
    Client: "BART",
    ClientDesc: "Bay Area Rapid Transit",
    ContractNumber: "C-90001",
    ObligatedAmount: 250000,
    EstimatedTotal: 300000,
    ActiveForBilling: true,
    IsClosed: false,
  },
  {
    Project: "90002",
    ProjectDesc: "Bridge Retrofit",
    Client: "TYL",
    ClientDesc: "T.Y. Lin",
    ContractNumber: "",
    ObligatedAmount: 0,
    EstimatedTotal: 80000,
    ActiveForBilling: false,
    IsClosed: true,
  },
  // Already represented by the manual plan below (jobNumber match) — skipped.
  {
    Project: "90003",
    ProjectDesc: "Existing Manual Plan Project",
    Client: "X",
    ClientDesc: "X Corp",
    ContractNumber: "",
    ObligatedAmount: 10,
    EstimatedTotal: 10,
    ActiveForBilling: true,
    IsClosed: false,
  },
];

const BILLING_ACCOUNT_ROWS = [
  {
    Project: "90001",
    FringePercent: 55.5,
    OverheadPercent: 90.25,
    FeePercent: 10,
    FacilitiesPercent: 0.5,
  },
];

let manualPlanId: number;

beforeAll(async () => {
  const [manual] = await db
    .insert(workPlansTable)
    .values({
      code: "WP-MANUAL-IMP",
      title: "Manual plan",
      client: "X Corp",
      jobNumber: "90003",
      totalBudget: 123,
    })
    .returning();
  manualPlanId = manual.id;

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/Project")) return odataResponse(PROJECT_ROWS);
      if (url.includes("/BillingAccount")) return odataResponse(BILLING_ACCOUNT_ROWS);
      return odataResponse([]);
    }),
  );
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await db
    .delete(workPlansTable)
    .where(inArray(workPlansTable.code, ["WP-MANUAL-IMP", "90001", "90002", "90003"]));
});

describe("importWorkPlansFromProcas", () => {
  it("imports the full Procas library, skipping projects already represented", async () => {
    const first = await importWorkPlansFromProcas(creds);
    expect(first.total).toBe(3);
    expect(first.created).toBe(2); // 90003 is claimed by the manual plan
    expect(first.updated).toBe(0);

    const [p1] = await db.select().from(workPlansTable).where(eq(workPlansTable.code, "90001"));
    expect(p1.title).toBe("Transit Station Upgrade");
    expect(p1.client).toBe("Bay Area Rapid Transit");
    expect(p1.jobNumber).toBe("90001");
    expect(p1.procasProject).toBe("90001");
    expect(p1.totalBudget).toBe(250000); // ObligatedAmount wins over EstimatedTotal
    expect(p1.status).toBe("active");
    expect(p1.fringeRate).toBe(55.5);
    expect(p1.overheadRate).toBe(90.25);
    expect(p1.fixedFeeRate).toBe(10);
    expect(p1.fccmRate).toBe(0.5);
    expect(p1.source).toBe("procas");

    const [p2] = await db.select().from(workPlansTable).where(eq(workPlansTable.code, "90002"));
    expect(p2.status).toBe("archived"); // IsClosed
    expect(p2.totalBudget).toBe(80000); // falls back to EstimatedTotal
  });

  it("is idempotent and refreshes Procas-owned fields on imported rows", async () => {
    // Drift the imported plan (as if Procas data changed since last import);
    // the rerun refreshes it, but the local budget is preserved.
    await db
      .update(workPlansTable)
      .set({ title: "Stale title", totalBudget: 999 })
      .where(eq(workPlansTable.code, "90001"));

    const second = await importWorkPlansFromProcas(creds);
    expect(second.created).toBe(0);
    expect(second.updated).toBe(1);

    const [p1] = await db.select().from(workPlansTable).where(eq(workPlansTable.code, "90001"));
    expect(p1.title).toBe("Transit Station Upgrade");
    expect(p1.totalBudget).toBe(999); // manual budget never stomped
  });

  it("leaves manually-owned plans alone even when linked to a Procas project", async () => {
    // A biller edit flips ownership to manual — imports must stop touching it.
    await db
      .update(workPlansTable)
      .set({ title: "Julie's custom title", source: "manual" })
      .where(eq(workPlansTable.code, "90002"));

    const result = await importWorkPlansFromProcas(creds);
    expect(result.created).toBe(0);

    const [p2] = await db.select().from(workPlansTable).where(eq(workPlansTable.code, "90002"));
    expect(p2.title).toBe("Julie's custom title");
  });

  it("never touches the manual plan", async () => {
    const [manual] = await db.select().from(workPlansTable).where(eq(workPlansTable.id, manualPlanId));
    expect(manual.title).toBe("Manual plan");
    expect(manual.totalBudget).toBe(123);
    expect(manual.procasProject).toBeNull();
  });
});
