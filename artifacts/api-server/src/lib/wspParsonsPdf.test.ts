import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { convertToPdf } from "./excel";
import { generateWspPdfSource } from "./wspWorkbook";
import { generateParsonsPdfSource } from "./parsonsWorkbook";
import type { PackageDocContext } from "./packageDocs";

/**
 * What the client actually receives is the PDF, and two defects in it are
 * invisible from the workbook: a value that does not fit its column renders as
 * `###` (Julie reported exactly that on the T.Y. Lin timesheets and Sub Calc),
 * and LibreOffice paginates by the sheet's used extent rather than the print
 * area, so cleared-but-styled rows still come out as pages.
 *
 * pdftotext (poppler) is a dev-only tool for reading the text back. It ships
 * with Git on Windows but is finicky there, so the text assertions soft-skip
 * when no working build is found — the PDF generation itself has already run.
 */
function pdfText(pdf: string): string | null {
  for (const bin of [
    process.env.PDFTOTEXT_BIN,
    "pdftotext",
    "C:\Program Files\Git\mingw64\bin\pdftotext.exe",
    "C:\Program Files (x86)\Git\mingw64\bin\pdftotext.exe",
  ].filter(Boolean) as string[]) {
    if (bin.includes("\\") && !existsSync(bin)) continue;
    try {
      const t = execFileSync(bin, [pdf, "-"], { encoding: "utf8" });
      if (t) return t;
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

const workPlan = {
  id: 1,
  code: "A.04-02",
  title: "Assistant Resident Engineer",
  client: "WSP",
  jobNumber: "6M8178",
  agreementNo: "6M8178",
  poNumber: "71994",
  wspProjectNo: "30900569.7859",
  clientProjectNo: "77XX999",
  totalBudget: 400000,
  fringeRate: 120.58,
  overheadRate: null,
  fixedFeeRate: 8,
  fccmRate: 0.39,
  bartProjectNumbers: "47CJ016",
  terms: "Net 30",
  sendToCompany: "WSP USA INC",
  sendToAddress1: "3260 Lone Tree Way",
  sendToAddress2: "Antioch, CA 94509",
  contactPerson: "Cindy Aldan",
} as unknown as PackageDocContext["workPlan"];

const weeks = [1, 2].map(
  (n) =>
    ({
      id: n,
      packageId: 1,
      label: `Week ${n}`,
      weekStart: `2026-05-0${n * 2}`,
      weekEnd: `2026-05-0${n * 2}`,
      sortOrder: n,
    }) as unknown as PackageDocContext["weeks"][number],
);

const entry = (weekId: number, category: string, hours: number) =>
  ({
    id: weekId * 10,
    packageId: 1,
    weekId,
    employeeId: 7,
    employeeName: "Ana Ruiz",
    classification: "Resident Engineer",
    category,
    location: "field",
    hoursMon: hours,
    hoursTue: hours,
    hoursWed: hours,
    hoursThu: hours,
    hoursFri: hours,
    hoursSat: 0,
    hoursSun: 0,
    rate: 55.5,
  }) as unknown as PackageDocContext["entries"][number];

function ctx(prime: string): PackageDocContext {
  return {
    pkg: {
      id: 1,
      employeeId: 7,
      workPlanId: 1,
      prime,
      payPeriodStart: "2026-05-02",
      payPeriodEnd: "2026-05-15",
      invoiceNumber: "A.04-02-99",
      invoiceDate: "2026-06-01",
      previouslyBilled: 9000,
      otherDirectCosts: 0,
      approvedBy: "Mahsa Azad, President",
    } as unknown as PackageDocContext["pkg"],
    employee: { name: "Ana Ruiz", classification: "Resident Engineer" },
    workPlan,
    weeks,
    entries: [entry(1, "regular", 8), entry(2, "ot", 1)],
    progress: {
      workPerformed: "Daily inspection reporting.",
      concerns: null,
      correctiveAction: null,
    } as unknown as PackageDocContext["progress"],
    overrides: [],
    signatureImagePath: null,
    billedLineItems: [],
  };
}

describe.each([
  ["WSP", generateWspPdfSource],
  ["Parsons", generateParsonsPdfSource],
])("%s printed package", (prime, generate) => {
  it("prints every figure and no blank or duplicated page", async () => {
    const pdf = await convertToPdf(await generate(ctx(prime)));
    expect(existsSync(pdf)).toBe(true);
    const text = pdfText(pdf);
    if (text === null) {
      console.warn("pdftotext unavailable — skipping PDF text assertions");
      return;
    }
    // A column too narrow for its value prints "###" instead of the number.
    expect(text).not.toContain("###");
    // The invoice total has to reach the page. WSP keeps fringe and fee at
    // full precision (6,098.19); Parsons rounds every layer (6,098.20).
    expect(text).toMatch(/6,098\.\d\d/);
    // Every page carries content: LibreOffice paginates by the sheet's used
    // extent, so a cleared-but-styled block still comes out as a blank page.
    const pages = text.split("\f").slice(0, -1);
    expect(pages.length).toBeGreaterThan(3);
    const blank = pages
      .map((p, i) => [i + 1, p.trim()] as const)
      .filter(([, p]) => p.length === 0)
      .map(([n]) => n);
    expect(blank).toEqual([]);
    // Exactly one "Total Amount Due" build-up: the Parsons template carries a
    // second PO-line block that used to be written with the same totals and
    // printed as a duplicate page of the invoice detail.
    // Case-sensitive: the invoice face carries "TOTAL AMOUNT DUE THIS INVOICE".
    expect(text.split("Total Amount Due").length - 1).toBeLessThanOrEqual(1);
  }, 180000);
});
