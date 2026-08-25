import { describe, it, expect, beforeAll } from "vitest";
import ExcelJS from "exceljs";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import {
  buildParsonsWorkbook,
  computeParsonsFinancials,
  isParsonsPrime,
} from "./parsonsWorkbook";
import { buildPackageRollup } from "./packageMappers";
import type { PackageDocContext } from "./packageDocs";

/**
 * Verifies the Parsons export engine against Julie's real single-employee
 * sample (Hashmatullah Ahmadzai, Agreement 6M8146, Work Plan B.55, Procas
 * project 10009.03, invoice AZAD-11 / "B.55-11").
 *
 * Ground truth derived from the sample workbook:
 *  - Field labor this period = 84 hrs @ $66.56 = $5,591.04 (`Invoice Calc`!H22;
 *    the invoice bills one PO-line's half of the period's 168-hour timesheet).
 *  - Overhead pool = ROUND(5591.04 × 1.2058, 2) = $6,741.68   (`Invoice Calc`!H24)
 *  - Fixed fee     = ROUND((5591.04 + 6741.68) × 0.08, 2) = $986.62  (H45)
 *  - FCCM          = ROUND(5591.04 × 0.0039, 2) = $21.81            (H51)
 *  - TOTAL THIS PERIOD = ROUND(5591.04 + 6741.68 + 986.62 + 21.81, 2)
 *                      = **$13,341.15**  (`Invoice Calc`!H52 == Invoice!L29,
 *    the authoritative "total this period" — the analog of WSP's
 *    `Sub Calc _revised!H51` / TYlin's `Sub1 Inv!H42`).
 *  - Previously billed $107,453.11 → Total To Date $120,794.26 (`Invoice Calc`!J52).
 *
 * There is NO overtime on this invoice (premium = 0). The indirect layer is the
 * "H&B Overhead Pool" (overheadRate 120.58%), not the "Fringe Benefits" row
 * (0 here); every layer is rounded per line (the Parsons rounding convention).
 */

