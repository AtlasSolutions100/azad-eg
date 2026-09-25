import { describe, it, expect, beforeAll } from "vitest";
import ExcelJS from "exceljs";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import {
  buildTylinWorkbook,
  computeTylinFinancials,
  isTylinPrime,
} from "./tylinWorkbook";
import { buildPackageRollup } from "./packageMappers";
import type { PackageDocContext } from "./packageDocs";

/**
 * Verifies the TYlin export engine against Julie's real multi-employee sample
 * (job 6M8213, Work Plan A.02-01/02, invoice AZAD-20). The field labor is
 * $65,981.68 (Sub1 Labor!E35), fringe 120.58%, fixed fee 8%, no FCCM, plus OT
 * premiums of $996 (Ryan) + $370.80 (Shane). The reference workbook's
 * Sub1 Inv!H42 / Invoice!L31 round to 158,552.58 and Total To Date to
 * 2,276,049.75 (previously billed 2,117,497.17) — the numbers this engine
 * must reproduce.
 */

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

interface EmpSpec {
  name: string;
  classification: string;
  rate: number;
  regular: number;
  ot?: number;
}

// The AZAD-20 field roster (monthly hours at base rate).
const ROSTER: EmpSpec[] = [
  { name: "Sarah Boyd", classification: "District Representative", rate: 89, regular: 176 },
  { name: "Ryan Harper", classification: "Field Inspector", rate: 83, regular: 176, ot: 24 },
  { name: "Amirhossein Hashemiastaneh", classification: "Assistant Resident Engineer", rate: 90, regular: 176 },
  { name: "Shane Terrell", classification: "Field Inspector", rate: 92.7, regular: 168, ot: 8 },
  { name: "Mike Ostrom", classification: "Claims/Change Order Support", rate: 140, regular: 2.5 },
  { name: "Jordy Peralta", classification: "Field Inspector", rate: 75.78, regular: 16 },
];

