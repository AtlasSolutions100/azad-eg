import { describe, it, expect } from "vitest";
import type { BilledLineItemRow } from "@workspace/db";
import { effectiveBilledLineItems } from "./billedLineItems";

const sum = (xs: number[]) => Math.round(xs.reduce((a, b) => a + b, 0) * 100) / 100;

function row(over: Partial<BilledLineItemRow>): BilledLineItemRow {
  return {
    id: 1,
    packageId: 9,
    workScopeNo: "B.50-03",
    poNo: "1638681",
    lineNo: 1,
    bartProjectNo: "15NL004/PJMGT",
    poAmount: 100,
    previousInvoiced: 0,
    currentInvoiced: 0,
    sortOrder: 0,
    source: "carry_forward",
    ...over,
  };
}

/**
 * The cover's Billed Line Items table printed EMPTY on the AECOM invoice — a
 * row of dashes for the total — because rows only ever came from being typed in
 * or carried forward from an approved package, and work plan 10007 had neither.
 */
describe("effectiveBilledLineItems", () => {
  it("fills the table from the PO schedule when a package has no rows", () => {
    const rows = effectiveBilledLineItems([], {
      packageId: 32,
      scheduleKeys: ["10007"],
      previouslyBilled: 1230254.44,
      totalThisPeriod: 26725.25,
    });
    expect(rows).toHaveLength(10);
    expect(sum(rows.map((r) => r.poAmount))).toBe(1381971.85);
    expect(sum(rows.map((r) => r.previousInvoiced))).toBe(1230254.44);
    expect(sum(rows.map((r) => r.currentInvoiced))).toBe(26725.25);
    // This invoice bills the open scope only.
    expect(rows.filter((r) => r.currentInvoiced > 0).every((r) => r.workScopeNo === "B.50-03")).toBe(true);
    // Computed rows are marked as such and are not real ids.
    expect(rows.every((r) => r.id < 0 && r.source === "po_schedule")).toBe(true);
  });

  it("leaves the table empty for a work plan it has no schedule for", () => {
    expect(
      effectiveBilledLineItems([], {
        packageId: 1,
        scheduleKeys: ["10014", null],
        previouslyBilled: 5,
        totalThisPeriod: 5,
      }),
    ).toEqual([]);
  });

  it("shares this invoice across carried-forward rows nobody has filled in", () => {
    const rows = effectiveBilledLineItems(
      [
        row({ id: 1, workScopeNo: "A", poAmount: 100, previousInvoiced: 100 }),
        row({ id: 2, workScopeNo: "B", poAmount: 60, previousInvoiced: 30 }),
        row({ id: 3, workScopeNo: "B", poAmount: 40, previousInvoiced: 20 }),
      ],
      { packageId: 9, scheduleKeys: [], previouslyBilled: 150, totalThisPeriod: 10 },
    );
    expect(rows.map((r) => r.currentInvoiced)).toEqual([0, 6, 4]);
    // Previous Invoiced was carried forward and is not recomputed.
    expect(rows.map((r) => r.previousInvoiced)).toEqual([100, 30, 20]);
  });

  it("never touches rows the biller has edited", () => {
    const stored = [
      row({ id: 1, source: "manual", previousInvoiced: 10, currentInvoiced: 0 }),
      row({ id: 2, source: "carry_forward", previousInvoiced: 10, currentInvoiced: 0 }),
    ];
    const rows = effectiveBilledLineItems(stored, {
      packageId: 9,
      scheduleKeys: ["10007"],
      previouslyBilled: 20,
      totalThisPeriod: 50,
    });
    expect(rows).toBe(stored);
  });

  it("keeps amounts already typed into carried-forward rows", () => {
    const stored = [row({ id: 1, currentInvoiced: 7 }), row({ id: 2, currentInvoiced: 0 })];
    expect(
      effectiveBilledLineItems(stored, {
        packageId: 9,
        scheduleKeys: [],
        previouslyBilled: 0,
        totalThisPeriod: 50,
      }),
    ).toBe(stored);
  });
});
