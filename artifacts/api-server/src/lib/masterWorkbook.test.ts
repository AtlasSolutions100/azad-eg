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

  it("keeps the roll-up chain live across renamed tabs", () => {
    const overview = wb.getWorksheet("Overview")!;
    expect(fx(overview, "B9")).toBe("'Week 1'!O9");
    expect(fx(overview, "F9")).toBe("'Week 5'!O9");
    expect(fx(overview, "G9")).toContain("SUBTOTAL");
    const labor = wb.getWorksheet("Labor Attachment")!;
    expect(fx(labor, "C19")).toContain("Overview");
    const cost = wb.getWorksheet("Sub Calc")!;
    expect(fx(cost, "H13")).toContain("Labor Attachment");
    const cover = wb.getWorksheet("Invoice")!;
    expect(fx(cover, "M21")).toContain("Sub Calc");
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
    expect(labor.getCell("C19").value).toBe(16);
    expect(fx(labor, "C20")).toContain("Overview");
    expect(fx(labor, "C20")).toContain("$G$9-C19");
    expect(String(labor.getCell("B20").value)).toContain("new rate effective 6/");
    // Template rate formulas stay wired to the two Overview rate cells.
    expect(fx(labor, "D19")).toContain("I17");
    expect(fx(labor, "D20")).toContain("I18");
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
    expect(fx(cover, "S26")).toBe("P26+M26");
    expect(fx(cover, "V26")).toBe("IF(ABS(J26-S26)<0.01,0,J26-S26)");
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
    const g9 = fx(wb6.getWorksheet("Overview")!, "G9");
    expect(g9).toContain("'Week 6'!O9");
    void ctx;
  });
});
