import { describe, it, expect } from "vitest";
import { bumpInvoiceNumber } from "./invoiceNumber";

describe("bumpInvoiceNumber", () => {
  it("increments the trailing suffix, keeping the prefix", () => {
    expect(bumpInvoiceNumber("A.04-02-12")).toBe("A.04-02-13");
    expect(bumpInvoiceNumber("6M8213 A.02-01-21")).toBe("6M8213 A.02-01-22");
    expect(bumpInvoiceNumber("Invoice_AZAD-9")).toBe("Invoice_AZAD-10");
  });

  it("preserves zero-padding width", () => {
    expect(bumpInvoiceNumber("INV-009")).toBe("INV-010");
    expect(bumpInvoiceNumber("INV-099")).toBe("INV-100"); // width grows past the pad
  });

  it("tolerates trailing whitespace", () => {
    expect(bumpInvoiceNumber("A.04-02-12 ")).toBe("A.04-02-13 ");
  });

  it("returns null when there's no trailing number", () => {
    expect(bumpInvoiceNumber("DRAFT")).toBeNull();
    expect(bumpInvoiceNumber("")).toBeNull();
    expect(bumpInvoiceNumber(null)).toBeNull();
    expect(bumpInvoiceNumber(undefined)).toBeNull();
  });
});
