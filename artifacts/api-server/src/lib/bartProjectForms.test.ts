import { describe, it, expect, beforeAll } from "vitest";
import ExcelJS from "exceljs";
import {
  LOADED_RATE_FLOOR,
  bartProjectOf,
  baseLcItem,
  burdenMultiplier,
  directRate,
} from "./procasPackageSync";
import { allocateAcrossPoLines, knownPoSchedule } from "./poSchedule";
import { effectiveBilledLineItems } from "./billedLineItems";
import { docWorkPlan, knownHeader, STORED_HEADER_FIELDS } from "./knownInvoiceHeaders";
import { buildWspLinesWorkbook, computeWspLinesFinancials, isWspLinesForm } from "./wspLinesWorkbook";
import { buildTylinWorkbook, baseClassification } from "./tylinWorkbook";
import { buildParsonsWorkbook } from "./parsonsWorkbook";
import { invoiceParts, type PackageDocContext } from "./packageDocs";
import { clientFileBase } from "./invoiceRegister";

/**
 * The forms and rules that depend on which BART project an hour was worked
 * for, and on Procas's two kinds of billing rate.
 */

function plan(project: string, client: string, rates: Record<string, number | null>) {
  const stored: Record<string, string> = {};
  const header = (knownHeader(project) ?? {}) as Record<string, string | undefined>;
  for (const f of STORED_HEADER_FIELDS) if (header[f]) stored[f] = header[f]!;
  return docWorkPlan({
    id: 1,
    code: project,
    title: `Procas title for ${project}`,
    client,
    jobNumber: project,
    procasProject: project,
    totalBudget: knownHeader(project)?.totalBudget ?? 0,
    fringeRate: 120.58,
    overheadRate: 0,
    fixedFeeRate: 8,
    fccmRate: 0.39,
    supplierId: null,
    terms: null,
    ...rates,
    ...stored,
  } as unknown as PackageDocContext["workPlan"] & { procasProject: string });
}

const weeks = ["2026-05-30", "2026-06-06", "2026-06-13", "2026-06-20"].map(
  (w, i) =>
    ({ id: i + 1, packageId: 1, label: `Week ${i + 1}`, weekStart: w, weekEnd: w, sortOrder: i + 1 }) as unknown as PackageDocContext["weeks"][number],
);

let seq = 0;
function entry(
  weekId: number,
  name: string,
  classification: string,
  rate: number,
  hours: number,
  opts: { category?: string; taskNo?: string | null } = {},
) {
  return {
    id: ++seq,
    packageId: 1,
    weekId,
    employeeId: name.length,
    employeeName: name,
    classification,
    category: opts.category ?? "regular",
    location: "home",
    hoursMon: hours,
    hoursTue: 0,
    hoursWed: 0,
    hoursThu: 0,
    hoursFri: 0,
    hoursSat: 0,
    hoursSun: 0,
    rate,
    taskNo: opts.taskNo ?? null,
    notes: null,
  } as unknown as PackageDocContext["entries"][number];
}

function ctx(
  prime: string,
  workPlan: PackageDocContext["workPlan"],
  invoiceNumber: string,
  entries: PackageDocContext["entries"],
  previouslyBilled: number,
): PackageDocContext {
  return {
    pkg: {
      id: 1,
      employeeId: null,
      workPlanId: 1,
      prime,
      payPeriodStart: "2026-05-30",
      payPeriodEnd: "2026-06-30",
      invoiceNumber,
      invoiceDate: "2026-06-30",
      previouslyBilled,
      previousHours: 4811,
      otherDirectCosts: 0,
      approvedBy: "Mahsa Azad, President",
    } as unknown as PackageDocContext["pkg"],
    employee: null,
    workPlan,
    weeks,
    entries,
    progress: null,
    overrides: [],
    signatureImagePath: null,
    billedLineItems: effectiveBilledLineItems([], {
      packageId: 1,
      scheduleKeys: [(workPlan as { procasProject?: string }).procasProject],
      previouslyBilled,
      totalThisPeriod: 0,
    }),
  };
}

