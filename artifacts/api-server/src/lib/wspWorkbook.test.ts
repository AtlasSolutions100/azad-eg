import { describe, it, expect, beforeAll } from "vitest";
import ExcelJS from "exceljs";
import { buildWspWorkbook, computeWspFinancials, isWspPrime } from "./wspWorkbook";
import { buildPackageRollup } from "./packageMappers";
import type { PackageDocContext } from "./packageDocs";

/**
 * Verifies the WSP export engine against Julie's real single-employee sample
 * (Jordy Peralta, Work Plan A.04-02: 144 field hours @ $76.22, fringe 120.58%,
 * fee 8%, FCCM 0.39%, previously billed 152,693.26). The reference workbook's
 * Invoice!L27 / Sub Calc _revised!H51 round to 26,189.78 and Total Billed to
 * Date to 178,883.04 — the numbers this engine must reproduce.
 */

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function makeCtx(overrides: Partial<PackageDocContext> = {}): PackageDocContext {
  const wp = {
    code: "A.04-02",
    title: "Assistant Resident Engineer / Inspector for Train Control and Communication Projects",
    client: "WSP",
    jobNumber: "6M8178",
    agreementNo: "6M8178",
    poNumber: "71994",
    wspProjectNo: "30900569.7859",
    totalBudget: 156185.34,
    fringeRate: 120.58,
    overheadRate: null,
    fixedFeeRate: 8,
    fccmRate: 0.39,
    bartProjectNumbers: "47CJ016, 20LT008",
    terms: "Net 30",
    sendToCompany: "WSP USA INC",
    sendToAddress1: "3260 Lone Tree Way, Suite 104",
    sendToAddress2: "Antioch, CA 94509",
    contactPerson: "Candelaria (Cindy) Aldan - Project Financial Analyst",
  } as unknown as PackageDocContext["workPlan"];

  // Saturdays that begin each Sat→Fri week; 40+40+40+24 = 144 straight hours.
  const weekStarts = ["2026-05-02", "2026-05-09", "2026-05-16", "2026-05-23"];
  const weeks = weekStarts.map(
    (ws, i) =>
      ({
        id: i + 1,
        packageId: 1,
        label: `Week ${i + 1}`,
        weekStart: ws,
        weekEnd: ws,
        sortOrder: i + 1,
      }) as unknown as PackageDocContext["weeks"][number],
  );
  const dayHours = [
    [8, 8, 8, 8, 8],
    [8, 8, 8, 8, 8],
    [8, 8, 8, 8, 8],
    [8, 8, 8, 0, 0],
  ];
  const entries = dayHours.map(
    (h, i) =>
      ({
        id: i + 1,
        packageId: 1,
        weekId: i + 1,
        employeeId: 42,
        employeeName: "Jordy Peralta",
        classification: "Assistant Resident Engineer",
        category: "regular",
        location: "field",
        hoursMon: h[0],
        hoursTue: h[1],
        hoursWed: h[2],
        hoursThu: h[3],
        hoursFri: h[4],
        hoursSat: 0,
        hoursSun: 0,
        rate: 76.22,
        source: "manual",
      }) as unknown as PackageDocContext["entries"][number],
  );

  return {
    pkg: {
      id: 1,
      employeeId: 42,
      workPlanId: 1,
      prime: "WSP",
      payPeriodStart: "2026-04-25",
      payPeriodEnd: "2026-05-29",
      invoiceNumber: "A.04-02-12",
      invoiceDate: "2026-07-23",
      previouslyBilled: 152693.26,
      otherDirectCosts: 0,
      approvedBy: "Mahsa Azad, President",
    } as unknown as PackageDocContext["pkg"],
    employee: { name: "Jordy Peralta", classification: "Assistant Resident Engineer" },
    workPlan: wp,
    weeks,
    entries,
    progress: {
      id: 1,
      packageId: 1,
      workPerformed: "Performed daily inventory counts of TR4s, TVM Kits, CSC Transports.",
      concerns: null,
      correctiveAction: null,
      percentComplete: null,
      reportDate: null,
    } as unknown as PackageDocContext["progress"],
    overrides: [],
    signatureImagePath: null,
    billedLineItems: [],
    ...overrides,
  };
}

