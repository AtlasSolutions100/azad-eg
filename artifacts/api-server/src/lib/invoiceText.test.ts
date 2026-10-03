import { describe, it, expect } from "vitest";
import { toDisplayName } from "./displayName";
import { agreementLine, agreementNumber, KNOWN_INVOICE_HEADERS } from "./knownInvoiceHeaders";

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