describe("Procas billing rates: direct or loaded", () => {
  const tylin = { fringeRate: 120.58, overheadRate: 0, fixedFeeRate: 8, fccmRate: 0 };
  const wsp = { fringeRate: 120.58, overheadRate: null, fixedFeeRate: 8, fccmRate: 0.39 };

  it("knows what a dollar of labor becomes on the invoice", () => {
    expect(burdenMultiplier(tylin)).toBeCloseTo(2.382264, 6);
    expect(burdenMultiplier(wsp)).toBeCloseTo(2.386164, 6);
    expect(burdenMultiplier({})).toBe(1);
  });

  it("unwinds T.Y. Lin's loaded rates to the rates on her June invoice", () => {
    // Procas BillingItem (Aug 2026) → Sub1 Labor, invoice 6M8213 A.02-01-20.
    expect(directRate(197.73, tylin)).toBe(83); // Ryan Harper
    expect(directRate(214.4, tylin)).toBe(90); // Amirhossein Hashemiastaneh
    expect(directRate(180.53, tylin)).toBe(75.78); // Jordy Peralta
    expect(directRate(212.02, tylin)).toBe(89); // Sarah Boyd
    expect(directRate(198.0549, wsp)).toBe(83); // Imani Lawson, WSP A.05-01
  });

  it("leaves a rate that is already the direct rate alone", () => {
    expect(directRate(74, wsp)).toBe(74); // De'Andre Rashad
    expect(directRate(140, tylin)).toBe(140); // the highest direct rate she bills
    expect(LOADED_RATE_FLOOR).toBeGreaterThan(140);
    expect(LOADED_RATE_FLOOR).toBeLessThan(146.72); // the lowest loaded rate in Procas
    // A work plan with no burden has nothing to unwind.
    expect(directRate(200, { fringeRate: 0, fixedFeeRate: 0 })).toBe(200);
  });

  it("prices overtime from the straight-time labor category", () => {
    expect(baseLcItem("FI-O")).toBe("FI");
    expect(baseLcItem("RE1-O")).toBe("RE1");
    expect(baseLcItem("INSP-D")).toBe("INSP");
    expect(baseLcItem("FI")).toBe("FI");
    expect(baseClassification("Field Inspector-Overtime")).toBe("Field Inspector");
    expect(baseClassification("Resident Engineer")).toBe("Resident Engineer");
  });

  it("reads the BART project off a Procas leaf project's description", () => {
    expect(bartProjectOf("WSP CM Services for BART 15EJRRC")).toBe("15EJRRC");
    expect(bartProjectOf("20LN003 Parsons BART TO B.40-02-001 LNP")).toBe("20LN003");
    expect(bartProjectOf("54RR510 Parsons BART Projects 6M8146 B.55")).toBe("54RR510");
    expect(bartProjectOf("Parsons BART TO B.55-01")).toBe("");
    expect(bartProjectOf("Parsons BART TO B.40-02-001 LNTP")).toBe("");
  });
});

