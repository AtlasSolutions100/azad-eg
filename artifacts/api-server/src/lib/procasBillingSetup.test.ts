import { describe, expect, it } from "vitest";
import { billedBeforePeriod, effectiveBillingAccount } from "./procasSync";
import { formPrime, knownHeader, KNOWN_INVOICE_HEADERS } from "./knownInvoiceHeaders";
import { burdenOnFringeLine } from "./billingProfile";
import { burdenMultiplier } from "./procasPackageSync";

/**
 * Procas's Billing Setup for project 10007, as the feed returned it on
 * 2026-10-05: one account per date range, oldest first.
 */
const ACCOUNTS_10007 = [
  { Project: "10007", BillingAccountDesc: "Direct Time - Field", OverheadPercent: 1.09, FeePercent: 0.08, BillingDateBeginning: "2024-01-07", BillingDateEnding: "2025-02-28" },
  { Project: "10007", BillingAccountDesc: "Direct Time - Field Unbillable", BillingDateBeginning: "2024-01-07", BillingDateEnding: "2025-02-28" },
  { Project: "10007", BillingAccountDesc: "Direct Time - Field", OverheadPercent: 1.09, FeePercent: 0.08, BillingDateBeginning: "2025-03-01", BillingDateEnding: "2025-10-31" },
  { Project: "10007", BillingAccountDesc: "Direct Time - Field", OverheadPercent: 1.2058, BillingDateBeginning: "2025-11-01", BillingDateEnding: "2025-11-16" },
  { Project: "10007", BillingAccountDesc: "Direct Time - Field", OverheadPercent: 1.2058, FeePercent: 0.08, FacilitiesPercent: 0.0039, BillingDateBeginning: "2025-11-17", BillingDateEnding: "2026-06-07" },
  { Project: "10007", BillingAccountDesc: "Direct Time - Field", OverheadPercent: 1.2058, FeePercent: 0.08, FacilitiesPercent: 0.0039, BillingDateBeginning: "2026-06-08", BillingDateEnding: "9999-12-31" },
];

describe("the Billing Setup account in force", () => {
  it("is the current row, not the first one Procas lists", () => {
    // The first row is 2024's 109% overhead with no FCCM. Julie's June 2026
    // invoice — and Procas's own billing history — use 120.58% and 0.39%.
    const acct = effectiveBillingAccount(ACCOUNTS_10007, new Date("2026-10-05T12:00:00Z"))!;
    expect(acct.OverheadPercent).toBe(1.2058);
    expect(acct.FacilitiesPercent).toBe(0.0039);
    expect(acct.BillingDateBeginning).toBe("2026-06-08");
  });

  it("follows the date ranges", () => {
    expect(effectiveBillingAccount(ACCOUNTS_10007, new Date("2025-06-15T12:00:00Z"))!.OverheadPercent).toBe(1.09);
    expect(effectiveBillingAccount(ACCOUNTS_10007, new Date("2025-11-10T12:00:00Z"))!.BillingDateEnding).toBe("2025-11-16");
  });

  it("never picks the unbillable or subcontract account over the labor one", () => {
    const rows = [
      { Project: "X", BillingAccountDesc: "Direct Subcontracts Time - Field", BillingDateBeginning: "2026-04-01", BillingDateEnding: "9999-12-31" },
      { Project: "X", BillingAccountDesc: "Direct Time - Field", OverheadPercent: 1.2058, BillingDateBeginning: "2026-04-01", BillingDateEnding: "9999-12-31" },
    ];
    expect(effectiveBillingAccount(rows)!.OverheadPercent).toBe(1.2058);
  });

  it("falls back to the latest row when none is in force, and to nothing when there are none", () => {
    const ended = ACCOUNTS_10007.slice(0, 3);
    expect(effectiveBillingAccount(ended, new Date("2026-10-05T12:00:00Z"))!.BillingDateBeginning).toBe("2025-03-01");
    expect(effectiveBillingAccount([])).toBeUndefined();
    // A row with no dates at all (the shape the older tests use) is still found.
    expect(effectiveBillingAccount([{ Project: "Y", OverheadPercent: 1.09 }])!.OverheadPercent).toBe(1.09);
  });
});