function num(ws: ExcelJS.Worksheet, addr: string): number {
  const v = ws.getCell(addr).value;
  if (v && typeof v === "object" && "result" in v) return Number((v as { result: number }).result);
  return typeof v === "number" ? v : NaN;
}

describe("isWspPrime", () => {
  it("detects WSP (case-insensitive) and rejects other primes", () => {
    expect(isWspPrime({ prime: "WSP" })).toBe(true);
    expect(isWspPrime({ prime: "WSP USA Inc" })).toBe(true);
    expect(isWspPrime({ prime: "wsp" })).toBe(true);
    expect(isWspPrime({ prime: "AECOM" })).toBe(false);
    expect(isWspPrime({ prime: "T.Y. Lin" })).toBe(false);
    expect(isWspPrime({ prime: null })).toBe(false);
  });
});

describe("computeWspFinancials", () => {
  it("reproduces the sample's burden chain to the cent", () => {
    const fin = computeWspFinancials(makeCtx());
    expect(fin.totalHours).toBe(144);
    expect(fin.field.directLabor).toBeCloseTo(10975.68, 2);
    expect(fin.field.fringe).toBeCloseTo(13234.474944, 4); // UNROUNDED
    expect(fin.fixedFee).toBeCloseTo(1936.812396, 4); // UNROUNDED
    expect(fin.field.fccm).toBeCloseTo(42.81, 2); // ROUNDED
    expect(round2(fin.totalThisPeriod)).toBe(26189.78);
    expect(round2(fin.totalToDate)).toBe(178883.04);
  });
});

describe("buildWspWorkbook", () => {
  let wb: ExcelJS.Workbook;
  let timesheetTabs: string[];
  beforeAll(async () => {
    ({ wb, timesheetTabs } = await buildWspWorkbook(makeCtx()));
  });

  it("writes the authoritative totals onto Invoice and Sub Calc _revised", () => {
    const inv = wb.getWorksheet("Invoice")!;
    const sc = wb.getWorksheet("Sub Calc _revised")!;
    expect(round2(num(inv, "L27"))).toBe(26189.78);
    expect(round2(num(inv, "L30"))).toBe(26189.78);
    expect(round2(num(sc, "H51"))).toBe(26189.78);
    expect(round2(num(sc, "I51"))).toBe(152693.26);
    expect(round2(num(sc, "J51"))).toBe(178883.04);
    // Billing summary.
    expect(round2(num(inv, "J35"))).toBe(26189.78);
    expect(round2(num(inv, "J36"))).toBe(152693.26);
    expect(round2(num(inv, "J37"))).toBe(178883.04);
  });

  it("writes Sub Calc leaf cells (unrounded fringe/fee, rounded FCCM)", () => {
    const sc = wb.getWorksheet("Sub Calc _revised")!;
    expect(num(sc, "H11")).toBeCloseTo(10975.68, 2);
    expect(num(sc, "H12")).toBeCloseTo(13234.474944, 4);
    expect(num(sc, "H43")).toBeCloseTo(1936.812396, 4);
    expect(num(sc, "H49")).toBeCloseTo(42.81, 2);
    expect(num(sc, "D12")).toBeCloseTo(1.2058, 6);
  });

  it("writes per-employee labor lines on Sub Labor", () => {
    const sl = wb.getWorksheet("Sub Labor")!;
    // Field labor lines occupy rows 20-25; the single field line lands on 20.
    expect(sl.getCell("B20").value).toBe("Assistant Resident Engineer");
    expect(sl.getCell("C20").value).toBe("Jordy Peralta");
    expect(sl.getCell("D20").value).toBe(144);
    expect(sl.getCell("E20").value).toBe(76.22);
    expect(num(sl, "F20")).toBeCloseTo(10975.68, 2);
    expect(num(sl, "D26")).toBe(144); // field subtotal hours
    expect(num(sl, "F26")).toBeCloseTo(10975.68, 2);
  });

  it("ships only the client-facing sheets (internal sheets removed)", () => {
    const names = wb.worksheets.map((w) => w.name);
    expect(names).toContain("Invoice");
    expect(names).toContain("Sub Calc _revised");
    expect(names).toContain("Sub Labor");
    expect(names).toContain("Progress Report");
    expect(names).not.toContain("Master File ");
    expect(names).not.toContain("Sub Calc");
    expect(names).not.toContain("MISC");
    expect(names).not.toContain("Prime ODCs");
  });

  it("builds one timesheet tab per week that starts on Saturday", () => {
    expect(timesheetTabs.length).toBe(4);
    for (const tab of timesheetTabs) {
      const ws = wb.getWorksheet(tab)!;
      const g6 = ws.getCell("G6").value as Date;
      expect(g6).toBeInstanceOf(Date);
      expect(g6.getDay()).toBe(6); // Saturday
      expect(ws.getCell("G7").value).toBe("Sat");
      expect(ws.getCell("M7").value).toBe("Fri");
    }
    // Week 1: Mon-Fri 8 each → straight-time row 9, columns I..M.
    const w1 = wb.getWorksheet(timesheetTabs[0])!;
    expect(w1.getCell("C5").value).toBe("Jordy Peralta");
    expect(num(w1, "I9")).toBe(8); // Monday
    expect(num(w1, "M9")).toBe(8); // Friday
    expect(num(w1, "N9")).toBe(40); // weekly straight total
  });

  it("scrubs yellow internal-highlight fills from client sheets", () => {
    for (const ws of wb.worksheets) {
      ws.eachRow({ includeEmpty: false }, (row) =>
        row.eachCell({ includeEmpty: false }, (cell) => {
          const fill = cell.style?.fill as { fgColor?: { argb?: string } } | undefined;
          expect(fill?.fgColor?.argb ?? "").not.toMatch(/FFFF00$/i);
        }),
      );
    }
  });

  it("leaves no formula pointing at a removed sheet (no #REF!)", () => {
    const tokens = ["'Master File '!", "'Sub Calc'!", "MISC!", "'JP Week", "'Prime ODCs'!"];
    const stale: string[] = [];
    for (const ws of wb.worksheets) {
      ws.eachRow({ includeEmpty: false }, (row) =>
        row.eachCell({ includeEmpty: false }, (cell) => {
          const v = cell.value as { formula?: string } | null;
          const f = v && typeof v === "object" ? v.formula : null;
          if (typeof f === "string" && tokens.some((t) => f.includes(t))) {
            stale.push(`${ws.name}!${cell.address}: ${f}`);
          }
        }),
      );
    }
    expect(stale).toEqual([]);
  });
});