describe("WSP A.03.01 — three PO lines, one per BART project", () => {
  // De'Andre's June hours by project, off invoice A.03.01-23.
  const june = () => [
    entry(1, "De'Andre Rashad", "Warehouse Specialist", 74, 48, { taskNo: "15EJRRC" }),
    entry(2, "De'Andre Rashad", "Warehouse Specialist", 74, 52, { taskNo: "15EJRRK" }),
    entry(3, "De'Andre Rashad", "Warehouse Specialist", 74, 68, { taskNo: "49GH006" }),
  ];
  const wp = () => plan("10013.TO01", "WSP", {});

  it("is the form for a work plan with several PO lines, and only that", () => {
    expect(isWspLinesForm({ workPlan: wp() })).toBe(true);
    expect(isWspLinesForm({ workPlan: plan("10013.TO02", "WSP", {}) })).toBe(false);
  });

  it("reproduces her June invoice's Current Month column to the cent", () => {
    const fin = computeWspLinesFinancials(ctx("WSP", wp(), "A.03.01-23", june(), 775362.94));
    expect(fin.lines.map((l) => l.project)).toEqual(["15EJRRC", "15EJRRK", "49GH006"]);
    expect(fin.lines.map((l) => l.current.total)).toEqual([8475.65, 9181.96, 12007.18]);
    expect(fin.totalThisPeriod).toBe(29664.79);
    expect(fin.lines.map((l) => l.budget.total)).toEqual([452143.97, 452143.97, 301429.3]);
    expect(fin.budget).toBe(1205717.24);
    // Line 1's build-up: labor, fringe, fee, FCCM.
    expect(fin.lines[0].current).toMatchObject({ labor: 3552, fringe: 4283, fee: 626.8, fccm: 13.85 });
    expect(fin.lines[0].budget).toMatchObject({ labor: 200311.88, fringe: 218339.95, fee: 33492.14 });
  });

  it("starts each line's history from that invoice's to-date figures", () => {
    // Everything billed through June, and nothing since.
    const even = computeWspLinesFinancials(ctx("WSP", wp(), "A.03.01-24", june(), 805027.73));
    expect(even.lines.map((l) => l.previous.total)).toEqual([313358.75, 309865.65, 181803.33]);
    expect(even.lines[0].previous).toMatchObject({ labor: 137962.6, fringe: 152129.79, fee: 23207.4 });
    // What has been billed since is shared by PO amount, and still ties out.
    const later = computeWspLinesFinancials(ctx("WSP", wp(), "A.03.01-25", june(), 835027.73));
    expect(later.previouslyBilled).toBe(835027.73);
    expect(later.lines[0].previous.total).toBe(324608.75); // + 37.5% of 30,000
    for (const l of later.lines) {
      const p = l.previous;
      expect(Math.abs(p.labor + p.fringe + p.pool + p.fee + p.fccm - p.total)).toBeLessThan(0.005);
    }
  });

  it("shares hours that carry no project across the lines without losing any", () => {
    const fin = computeWspLinesFinancials(
      ctx("WSP", wp(), "A.03.01-25", [entry(1, "De'Andre Rashad", "Warehouse Specialist", 74, 41)], 805027.73),
    );
    expect(fin.lines.reduce((s, l) => s + l.hours, 0)).toBe(41);
  });

  describe("the workbook", () => {
    let wb: ExcelJS.Workbook;
    beforeAll(async () => {
      ({ wb } = await buildWspLinesWorkbook(ctx("WSP", wp(), "A.03.01-23", june(), 805027.73)));
    });

    it("has her pages in her order", () => {
      expect(wb.worksheets.map((w) => w.name)).toEqual([
        "Invoice",
        "Prime Calc 1-1",
        "Prime Labor 1-1",
        "Prime Calc 2-1",
        "Prime Labor 2-1",
        "Prime Calc 3-1",
        "Prime Labor 3-1",
        "Prime Overall Inv",
        "Progress Report",
        "DR Week 1",
        "DR Week 2",
        "DR Week 3",
      ]);
    });

    it("lists the three lines on the cover", () => {
      const inv = wb.getWorksheet("Invoice")!;
      expect(inv.getCell("L5").value).toBe("6M8178 A.03.01-23");
      expect(inv.getCell("C28").value).toBe("15EJRRC");
      expect(inv.getCell("F29").value).toBe(9181.96);
      expect(inv.getCell("H30").value).toBe(181803.33);
      expect(inv.getCell("F33").value).toBe(29664.79);
      expect(inv.getCell("L33").value).toBe(1205717.24);
    });

    it("carries no formulas: the PDF renderer does not recalculate", () => {
      for (const ws of wb.worksheets) {
        ws.eachRow({ includeEmpty: false }, (row) => {
          row.eachCell({ includeEmpty: false }, (cell) => {
            const v = cell.value as { formula?: string; sharedFormula?: string } | null;
            const isFormula = !!v && typeof v === "object" && (v.formula != null || v.sharedFormula != null);
            expect(isFormula, `${ws.name}!${cell.address}`).toBe(false);
          });
        });
      }
    });

    it("puts each project's hours on its own timesheet row", () => {
      const ts = wb.getWorksheet("DR Week 2")!;
      expect(String(ts.getCell("B10").value)).toContain("15EJRRK");
      expect(ts.getCell("O10").value).toBe(52);
      expect(ts.getCell("O9").value).toBe(0);
      expect(ts.getCell("O15").value).toBe(52);
    });
  });
});

describe("PO line history", () => {
  it("falls back to a plain pro-rata split below the anchors", () => {
    const lines = allocateAcrossPoLines(knownPoSchedule("10013.TO01")!, 100000, 0);
    expect(lines.map((l) => l.previousInvoiced)).toEqual([37500, 37500, 25000]);
  });
});

