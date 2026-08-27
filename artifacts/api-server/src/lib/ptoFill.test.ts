import { describe, it, expect } from "vitest";
import { computePtoFill, totalDayHours, type PtoFillEntry } from "./ptoFill";

const entry = (partial: Partial<PtoFillEntry>): PtoFillEntry => ({
  category: "regular",
  hoursMon: 0,
  hoursTue: 0,
  hoursWed: 0,
  hoursThu: 0,
  hoursFri: 0,
  hoursSat: 0,
  hoursSun: 0,
  ...partial,
});

// Week of Mon 2026-06-01 … Sun 2026-06-07.
const WEEK = "2026-06-01";

describe("40-hour PTO/Sick top-up", () => {
  it("tops each short weekday up to eight hours", () => {
    // Julie's example: 30 hours worked across five days.
    const entries = [
      entry({ hoursMon: 6, hoursTue: 6, hoursWed: 6, hoursThu: 6, hoursFri: 6 }),
    ];
    const fill = computePtoFill(entries, { weekStart: WEEK });
    expect(fill).not.toBeNull();
    expect(fill).toMatchObject({
      hoursMon: 2,
      hoursTue: 2,
      hoursWed: 2,
      hoursThu: 2,
      hoursFri: 2,
    });
    expect(totalDayHours(fill!)).toBe(10); // 30 worked + 10 PTO = 40
  });

  it("returns null when the week is already full", () => {
    const entries = [
      entry({ hoursMon: 8, hoursTue: 8, hoursWed: 8, hoursThu: 8, hoursFri: 8 }),
    ];
    expect(computePtoFill(entries, { weekStart: WEEK })).toBeNull();
  });

  it("never fills weekends", () => {
    const entries = [
      entry({ hoursMon: 8, hoursTue: 8, hoursWed: 8, hoursThu: 8, hoursFri: 8, hoursSat: 2 }),
    ];
    const fill = computePtoFill(entries, { weekStart: WEEK });
    // Saturday worked 2h but is not topped up to 8, and nothing else is short.
    expect(fill).toBeNull();
  });

  it("counts every category toward the eight hours, not just billable work", () => {
    // 4h billable + 4h holiday already makes a full day — no top-up.
    const entries = [
      entry({ category: "regular", hoursMon: 4 }),
      entry({ category: "holiday", hoursMon: 4 }),
    ];
    expect(computePtoFill(entries, { weekStart: WEEK })).toBeNull();
  });

  it("sums multiple rows on the same day before deciding the shortfall", () => {
    const entries = [
      entry({ category: "regular", hoursTue: 3 }),
      entry({ category: "regular", hoursTue: 2 }),
    ];
    const fill = computePtoFill(entries, { weekStart: WEEK });
    expect(fill?.hoursTue).toBe(3);
  });

  it("does not top up overtime days", () => {
    const entries = [entry({ hoursWed: 10 })];
    expect(computePtoFill(entries, { weekStart: WEEK })).toBeNull();
  });

  // A week straddling the period boundary must not sprout phantom PTO for days
  // that belong to the previous or next invoice.
  it("only fills days inside the pay period", () => {
    const entries = [entry({ hoursThu: 5, hoursFri: 5 })];
    const fill = computePtoFill(entries, {
      weekStart: WEEK, // Mon Jun 1
      periodStart: "2026-06-04", // period opens Thursday
    });
    expect(fill).toMatchObject({ hoursThu: 3, hoursFri: 3 });
    expect(fill?.hoursMon).toBe(0);
    expect(fill?.hoursTue).toBe(0);
    expect(fill?.hoursWed).toBe(0);
  });

  it("respects the end of the pay period too", () => {
    const entries = [entry({ hoursMon: 4, hoursTue: 4, hoursWed: 4 })];
    const fill = computePtoFill(entries, {
      weekStart: WEEK,
      periodEnd: "2026-06-02", // period closes Tuesday
    });
    expect(fill).toMatchObject({ hoursMon: 4, hoursTue: 4 });
    expect(fill?.hoursWed).toBe(0);
  });

  // Azad staff split time across projects and Procas only feeds this project's
  // hours, so a day with nothing charged here is probably a day worked
  // elsewhere — not a day off.
  it("skips weekdays with no hours charged to this project by default", () => {
    const entries = [entry({ hoursMon: 8, hoursTue: 8 })];
    const fill = computePtoFill(entries, { weekStart: WEEK });
    expect(fill).toBeNull();
  });

  it("fills empty weekdays when explicitly opted in", () => {
    const entries = [entry({ hoursMon: 8, hoursTue: 8 })];
    const fill = computePtoFill(entries, { weekStart: WEEK, fillEmptyDays: true });
    expect(fill).toMatchObject({ hoursWed: 8, hoursThu: 8, hoursFri: 8 });
    expect(totalDayHours(fill!)).toBe(24);
  });

  it("honours a non-standard working day", () => {
    const entries = [entry({ hoursMon: 4 })];
    const fill = computePtoFill(entries, { weekStart: WEEK, standardDayHours: 6 });
    expect(fill?.hoursMon).toBe(2);
  });

  it("shrugs off floating-point dust", () => {
    const entries = [entry({ hoursMon: 7.999999999 })];
    expect(computePtoFill(entries, { weekStart: WEEK })).toBeNull();
  });

  it("handles a week with no entries at all", () => {
    expect(computePtoFill([], { weekStart: WEEK })).toBeNull();
    const fill = computePtoFill([], { weekStart: WEEK, fillEmptyDays: true });
    expect(totalDayHours(fill!)).toBe(40);
  });

  it("crosses a month boundary correctly when checking the period", () => {
    // Week of Mon 2026-06-29 runs into July.
    const entries = [entry({ hoursMon: 5, hoursTue: 5, hoursWed: 5 })];
    const fill = computePtoFill(entries, {
      weekStart: "2026-06-29",
      periodEnd: "2026-06-30", // June invoice stops on the 30th (Tuesday)
    });
    expect(fill).toMatchObject({ hoursMon: 3, hoursTue: 3 });
    expect(fill?.hoursWed).toBe(0); // July 1 belongs to the next invoice
  });
});