function makeCtx(overrides: Partial<PackageDocContext> = {}): PackageDocContext {
  const wp = {
    code: "A.02-01",
    title: "Construction Mngment., Design Oversight and PM Support",
    client: "T.Y. Lin",
    jobNumber: "6M8213",
    agreementNo: "6M8213",
    poNumber: "BARTD-0000069210",
    totalBudget: 2588054.112,
    fringeRate: 120.58,
    overheadRate: null,
    fixedFeeRate: 8,
    fccmRate: null,
    bartProjectNumbers: "17AY001",
    clientProjectNo: "17AY001",
    terms: "Net 30",
    sendToCompany: "T.Y. Lin International + TSE, JV",
    sendToAddress1: "Accounts Payable Department",
    contactPerson: "",
  } as unknown as PackageDocContext["workPlan"];

  // One Sat→Fri week (weekStart is a Saturday); all monthly hours live here.
  const weeks = [
    {
      id: 1,
      packageId: 1,
      label: "Week 1",
      weekStart: "2026-05-30",
      weekEnd: "2026-06-05",
      sortOrder: 1,
    } as unknown as PackageDocContext["weeks"][number],
  ];

  let id = 0;
  const entries: PackageDocContext["entries"] = [];
  for (const e of ROSTER) {
    entries.push({
      id: ++id,
      packageId: 1,
      weekId: 1,
      employeeId: id,
      employeeName: e.name,
      classification: e.classification,
      category: "regular",
      location: "field",
      hoursMon: e.regular,
      hoursTue: 0,
      hoursWed: 0,
      hoursThu: 0,
      hoursFri: 0,
      hoursSat: 0,
      hoursSun: 0,
      rate: e.rate,
      source: "manual",
    } as unknown as PackageDocContext["entries"][number]);
    if (e.ot) {
      entries.push({
        id: ++id,
        packageId: 1,
        weekId: 1,
        employeeId: id - 1, // same employee identity as the regular row
        employeeName: e.name,
        classification: e.classification,
        category: "ot",
        location: "field",
        hoursMon: e.ot,
        hoursTue: 0,
        hoursWed: 0,
        hoursThu: 0,
        hoursFri: 0,
        hoursSat: 0,
        hoursSun: 0,
        rate: e.rate,
        source: "manual",
      } as unknown as PackageDocContext["entries"][number]);
    }
  }

  return {
    pkg: {
      id: 1,
      employeeId: null,
      workPlanId: 1,
      prime: "T.Y. Lin International",
      payPeriodStart: "2026-06-01",
      payPeriodEnd: "2026-06-30",
      invoiceNumber: "6M8213 A.02-01-20",
      invoiceDate: "2026-07-08",
      previouslyBilled: 2117497.17,
      otherDirectCosts: 0,
      approvedBy: "Mahsa Azad, President",
    } as unknown as PackageDocContext["pkg"],
    employee: null,
    workPlan: wp,
    weeks,
    entries,
    progress: {
      id: 1,
      packageId: 1,
      workPerformed: "Construction management, design oversight, and PM support.",
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

describe("isTylinPrime", () => {
  it("detects T.Y. Lin (case-insensitive) and rejects WSP/AECOM", () => {
    expect(isTylinPrime({ prime: "T.Y. Lin" })).toBe(true);
    expect(isTylinPrime({ prime: "T.Y. Lin International" })).toBe(true);
    expect(isTylinPrime({ prime: "TYLin" })).toBe(true);
    expect(isTylinPrime({ prime: "ty lin" })).toBe(true);
    expect(isTylinPrime({ prime: "Lin" })).toBe(true);
    expect(isTylinPrime({ prime: "WSP" })).toBe(false);
    expect(isTylinPrime({ prime: "AECOM" })).toBe(false);
    expect(isTylinPrime({ prime: null })).toBe(false);
  });
});

describe("computeTylinFinancials", () => {
  it("reproduces the AZAD-20 burden chain to the cent", () => {
    const fin = computeTylinFinancials(makeCtx());
    expect(fin.totalHours).toBe(746.5);
    expect(fin.field.directLabor).toBeCloseTo(65981.68, 2);
    expect(fin.field.fringe).toBeCloseTo(79560.70974, 4); // UNROUNDED
    expect(fin.fixedFee).toBeCloseTo(11643.3911792, 4); // UNROUNDED
    expect(fin.field.fccm).toBe(0); // TYlin has no FCCM line
    expect(fin.otPremium).toBeCloseTo(1366.8, 2); // 996 (Ryan) + 370.80 (Shane)
    expect(fin.dtPremium).toBe(0);
    expect(round2(fin.totalThisPeriod)).toBe(158552.58);
    expect(round2(fin.totalToDate)).toBe(2276049.75);
  });
});

describe("buildTylinWorkbook", () => {
  let wb: ExcelJS.Workbook;
  let timesheetTabs: string[];
  beforeAll(async () => {
    ({ wb, timesheetTabs } = await buildTylinWorkbook(makeCtx()));
  });

  it("writes the authoritative total onto Sub1 Inv!H42 and the Invoice face", () => {
    const inv = wb.getWorksheet("Invoice")!;
    const sc = wb.getWorksheet("Sub1 Inv")!;
    expect(round2(num(sc, "H42"))).toBe(158552.58); // AUTHORITATIVE
    expect(round2(num(sc, "I42"))).toBe(2117497.17);
    expect(round2(num(sc, "J42"))).toBe(2276049.75);
    expect(round2(num(inv, "L28"))).toBe(158552.58);
    expect(round2(num(inv, "L31"))).toBe(158552.58);
    expect(round2(num(inv, "J36"))).toBe(158552.58);
    expect(round2(num(inv, "J37"))).toBe(2117497.17);
  });

  it("writes Sub1 Inv leaf cells (unrounded fringe/fee, 1.2058 multiplier)", () => {
    const sc = wb.getWorksheet("Sub1 Inv")!;
    expect(num(sc, "H11")).toBeCloseTo(65981.68, 2);
    expect(num(sc, "H12")).toBeCloseTo(79560.70974, 4);
    expect(num(sc, "H35")).toBeCloseTo(11643.39, 2);
    expect(num(sc, "D12")).toBeCloseTo(1.2058, 6);
    expect(num(sc, "H29")).toBeCloseTo(1366.8, 2); // aggregate OT premium
  });

  it("writes per-employee labor lines on Sub1 Labor with the field subtotal", () => {
    const sl = wb.getWorksheet("Sub1 Labor")!;
    expect(num(sl, "C35")).toBe(746.5); // field subtotal hours
    expect(num(sl, "E35")).toBeCloseTo(65981.68, 2); // field subtotal amount
    expect(num(sl, "E38")).toBeCloseTo(65981.68, 2); // TOTAL LABOR
  });

  it("ships the client-facing sheets and removes internal ones", () => {
    const names = wb.worksheets.map((w) => w.name);
    expect(names).toContain("Invoice");
    expect(names).toContain("Sub1 Inv");
    expect(names).toContain("Sub1 Labor");
    expect(names).not.toContain("master file");
    expect(names).not.toContain("master file_old");
    expect(names).not.toContain("Sub1 Inv (2)");
    expect(names).not.toContain("NOTES");
  });

  it("builds one timesheet tab per contributor that starts on Saturday", () => {
    expect(timesheetTabs.length).toBe(ROSTER.length); // 1 week × 6 people
    for (const tab of timesheetTabs) {
      const ws = wb.getWorksheet(tab)!;
      const h6 = ws.getCell("H6").value as Date;
      expect(h6).toBeInstanceOf(Date);
      expect(h6.getDay()).toBe(6); // Saturday
      expect(ws.getCell("H7").value).toBe("Sat");
      expect(ws.getCell("N7").value).toBe("Fri");
    }
  });

  it("leaves no formula pointing at a removed sheet or DUMMYFUNCTION", () => {
    const tokens = ["'master file'!", "master file!", "'Sub1 Inv (2)'!", "DUMMYFUNCTION", "#REF!"];
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

  /**
   * Julie's 9/1 review of the generated 10014 package. Every item below was a
   * cell the engine never wrote, so the reference workbook's own invoice
   * shipped to the client in its place.
   */
  it("leaves no reference-workbook figures in the Sub1 Inv right-hand columns", () => {
    const subinv = wb.getWorksheet("Sub1 Inv")!;
    // Budget / Previously Billed / Amount To Date / % Expended used to carry
    // the template's $1.2M and $2.39M budgets, $1.95M previously billed and
    // 87.6% expended. Only the row-42 totals are ours to state.
    // I11/I12/I35 are the one thing we do state above row 42: the scalar
    // previously-billed carry-forward (or its per-category split).
    const carryForward = new Set(["I11", "I12", "I35"]);
    for (let r = 5; r <= 41; r++) {
      for (const col of ["G", "I", "J", "K"]) {
        const addr = `${col}${r}`;
        if (carryForward.has(addr)) continue;
        const v = subinv.getCell(addr).value;
        expect(v === null || v === undefined || v === 0, `${addr} = ${String(v)}`).toBe(true);
      }
    }
    expect(subinv.getCell("G42").value).toBeCloseTo(2588054.112, 2);
    expect(subinv.getCell("I42").value).toBeCloseTo(2117497.17, 2);
  });

  it("writes the Hours to Date row as values instead of a stale formula", () => {
    const subinv = wb.getWorksheet("Sub1 Inv")!;
    // F11 was `=D11+E11` with the template's cached 11,028.5 hours.
    const current = subinv.getCell("D11").value as number;
    expect(current).toBeGreaterThan(0);
    // This fixture carries no previousHours, so Previous prints blank rather
    // than a 0 that would read as "nobody has ever worked this job", and To
    // Date equals Current.
    expect(subinv.getCell("E11").value).toBeNull();
    expect(subinv.getCell("F11").value).toBe(current);
  });

  it("states the previous hours Procas holds, on the row carrying the labor", async () => {
    // Work plan 10007 has 6,627 hours booked before the period; the sub-calc
    // used to print a hard 0 there ("missing previous hours").
    const ctx = makeCtx();
    const { wb: withPrev } = await buildTylinWorkbook({
      ...ctx,
      pkg: { ...ctx.pkg, previousHours: 6627 } as typeof ctx.pkg,
    });
    const subinv = withPrev.getWorksheet("Sub1 Inv")!;
    const current = subinv.getCell("D11").value as number;
    expect(subinv.getCell("E11").value).toBe(6627);
    expect(subinv.getCell("F11").value).toBe(round2(current + 6627));
    // It is a project total, not a per-location one, so it appears once.
    expect(subinv.getCell("E7").value).toBeNull();
  });

  it("clears the reconciliation scratch beside TOTAL LABOR", () => {
    const sublabor = wb.getWorksheet("Sub1 Labor")!;
    // H38 held `=59250.7-E38` and I38 the bare label "ODC", both printing on
    // the client's Labor Attachment.
    for (const col of ["F", "G", "H", "I", "J", "K", "L"]) {
      expect(sublabor.getCell(`${col}38`).value ?? null).toBeNull();
    }
    // The scratch cells beside the FIELD block go too.
    expect(sublabor.getCell("G16").value ?? null).toBeNull();
    expect(sublabor.getCell("H32").value ?? null).toBeNull();
  });

  it("regenerates the ODCs sheet from this period's overtime", () => {
    const odcs = wb.getWorksheet("ODCs")!;
    // Month was hardcoded "May"; the roster's OT is Ryan Harper (24h) and
    // Shane Terrell (8h), worth $996.00 and $370.80.
    expect(String(odcs.getCell("C3").value)).toContain("June");
    const names: string[] = [];
    for (let r = 7; r <= 16; r++) {
      const v = odcs.getCell(`D${r}`).value;
      if (v) names.push(String(v));
    }
    expect(names).toEqual(["Ryan Harper-OT", "Shane Terrell-OT"]);
    expect(odcs.getCell("F7").value).toBeCloseTo(996, 2);
    expect(odcs.getCell("F8").value).toBeCloseTo(370.8, 2);
    expect(odcs.getCell("F23").value).toBeCloseTo(1366.8, 2);
    // No lingering `='Sub1 Labor'!B24` pointing at a row we rewrote.
    for (let r = 7; r <= 16; r++) {
      const v = odcs.getCell(`D${r}`).value as { formula?: string } | null;
      expect(v && typeof v === "object" && "formula" in v).toBeFalsy();
    }
  });

  it("keeps only the progress reports of people on this package", () => {
    const reports = wb.worksheets
      .map((w) => w.name)
      .filter((n) => /^Progress Report/i.test(n));
    // The template ships reports for Mahsa and Robert (hidden) who are not on
    // the roster; every retained report must belong to a contributor.
    expect(reports.some((n) => /mahsa/i.test(n))).toBe(false);
    expect(reports.some((n) => /robert/i.test(n))).toBe(false);
    expect(reports.length).toBeGreaterThan(0);
  });

  it("pins the invoice forms to a single printed page", () => {
    for (const name of ["Invoice", "Sub1 Inv", "Sub1 Labor"]) {
      expect(wb.getWorksheet(name)!.pageSetup.fitToHeight).toBe(1);
    }
    // Timesheets still flow down rather than being squeezed.
    const week = wb.worksheets.find((w) => /Week 1$/.test(w.name))!;
    expect(week.pageSetup.fitToHeight).toBe(0);
  });

  it("has no formulas left on the client-facing sheets", () => {
    // Same guard as the AECOM engine: ExcelJS emits formula text without
    // evaluating it, and neither LibreOffice's PDF export nor a plain viewer
    // recalculates on open, so any surviving formula prints the cached result
    // stored in Julie's reference workbook rather than this package's number.
    const offenders: string[] = [];
    for (const ws of wb.worksheets) {
      if (!["Invoice", "Sub1 Inv", "Sub1 Labor", "ODCs"].includes(ws.name)) continue;
      ws.eachRow({ includeEmpty: false }, (row) => {
        row.eachCell({ includeEmpty: false }, (cell) => {
          const v = cell.value as Record<string, unknown> | null;
          if (v && typeof v === "object" && ("formula" in v || "sharedFormula" in v)) {
            offenders.push(`${ws.name}!${cell.address}`);
          }
        });
      });
    }
    expect(offenders).toEqual([]);
  });

  it("states the cost forecast from this package, not the reference invoice", () => {
    const report = wb.worksheets.find((w) => /^Progress Report/i.test(w.name))!;
    let sentence: string | null = null;
    report.eachRow({ includeEmpty: false }, (row) => {
      row.eachCell({ includeEmpty: false }, (cell) => {
        const v = cell.value;
        if (typeof v === "string" && v.startsWith("Cost Forecast Completion")) sentence = v;
      });
    });
    expect(sentence).toBeTruthy();
    // Budget 2,588,054.112; to date 2,276,049.75 → 87.9%.
    expect(sentence!).toContain("$2,588,054.11");
    expect(sentence!).toContain("$2,276,049.75");
    expect(sentence!).toContain("(87.9%)");
  });

  it("drops defined names that point at removed sheets", () => {
    const dead = wb.definedNames.model.filter((dn) =>
      dn.ranges.some(
        (r) => /#REF!/i.test(r) || /\[[^\]]+\]/.test(r) || /master file|Sub1 Inv \(2\)/.test(r),
      ),
    );
    expect(dead).toEqual([]);
  });
});

describe("buildTylinWorkbook — fresh-reload validation", () => {
  it("Sub1 Inv!H42 still equals 158552.58 after a full write/read roundtrip", async () => {
    const { wb } = await buildTylinWorkbook(makeCtx());
    const out = path.join(os.tmpdir(), `tylin-roundtrip-${Date.now()}.xlsx`);
    await wb.xlsx.writeFile(out);
    try {
      const reread = new ExcelJS.Workbook();
      await reread.xlsx.readFile(out);
      const sc = reread.getWorksheet("Sub1 Inv")!;
      expect(round2(num(sc, "H42"))).toBe(158552.58);
      const inv = reread.getWorksheet("Invoice")!;
      expect(round2(num(inv, "L31"))).toBe(158552.58);
    } finally {
      fs.rmSync(out, { force: true });
    }
  });
});

/**
 * Drift guard: the TYlin export engine and the on-screen rollup must agree to
 * the cent (same BART burden chain), so the client invoice matches the review
 * screen. (Now that packageMappers applies the fringe layer correctly.)
 */
describe("TYlin export ↔ on-screen rollup parity", () => {
  it("computeTylinFinancials and buildPackageRollup agree on the period totals", () => {
    const ctx = makeCtx();
    const tylin = computeTylinFinancials(ctx);
    const rollup = buildPackageRollup(ctx.entries, ctx.workPlan, {
      previouslyBilled: ctx.pkg.previouslyBilled,
      otherDirectCosts: ctx.pkg.otherDirectCosts,
    });
    expect(rollup.totalThisPeriod).toBeCloseTo(tylin.totalThisPeriod, 2);
    expect(rollup.totalToDate).toBeCloseTo(tylin.totalToDate, 2);
    expect(rollup.otdtPremium).toBeCloseTo(tylin.otPremium + tylin.dtPremium, 2);
    expect(rollup.totalHours).toBe(tylin.totalHours);
  });
});