describe("T.Y. Lin with Procas-shaped entries", () => {
  let wb: ExcelJS.Workbook;
  beforeAll(async () => {
    const tylin = plan("10014", "T.Y. Lin", { fccmRate: 0 });
    const entries = [
      entry(1, "Ryan Harper", "Field Inspector", 83, 40),
      entry(1, "Ryan Harper", "Field Inspector-Overtime", 83, 8, { category: "ot" }),
      entry(1, "Sarah Boyd", "Resident Engineer", 89, 40),
      entry(1, "Sarah Boyd", "Resident Engineer1- Overtime", 89, 6, { category: "ot" }),
      entry(1, "Amirhossein Hashemiastaneh", "Construction Manager.", 90, 40),
      entry(1, "Jordy Peralta", "Inspector-Day", 75.78, 40),
    ];
    ({ wb } = await buildTylinWorkbook(ctx("T.Y. Lin", tylin, "6M8213 A.02-01-22", entries, 2565543.37)));
  });

  it("bills the labor under Field, as her invoice does", () => {
    const labor = wb.getWorksheet("Sub1 Labor")!;
    expect(labor.getCell("A6").value).toBe("Home");
    expect(labor.getCell("C13").value).toBe(0); // SUBTOTAL (HOME)
    expect(labor.getCell("C35").value).toBe(174); // SUBTOTAL (FIELD)
  });

  it("shows every labor line it counts, overtime on its own line", () => {
    const labor = wb.getWorksheet("Sub1 Labor")!;
    const shown: string[] = [];
    let total = 0;
    for (let r = 16; r <= 34; r++) {
      const name = labor.getCell(`B${r}`).value;
      if (!name) continue;
      expect(labor.getRow(r).hidden, `row ${r} (${name})`).toBeFalsy();
      shown.push(String(name));
      total += Number(labor.getCell(`E${r}`).value);
    }
    expect(shown).toContain("Ryan Harper-OT");
    expect(shown).toContain("Sarah Boyd-OT");
    // The page adds up to its own subtotal.
    expect(total).toBeCloseTo(Number(labor.getCell("E35").value), 2);
  });

  it("itemises the overtime premium on the ODC table, on rows that print", () => {
    const odcs = wb.getWorksheet("ODCs")!;
    expect(odcs.getCell("D7").value).toBe("Ryan Harper-OT");
    expect(odcs.getCell("F7").value).toBe(332); // 8 h x 0.5 x $83
    expect(odcs.getCell("C7").value).toBe("BART");
    expect(odcs.getCell("D8").value).toBe("Sarah Boyd-OT");
    expect(odcs.getRow(7).hidden).toBeFalsy();
    expect(odcs.getRow(8).hidden).toBeFalsy();
    expect(odcs.getRow(9).hidden).toBe(true);
    expect(odcs.getCell("F23").value).toBe(599); // 332 + 267
  });

  it("names each person's premium on the build-up", () => {
    const inv = wb.getWorksheet("Sub1 Inv")!;
    expect(inv.getCell("C29").value).toBe("SS OT Premium(Ryan) 41.50/HR HRS");
    expect(inv.getCell("H30").value).toBe(267);
    expect(inv.getCell("D14").value).toBeCloseTo(1.2058, 6);
  });
});

describe("Parsons — one invoice per BART project", () => {
  const narmadha = () =>
    ctx(
      "Parsons",
      plan("10009.02", "Parsons", { fringeRate: 0, overheadRate: 120.58 }),
      "B.40-02-12",
      [
        entry(1, "Narmadha Gopalasamy", "Project Manager 1", 83, 8, { taskNo: "20CE002" }),
        entry(2, "Narmadha Gopalasamy", "Project Manager 1", 83, 6, { taskNo: "20LN003" }),
        entry(2, "Narmadha Gopalasamy", "Project Manager 1", 83, 4),
        entry(3, "Narmadha Gopalasamy", "Project Manager 1", 83, 8, { category: "pto" }),
      ],
      224833.94,
    );

  it("splits the package along the BART project, numbered her way", () => {
    const parts = invoiceParts(narmadha());
    expect(parts.map((p) => p.pkg.invoiceNumber)).toEqual([
      "B.40-02-12",
      "B.40-02-12 (20CE002)",
      "B.40-02-12 (20LN003)",
    ]);
    // Every billable hour lands on exactly one invoice.
    const billable = (p: PackageDocContext) =>
      p.entries.filter((e) => e.category === "regular").reduce((s, e) => s + e.hoursMon, 0);
    expect(parts.map(billable)).toEqual([4, 8, 6]);
    // Leave is not billed and rides with one of them only.
    expect(parts.filter((p) => p.entries.some((e) => e.category === "pto"))).toHaveLength(1);
  });

  it("leaves a package with no projects on its entries as one invoice", () => {
    const c = narmadha();
    c.entries = c.entries.map((e) => ({ ...e, taskNo: null }));
    expect(invoiceParts(c)).toHaveLength(1);
  });

  it("does not split a work plan that bills as one invoice", () => {
    const c = ctx("WSP", plan("10013.TO02", "WSP", {}), "A.05-01-18", [
      entry(1, "Imani Lawson", "Assistant Resident Engineer", 83, 8, { taskNo: "60C004" }),
    ], 1000);
    expect(invoiceParts(c)).toHaveLength(1);
  });

  it("names the files the way her register does", () => {
    expect(clientFileBase(["10009.02"], "2026-08-28", "B.40-02-12")).toBe(
      "08-2026-BART 6M8146-Parsons-B.40-02-001 Invoice_AZAD-12",
    );
  });

  it("prints the project and the work plan's own number on its invoice", async () => {
    const part = invoiceParts(narmadha())[1];
    const { wb } = await buildParsonsWorkbook(part);
    const inv = wb.getWorksheet("Invoice")!;
    expect(inv.getCell("L5").value).toBe("B.40-02-12 (20CE002)");
    expect(inv.getCell("L19").value).toBe("20CE002");
    expect(inv.getCell("C33").value).toBe("B.40-02-001"); // was the template's "B.55"
    const ts = wb.worksheets.find((w) => /Week 1$/.test(w.name))!;
    expect(String(ts.getCell("B9").value)).toMatch(/B\.40-02-001 20CE002$/);
  });
});
