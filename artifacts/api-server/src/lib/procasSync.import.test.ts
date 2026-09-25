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

// Procas returns percentages as FRACTIONS (0.555 = 55.5%); the import scales
// them ×100 into the whole-number percents asserted below.
const BILLING_ACCOUNT_ROWS = [
  {
    Project: "90001",
    FringePercent: 0.555,
    OverheadPercent: 0.9025,
    FeePercent: 0.1,
    FacilitiesPercent: 0.005,
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
    // ContractNumber is the one invoice header field Procas knows, so the
    // Agreement No. arrives filled instead of Julie typing it per work plan.
    expect(p1.agreementNo).toBe("C-90001");
    expect(p1.status).toBe("active");
    expect(p1.fringeRate).toBe(55.5);
    expect(p1.overheadRate).toBe(90.25);
    expect(p1.fixedFeeRate).toBe(10);
    expect(p1.fccmRate).toBe(0.5);
    expect(p1.source).toBe("procas");

    const [p2] = await db.select().from(workPlansTable).where(eq(workPlansTable.code, "90002"));
    expect(p2.status).toBe("archived"); // IsClosed
    expect(p2.totalBudget).toBe(80000); // falls back to EstimatedTotal
    expect(p2.agreementNo).toBeNull(); // Procas has no contract number for it
  });

  it("is idempotent and refreshes Procas-owned fields on imported rows", async () => {
    // Drift the imported plan (as if Procas data changed since last import);
    // the rerun refreshes it, but the local budget is preserved.
    await db
      .update(workPlansTable)
      .set({ title: "Stale title", totalBudget: 999, agreementNo: "6M8213" })
      .where(eq(workPlansTable.code, "90001"));

    const second = await importWorkPlansFromProcas(creds);
    expect(second.created).toBe(0);
    expect(second.updated).toBe(1);

    const [p1] = await db.select().from(workPlansTable).where(eq(workPlansTable.code, "90001"));
    expect(p1.title).toBe("Transit Station Upgrade");
    expect(p1.totalBudget).toBe(999); // manual budget never stomped
    expect(p1.agreementNo).toBe("6M8213"); // nor a hand-corrected agreement no
  });

  it("imports BART's last-Friday billing cycle, and corrects plans stuck on whole-month", async () => {
    // Every contract here bills Sat→Fri through the last Friday of the month.
    // New imports get that cycle outright.
    const [fresh] = await db.select().from(workPlansTable).where(eq(workPlansTable.code, "90001"));
    expect(fresh.billingCycle).toBe("last_friday");

    // Plans imported before that was the default sit on "whole_month" — a value
    // no biller chose. It pre-filled 9/1-9/30 on an AECOM package whose period
    // should have ended Friday 9/25. A refresh corrects them and says how many.
    await db
      .update(workPlansTable)
      .set({ billingCycle: "whole_month" })
      .where(eq(workPlansTable.code, "90001"));

    const result = await importWorkPlansFromProcas(creds);
    expect(result.cyclesCorrected).toBe(1);
    const [corrected] = await db
      .select()
      .from(workPlansTable)
      .where(eq(workPlansTable.code, "90001"));
    expect(corrected.billingCycle).toBe("last_friday");

    // A plan the biller owns is never touched, whatever its cycle.
    await db
      .update(workPlansTable)
      .set({ billingCycle: "whole_month" })
      .where(eq(workPlansTable.id, manualPlanId));
    const after = await importWorkPlansFromProcas(creds);
    expect(after.cyclesCorrected).toBe(0);
    const [manual] = await db
      .select()
      .from(workPlansTable)
      .where(eq(workPlansTable.id, manualPlanId));
    expect(manual.billingCycle).toBe("whole_month");
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
