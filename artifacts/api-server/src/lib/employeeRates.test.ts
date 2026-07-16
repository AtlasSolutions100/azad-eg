import { describe, it, expect } from "vitest";
import { effectiveRate, rateChangeInForce } from "./employeeRates";
import type { EmployeeRateChange } from "@workspace/db";

const rc = (
  id: number,
  effectiveDate: string,
  homeRate: number,
  fieldRate: number | null = null,
): EmployeeRateChange => ({
  id,
  employeeId: 1,
  effectiveDate,
  homeRate,
  fieldRate,
  createdAt: new Date("2026-01-01T00:00:00Z"),
});

const emp = { homeRate: 100, fieldRate: 110 };

describe("rateChangeInForce", () => {
  it("returns null before the earliest change", () => {
    expect(rateChangeInForce([rc(1, "2026-06-15", 120)], "2026-06-14")).toBeNull();
  });

  it("is inclusive of the effective date", () => {
    expect(rateChangeInForce([rc(1, "2026-06-15", 120)], "2026-06-15")?.id).toBe(1);
  });

  it("picks the latest change on/before the date", () => {
    const changes = [rc(1, "2026-01-01", 105), rc(2, "2026-06-15", 120), rc(3, "2026-09-01", 130)];
    expect(rateChangeInForce(changes, "2026-07-01")?.id).toBe(2);
    expect(rateChangeInForce(changes, "2026-09-01")?.id).toBe(3);
  });
});

describe("effectiveRate", () => {
  it("uses base rates before any change", () => {
    expect(effectiveRate(emp, [rc(1, "2026-06-15", 120, 125)], "home", "2026-06-01")).toBe(100);
    expect(effectiveRate(emp, [rc(1, "2026-06-15", 120, 125)], "field", "2026-06-01")).toBe(110);
  });

  it("uses the change's rates from its effective date onward", () => {
    expect(effectiveRate(emp, [rc(1, "2026-06-15", 120, 125)], "home", "2026-06-15")).toBe(120);
    expect(effectiveRate(emp, [rc(1, "2026-06-15", 120, 125)], "field", "2026-07-01")).toBe(125);
  });

  it("falls back to the change's home rate when it has no field rate", () => {
    expect(effectiveRate(emp, [rc(1, "2026-06-15", 120)], "field", "2026-07-01")).toBe(120);
  });

  it("falls back to base home rate for field before changes when fieldRate is null", () => {
    expect(effectiveRate({ homeRate: 100, fieldRate: null }, [], "field", "2026-06-01")).toBe(100);
  });

  it("mid-period change yields old rate for early weeks and new rate for later weeks", () => {
    const changes = [rc(1, "2026-06-15", 120)];
    // Week starting before the change → old rate; week on/after → new rate.
    expect(effectiveRate(emp, changes, "home", "2026-06-08")).toBe(100);
    expect(effectiveRate(emp, changes, "home", "2026-06-15")).toBe(120);
    expect(effectiveRate(emp, changes, "home", "2026-06-22")).toBe(120);
  });
});
