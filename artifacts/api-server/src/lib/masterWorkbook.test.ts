import { describe, it, expect, beforeAll } from "vitest";
import ExcelJS from "exceljs";
import { buildMasterWorkbook } from "./masterWorkbook";
import type { PackageDocContext } from "./packageDocs";

/**
 * Verifies the reference-workbook export engine against a context that
 * mirrors Julie's real BART/AECOM package (Invoice B.50-01-30): sheet set,
 * renamed-tab formula chain, injected header data, billed line items, and
 * scrubbing of internal notes/highlights.
 */

function makeCtx(overrides: Partial<PackageDocContext> = {}): PackageDocContext {
  const wp = {
    id: 1,
    code: "B.50-03",
    title: "B.50-03",
    client: "AECOM",
    jobNumber: "6M8142-B50",
    agreementNo: "6M8142",
    poNumber: "1638681",
    totalBudget: 1381971.85,
    overheadRate: 120.58,
    fixedFeeRate: 8,
    fccmRate: 0.39,
    supplierId: "12345",
    clientProjectNo: "60723341.03",
    sendToCompany: "AECOM",
    sendToAddress1: "300 Lakeside Drive, Suite 400",
    sendToAddress2: "Oakland, CA 94612",
    contactPerson: "Chris Berilla, Program Manager",
    bartProjectNumbers: "(15CQ002, 15TC002, 45GA000) 15NL004",
    terms: "Net 30 Days",
  } as unknown as PackageDocContext["workPlan"];
  const weeks = [1, 2, 3, 4, 5].map(
    (n) =>
      ({
        id: n,
        packageId: 1,
        label: `Week ${n}`,
        weekStart: `2026-06-0${n}`,
        weekEnd: `2026-06-0${n}`,
        sortOrder: n,
      }) as unknown as PackageDocContext["weeks"][number],
  );
  const mkEntry = (weekId: number, hrs: number[]) =>
    ({
      id: weekId,
      packageId: 1,
      weekId,
      employeeId: 7,
      employeeName: "Travis Johnson",
      classification: "Project Manager",
      category: "regular",
      location: "field",
      hoursMon: hrs[0] ?? 0,
      hoursTue: hrs[1] ?? 0,
      hoursWed: hrs[2] ?? 0,
      hoursThu: hrs[3] ?? 0,
      hoursFri: hrs[4] ?? 0,
      hoursSat: 0,
      hoursSun: 0,
      rate: 92.5,
    }) as unknown as PackageDocContext["entries"][number];
  return {
    pkg: {
      id: 1,
      employeeId: 7,
      workPlanId: 1,
      payPeriodStart: "2026-05-30",
      payPeriodEnd: "2026-06-30",
      invoiceNumber: "B.50-01-30",
      invoiceDate: "2026-07-08",
      previouslyBilled: 1135877.49,
      otherDirectCosts: 0,
      approvedBy: "Mahsa Azad, President",
    } as unknown as PackageDocContext["pkg"],
    employee: { name: "Travis Johnson", classification: "Project Manager" },
    workPlan: wp,
    weeks,
    entries: [
      mkEntry(1, [8, 8]),
      mkEntry(2, [8, 8, 8, 8, 8]),
      mkEntry(3, [8, 8, 8, 8]),
      mkEntry(4, [8, 8, 8, 8, 8]),
      mkEntry(5, [8, 8]),
    ],
    progress: {
      id: 1,
      packageId: 1,
      workPerformed: "15CH001 (Millbrae)\n- Performed routine reporting\n- Coordinated site walk",
      concerns: null,
      correctiveAction: null,
    } as unknown as PackageDocContext["progress"],
    overrides: [],
    signatureImagePath: null,
    billedLineItems: [
      {
        id: 1,
        packageId: 1,
        workScopeNo: "B.50-01",
        poNo: "1638681",
        lineNo: 1,
        bartProjectNo: "15TC002/PJMGT",
        poAmount: 179582.83,
        previousInvoiced: 179582.84,
        currentInvoiced: 0,
        sortOrder: 0,
        source: "carry_forward",
      },
      {
        id: 2,
        packageId: 1,
        workScopeNo: "B.50-03",
        poNo: "1638681",
        lineNo: 1,
        bartProjectNo: "15NL004/PJMGT",
        poAmount: 115293.32,
        previousInvoiced: 48847.83,
        currentInvoiced: 8556.96,
        sortOrder: 1,
        source: "manual",
      },
    ] as unknown as PackageDocContext["billedLineItems"],
    ...overrides,
  };
}

