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

/**
 * Everything on a client-facing sheet must be a value. ExcelJS writes formula
 * TEXT without evaluating it, and neither LibreOffice's PDF export nor a plain
 * viewer recalculates an .xlsx on open — so a surviving formula prints the
 * cached result stored in Julie's reference workbook rather than this
 * package's number. This is the guard the AECOM and T.Y. Lin engines carry.
 */
function formulaCells(wb: ExcelJS.Workbook): string[] {
  const offenders: string[] = [];
  for (const ws of wb.worksheets) {
    ws.eachRow({ includeEmpty: false }, (row) => {
      row.eachCell({ includeEmpty: false }, (cell) => {
        const v = cell.value as Record<string, unknown> | null;
        if (v && typeof v === "object" && ("formula" in v || "sharedFormula" in v)) {
          offenders.push(`${ws.name}!${cell.address}`);
        }
      });
    });
  }
  return offenders;
}

/** Every cell value on every sheet, flattened for fingerprint scanning. */
function allValues(wb: ExcelJS.Workbook): Array<{ at: string; value: unknown }> {
  const out: Array<{ at: string; value: unknown }> = [];
  for (const ws of wb.worksheets) {
    ws.eachRow({ includeEmpty: false }, (row) => {
      row.eachCell({ includeEmpty: false }, (cell) => {
        out.push({ at: `${ws.name}!${cell.address}`, value: cell.value });
      });
    });
  }
  return out;
}

describe("buildWspWorkbook — no reference-workbook leftovers", () => {
  it("has no formulas left anywhere in the deliverable", async () => {
    const { wb } = await buildWspWorkbook(makeCtx());
    expect(formulaCells(wb)).toEqual([]);
  });

  /**
   * The default fixture reproduces Julie's own sample invoice, so a stale cell
   * and a correct one look identical. This one bills different people, hours,
   * rates and budget, which makes any surviving reference figure visible.
   */
  function makeDifferentCtx(): PackageDocContext {
    const base = makeCtx();
    const wp = {
      ...base.workPlan,
      totalBudget: 400000,
      fccmRate: 0.5,
    } as PackageDocContext["workPlan"];
    const entries = [
      {
        ...base.entries[0],
        id: 91,
        weekId: 1,
        employeeId: 7,
        employeeName: "Ana Ruiz",
        classification: "Resident Engineer",
        rate: 55.5,
        hoursMon: 8,
        hoursTue: 8,
        hoursWed: 8,
        hoursThu: 8,
        hoursFri: 8,
      },
      {
        ...base.entries[0],
        id: 92,
        weekId: 2,
        employeeId: 7,
        employeeName: "Ana Ruiz",
        classification: "Resident Engineer",
        category: "ot",
        rate: 55.5,
        hoursMon: 4,
        hoursTue: 0,
        hoursWed: 0,
        hoursThu: 0,
        hoursFri: 0,
      },
    ] as PackageDocContext["entries"];
    return {
      ...base,
      workPlan: wp,
      entries,
      pkg: { ...base.pkg, previouslyBilled: 9000 } as PackageDocContext["pkg"],
    };
  }

  it("carries none of the reference invoice's figures into a different package", async () => {
    const { wb } = await buildWspWorkbook(makeDifferentCtx());
    // Every one of these is a number or a note that lives only in Julie's own
    // A.04-02 invoice: her labor/fringe/ODC budgets, her previously-billed and
    // to-date columns, her 1,475 prior hours, her burdened labor total, the
    // "Budget Increase" back-solve beside the form, and her working notes.
    const fingerprints = [
      68450, 74610.51, 1680, 3700, 143060.51, 137956.72, 162166.8749, 1619, 1475,
      26146.97, 133202.19, 156185.3508, 152693.26,
    ];
    const notes = [
      "Max Rate Cap",
      "Bill Rate Overide",
      "Budget Increase",
      "Target Total",
      "Grand Total (Check)",
      "Time Passed",
      "UPDATE",
      "Jordy",
    ];
    const cells = allValues(wb);
    expect(cells.length).toBeGreaterThan(200); // the scan actually looked at the book
    const found: string[] = [];
    for (const { at, value } of cells) {
      if (typeof value === "number" && fingerprints.some((f) => Math.abs(value - f) < 0.005)) {
        found.push(`${at}=${value}`);
      }
      if (typeof value === "string" && notes.some((n) => value.includes(n))) {
        found.push(`${at}="${value}"`);
      }
    }
    expect(found).toEqual([]);
  });

  it("states this period's hours, not the reference's prior-period band", async () => {
    const { wb } = await buildWspWorkbook(makeDifferentCtx());
    const sc = wb.getWorksheet("Sub Calc _revised")!;
    // 5 straight days + 4 OT hours, all field.
    expect(sc.getCell("D11").value).toBe(44);
    // No previousHours on this fixture, so Previous prints blank rather than a
    // 0 that would read as "nobody has ever worked this job".
    expect(sc.getCell("E11").value).toBeNull();
    expect(sc.getCell("F11").value).toBe(44);
    // % Expended computes off this work plan's budget, never #DIV/0!.
    expect(Number(sc.getCell("K51").value)).toBeGreaterThan(0);
    expect(Number(sc.getCell("K51").value)).toBeLessThan(1);
  });

  it("states the previous hours Procas holds, on the row carrying the labor", async () => {
    const base = makeDifferentCtx();
    const { wb } = await buildWspWorkbook({
      ...base,
      pkg: { ...base.pkg, previousHours: 6627 } as typeof base.pkg,
    });
    const sc = wb.getWorksheet("Sub Calc _revised")!;
    // All 44 hours are field, so the project total lands on the field row.
    expect(sc.getCell("E11").value).toBe(6627);
    expect(sc.getCell("F11").value).toBe(6671);
    // And is not double-counted on the empty home row.
    expect(sc.getCell("E7").value).toBeNull();
  });

  it("names the people who actually worked overtime on the premium rows", async () => {
    const { wb } = await buildWspWorkbook(makeDifferentCtx());
    const sc = wb.getWorksheet("Sub Calc _revised")!;
    expect(String(sc.getCell("D24").value)).toBe("SS OT Premium (Ana Ruiz)");
    expect(String(sc.getCell("E24").value)).toBe("27.75/HR"); // 0.5 × 55.50
    expect(String(sc.getCell("F24").value)).toBe("4 HRS");
    // Nobody worked doubletime, so that row is blank rather than naming anyone.
    expect(sc.getCell("D25").value).toBeFalsy();
  });

  it("prints the forms without Julie's working columns", async () => {
    const { wb } = await buildWspWorkbook(makeCtx());
    // The template ships A1:Q59 / A1:U31, which reach the scratch beside each
    // form and stretch the page past 19in.
    expect(wb.getWorksheet("Sub Calc _revised")!.pageSetup.printArea).toBe("A1:K52");
    expect(wb.getWorksheet("Sub Labor")!.pageSetup.printArea).toBe("A1:H29");
  });
});
