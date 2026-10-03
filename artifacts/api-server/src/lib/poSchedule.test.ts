import { describe, it, expect } from "vitest";
import {
  KNOWN_PO_SCHEDULES,
  allocateAcrossPoLines,
  allocateCurrent,
  knownPoSchedule,
  splitProRata,
} from "./poSchedule";

const sum = (xs: number[]) => Math.round(xs.reduce((a, b) => a + b, 0) * 100) / 100;

/**
 * Ground truth: Julie's real AECOM invoice B.50-01-30 (June 2026), cover page.
 * Previously billed $1,135,877.49, this invoice $31,692.46, ten PO lines.
 */
describe("Billed Line Items — reproduces Julie's June invoice", () => {
  const schedule = KNOWN_PO_SCHEDULES["10007"];
  const rows = allocateAcrossPoLines(schedule, 1135877.49, 31692.46);

  it("carries a PO schedule whose amounts sum to the work plan budget", () => {
    expect(schedule).toHaveLength(10);
    expect(sum(schedule.map((l) => l.poAmount))).toBe(1381971.85);
  });

  it("splits this invoice across the scope being billed exactly as she did", () => {
    // Her "Current Invoiced Amount" column, rows B.50-03 lines 1-5.
    expect(rows.slice(5).map((r) => r.currentInvoiced)).toEqual([
      8556.96, 11092.36, 5704.64, 3169.25, 3169.25,
    ]);
    // Closed scopes take nothing this period.
    expect(rows.slice(0, 5).every((r) => r.currentInvoiced === 0)).toBe(true);
  });

  it("holds closed scopes at their PO amount and shares the rest pro rata", () => {
    // B.50-01 and B.50-02 are fully billed: Previous Invoiced = PO Amount.
    for (const r of rows.slice(0, 5)) expect(r.previousInvoiced).toBe(r.poAmount);
    // B.50-03 on her invoice: 48,847.83 / 63,321.28 / 32,565.23 / 18,091.79 /
    // 18,091.80. Hers carries a one-cent quirk on a closed line (179,582.84
    // against a 179,582.83 PO), so each of ours may sit a cent from hers.
    const hers = [48847.83, 63321.28, 32565.23, 18091.79, 18091.8];
    rows.slice(5).forEach((r, i) => expect(Math.abs(r.previousInvoiced - hers[i])).toBeLessThanOrEqual(0.011));
  });

  it("ties out: the columns sum to exactly what was billed", () => {
    expect(sum(rows.map((r) => r.previousInvoiced))).toBe(1135877.49);
    expect(sum(rows.map((r) => r.currentInvoiced))).toBe(31692.46);
  });
});

describe("allocateAcrossPoLines — edges", () => {
  const lines = [
    { workScopeNo: "A", poNo: "1", lineNo: 1, bartProjectNo: null, poAmount: 100 },
    { workScopeNo: "B", poNo: "1", lineNo: 1, bartProjectNo: null, poAmount: 60 },
    { workScopeNo: "B", poNo: "1", lineNo: 2, bartProjectNo: null, poAmount: 40 },
  ];

  it("bills the first scope when nothing has been billed yet", () => {
    const rows = allocateAcrossPoLines(lines, 0, 10);
    expect(rows.map((r) => r.previousInvoiced)).toEqual([0, 0, 0]);
    expect(rows.map((r) => r.currentInvoiced)).toEqual([10, 0, 0]);
  });

  it("moves to the next scope once the first is fully billed", () => {
    const rows = allocateAcrossPoLines(lines, 130, 10);
    expect(rows.map((r) => r.previousInvoiced)).toEqual([100, 18, 12]);
    expect(rows.map((r) => r.currentInvoiced)).toEqual([0, 6, 4]);
  });

  it("puts an overrun on the last scope rather than losing it", () => {
    const rows = allocateAcrossPoLines(lines, 250, 10);
    expect(sum(rows.map((r) => r.previousInvoiced))).toBe(250);
    expect(sum(rows.map((r) => r.currentInvoiced))).toBe(10);
    expect(rows[0].previousInvoiced).toBe(100);
  });
});

describe("splitProRata", () => {
  it("always sums to the amount, with the residue on the last line", () => {
    const parts = splitProRata(100, [1, 1, 1]);
    expect(parts).toEqual([33.33, 33.33, 33.34]);
    expect(sum(parts)).toBe(100);
  });
});

describe("allocateCurrent — carried-forward rows", () => {
  it("bills the first scope that still has balance", () => {
    const rows = [
      { workScopeNo: "A", poNo: null, lineNo: 1, bartProjectNo: null, poAmount: 100, previousInvoiced: 100 },
      { workScopeNo: "B", poNo: null, lineNo: 1, bartProjectNo: null, poAmount: 60, previousInvoiced: 30 },
      { workScopeNo: "B", poNo: null, lineNo: 2, bartProjectNo: null, poAmount: 40, previousInvoiced: 20 },
    ];
    expect(allocateCurrent(rows, 10)).toEqual([0, 6, 4]);
  });
});

describe("knownPoSchedule", () => {
  it("matches on the Procas project or the job number, and nothing else", () => {
    expect(knownPoSchedule(null, "10007")).toBe(KNOWN_PO_SCHEDULES["10007"]);
    expect(knownPoSchedule(" 10007 ")).toBe(KNOWN_PO_SCHEDULES["10007"]);
    expect(knownPoSchedule("10014", undefined)).toBeNull();
  });
});
