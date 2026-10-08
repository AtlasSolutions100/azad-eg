import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import ExcelJS from "exceljs";
import { convertToPdf, formattedLength, personKey } from "./excel";
import { buildWspWorkbook, generateWspPdfSource } from "./wspWorkbook";
import { buildParsonsWorkbook, generateParsonsPdfSource } from "./parsonsWorkbook";
import { buildTylinWorkbook, generateTylinPdfSource } from "./tylinWorkbook";
import { generateMasterPdfSource } from "./masterWorkbook";
import { effectiveBilledLineItems } from "./billedLineItems";
import { docWorkPlan, knownHeader, STORED_HEADER_FIELDS } from "./knownInvoiceHeaders";
import { toDisplayName } from "./displayName";
import type { PackageDocContext } from "./packageDocs";

/**
 * Every prime, built the way the server builds it, with figures the size real
 * work plans carry.
 *
 * The earlier export tests reproduce Julie's own sample invoices or use small
 * round numbers, and both hide the same class of defect: a $9,000 previously
 * billed fits a cell that $240,317.93 does not, and a timesheet for the
 * template's own employee cannot show that it would carry their signature onto
 * somebody else's. Each case below was a real fault on a rendered page.
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
    totalBudget: 1381971.85,
    fringeRate: 0,
    overheadRate: 109,
    fixedFeeRate: 8,
    fccmRate: 0.39,
    supplierId: null,
    terms: null,
    ...rates,
    ...stored,
  } as unknown as PackageDocContext["workPlan"] & { procasProject: string });
}

const weeks = ["2026-08-03", "2026-08-10", "2026-08-17", "2026-08-24"].map(
  (w, i) =>
    ({ id: i + 1, packageId: 1, label: `Week ${i + 1}`, weekStart: w, weekEnd: w, sortOrder: i + 1 }) as unknown as PackageDocContext["weeks"][number],
);

function entry(weekId: number, name: string, classification: string, rate: number, days: number) {
  const h = (n: number) => (days >= n ? 8 : 0);
  return {
    id: weekId * 100 + name.length,
    packageId: 1,
    weekId,
    employeeId: name.length,
    employeeName: toDisplayName(name),
    classification,
    category: "regular",
    location: "field",
    hoursMon: h(1),
    hoursTue: h(2),
    hoursWed: h(3),
    hoursThu: h(4),
    hoursFri: h(5),
    hoursSat: 0,
    hoursSun: 0,
    rate,
  } as unknown as PackageDocContext["entries"][number];
}

function ctx(
  prime: string,
  workPlan: PackageDocContext["workPlan"],
  invoiceNumber: string,
  people: Array<[string, string, number]>,
): PackageDocContext {
  const previouslyBilled = 240317.93;
  return {
    pkg: {
      id: 1,
      employeeId: null,
      workPlanId: 1,
      prime,
      payPeriodStart: "2026-08-01",
      payPeriodEnd: "2026-08-28",
      invoiceNumber,
      invoiceDate: "2026-09-01",
      previouslyBilled,
      previousHours: 3120,
      otherDirectCosts: 0,
      approvedBy: "Mahsa Azad, President",
    } as unknown as PackageDocContext["pkg"],
    employee: null,
    workPlan,
    weeks,
    entries: people.flatMap(([name, cls, rate]) => [
      entry(1, name, cls, rate, 5),
      entry(2, name, cls, rate, 5),
      entry(3, name, cls, rate, 5),
      entry(4, name, cls, rate, 4),
    ]),
    progress: {
      workPerformed: "Performed routine reporting and participated in associated meetings.",
      concerns: null,
      correctiveAction: null,
    } as unknown as PackageDocContext["progress"],
    overrides: [],
    signatureImagePath: null,
    billedLineItems: effectiveBilledLineItems([], {
      packageId: 1,
      scheduleKeys: [(workPlan as { procasProject?: string }).procasProject],
      previouslyBilled,
      totalThisPeriod: 10000,
    }),
  };
}

const TYLIN = () =>
  ctx("T.Y. Lin", plan("10014.01", "T.Y. Lin", {}), "6M8213 A.02-01-22", [
    ["Boyd, Sarah", "District Representative", 85],
    ["Harper, Ryan", "Resident Engineer", 91],
  ]);
const WSP = () =>
  ctx("WSP", plan("10013.TO02", "WSP", { fringeRate: 120.58, overheadRate: null }), "A.05-01-18", [
    ["Lawson, Imani", "Resident Engineer", 83],
  ]);
const PARSONS = () =>
  ctx("Parsons", plan("10009.03", "Parsons", { fringeRate: 0, overheadRate: 120.58 }), "B.55-11", [
    ["Ahmadzai, Hashmatullah", "Project Manager", 66.56],
  ]);
const AECOM = () =>
  ctx("AECOM", plan("10007", "AECOM", {}), "B.50-01-32", [["Johnson, Travis", "Program Manager", 92.5]]);

const pictures = (ws: ExcelJS.Worksheet) => ws.getImages().length;
const merges = (ws: ExcelJS.Worksheet) =>
  ((ws.model as unknown as { merges?: string[] }).merges ?? []).length;
const sheet = (wb: ExcelJS.Workbook, test: RegExp) => wb.worksheets.find((w) => test.test(w.name))!;
const text = (ws: ExcelJS.Worksheet, addr: string) => String(ws.getCell(addr).value ?? "");

describe("WSP — a work plan that is not the template's", () => {
  let wb: ExcelJS.Workbook;
  beforeAll(async () => {
    ({ wb } = await buildWspWorkbook(WSP()));
  });

  it("prints the client's work plan, title and header, not Procas's", () => {
    const inv = wb.getWorksheet("Invoice")!;
    expect(text(inv, "C27")).toBe("Work Plan A.05-01");
    expect(text(inv, "E22")).toBe("MOCC & LMA HVAC");
    expect(text(inv, "L8")).toBe("71262");
    expect(text(inv, "L11")).toBe("WSP Project No.: 30900569.4687");
    expect(text(inv, "D12")).toBe("WSP USA INC");
    expect(text(inv, "D15")).toBe("Email: candelaria.aldan@wsp.com");
    // "Mahsa Azad," + ",President" in two cells printed as "Mahsa Az,President".
    expect(text(inv, "B46")).toBe("Mahsa Azad, President");
    expect(inv.getCell("D46").value).toBeFalsy();
  });

  it("does not print the reference workbook's pasted labor screenshot", () => {
    // A picture of another employee's labor summary sat beside the Sub Calc.
    expect(pictures(wb.getWorksheet("Sub Calc _revised")!)).toBe(0);
  });

  it("keeps the timesheet's merged cells, so its headings are not cut off", () => {
    expect(merges(sheet(wb, /Week 1$/))).toBeGreaterThan(5);
  });

  it("signs Imani's timesheet with her own signature, not Jordy's", () => {
    // "Missing signature for Imani": the template carries Jordy's, which was
    // rightly removed from her timesheet — and nothing put hers in its place.
    const signatureOf = (ws: ExcelJS.Worksheet): number => {
      const media = (ws as unknown as {
        _media: Array<{ imageId: number | string; range?: { tl?: { nativeRow?: number; nativeCol?: number } } }>;
      })._media;
      const beside = media.filter((m) => (m.range?.tl?.nativeRow ?? 0) >= 15 && (m.range?.tl?.nativeCol ?? 9) < 4);
      expect(beside).toHaveLength(1);
      return (ws.workbook.getImage(Number(beside[0].imageId)).buffer as unknown as Uint8Array).length;
    };
    const imani = sheet(wb, /Week 1$/);
    return buildWspWorkbook(
      ctx("WSP", plan("10013.TO03", "WSP", { fringeRate: 120.58, overheadRate: null }), "A.04-02-15", [
        ["Peralta, Jordy", "Assistant Resident Engineer", 76.22],
      ]),
    ).then(({ wb: jordys }) => {
      // Both timesheets are signed (logo/approver/employee)…
      expect(pictures(imani)).toBe(pictures(sheet(jordys, /Week 1$/)));
      // …each by its own employee.
      expect(signatureOf(imani)).not.toBe(signatureOf(sheet(jordys, /Week 1$/)));
    });
  });
});

describe("T.Y. Lin", () => {
  let wb: ExcelJS.Workbook;
  beforeAll(async () => {
    ({ wb } = await buildTylinWorkbook(TYLIN()));
  });

  it("prints T.Y. Lin's job number and work plan, not Procas project 10014", () => {
    const inv = wb.getWorksheet("Invoice")!;
    expect(text(inv, "L12")).toBe("T4567");
    expect(text(inv, "L10")).toBe("BARTD-0000069210");
    expect(text(inv, "C28")).toBe("Work Plan A.02-01");
    expect(text(inv, "E22")).toBe("6M8213 General Engineering Services");
  });

  it("signs each timesheet with that person's own signature, never somebody else's", async () => {
    // Ryan's is the template's picture; Sarah's is hers off Julie's invoices
    // ("missing her signature"). Both sheets carry it beside the approver's.
    const sarah = pictures(sheet(wb, /^Sarah Week 1/));
    const ryan = pictures(sheet(wb, /^Ryan Week 1/));
    expect(sarah).toBe(ryan);
    const ids = (ws: ExcelJS.Worksheet) => ws.getImages().map((i) => String(i.imageId)).sort().join(",");
    expect(ids(sheet(wb, /^Sarah Week 1/))).not.toBe(ids(sheet(wb, /^Ryan Week 1/)));

    // Somebody we hold no signature for is signed the way her workbook signs
    // for such people: the name in a script face, and no borrowed picture.
    const { wb: other } = await buildTylinWorkbook(
      ctx("T.Y. Lin", plan("10014.01", "T.Y. Lin", {}), "6M8213 A.02-01-23", [
        ["Zapanta, Joanna", "Assistant Resident Engineer 2", 82.4],
      ]),
    );
    const joanna = sheet(other, /^Joanna Week 1/);
    expect(pictures(joanna)).toBe(ryan - 1);
    expect(joanna.getCell("E17").value).toBe("Joanna Zapanta");
  });

  it("groups the timesheets by person, in her order of people", () => {
    // "Please group timesheets by person" — they ran week by week.
    const tabs = wb.worksheets.map((w) => w.name).filter((n) => /Week \d+$/.test(n));
    expect(tabs).toEqual([
      "Sarah Week 1",
      "Sarah Week 2",
      "Sarah Week 3",
      "Sarah Week 4",
      "Ryan Week 1",
      "Ryan Week 2",
      "Ryan Week 3",
      "Ryan Week 4",
    ]);
    // …and the labor attachment lists them the same way round.
    const labor = wb.getWorksheet("Sub1 Labor")!;
    expect(labor.getCell("B16").value).toBe("Sarah Boyd");
    expect(labor.getCell("B17").value).toBe("Ryan Harper");
  });

  it("keeps the cover's Project No. label", () => {
    expect(text(wb.getWorksheet("Invoice")!, "L22")).toBe("Project No:");
  });

  it("keeps the timesheet's merged cells", () => {
    expect(merges(sheet(wb, /^Sarah Week 1/))).toBeGreaterThan(5);
  });
});

describe("Parsons", () => {
  let wb: ExcelJS.Workbook;
  beforeAll(async () => {
    ({ wb } = await buildParsonsWorkbook(PARSONS()));
  });

  it("prints work plan B.55 under agreement 6M8146", () => {
    const inv = wb.getWorksheet("Invoice")!;
    expect(text(inv, "E19")).toBe("B.55");
    expect(text(inv, "E18")).toBe("6M8146 – Scheduling Support for Capital Projects");
    expect(text(inv, "D11")).toBe("Parsons Transport Group, Inc");
  });

  it("shows the hours row on the timesheet", () => {
    // Rows 9-11 are hidden in the reference tab; the hours were written to
    // them and printed as totals with no hours above.
    const ts = sheet(wb, /Week 1$/);
    expect(ts.getRow(9).hidden).toBe(false);
    expect(ts.getCell("J9").value).toBe(8);
    expect(ts.getRow(10).hidden).toBe(true); // no overtime this week
    expect(ts.getRow(12).hidden).toBe(true); // the reference's own labor line
  });
});

describe("figures the size real work plans carry", () => {
  it("estimates how wide a formatted value prints", () => {
    expect(formattedLength(1381971.85, '_("$"* #,##0.00_)')).toBeGreaterThanOrEqual(14);
    expect(formattedLength(3424, '0.0" Hrs."')).toBe(11); // "3424.0 Hrs."
    expect(formattedLength(0.9096, "0.00%")).toBe(6); // "90.96%"
    expect(formattedLength(new Date(2026, 7, 28), "mmmm d, yyyy")).toBe(18);
    expect(formattedLength(8, "General")).toBe(1);
  });

  it("matches a person however Procas or a biller wrote the name", () => {
    expect(personKey("Johnson, Travis")).toBe(personKey("Travis Johnson"));
    expect(personKey("Ryan  Harper")).toBe(personKey("ryan harper"));
    expect(personKey("Sarah Boyd")).not.toBe(personKey("Ryan Harper"));
  });

  function pdfText(pdf: string): string | null {
    for (const bin of [
      process.env.PDFTOTEXT_BIN,
      "pdftotext",
      "C:\\Program Files\\Git\\mingw64\\bin\\pdftotext.exe",
    ].filter(Boolean) as string[]) {
      if (bin.includes("\\") && !existsSync(bin)) continue;
      try {
        const t = execFileSync(bin, ["-layout", pdf, "-"], { encoding: "utf8" });
        if (t) return t;
      } catch {
        /* try the next candidate */
      }
    }
    return null;
  }

  it.each([
    ["T.Y. Lin", generateTylinPdfSource, TYLIN],
    ["WSP", generateWspPdfSource, WSP],
    ["Parsons", generateParsonsPdfSource, PARSONS],
    ["AECOM", generateMasterPdfSource, AECOM],
  ] as const)(
    "%s prints no ### with a seven-figure budget and four-digit hours",
    async (_name, generate, make) => {
      const pdf = await convertToPdf(await generate(make()));
      const out = pdfText(pdf);
      if (out === null) {
        console.warn("pdftotext unavailable — skipping PDF text assertions");
        return;
      }
      expect(out).not.toContain("###");
      // The previously billed figure and the hours-to-date reach the page.
      expect(out).toContain("240,317.93");
    },
    240000,
  );
});
