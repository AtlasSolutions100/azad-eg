import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  db,
  workPlansTable,
  packagesTable,
  packageWeeksTable,
  timesheetEntriesTable,
} from "@workspace/db";
import {
  pullPackageHoursFromProcas,
  normalizeCategory,
  isFinalStatus,
  leaveCategory,
} from "./procasPackageSync";
import type { ProcasCreds } from "./procas";

describe("normalizeCategory", () => {
  it("classifies OT/DT/holiday/PTO from the paycode", () => {
    expect(normalizeCategory("Overtime")).toBe("ot");
    expect(normalizeCategory("Doubletime")).toBe("dt");
    expect(normalizeCategory("Holiday")).toBe("holiday");
    expect(normalizeCategory("Sick")).toBe("pto");
    expect(normalizeCategory("Regular")).toBe("regular");
  });
  it("treats G&A / B&P / Overhead account descriptions as non-billable (PTO)", () => {
    expect(normalizeCategory("Regular", "G&A")).toBe("pto");
    expect(normalizeCategory("Regular", "B&P")).toBe("pto");
    expect(normalizeCategory("Regular", "Bid & Proposal")).toBe("pto");
    expect(normalizeCategory("Regular", "Overhead")).toBe("pto");
    // Direct time stays billable.
    expect(normalizeCategory("Regular", "Direct Time Field")).toBe("regular");
    expect(normalizeCategory("Overtime", "Direct Time Field")).toBe("ot");
  });
});

describe("isFinalStatus", () => {
  it("does not read \"Disapproved\" as approved", () => {
    // The test was "contains the word approved"; a month of disapproved hours
    // pulled in as approved, with nothing to stop the export.
    expect(isFinalStatus("Approved")).toBe(true);
    expect(isFinalStatus("Locked")).toBe(true);
    expect(isFinalStatus("Processed")).toBe(true);
    expect(isFinalStatus("Disapproved")).toBe(false);
    expect(isFinalStatus("Unapproved")).toBe(false);
    expect(isFinalStatus("Not Approved")).toBe(false);
    expect(isFinalStatus("Unsubmitted")).toBe(false);
    expect(isFinalStatus("Pending Approval")).toBe(false);
  });
});

describe("leaveCategory", () => {
  it("sorts Procas's leave pay codes into the timesheet's two leave rows", () => {
    expect(leaveCategory("Holiday")).toBe("holiday");
    expect(leaveCategory("H")).toBe("holiday");
    expect(leaveCategory("Sick")).toBe("pto");
    expect(leaveCategory("Vacation (or PTO)")).toBe("pto");
    expect(leaveCategory("V")).toBe("pto");
    // Worked time, and leave without pay, have no leave row.
    expect(leaveCategory("Rate 1 Regular")).toBeNull();
    expect(leaveCategory("Rate 1 Overtime")).toBeNull();
    expect(leaveCategory("Leave Without Pay")).toBeNull();
    expect(leaveCategory("L")).toBeNull();
  });
});

const creds: ProcasCreds = {
  companyCode: "AZADEN",
  username: "u",
  password: "p",
};