function fx(ws: ExcelJS.Worksheet, addr: string): string | null {
  const v = ws.getCell(addr).value as { formula?: string } | null;
  return v && typeof v === "object" && v.formula ? v.formula : null;
}

describe("buildMasterWorkbook", () => {
  let wb: ExcelJS.Workbook;
  beforeAll(async () => {
    ({ wb } = await buildMasterWorkbook(makeCtx()));
  });

  it("ships exactly the client-facing sheets in reference order", () => {
    expect(wb.worksheets.map((w) => w.name)).toEqual([
      "Overview",
      "Invoice",
      "Sub Calc",
      "Labor Attachment",
      "Progress Report",
      "Week 1",
      "Week 2",
      "Week 3",
      "Week 4",
      "Week 5",
    ]);
  });

  it("writes the Overview week roll-up as values, not a formula chain", () => {
    const overview = wb.getWorksheet("Overview")!;
    // The fixture bills 16/40/32/40/16 hours across the five weeks. These were
    // once `='Week 1'!O9` formulas pointing at cells that were themselves
    // shared SUM formulas — a chain nothing in the pipeline ever evaluated, so
    // the client's Overview arrived blank. Values only.
    expect(fx(overview, "B9")).toBeNull();
    expect(overview.getCell("B9").value).toBe(16);
    expect(overview.getCell("C9").value).toBe(40);
    expect(overview.getCell("F9").value).toBe(16);
    expect(overview.getCell("G9").value).toBe(144);
    // Each week tab carries its own weekly total in O9 as a value too.
    expect(wb.getWorksheet("Week 2")!.getCell("O9").value).toBe(40);
    // The rest of the chain the Overview used to feed is values too.
    const labor = wb.getWorksheet("Labor Attachment")!;
    expect(fx(labor, "C19")).toBeNull();
    expect(labor.getCell("C24").value).toBe(144);
    const cost = wb.getWorksheet("Sub Calc")!;
    expect(fx(cost, "H13")).toBeNull();
    expect(cost.getCell("D10").value).toBe(144);
    // No reference-workbook money left in the Amount To Date / % Expended
    // columns: J20 is this period plus what was actually carried forward.
    expect(cost.getCell("J20").value).toBeCloseTo(
      (cost.getCell("H20").value as number) + (cost.getCell("I20").value as number),
      2,
    );
  });

  it("dates all seven day headers on every week tab", () => {
    // I6..N6 ship as shared `=H6+1` formulas. Leaving them alone meant
    // `freezeSharedFormulas` later stamped in the reference workbook's cached
    // June dates, so a July timesheet showed one correct Saturday followed by
    // six days from June — Julie's "the week ending month shows June".
    for (const name of ["Week 1", "Week 2", "Week 5"]) {
      const ws = wb.getWorksheet(name)!;
      const days = ["H", "I", "J", "K", "L", "M", "N"].map((c) => ws.getCell(`${c}6`).value);
      for (const d of days) expect(d).toBeInstanceOf(Date);
      const dates = days as Date[];
      expect(dates[0].getDay()).toBe(6); // Saturday
      for (let i = 1; i < 7; i++) {
        const gap = (dates[i].getTime() - dates[i - 1].getTime()) / 86400000;
        expect(Math.round(gap)).toBe(1);
      }
      // Every day belongs to the same week as the tab's Saturday — no cell
      // left pointing at the template's month.
      expect(dates[6].getMonth()).toBe(new Date(dates[0].getTime() + 6 * 86400000).getMonth());
    }
  });

  it("writes the week-ending date and TOTAL HOURS row as values", () => {
    const ws = wb.getWorksheet("Week 2")!;
    // J5 shipped as `=N6` and row 15 as shared `=SUM(H9:H14)` formulas, both of
    // which print their cached reference-workbook results in a viewer that does
    // not recalculate.
    const weekEnding = ws.getCell("J5").value;
    expect(weekEnding).toBeInstanceOf(Date);
    expect((weekEnding as Date).getDay()).toBe(5); // Friday
    expect((weekEnding as Date)).toEqual(ws.getCell("N6").value);
    // Fixture week 2 is a full 40-hour Mon-Fri week.
    expect(ws.getCell("O15").value).toBe(40);
    expect(ws.getCell("J15").value).toBe(8);
    expect(ws.getCell("H15").value).toBe(0); // Saturday
  });

  /**
   * The defining bug of Julie's 9/1 review: the client-facing sheets were built
   * as a formula chain (week tabs → Overview → Labor Attachment → Sub Calc →
   * Invoice). ExcelJS writes formula text without evaluating it, and neither
   * LibreOffice's PDF export nor a plain viewer recalculates on open, so every
   * one of those cells printed the cached result stored in Julie's reference
   * workbook — her previous invoice's hours, rates, dates and totals. There is
   * no partial fix: one surviving formula is one wrong number on a client
   * invoice, so the client sheets must carry values only.
   */
  it("states the Billing Summary from the work plan when no line items exist", async () => {
    // Most packages have no Billed Line Items entered — that PO schedule is
    // filled in separately. The template drove the Billing Summary off that
    // table (O38 = J35), so the cover printed a summary of dashes even though
    // the work plan carries a $1.38M budget and the invoice below it showed a
    // real total. Julie's reviewer reads that page as blank.
    const { wb: bare } = await buildMasterWorkbook(
      makeCtx({ billedLineItems: [] as unknown as PackageDocContext["billedLineItems"] }),
    );
    const cover = bare.getWorksheet("Invoice")!;
    expect(cover.getCell("O38").value).toBeCloseTo(1_381_971.85, 2);
    expect(cover.getCell("O39").value).toBeCloseTo(1_135_877.49, 2);
    const toDate = cover.getCell("O40").value as number;
    expect(toDate).toBeGreaterThan(1_135_877.49);
    expect(cover.getCell("O41").value).toBeCloseTo(1_381_971.85 - toDate, 2);
    expect(cover.getCell("O42").value as number).toBeGreaterThan(0);
    // And the invoice total is still stated.
    expect(cover.getCell("M21").value as number).toBeGreaterThan(0);
  });

  it("clears the working columns right of the cover form", () => {
    // Columns Z..AG held a "=22,702.34 + 436,617.12" note beside the total and
    // loose figures in AC, all inside the print area (A1:AG58).
    const cover = wb.getWorksheet("Invoice")!;
    for (const addr of ["AE21", "AF21", "AG21", "AC23", "AC9"]) {
      expect(cover.getCell(addr).value ?? null, addr).toBeNull();
    }
  });

  it("has no formulas left on the client-facing sheets", () => {
    const offenders: string[] = [];
    for (const name of ["Overview", "Invoice", "Sub Calc", "Labor Attachment", "Progress Report"]) {
      const ws = wb.getWorksheet(name)!;
      ws.eachRow({ includeEmpty: false }, (row) => {
        row.eachCell({ includeEmpty: false }, (cell) => {
          const v = cell.value as Record<string, unknown> | null;
          if (v && typeof v === "object" && ("formula" in v || "sharedFormula" in v)) {
            offenders.push(`${name}!${cell.address}`);
          }
        });
      });
    }
    expect(offenders).toEqual([]);
  });

  it("has no formula or defined name referencing removed/old sheet names", () => {
    const stale: string[] = [];
    for (const ws of wb.worksheets) {
      ws.eachRow({ includeEmpty: false }, (row) =>
        row.eachCell({ includeEmpty: false }, (cell) => {
          const v = cell.value as { formula?: string } | null;
          const f = v && typeof v === "object" ? v.formula : null;
          if (
            typeof f === "string" &&
            /('Master File'|'Cover'|Cover!|'Cost'|Cost!|'Labor'|Labor!|'Report'|Report!|TJ Week|ODCs|Non-Performance|IL Week)/.test(
              f,
            )
          ) {
            stale.push(`${ws.name}!${cell.address}: ${f}`);
          }
        }),
      );
    }
    expect(stale).toEqual([]);
  });

  it("injects package header data at the reference addresses", () => {
    const overview = wb.getWorksheet("Overview")!;
    expect(overview.getCell("C3").value).toBe("B.50-01-30");
    expect(overview.getCell("D4").value).toBe("6M8142");
    expect(overview.getCell("B18").value).toBe(1381971.85);
    expect(overview.getCell("E23").value).toBe(1135877.49);
    expect(overview.getCell("I17").value).toBe(92.5);
    const cover = wb.getWorksheet("Invoice")!;
    expect(cover.getCell("U8").value).toBe("1638681");
    expect(cover.getCell("H10").value).toBe("AECOM");
    expect(cover.getCell("T18").value).toBe("Net 30 Days");
    const cost = wb.getWorksheet("Sub Calc")!;
    expect(cost.getCell("C12").value).toBeCloseTo(1.2058, 6);
    expect(cost.getCell("E37").value).toBeCloseTo(0.08, 6);
    expect(cost.getCell("D43").value).toBeCloseTo(0.0039, 6);
  });

  it("decomposes budget and previously billed per work scope on Sub Calc", () => {
    const cost = wb.getWorksheet("Sub Calc")!;
    const num = (addr: string) => {
      const v = cost.getCell(addr).value;
      if (v && typeof v === "object" && "result" in v) return (v as { result: number }).result;
      return typeof v === "number" ? v : 0;
    };
    const oh = 1.2058;
    const fccm = 0.0039;
    // Own scope (B.50-03, the row with current billing): budget 115293.32
    // splits across labor (G13) / OH (G14 formula) / fee (G39) / FCCM (G43
    // formula) and sums back exactly.
    const g13 = num("G13");
    const g14 = Math.round(g13 * oh * 100) / 100;
    const g43 = Math.round(g13 * fccm * 100) / 100;
    expect(g13 + g14 + num("G39") + g43).toBeCloseTo(115293.32, 2);
    expect(num("I13") + num("I14") + num("I39") + num("I43")).toBeCloseTo(48847.83, 2);
    // Other scopes (B.50-01) aggregate on rows 11/12 with fee on row 37.
    expect(num("G11") + num("G12") + num("G37")).toBeCloseTo(179582.83, 2);
    expect(num("I11") + num("I12") + num("I37")).toBeCloseTo(179582.84, 2);
    expect(cost.getCell("A13").value).toBe("Field B.50-03");
    expect(cost.getCell("A11").value).toBe("Field B.50-01");
  });

  it("writes the work plan's explicit per-category decomposition literally when set", async () => {
    const ctx = makeCtx();
    ctx.workPlan = {
      ...ctx.workPlan,
      budgetLabor: 50000.25,
      budgetOverhead: 60290.42,
      budgetFixedFee: 4807.55,
      budgetFccm: 195.1,
      prevBilledLabor: 21000.11,
      prevBilledOverhead: 25322.93,
      prevBilledFixedFee: 2442.9,
      prevBilledFccm: 81.89,
    } as typeof ctx.workPlan;
    const { wb: wb2 } = await buildMasterWorkbook(ctx);
    const cost = wb2.getWorksheet("Sub Calc")!;
    expect(cost.getCell("G13").value).toBe(50000.25);
    expect(cost.getCell("G14").value).toBe(60290.42);
    expect(cost.getCell("G39").value).toBe(4807.55);
    expect(cost.getCell("G43").value).toBe(195.1);
    expect(cost.getCell("I13").value).toBe(21000.11);
    expect(cost.getCell("I14").value).toBe(25322.93);
    expect(cost.getCell("I39").value).toBe(2442.9);
    expect(cost.getCell("I43").value).toBe(81.89);
    // Other-scope rows are still back-solved from the billed line items.
    const num = (addr: string) => {
      const v = cost.getCell(addr).value;
      if (v && typeof v === "object" && "result" in v) return (v as { result: number }).result;
      return typeof v === "number" ? v : 0;
    };
    expect(num("G11") + num("G12") + num("G37")).toBeCloseTo(179582.83, 2);
  });

  it("splits labor rows on a mid-period rate change like the reference", async () => {
    const ctx = makeCtx();
    // Week 1 (16 hrs) at the old rate; weeks 2-5 (128 hrs) at the new rate.
    ctx.entries = ctx.entries.map((e, i) =>
      i === 0 ? ({ ...e, rate: 90.11 } as typeof e) : e,
    );
    const { wb: wb2 } = await buildMasterWorkbook(ctx);
    const overview = wb2.getWorksheet("Overview")!;
    expect(overview.getCell("I17").value).toBe(90.11);
    expect(overview.getCell("I18").value).toBe(92.5);
    expect(String(overview.getCell("H18").value)).toContain("Effective 6/");
    const labor = wb2.getWorksheet("Labor Attachment")!;
    // The second-rate line is shown only when it carries hours; with a single
    // rate it printed as a bare "0  --  $0.00" between the labor line and its
    // subtotal.
    expect(labor.getRow(20).hidden).toBe(false);
    expect(wb.getWorksheet("Labor Attachment")!.getRow(20).hidden).toBe(true);
    // Julie's August AECOM invoice is exactly this shape, and it printed as a
    // single 144-hour line at the superseded $90.11 because every cell below
    // was an unevaluated formula showing its cached result. Both rows must
    // carry their own hours, rate and amount as values.
    expect(labor.getCell("C19").value).toBe(16);
    expect(labor.getCell("D19").value).toBe(90.11);
    expect(labor.getCell("E19").value).toBeCloseTo(1441.76, 2);
    expect(labor.getCell("C20").value).toBe(128);
    expect(labor.getCell("D20").value).toBe(92.5);
    expect(labor.getCell("E20").value).toBeCloseTo(11840, 2);
    expect(labor.getCell("C24").value).toBe(144);
    expect(labor.getCell("E24").value).toBeCloseTo(13281.76, 2);
    expect(String(labor.getCell("B20").value)).toContain("new rate effective 6/");
  });

  it("rejects more than two distinct billing rates", async () => {
    const ctx = makeCtx();
    ctx.entries = ctx.entries.map((e, i) =>
      ({ ...e, rate: i === 0 ? 90.11 : i === 1 ? 91 : 92.5 }) as typeof e,
    );
    await expect(buildMasterWorkbook(ctx)).rejects.toThrow(/at most 2 billing rates/);
  });

  it("writes billed line items with variance formulas and clears unused rows", () => {
    const cover = wb.getWorksheet("Invoice")!;
    expect(cover.getCell("C25").value).toBe("B.50-01");
    expect(cover.getCell("J26").value).toBe(115293.32);
    expect(cover.getCell("P26").value).toBe(8556.96);
    // Invoiced-to-date and remaining are values, like every other figure in
    // the deliverable — a formula here prints its cached result in a viewer
    // that does not recalculate.
    expect(fx(cover, "S26")).toBeNull();
    expect(cover.getCell("S26").value).toBeCloseTo(48847.83 + 8556.96, 2);
    expect(cover.getCell("V26").value).toBeCloseTo(115293.32 - (48847.83 + 8556.96), 2);
    // Row 35 totals and the Billing Summary come from the same line items.
    expect(cover.getCell("J35").value).toBeCloseTo(179582.83 + 115293.32, 2);
    expect(cover.getCell("P35").value).toBeCloseTo(8556.96, 2);
    expect(cover.getCell("O38").value).toBeCloseTo(179582.83 + 115293.32, 2);
    // Period of Service and the signature date were formula-driven and shipped
    // blank / three weeks stale.
    expect(String(cover.getCell("F18").value)).toBe("5/30/2026 to 6/30/2026");
    expect(cover.getCell("P48").value).toBeInstanceOf(Date);
    expect(cover.getCell("U4").value).toBe("B.50-01-30");
    expect(cover.getCell("AC9").value ?? null).toBeNull();
    expect(cover.getCell("C27").value).toBeNull();
    expect(cover.getCell("J34").value).toBeNull();
  });

  it("fills week tabs with hours in the Sat..Fri day columns", () => {
    const w2 = wb.getWorksheet("Week 2")!;
    expect(w2.getCell("D5").value).toBe("Travis Johnson");
    expect(w2.getCell("J9").value).toBe(8); // Monday
    expect(w2.getCell("N9").value).toBe(8); // Friday
    expect(w2.getCell("H9").value).toBeNull(); // Saturday empty
    const h6 = w2.getCell("H6").value as Date;
    expect(h6.getDay()).toBe(6); // Saturday
  });

  it("writes the progress narrative with bullets", () => {
    const report = wb.getWorksheet("Progress Report")!;
    expect(report.getCell("C23").value).toBe("15CH001 (Millbrae)");
    expect(report.getCell("B24").value).toBe("•");
    expect(report.getCell("C24").value).toBe("Performed routine reporting");
    expect(report.getCell("B72").value).toContain("None at the present");
  });

  it("scrubs comments and yellow highlight fills", () => {
    for (const ws of wb.worksheets) {
      ws.eachRow({ includeEmpty: false }, (row) =>
        row.eachCell({ includeEmpty: false }, (cell) => {
          expect(cell.note ?? undefined).toBeUndefined();
          const fill = cell.style?.fill as { fgColor?: { argb?: string } } | undefined;
          expect(fill?.fgColor?.argb ?? "").not.toMatch(/FFFF00$/i);
        }),
      );
    }
  });

  it("throws when more than 10 billed line items are supplied", async () => {
    const items = Array.from({ length: 11 }, (_, i) => ({
      id: i + 1,
      packageId: 1,
      workScopeNo: `B.50-${i}`,
      poNo: null,
      lineNo: i + 1,
      bartProjectNo: null,
      poAmount: 100,
      previousInvoiced: 0,
      currentInvoiced: 0,
      sortOrder: i,
      source: "manual",
    })) as unknown as PackageDocContext["billedLineItems"];
    await expect(buildMasterWorkbook(makeCtx({ billedLineItems: items }))).rejects.toThrow(
      /up to 10 billed line items/,
    );
  });

  it("supports more weeks than the template carries by cloning tabs", async () => {
    const ctx = makeCtx();
    const weeks = [1, 2, 3, 4, 5, 6].map(
      (n) =>
        ({
          id: n,
          packageId: 1,
          label: `Week ${n}`,
          weekStart: `2026-06-${String(n).padStart(2, "0")}`,
          weekEnd: `2026-06-${String(n).padStart(2, "0")}`,
          sortOrder: n,
        }) as unknown as PackageDocContext["weeks"][number],
    );
    const { wb: wb6 } = await buildMasterWorkbook(makeCtx({ weeks }));
    expect(wb6.getWorksheet("Week 6")).toBeTruthy();
    // Only five entry rows exist, so week 6 contributes nothing — but G9 must
    // still total every week, including those past the 5-column grid.
    const overview6 = wb6.getWorksheet("Overview")!;
    expect(overview6.getCell("G9").value).toBe(144);
    void ctx;
  });
});
