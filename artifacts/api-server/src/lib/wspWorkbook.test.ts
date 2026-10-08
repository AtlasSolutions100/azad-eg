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
    expect(wb.getWorksheet("Sub Labor")!.pageSetup.printArea).toBe("B1:F29");
  });
});

/**
 * Julie's notes on the September A.05-01 invoice (Imani Lawson), which she
 * expects on the other invoices too.
 */
describe("buildWspWorkbook — notes on the A.05-01 invoice", () => {
  const leaveCtx = (): PackageDocContext => {
    const base = makeCtx();
    // Week 4 is worked Mon–Wed; Thursday is sick leave and Friday a holiday.
    const leave = (id: number, category: string, day: "hoursThu" | "hoursFri") =>
      ({
        ...base.entries[3],
        id,
        category,
        rate: 0,
        hoursMon: 0,
        hoursTue: 0,
        hoursWed: 0,
        [day]: 8,
      }) as unknown as PackageDocContext["entries"][number];
    return { ...base, entries: [...base.entries, leave(90, "pto", "hoursThu"), leave(91, "holiday", "hoursFri")] };
  };
  let wb: ExcelJS.Workbook;
  let timesheetTabs: string[];
  beforeAll(async () => {
    ({ wb, timesheetTabs } = await buildWspWorkbook(leaveCtx()));
  });

  it("puts the labor attachment before the progress report", () => {
    const order = [...wb.worksheets]
      .sort((a, b) => (a as unknown as { orderNo: number }).orderNo - (b as unknown as { orderNo: number }).orderNo)
      .map((w) => w.name);
    expect(order.slice(0, 4)).toEqual(["Invoice", "Sub Calc _revised", "Sub Labor", "Progress Report"]);
    expect(order.slice(4)).toEqual(timesheetTabs);
  });

  it("prints no \"Billed $\" column or row flags on the labor attachment", () => {
    const sl = wb.getWorksheet("Sub Labor")!;
    expect(sl.getColumn("A").hidden).toBe(true);
    for (let r = 1; r <= 33; r++) {
      for (const col of ["A", "G", "H"]) expect(sl.getCell(`${col}${r}`).value ?? null).toBeNull();
    }
  });

  it("formats hours as hours and money as money on the labor attachment", () => {
    // "There's funky dollar signs here.. 128.00 is hours, $83.00 is money."
    const sl = wb.getWorksheet("Sub Labor")!;
    expect(sl.getCell("D20").numFmt).toBe("0.00");
    expect(sl.getCell("E20").numFmt).toBe('"$"#,##0.00');
    expect(sl.getCell("F20").numFmt).toBe('"$"#,##0.00');
    for (const total of ["F18", "F26", "F29"]) expect(sl.getCell(total).numFmt).toBe('"$"#,##0.00');
    // Leave is not labor: the attachment still bills 144 hours.
    expect(num(sl, "D29")).toBe(144);
  });

  it("shows PTO and holiday hours on the timesheet without billing them", () => {
    const w4 = wb.getWorksheet(timesheetTabs[3])!;
    expect(w4.getCell("C13").value).toBe("PTO (Sick/Vacation)");
    expect(w4.getCell("C14").value).toBe("Holiday");
    expect(num(w4, "L13")).toBe(8); // Thursday, sick
    expect(num(w4, "M14")).toBe(8); // Friday, holiday
    expect(num(w4, "N9")).toBe(24);
    expect(num(w4, "N13")).toBe(8);
    expect(num(w4, "N14")).toBe(8);
    expect(num(w4, "N16")).toBe(40);
    const fin = computeWspFinancials(leaveCtx());
    expect(fin.totalHours).toBe(144);
    expect(round2(fin.totalThisPeriod)).toBe(26189.78);
  });

  it("gives every hours figure on a timesheet the same decimals", async () => {
    // Whole hours: none anywhere ("no decimal points are needed").
    const w4 = wb.getWorksheet(timesheetTabs[3])!;
    for (const addr of ["I9", "N9", "N11", "N12", "N13", "N14", "I16", "N16"]) {
      expect(w4.getCell(addr).numFmt).toBe("0");
    }
    // A half hour anywhere on the sheet: two everywhere on it.
    const base = makeCtx();
    const half = { ...base.entries[0], hoursMon: 7.5 } as PackageDocContext["entries"][number];
    const built = await buildWspWorkbook({ ...base, entries: [half, ...base.entries.slice(1)] });
    const w1 = built.wb.getWorksheet(built.timesheetTabs[0])!;
    for (const addr of ["I9", "J9", "N9", "N12", "N16"]) expect(w1.getCell(addr).numFmt).toBe("0.00");
    expect(built.wb.getWorksheet(built.timesheetTabs[1])!.getCell("N9").numFmt).toBe("0");
  });

  it("states the period under the progress report's title and the forecast as sentences", () => {
    const report = wb.getWorksheet("Progress Report")!;
    expect(report.getCell("B4").value).toBe("4/25/2026 to 5/29/2026");
    expect(String(report.getCell("B29").value)).toBe(
      "Cost Forecast at Completion:  Current approved budget is $156,185.34.",
    );
    expect(String(report.getCell("B30").value)).toBe("Through this invoice, $178,883.04 (115%) has been billed.");
    // It wrapped inside a column a few characters wide and showed one word.
    expect(report.getCell("B30").alignment?.wrapText).toBeFalsy();
    for (const addr of ["F29", "G29", "C30", "E30"]) expect(report.getCell(addr).value ?? null).toBeNull();
    expect(report.getRow(28).hidden).toBe(true);
    expect(report.pageSetup.printArea).toBe("A1:I38");
  });

  it("fills the detail page's Budget and Previously Billed columns row by row", () => {
    const sc = wb.getWorksheet("Sub Calc _revised")!;
    const rows = (col: string) => round2([11, 12, 23, 24, 43, 49].reduce((s, r) => s + (num(sc, `${col}${r}`) || 0), 0));
    expect(num(sc, "G11")).toBeGreaterThan(0);
    expect(num(sc, "G12")).toBeGreaterThan(0);
    expect(num(sc, "I11")).toBeGreaterThan(0);
    expect(num(sc, "I12")).toBeGreaterThan(0);
    // The rows add up to the totals printed under them.
    expect(rows("G")).toBe(156185.34);
    expect(rows("I")).toBe(152693.26);
    expect(num(sc, "G51")).toBe(156185.34);
    // % Expended on the "Total" rows only; the block subtotal printed 1.14532…
    expect(sc.getCell("K14").value ?? null).toBeNull();
    expect(num(sc, "K20")).toBeCloseTo(178840.23 / 156142.53, 1);
    expect(sc.getCell("K20").numFmt).toBe("0.0%");
  });

  it("prints the budget by cost category as the biller entered it", async () => {
    const base = makeCtx();
    const { wb: entered } = await buildWspWorkbook({
      ...base,
      workPlan: {
        ...base.workPlan,
        budgetLabor: 66000,
        budgetOverhead: 79000,
        budgetFixedFee: 11000,
        budgetFccm: 185.34,
      } as PackageDocContext["workPlan"],
    });
    const sc = entered.getWorksheet("Sub Calc _revised")!;
    expect(num(sc, "G11")).toBe(66000);
    expect(num(sc, "G12")).toBe(79000);
    expect(num(sc, "G43")).toBe(11000);
    expect(num(sc, "G49")).toBe(185.34);
    expect(num(sc, "G51")).toBe(156185.34);
  });
});