function odataResponse(rows: unknown[]) {
  return new Response(JSON.stringify({ value: rows }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const TS_ROWS = [
  // Week of Mon 6/1 – Sun 6/7, two days for Boyd (trailing-space name), regular
  {
    PersonnelName: "Boyd, Sarah ",
    Project: "10007.01.01.0.CA",
    LCItem: "ENG3",
    LCItemDesc: "Engineer III",
    PayCode: "R",
    PayCodeDesc: "Rate 1 Regular",
    WorkDate: "2026-06-01T00:00:00-04:00",
    HoursWorked: 8,
    Status: "Locked",
    TimePeriodBeginningDate: "2026-06-01T00:00:00-04:00",
    TimePeriodEndingDate: "2026-06-07T00:00:00-04:00",
  },
  {
    PersonnelName: "Boyd, Sarah ",
    Project: "10007.01.01.0.CA",
    LCItem: "ENG3",
    LCItemDesc: "Engineer III",
    PayCode: "R",
    PayCodeDesc: "Rate 1 Regular",
    WorkDate: "2026-06-03T00:00:00-04:00",
    HoursWorked: 6.5,
    Status: "Locked",
    TimePeriodBeginningDate: "2026-06-01T00:00:00-04:00",
    TimePeriodEndingDate: "2026-06-07T00:00:00-04:00",
  },
  // Same week, overtime row for Boyd → separate entry
  {
    PersonnelName: "Boyd, Sarah ",
    Project: "10007.01.01.0.CA",
    LCItem: "ENG3",
    LCItemDesc: "Engineer III",
    PayCode: "O",
    PayCodeDesc: "Rate 1 Overtime",
    WorkDate: "2026-06-03T00:00:00-04:00",
    HoursWorked: 2,
    Status: "Locked",
    TimePeriodBeginningDate: "2026-06-01T00:00:00-04:00",
    TimePeriodEndingDate: "2026-06-07T00:00:00-04:00",
  },
  // Second week, unsubmitted status → warning, no billing rate for LC → warning
  {
    PersonnelName: "Johnson, Travis  ",
    Project: "10007.00.00.00.CA",
    LCItem: "PM",
    LCItemDesc: "Program Manager",
    PayCode: "R",
    PayCodeDesc: "Rate 1 Regular",
    WorkDate: "2026-06-09T00:00:00-04:00",
    HoursWorked: 4,
    Status: "Unsubmitted",
    TimePeriodBeginningDate: "2026-06-08T00:00:00-04:00",
    TimePeriodEndingDate: "2026-06-14T00:00:00-04:00",
  },
];

const BILLING_ROWS = [
  {
    Project: "10007",
    LCItem: "ENG3",
    BillingRate: 141.19,
    BillingDateBeginning: "2026-01-01T00:00:00-05:00",
    BillingDateEnding: "2026-12-31T00:00:00-05:00",
  },
];

let workPlanId: number;
let packageId: number;

describe("pullPackageHoursFromProcas", () => {
  beforeAll(async () => {
    const [wp] = await db
      .insert(workPlansTable)
      .values({
        code: "TEST-PROCAS-PULL",
        title: "Procas pull test",
        client: "Test",
        jobNumber: "TEST",
        totalBudget: 1000,
        billingCycle: "whole_month",
        procasProject: "10007",
      })
      .returning();
    workPlanId = wp.id;
    const [pkg] = await db
      .insert(packagesTable)
      .values({
        workPlanId,
        payPeriodStart: "2026-06-01",
        payPeriodEnd: "2026-06-14",
      })
      .returning();
    packageId = pkg.id;
  });

  afterAll(async () => {
    await db.delete(packagesTable).where(eq(packagesTable.id, packageId));
    await db.delete(workPlansTable).where(eq(workPlansTable.id, workPlanId));
    vi.restoreAllMocks();
  });

  it("imports aggregated weekly entries, creates weeks, and is idempotent", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      // Query strings encode spaces as '+' or '%20'; normalize both before matching.
      const url = decodeURIComponent(String(input)).replace(/\+/g, " ");
      expect(url).toContain("startswith(Project, '10007')");
      if (url.includes("/Timesheet")) {
        expect(url).toContain("WorkDate ge 2026-06-01");
        return odataResponse(TS_ROWS);
      }
      if (url.includes("/BillingItem")) return odataResponse(BILLING_ROWS);
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const [pkg] = await db.select().from(packagesTable).where(eq(packagesTable.id, packageId));
    const [wp] = await db.select().from(workPlansTable).where(eq(workPlansTable.id, workPlanId));

    const result = await pullPackageHoursFromProcas(pkg, wp, creds);
    expect(result.ok).toBe(true);
    expect(result.importedCount).toBe(3);
    expect(result.replacedCount).toBe(0);
    expect(result.weeksCreated).toBe(2);
    expect(result.warnings.join(" ")).toMatch(/Unsubmitted/);
    expect(result.warnings.join(" ")).toMatch(/Program Manager/);
    // Johnson's 4 "Unsubmitted" hours are the only unapproved ones; Boyd's rows
    // are "Locked" (finalized/approved).
    expect(result.unapprovedHours).toBe(4);

    const weeks = await db
      .select()
      .from(packageWeeksTable)
      .where(eq(packageWeeksTable.packageId, packageId));
    expect(weeks.map((w) => w.weekStart).sort()).toEqual(["2026-06-01", "2026-06-08"]);

    const entries = await db
      .select()
      .from(timesheetEntriesTable)
      .where(eq(timesheetEntriesTable.packageId, packageId));
    expect(entries).toHaveLength(3);
    expect(entries.every((e) => e.source === "procas")).toBe(true);

    const regular = entries.find((e) => e.employeeName === "Boyd, Sarah" && e.category === "regular");
    expect(regular).toBeDefined();
    expect(regular!.hoursMon).toBe(8);
    expect(regular!.hoursWed).toBe(6.5);
    expect(regular!.rate).toBe(141.19);
    // "Locked" Procas status → approved.
    expect(regular!.approved).toBe(true);

    const ot = entries.find((e) => e.employeeName === "Boyd, Sarah" && e.category === "ot");
    expect(ot).toBeDefined();
    expect(ot!.hoursWed).toBe(2);
    expect(ot!.approved).toBe(true);

    const pm = entries.find((e) => e.employeeName === "Johnson, Travis");
    expect(pm).toBeDefined();
    expect(pm!.hoursTue).toBe(4);
    expect(pm!.rate).toBe(0);
    // "Unsubmitted" Procas status → not approved (shown in red, blocks export).
    expect(pm!.approved).toBe(false);

    // Add a manual entry, re-pull: procas entries replaced, manual preserved.
    await db.insert(timesheetEntriesTable).values({
      packageId,
      weekId: weeks[0].id,
      employeeName: "Manual Person",
      classification: "Manual",
      category: "regular",
      location: "home",
      hoursMon: 1,
      rate: 100,
      source: "manual",
    });

    const again = await pullPackageHoursFromProcas(pkg, wp, creds);
    expect(again.ok).toBe(true);
    expect(again.replacedCount).toBe(3);
    expect(again.importedCount).toBe(3);
    expect(again.weeksCreated).toBe(0);
    expect(again.unapprovedHours).toBe(4);

    const after = await db
      .select()
      .from(timesheetEntriesTable)
      .where(eq(timesheetEntriesTable.packageId, packageId));
    expect(after).toHaveLength(4);
    const manual = after.filter((e) => e.source === "manual");
    expect(manual).toHaveLength(1);
    // Manual entries are biller-entered and default to approved.
    expect(manual[0].approved).toBe(true);
  });

  it("brings in the same people's holiday and PTO hours, unbilled", async () => {
    // "Need to show on timesheet if Imani worked Holiday or PTO. This needs to
    // be on for all BART timesheets." Procas books leave to its own projects
    // (holidays to none), so a pull by client project never saw it.
    const week = {
      TimePeriodBeginningDate: "2026-06-01T00:00:00-04:00",
      TimePeriodEndingDate: "2026-06-07T00:00:00-04:00",
    };
    const worked = {
      Personnel: "E100",
      PersonnelName: "Lawson, Imani ",
      Project: "10007.01.01.0.CA",
      LCItem: "ENG3",
      LCItemDesc: "Engineer III",
      PayCode: "R",
      PayCodeDesc: "Rate 1 Regular",
      WorkDate: "2026-06-02T00:00:00-04:00",
      HoursWorked: 8,
      Status: "Approved",
      ...week,
    };
    const elsewhere = [
      worked, // the project's own row comes back again and is not counted twice
      { ...worked, Project: "S0001.SIC.2026", LCItem: "EMP", LCItemDesc: "Employee", PayCode: "S", PayCodeDesc: "Sick", WorkDate: "2026-06-03T00:00:00-04:00" },
      { ...worked, Project: "S0001.VAC.2026", LCItem: "EMP", LCItemDesc: "Employee", PayCode: "V", PayCodeDesc: "Vacation (or PTO)", WorkDate: "2026-06-04T00:00:00-04:00", HoursWorked: 4 },
      { ...worked, Project: null, LCItem: "EMP", LCItemDesc: "Employee", PayCode: "H", PayCodeDesc: "Holiday", WorkDate: "2026-06-05T00:00:00-04:00" },
      // Time on another client's job, and leave without pay, stay off this timesheet.
      { ...worked, Project: "10014.01", WorkDate: "2026-06-01T00:00:00-04:00" },
      { ...worked, Project: null, PayCode: "L", PayCodeDesc: "Leave Without Pay", WorkDate: "2026-06-01T00:00:00-04:00" },
    ];
    const requests: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = decodeURIComponent(String(input)).replace(/\+/g, " ");
        requests.push(url);
        if (url.includes("/Timesheet")) {
          return odataResponse(url.includes("Personnel eq 'E100'") ? elsewhere : [worked]);
        }
        if (url.includes("/BillingItem")) return odataResponse(BILLING_ROWS);
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );

    const [pkg] = await db.select().from(packagesTable).where(eq(packagesTable.id, packageId));
    const [wp] = await db.select().from(workPlansTable).where(eq(workPlansTable.id, workPlanId));
    const result = await pullPackageHoursFromProcas(pkg, wp, creds);
    expect(result.ok).toBe(true);
    // The leave request is for these people and these dates only.
    const leaveRequest = requests.find((u) => u.includes("Personnel eq 'E100'"))!;
    expect(leaveRequest).toContain("WorkDate ge 2026-06-01");
    expect(leaveRequest).toContain("WorkDate le 2026-06-14");

    const entries = (
      await db.select().from(timesheetEntriesTable).where(eq(timesheetEntriesTable.packageId, packageId))
    ).filter((e) => e.source === "procas");
    const by = (category: string) => entries.filter((e) => e.category === category);
    expect(by("regular")).toHaveLength(1);
    expect(by("regular")[0].hoursTue).toBe(8);
    expect(by("regular")[0].hoursMon).toBe(0);
    // Sick and vacation share the timesheet's one PTO row.
    expect(by("pto")).toHaveLength(1);
    expect(by("pto")[0].hoursWed).toBe(8);
    expect(by("pto")[0].hoursThu).toBe(4);
    expect(by("holiday")).toHaveLength(1);
    expect(by("holiday")[0].hoursFri).toBe(8);
    for (const e of [...by("pto"), ...by("holiday")]) {
      expect(e.employeeName).toBe("Lawson, Imani");
      // Filed under the classification the person works as, at no rate.
      expect(e.classification).toBe("Engineer III");
      expect(e.rate).toBe(0);
    }
    expect(result.warnings.join(" ")).not.toMatch(/no billing rate/i);
  });

  it("still imports the worked hours when the leave request fails", async () => {
    const worked = {
      Personnel: "E100",
      PersonnelName: "Lawson, Imani ",
      Project: "10007.01.01.0.CA",
      LCItem: "ENG3",
      LCItemDesc: "Engineer III",
      PayCode: "R",
      PayCodeDesc: "Rate 1 Regular",
      WorkDate: "2026-06-02T00:00:00-04:00",
      HoursWorked: 8,
      Status: "Approved",
      TimePeriodBeginningDate: "2026-06-01T00:00:00-04:00",
      TimePeriodEndingDate: "2026-06-07T00:00:00-04:00",
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = decodeURIComponent(String(input)).replace(/\+/g, " ");
        if (url.includes("Personnel eq 'E100'")) return new Response("nope", { status: 500 });
        if (url.includes("/Timesheet")) return odataResponse([worked]);
        if (url.includes("/BillingItem")) return odataResponse(BILLING_ROWS);
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );
    const [pkg] = await db.select().from(packagesTable).where(eq(packagesTable.id, packageId));
    const [wp] = await db.select().from(workPlansTable).where(eq(workPlansTable.id, workPlanId));
    const result = await pullPackageHoursFromProcas(pkg, wp, creds);
    expect(result.ok).toBe(true);
    expect(result.importedCount).toBe(1);
    expect(result.warnings.join(" ")).toMatch(/Holiday and PTO hours could not be read/);
  });

  it("fails clearly when the work plan has no Procas project", async () => {
    const [pkg] = await db.select().from(packagesTable).where(eq(packagesTable.id, packageId));
    const [wp] = await db.select().from(workPlansTable).where(eq(workPlansTable.id, workPlanId));
    const result = await pullPackageHoursFromProcas(pkg, { ...wp, procasProject: null }, creds);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not linked to a Procas project/);
  });
});
