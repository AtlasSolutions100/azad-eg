import { describe, it, expect } from "vitest";
import { clientFileBase, knownBillingCycle, registerEntry, seededInvoiceNumber } from "./invoiceRegister";

/**
 * Julie's own register: `Procas _ Azad Dashboard.xlsx`, tabs "Invoice Numbers
 * and naming conv" and "Billing Periods".
 */
describe("billing period type, per her sheet", () => {
  it("bills AECOM, Parsons and WSP on BART's last-Friday cycle", () => {
    for (const project of ["10007", "10009.02", "10009.03", "10013.TO01", "10013.TO03"]) {
      expect(knownBillingCycle(project), project).toBe("last_friday");
    }
  });

  it("bills T.Y. Lin to the last day of the month — NOT last Friday", () => {
    // Making last-Friday the default for every imported work plan was wrong
    // for exactly this row.
    expect(knownBillingCycle("10014")).toBe("whole_month");
    expect(knownBillingCycle("10014.01")).toBe("whole_month");
  });

  it("covers a project's Procas sub-codes, and nothing that merely starts alike", () => {
    expect(knownBillingCycle("10007.00.00.00.CA")).toBe("last_friday");
    expect(knownBillingCycle("100070")).toBeNull();
    expect(registerEntry("  10007  ")).toBeTruthy();
  });

  it("says nothing about work plans the sheet gives no period type for", () => {
    // Caltrans, SFCTA, VTA, City of Oakland — blank in her sheet.
    for (const project of ["10011.06", "10015.TO3A", "10027", "10017.02", "90001"]) {
      expect(knownBillingCycle(project), project).toBeNull();
    }
    expect(knownBillingCycle(null, undefined, "")).toBeNull();
  });
});

describe("invoice number series, seeded from her July numbers", () => {
  it("advances one per billing month", () => {
    expect(seededInvoiceNumber(["10007"], "2026-07-31")).toBe("B.50-01-31");
    expect(seededInvoiceNumber(["10007"], "2026-08-28")).toBe("B.50-01-32");
    expect(seededInvoiceNumber(["10007"], "2026-09-25")).toBe("B.50-01-33");
    expect(seededInvoiceNumber(["10007"], "2027-01-29")).toBe("B.50-01-37");
  });

  it("keeps each prime's own numbering shape", () => {
    expect(seededInvoiceNumber(["10014"], "2026-08-31")).toBe("6M8213 A.02-01-22");
    expect(seededInvoiceNumber(["10013.TO01"], "2026-08-28")).toBe("A.03.01-25");
    expect(seededInvoiceNumber(["10009.03"], "2026-08-28")).toBe("B.55-11");
  });

  it("does not guess backwards, or for a project it has no number for", () => {
    expect(seededInvoiceNumber(["10007"], "2026-06-30")).toBeNull();
    expect(seededInvoiceNumber(["90001"], "2026-08-28")).toBeNull();
  });
});

describe("sent-file name", () => {
  it("names the AECOM invoice the way she sends it", () => {
    // July in her sheet: "07-2026-BART6M8142-AECOM-B.50-01 Invoice_AZAD-31".
    expect(clientFileBase(["10007"], "2026-07-31", "B.50-01-31")).toBe(
      "07-2026-BART6M8142-AECOM-B.50-01 Invoice_AZAD-31",
    );
    expect(clientFileBase(["10007"], "2026-08-28", "B.50-01-32")).toBe(
      "08-2026-BART6M8142-AECOM-B.50-01 Invoice_AZAD-32",
    );
  });

  it("names T.Y. Lin's and Imani's the way their June invoices were sent", () => {
    // The register leaves these two blank; the names are her June files'.
    expect(clientFileBase(["10014"], "2026-08-31", "6M8213 A.02-01-22")).toBe(
      "08-2026-BART6M8213-T.Y.Lin-A.02-01_02-Invoice_AZAD-22",
    );
    expect(clientFileBase(["10013.TO02"], "2026-08-28", "A.05.01-18")).toBe(
      "08-2026-BART6M8178-WSP-A.05.01-Invoice_AZAD-18",
    );
  });

  it("falls back when it has no template or no number to put in it", () => {
    expect(clientFileBase(["10099"], "2026-08-31", "X-22")).toBeNull();
    expect(clientFileBase(["10007"], "2026-08-28", null)).toBeNull();
    expect(clientFileBase(["10007"], "2026-08-28", "TBD")).toBeNull();
  });
});
