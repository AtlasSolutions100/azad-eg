import { describe, it, expect } from "vitest";
import { deriveBillingPeriod, lastFridayOfMonth } from "./billingPeriod";

describe("deriveBillingPeriod", () => {
  it("whole_month → first to last calendar day", () => {
    expect(deriveBillingPeriod(2026, 5, "whole_month")).toEqual({
      start: "2026-05-01",
      end: "2026-05-31",
    });
    // February leap-year boundary.
    expect(deriveBillingPeriod(2028, 2, "whole_month")).toEqual({
      start: "2028-02-01",
      end: "2028-02-29",
    });
  });

  it("last_friday → matches Julie's real WSP May 2026 invoice (04-25 → 05-29)", () => {
    expect(deriveBillingPeriod(2026, 5, "last_friday")).toEqual({
      start: "2026-04-25",
      end: "2026-05-29",
    });
  });

  it("last_friday June exception → billed through June 30", () => {
    const june = deriveBillingPeriod(2026, 6, "last_friday");
    expect(june.end).toBe("2026-06-30");
    // Starts the day after May's last Friday (May 29 → May 30).
    expect(june.start).toBe("2026-05-30");
  });

  it("last_friday July after the June-30 exception starts July 1", () => {
    const july = deriveBillingPeriod(2026, 7, "last_friday");
    expect(july.start).toBe("2026-07-01");
  });

  it("last_friday handles the January year boundary", () => {
    const jan = deriveBillingPeriod(2026, 1, "last_friday");
    // Dec 2025 last Friday is the 26th → start Dec 27; Jan 2026 last Friday 30th.
    expect(jan.start).toBe("2025-12-27");
    expect(jan.end).toBe("2026-01-30");
  });

  it("lastFridayOfMonth is correct for a few known months", () => {
    expect(lastFridayOfMonth(2026, 5).toISOString().slice(0, 10)).toBe("2026-05-29");
    expect(lastFridayOfMonth(2026, 4).toISOString().slice(0, 10)).toBe("2026-04-24");
    expect(lastFridayOfMonth(2026, 1).toISOString().slice(0, 10)).toBe("2026-01-30");
  });
});
