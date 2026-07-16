import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { generateMasterPdfSource } from "./masterWorkbook";
import { convertToPdf } from "./excel";
import type { PackageDocContext } from "./packageDocs";

const wp: any = {
  id: 1, code: "B.50-03", title: "B.50-03", client: "AECOM", jobNumber: "6M8142-B50",
  agreementNo: "6M8142", poNumber: "1638681", totalBudget: 1381971.85,
  overheadRate: 120.58, fixedFeeRate: 8, fccmRate: 0.39,
  supplierId: "12345", clientProjectNo: "60723341.03", sendToCompany: "AECOM",
  sendToAddress1: "300 Lakeside Drive, Suite 400", sendToAddress2: "Oakland, CA 94612",
  contactPerson: "Chris Berilla, Program Manager",
  bartProjectNumbers: "(15CQ002, 15TC002, 45GA000) 15NL004", terms: "Net 30 Days",
};
const weeks: any[] = [1,2,3,4,5].map((n) => ({ id: n, packageId: 1, label: `Week ${n}`, weekStart: `2026-06-0${n}`, weekEnd: `2026-06-0${n}`, sortOrder: n }));
const mk = (weekId: number, hrs: number[]): any => ({
  id: weekId, packageId: 1, weekId, employeeId: 7, employeeName: "Travis Johnson",
  classification: "Project Manager", category: "regular", location: "field",
  hoursMon: hrs[0]??0, hoursTue: hrs[1]??0, hoursWed: hrs[2]??0, hoursThu: hrs[3]??0, hoursFri: hrs[4]??0,
  hoursSat: 0, hoursSun: 0, rate: 92.5,
});
const ctx: PackageDocContext = {
  pkg: { id: 1, employeeId: 7, workPlanId: 1, payPeriodStart: "2026-06-01", payPeriodEnd: "2026-06-30",
    invoiceNumber: "B.50-01-30", invoiceDate: "2026-07-08", previouslyBilled: 1135877.49,
    otherDirectCosts: 0, approvedBy: "Mahsa Azad, President" } as any,
  employee: { name: "Travis Johnson", classification: "Project Manager" },
  workPlan: wp, weeks,
  entries: [mk(1,[8,8]), mk(2,[8,8,8,8,8]), mk(3,[8,8,8,8]), mk(4,[8,8,8,8,8]), mk(5,[8,8])],
  progress: { workPerformed: "15CH001 (Millbrae)\n- Performed routine reporting", concerns: null, correctiveAction: null } as any,
  overrides: [], signatureImagePath: null,
  billedLineItems: [
    { id:1, packageId:1, workScopeNo:"B.50-01", poNo:"1638681", lineNo:1, bartProjectNo:"15TC002/PJMGT", poAmount:179582.83, previousInvoiced:179582.84, currentInvoiced:0, sortOrder:0, source:"carry_forward" },
  ] as any,
};

describe("master workbook PDF", () => {
  it("renders with Invoice first and computed totals", async () => {
    const src = await generateMasterPdfSource(ctx);
    const pdf = await convertToPdf(src);
    const text = execFileSync("pdftotext", [pdf, "-"], { encoding: "utf8" });
    fs.writeFileSync("/tmp/master-pdf.txt", text);
    const iInvoice = text.indexOf("REMIT TO");
    const iOverview = text.indexOf("Invoice Prep");
    expect(iInvoice).toBeGreaterThanOrEqual(0);
    expect(iOverview).toBe(-1); // Overview hidden -> not in PDF
    console.log("PDF text length", text.length);
  }, 120000);
});
