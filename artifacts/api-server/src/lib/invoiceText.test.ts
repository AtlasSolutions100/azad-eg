import { describe, it, expect } from "vitest";
import { toDisplayName } from "./displayName";
import {
  agreementLine,
  agreementNumber,
  docWorkPlan,
  knownHeader,
  KNOWN_INVOICE_HEADERS,
} from "./knownInvoiceHeaders";

describe("toDisplayName", () => {
  it('turns Procas\'s "Last, First" into the name as it is said', () => {
    // "Submitted by: Johnson, Travis, Program Manager" read as three things.
    expect(toDisplayName("Johnson, Travis")).toBe("Travis Johnson");
    expect(toDisplayName("  Johnson ,  Travis  ")).toBe("Travis Johnson");
  });

  it("leaves anything that is not an unambiguous Last, First alone", () => {
    expect(toDisplayName("Travis Johnson")).toBe("Travis Johnson");
    expect(toDisplayName("Smith, John, Jr.")).toBe("Smith, John, Jr.");
    expect(toDisplayName("Johnson,")).toBe("Johnson,");
    expect(toDisplayName(null)).toBe("");
  });
});

describe("agreement line and number", () => {
  it("prints the agreement's service description on the cover", () => {
    // Her cover: "Agreement No.  6M8142 Architectural and General Engineering Services".
    expect(agreementLine("6M8142")).toBe("6M8142 Architectural and General Engineering Services");
  });

  it("prints an agreement we hold no description for as it was entered", () => {
    expect(agreementLine("6M8178")).toBe("6M8178");
    expect(agreementLine(null)).toBe("");
  });

  it("uses the number alone where it is a short code", () => {
    // Her timesheets: "6M8142 / B.50-03".
    expect(agreementNumber("6M8142")).toBe("6M8142");
    expect(agreementNumber("6M8142 Architectural and General Engineering Services")).toBe("6M8142");
    expect(agreementNumber(undefined)).toBe("");
  });
});

describe("known invoice headers", () => {
  it("carries what her real 10007 invoice prints, and no Supplier ID", () => {
    const h = KNOWN_INVOICE_HEADERS["10007"];
    expect(h.sendToCompany).toBe("AECOM");
    expect(h.sendToAddress1).toBe("300 Lakeside Drive, Suite 400");
    expect(h.contactPerson).toBe("Chris Berilla, Program Manager");
    expect(h.poNumber).toBe("1638681");
    expect(h.clientProjectNo).toBe("60723341.03");
    // Her invoice prints "--" for Supplier ID, so there is nothing to supply.
    expect(Object.keys(h)).not.toContain("supplierId");
  });
});

/**
 * The other three primes. A work plan imported from Procas carries Procas's
 * identifiers, and the engines printed them: "Work Plan 10014", "Job Number
 * 10014", "Work Plan Title: 10009.03". Her invoices use the client's.
 */
describe("docWorkPlan — the work plan as the client's paperwork names it", () => {
  const procasPlan = (code: string, title: string) => ({
    code,
    title,
    jobNumber: code,
    procasProject: code,
    totalBudget: 1,
  });

  it("T.Y. Lin: work plan A.02-01 under job number T4567", () => {
    const wp = docWorkPlan(procasPlan("10014.01", "TYLin GEC"));
    expect(wp.code).toBe("A.02-01");
    expect(wp.jobNumber).toBe("T4567");
    expect(wp.title).toBe("A.02-01 &A02-02 Construction Mngment., Design Ovesight & PM Support");
    // Still found by its Procas project for the register and PO schedule.
    expect(wp.procasProject).toBe("10014.01");
    expect(wp.totalBudget).toBe(1);
  });

  it("WSP: each task order prints its own work plan and title", () => {
    expect(docWorkPlan(procasPlan("10013.TO02", "x")).code).toBe("A.05-01");
    expect(docWorkPlan(procasPlan("10013.TO02", "x")).title).toBe("MOCC & LMA HVAC");
    expect(docWorkPlan(procasPlan("10013.TO03", "x")).code).toBe("A.04-02");
    expect(docWorkPlan(procasPlan("10013.TO01", "x")).code).toBe("A.03.01");
  });

  it("Parsons: B.55 under agreement 6M8146", () => {
    const wp = docWorkPlan(procasPlan("10009.03", "x"));
    expect(wp.code).toBe("B.55");
    expect(wp.jobNumber).toBe("6M8146");
  });

  it("leaves AECOM and unknown work plans exactly as they are", () => {
    // 10007's scope ("B.50-03") comes from its PO schedule, not from here.
    const aecom = procasPlan("10007", "AECOM PM Support");
    expect(docWorkPlan(aecom)).toEqual(aecom);
    const other = procasPlan("90001", "Something else");
    expect(docWorkPlan(other)).toBe(other);
  });
});

describe("known headers for the other primes", () => {
  it("carries what each real invoice prints", () => {
    expect(knownHeader("10014")?.poNumber).toBe("BARTD-0000069210");
    expect(knownHeader("10014.01")?.sendToCompany).toBe("T.Y. Lin International + TSE, JV");
    expect(knownHeader("10013.TO02")?.wspProjectNo).toBe("30900569.4687");
    expect(knownHeader("10013.TO02")?.poNumber).toBe("71262");
    expect(knownHeader("10009.03")?.contactPerson).toBe("Doug Woodville");
    expect(knownHeader("10013.TO01")?.supplierId).toBe("0000003167");
  });

  it("covers sub-codes but not look-alikes", () => {
    expect(knownHeader("10009.03.00.CA")?.workPlanNo).toBe("B.55");
    expect(knownHeader("100140")).toBeNull();
  });

  it("words the agreement line the way each invoice does", () => {
    expect(agreementLine("6M8213", "10014")).toBe("6M8213 General Engineering Services");
    expect(agreementLine("6M8146", "10009.03")).toBe(
      "6M8146 – Scheduling Support for Capital Projects",
    );
    // WSP prints the bare number.
    expect(agreementLine("6M8178", "10013.TO02")).toBe("6M8178");
    // A number the biller has changed is not overridden by a stale description.
    expect(agreementLine("6M9999", "10014")).toBe("6M9999");
  });
});