/**
 * Drift guard: the WSP export engine (computeWspFinancials) and the on-screen
 * rollup (buildPackageRollup) implement the BART burden chain separately. They
 * must agree to the cent, or the invoice a client receives won't match what the
 * biller reviewed on screen.
 */
describe("WSP export ↔ on-screen rollup parity", () => {
  it("computeWspFinancials and buildPackageRollup agree on the period totals", () => {
    const ctx = makeCtx();
    const wsp = computeWspFinancials(ctx);
    const rollup = buildPackageRollup(ctx.entries, ctx.workPlan, {
      previouslyBilled: ctx.pkg.previouslyBilled,
      otherDirectCosts: ctx.pkg.otherDirectCosts,
    });
    expect(rollup.totalThisPeriod).toBeCloseTo(wsp.totalThisPeriod, 2);
    expect(rollup.totalToDate).toBeCloseTo(wsp.totalToDate, 2);
    expect(rollup.totalHours).toBe(wsp.totalHours);
  });

  it("still agree when the employee works overtime (premium unburdened in both)", () => {
    const base = makeCtx();
    const otEntry = { ...base.entries[0], id: 99, category: "ot", hoursMon: 8, hoursTue: 0, hoursWed: 0, hoursThu: 0, hoursFri: 0 } as PackageDocContext["entries"][number];
    const ctx = { ...base, entries: [...base.entries, otEntry] };
    const wsp = computeWspFinancials(ctx);
    const rollup = buildPackageRollup(ctx.entries, ctx.workPlan, {
      previouslyBilled: ctx.pkg.previouslyBilled,
      otherDirectCosts: ctx.pkg.otherDirectCosts,
    });
    expect(rollup.totalThisPeriod).toBeCloseTo(wsp.totalThisPeriod, 2);
    expect(rollup.otdtPremium).toBeCloseTo(wsp.otPremium + wsp.dtPremium, 2);
  });
});