describe("previously billed", () => {
  // Procas billing history for 10007 around the August 2026 package.
  const july = { InvoiceNumber: "B.50-01-31", CurrentPeriodBegDate: "2026-07-01T00:00:00-04:00", CurrentPeriodEndDate: "2026-07-31T00:00:00-04:00" };
  const august = { InvoiceNumber: "B.50-01-32", CurrentPeriodBegDate: "2026-08-01T00:00:00-04:00", CurrentPeriodEndDate: "2026-08-28T00:00:00-04:00" };

  it("counts the periods before this one, and not this period's own invoice", () => {
    // Once Procas has posted August, an August package must not call it "previous".
    expect(billedBeforePeriod(july, "2026-08-01")).toBe(true);
    expect(billedBeforePeriod(august, "2026-08-01")).toBe(false);
  });

  it("treats a row with no period as earlier history", () => {
    expect(billedBeforePeriod({ InvoiceNumber: "old" }, "2026-08-01")).toBe(true);
  });
});

describe("which invoice form a package is built on", () => {
  it("is the work plan's, whatever was or was not typed on the package", () => {
    expect(formPrime({ typed: null, keys: ["10014"] })).toBe("T.Y. Lin");
    expect(formPrime({ typed: "", keys: ["10013.TO01"] })).toBe("WSP");
    expect(formPrime({ typed: null, keys: [null, "10009.02"] })).toBe("Parsons");
    expect(formPrime({ typed: null, keys: ["10007"] })).toBe("AECOM");
    // A prime carried over from another work plan's package does not win.
    expect(formPrime({ typed: "AECOM", keys: ["10014"] })).toBe("T.Y. Lin");
    // Procas leaf codes belong to their work plan.
    expect(formPrime({ typed: null, keys: ["10014.01.01.0.CA"] })).toBe("T.Y. Lin");
  });

  it("keeps what the biller typed for a work plan we hold no invoice for", () => {
    expect(formPrime({ typed: "Azad (we are the prime)", keys: ["10099"], client: "WSP-BART CM" })).toBe(
      "Azad (we are the prime)",
    );
  });

  it("reads the client's name when nothing was typed", () => {
    expect(formPrime({ keys: ["10099"], client: "WSP-BART CM" })).toBe("WSP");
    expect(formPrime({ keys: ["10099"], client: "T.Y. Lin International + TSE" })).toBe("T.Y. Lin");
    expect(formPrime({ keys: ["10099"], client: "Parsons Transportation Group Inc" })).toBe("Parsons");
    expect(formPrime({ keys: ["10099"], client: "City of Oakland" })).toBeNull();
  });
});

describe("the burden on her invoices", () => {
  it("is recorded for every BART work plan, with its labor billed under Field", () => {
    for (const [project, header] of Object.entries(KNOWN_INVOICE_HEADERS)) {
      expect(header.burden, project).toBeDefined();
      expect(header.prime, project).toBeDefined();
      expect(header.laborLocation, project).toBe("field");
    }
    // Same total burden for AECOM, WSP and Parsons; T.Y. Lin has no FCCM.
    expect(burdenMultiplier(knownHeader("10007")!.burden!)).toBeCloseTo(2.386164, 6);
    expect(burdenMultiplier(knownHeader("10013.TO02")!.burden!)).toBeCloseTo(2.386164, 6);
    expect(burdenMultiplier(knownHeader("10009.03")!.burden!)).toBeCloseTo(2.386164, 6);
    expect(burdenMultiplier(knownHeader("10014")!.burden!)).toBeCloseTo(2.382264, 6);
  });

  it("prints on the Fringe line for the forms that have no overhead of their own", () => {
    // Procas files WSP's 120.58% under overhead; her form shows it as fringe.
    expect(burdenOnFringeLine({ fringeRate: 0, overheadRate: 120.58 })).toEqual({ fringeFrac: 1.2058, overheadFrac: 0 });
    expect(burdenOnFringeLine({ fringeRate: 120.58, overheadRate: 0 })).toEqual({ fringeFrac: 1.2058, overheadFrac: 0 });
    expect(burdenOnFringeLine({ fringeRate: 120.58, overheadRate: null })).toEqual({ fringeFrac: 1.2058, overheadFrac: 0 });
    // A work plan with both keeps both.
    expect(burdenOnFringeLine({ fringeRate: 30, overheadRate: 90 })).toEqual({ fringeFrac: 0.3, overheadFrac: 0.9 });
  });
});