const TARGET_TOTAL_THIS_PERIOD = 13341.15;
const TARGET_TOTAL_TO_DATE = 120794.26;

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function makeCtx(overrides: Partial<PackageDocContext> = {}): PackageDocContext {
  const wp = {
    code: "B.55",
    title: "Scheduling Support for Capital Projects",
    client: "Parsons",
    jobNumber: "6M8146",
    agreementNo: "6M8146",
    poNumber: "N/A",
    totalBudget: 147407.67,
    // Parsons indirect layer lives in the "H&B Overhead Pool" (overheadRate);
    // the separate "Fringe Benefits" layer is 0 for this contract.
    fringeRate: 0,
    overheadRate: 120.58,
    fixedFeeRate: 8,
    fccmRate: 0.39,
    bartProjectNumbers: "15NL005, 54RR510",
    clientProjectNo: "15NL005",
    terms: "Net 30",
    sendToCompany: "Parsons Transport Group, Inc",
    sendToAddress1: "555 12th Street, Suite 2130",
    sendToAddress2: "Oakland, CA  94607",
    contactPerson: "Doug Woodville",
  } as unknown as PackageDocContext["workPlan"];

  // Saturdays that begin each Sat→Fri week; 40 + 40 + 4 = 84 billable field hrs.
  const weekStarts = ["2026-08-01", "2026-08-08", "2026-08-15"];
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
  // Mon-Fri hours per week: W1 = 40, W2 = 40, W3 = 4. Plus an 8-hour holiday in
  // W3 (billed $0, still shown on the timesheet).
  const dayHours = [
    [8, 8, 8, 8, 8],
    [8, 8, 8, 8, 8],
    [4, 0, 0, 0, 0],
  ];
  const entries = dayHours.map(
    (h, i) =>
      ({
        id: i + 1,
        packageId: 1,
        weekId: i + 1,
        employeeId: 11,
        employeeName: "Hashmatullah Ahmadzai",
        classification: "Project Manager",
        category: "regular",
        location: "field",
        hoursMon: h[0],
        hoursTue: h[1],
        hoursWed: h[2],
        hoursThu: h[3],
        hoursFri: h[4],
        hoursSat: 0,
        hoursSun: 0,
        rate: 66.56,
        source: "manual",
      }) as unknown as PackageDocContext["entries"][number],
  );
  // A holiday row: billed $0 (non-billable), still appears on the timesheet.
  entries.push({
    id: 99,
    packageId: 1,
    weekId: 3,
    employeeId: 11,
    employeeName: "Hashmatullah Ahmadzai",
    classification: "Project Manager",
    category: "holiday",
    location: "field",
    hoursMon: 0,
    hoursTue: 8,
    hoursWed: 0,
    hoursThu: 0,
    hoursFri: 0,
    hoursSat: 0,
    hoursSun: 0,
    rate: 66.56,
    source: "manual",
  } as unknown as PackageDocContext["entries"][number]);

  return {
    pkg: {
      id: 1,
      employeeId: 11,
      workPlanId: 1,
      prime: "Parsons Transport Group, Inc",
      procasProject: "10009.03",
      payPeriodStart: "2026-08-01",
      payPeriodEnd: "2026-08-28",
      invoiceNumber: "B.55-11",
      invoiceDate: "2026-08-20",
      previouslyBilled: 107453.11,
      otherDirectCosts: 0,
      approvedBy: "Mahsa Azad, President",
    } as unknown as PackageDocContext["pkg"],
    employee: { name: "Hashmatullah Ahmadzai", classification: "Project Manager" },
    workPlan: wp,
    weeks,
    entries,
    progress: {
      id: 1,
      packageId: 1,
      workPerformed: "Monthly P6 Schedule updated for Project ID 15NL005.",
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

describe("isParsonsPrime", () => {
  it("detects Parsons (case-insensitive) and rejects other primes", () => {
    expect(isParsonsPrime({ prime: "Parsons" })).toBe(true);
    expect(isParsonsPrime({ prime: "Parsons Transport Group, Inc" })).toBe(true);
    expect(isParsonsPrime({ prime: "parsons" })).toBe(true);
    expect(isParsonsPrime({ prime: "WSP" })).toBe(false);
    expect(isParsonsPrime({ prime: "T.Y. Lin" })).toBe(false);
    expect(isParsonsPrime({ prime: null })).toBe(false);
  });
});

describe("computeParsonsFinancials", () => {
  it("reproduces the AZAD-11 burden chain to the cent (no overtime)", () => {
    const fin = computeParsonsFinancials(makeCtx());
    expect(fin.totalHours).toBe(84);
    expect(fin.fieldDirectLabor).toBeCloseTo(5591.04, 2);
    expect(fin.overheadTotal).toBeCloseTo(6741.68, 2); // ROUND(5591.04 × 1.2058)
    expect(fin.fringeTotal).toBe(0); // "Fringe Benefits" layer is 0
    expect(fin.fixedFee).toBeCloseTo(986.62, 2); // ROUND((labor+OH) × 0.08)
    expect(fin.fccm).toBeCloseTo(21.81, 2); // ROUND(labor × 0.0039)
    expect(fin.otPremium).toBe(0); // no overtime on this invoice
    expect(fin.dtPremium).toBe(0);
    expect(round2(fin.totalThisPeriod)).toBe(TARGET_TOTAL_THIS_PERIOD);
    expect(round2(fin.totalToDate)).toBe(TARGET_TOTAL_TO_DATE);
  });
});

describe("buildParsonsWorkbook", () => {
  let wb: ExcelJS.Workbook;
  let timesheetTabs: string[];
  beforeAll(async () => {
    ({ wb, timesheetTabs } = await buildParsonsWorkbook(makeCtx()));
  });

  it("writes the authoritative total onto Invoice Calc!H52 and the Invoice face", () => {
    const inv = wb.getWorksheet("Invoice")!;
    const calc = wb.getWorksheet("Invoice Calc")!;
    expect(round2(num(calc, "H52"))).toBe(TARGET_TOTAL_THIS_PERIOD); // AUTHORITATIVE
    expect(round2(num(calc, "H92"))).toBe(TARGET_TOTAL_THIS_PERIOD); // Line 1.2 mirror
    expect(round2(num(calc, "I52"))).toBe(107453.11);
    expect(round2(num(calc, "J52"))).toBe(TARGET_TOTAL_TO_DATE);
    expect(round2(num(inv, "L27"))).toBe(TARGET_TOTAL_THIS_PERIOD);
    expect(round2(num(inv, "L29"))).toBe(TARGET_TOTAL_THIS_PERIOD);
  });

  it("writes Invoice Calc leaf cells with the Parsons round-per-layer values", () => {
    const calc = wb.getWorksheet("Invoice Calc")!;
    expect(num(calc, "H22")).toBeCloseTo(5591.04, 2); // field direct labor
    expect(num(calc, "H24")).toBeCloseTo(6741.68, 2); // overhead pool (rounded)
    expect(num(calc, "D24")).toBeCloseTo(1.2058, 6); // overhead multiplier
    expect(num(calc, "H45")).toBeCloseTo(986.62, 2); // fixed fee (rounded)
    expect(num(calc, "H51")).toBeCloseTo(21.81, 2); // FCCM (rounded)
    expect(num(calc, "D51")).toBeCloseTo(0.0039, 6); // FCCM rate
  });

  it("writes the field-labor line on the Labor_ attachment", () => {
    const lab = wb.getWorksheet("Labor_")!;
    expect(num(lab, "E26")).toBe(84); // field hours
    expect(num(lab, "F26")).toBeCloseTo(66.56, 2); // rate
    expect(num(lab, "G26")).toBeCloseTo(5591.04, 2); // field labor amount
  });

  it("ships the client-facing sheets and removes internal ones", () => {
    const names = wb.worksheets.map((w) => w.name);
    expect(names).toContain("Invoice");
    expect(names).toContain("Invoice Calc");
    expect(names).toContain("Labor_");
    expect(names).toContain("Progress Report-Hash");
    expect(names).not.toContain("master file");
    expect(names).not.toContain("Invoice_1");
    expect(names).not.toContain("Invoice Calc Summary");
    expect(names).not.toContain("Invoice Calc (2)");
    expect(names).not.toContain("Labor");
    expect(names).not.toContain("MISC");
    expect(names).not.toContain(" Progress XXX-OLD");
    expect(names).not.toContain("Progress Report-Jordy");
    // No leftover template week tabs (they are regenerated).
    expect(names.filter((n) => /^Hash Week \d+$/.test(n))).toEqual([]);
    expect(names.filter((n) => /^JP Week/.test(n))).toEqual([]);
  });

  it("builds one timesheet tab per week that starts on Saturday", () => {
    expect(timesheetTabs.length).toBe(3); // 3 weeks × 1 contributor
    for (const tab of timesheetTabs) {
      const ws = wb.getWorksheet(tab)!;
      const h7 = ws.getCell("H7").value as Date;
      expect(h7).toBeInstanceOf(Date);
      expect(h7.getDay()).toBe(6); // Saturday
      expect(ws.getCell("H8").value).toBe("Sat");
      expect(ws.getCell("N8").value).toBe("Fri");
      expect(ws.getCell("D6").value).toBe("Hashmatullah Ahmadzai");
    }
    // Week 1: Mon-Fri 8 each → straight-time row 9, columns J..N, weekly 40.
    const w1 = wb.getWorksheet(timesheetTabs[0])!;
    expect(num(w1, "J9")).toBe(8); // Monday
    expect(num(w1, "N9")).toBe(8); // Friday
    expect(num(w1, "O9")).toBe(40); // weekly straight total
    // Week 3 holiday row (row 14) carries 8 hrs but bills $0 (non-billable).
    const w3 = wb.getWorksheet(timesheetTabs[2])!;
    expect(num(w3, "O14")).toBe(8); // holiday hours shown
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

  it("leaves no formula with #REF!/#NAME?/DUMMYFUNCTION or a removed-sheet ref", () => {
    const tokens = [
      "#REF!",
      "#NAME?",
      "DUMMYFUNCTION",
      "'master file'!",
      "master file!",
      "'Invoice Calc Summary'!",
      "'Invoice Calc (2)'!",
      "'Invoice_1'!",
      "'Hash Week",
      "'JP Week",
    ];
    const stale: string[] = [];
    for (const ws of wb.worksheets) {
      ws.eachRow({ includeEmpty: false }, (row) =>
        row.eachCell({ includeEmpty: false }, (cell) => {
          const v = cell.value as { formula?: string; error?: string } | null;
          const f = v && typeof v === "object" ? v.formula : null;
          if (typeof f === "string" && tokens.some((t) => f.includes(t))) {
            stale.push(`${ws.name}!${cell.address}: ${f}`);
          }
          // A frozen/cached error value must not survive either.
          if (v && typeof v === "object" && "error" in v && v.error) {
            stale.push(`${ws.name}!${cell.address}: (error ${v.error})`);
          }
        }),
      );
    }
    expect(stale).toEqual([]);
  });

  it("drops defined names that point at removed sheets or #REF!", () => {
    const dead = wb.definedNames.model.filter((dn) =>
      dn.ranges.some(
        (r) =>
          /#REF!/i.test(r) ||
          /\[[^\]]+\]/.test(r) ||
          /master file|Invoice Calc Summary|Invoice Calc \(2\)|Invoice_1/.test(r),
      ),
    );
    expect(dead).toEqual([]);
  });
});

describe("buildParsonsWorkbook — fresh-reload validation", () => {
  it("Invoice Calc!H52 still equals 13341.15 after a full write/read roundtrip", async () => {
    const { wb } = await buildParsonsWorkbook(makeCtx());
    const out = path.join(os.tmpdir(), `parsons-roundtrip-${Date.now()}.xlsx`);
    await wb.xlsx.writeFile(out);
    try {
      const reread = new ExcelJS.Workbook();
      await reread.xlsx.readFile(out);
      const calc = reread.getWorksheet("Invoice Calc")!;
      expect(round2(num(calc, "H52"))).toBe(TARGET_TOTAL_THIS_PERIOD);
      const inv = reread.getWorksheet("Invoice")!;
      expect(round2(num(inv, "L29"))).toBe(TARGET_TOTAL_THIS_PERIOD);
    } finally {
      fs.rmSync(out, { force: true });
    }
  });
});

/**
 * Drift guard: the Parsons export engine and the on-screen rollup implement the
 * BART burden chain separately. The EXPORT is authoritative (it reproduces
 * Julie's real invoice to the cent); the rollup is the review estimate. They can
 * differ by at most one cent because Parsons' workbook rounds every indirect
 * layer per line while the shared rollup keeps intermediates full-precision and
 * rounds once (the convention that makes WSP land on its exact cent). The guard
 * therefore catches dollars of drift — a dropped fringe layer, a wrong rate —
 * not sub-cent rounding.
 */
describe("Parsons export ↔ on-screen rollup parity", () => {
  it("export hits the sample to the cent; rollup agrees within a penny", () => {
    const ctx = makeCtx();
    const parsons = computeParsonsFinancials(ctx);
    const rollup = buildPackageRollup(ctx.entries, ctx.workPlan, {
      previouslyBilled: ctx.pkg.previouslyBilled,
      otherDirectCosts: ctx.pkg.otherDirectCosts,
    });
    // The export is the client-facing number and must match the real invoice.
    expect(parsons.totalThisPeriod).toBe(TARGET_TOTAL_THIS_PERIOD);
    // The rollup (review estimate) agrees within one cent. Compare in integer
    // cents so binary-float noise can't tip the assertion.
    const cents = (n: number): number => Math.round(n * 100);
    expect(Math.abs(cents(rollup.totalThisPeriod) - cents(parsons.totalThisPeriod))).toBeLessThanOrEqual(1);
    expect(Math.abs(cents(rollup.totalToDate) - cents(parsons.totalToDate))).toBeLessThanOrEqual(1);
    expect(rollup.totalHours).toBe(parsons.totalHours);
  });
});
