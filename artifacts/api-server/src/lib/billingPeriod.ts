/**
 * Derives an invoice's service period from the work plan's billing cycle, so the
 * biller no longer types the two dates by hand (a step Julie called out).
 *
 * Two cycles are in use for BART (per Julie's Procas data map; the older
 * Caltrans "D3" custom format was dropped):
 *
 *   whole_month  — the full calendar month: 1st → last day.
 *   last_friday  — BART's Sat→Fri cycle: the period ENDS on the last Friday of
 *                  the month and STARTS the day after the prior month's last
 *                  Friday (i.e. the first Saturday after it). Exception: June
 *                  is always billed through June 30, not its last Friday.
 *
 * Validated against Julie's real WSP invoice: a May 2026 "last_friday" invoice
 * covers 2026-04-25 → 2026-05-29 (April's last Friday is the 24th → start 25th;
 * May's last Friday is the 29th).
 */

export type BillingCycle = "whole_month" | "last_friday";

export interface BillingPeriod {
  start: string; // YYYY-MM-DD
  end: string; // YYYY-MM-DD
}

function iso(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Last calendar day of month `month` (1-12) in `year`. */
function lastDayOfMonth(year: number, month: number): Date {
  // Day 0 of the next month is the last day of this month.
  return new Date(Date.UTC(year, month, 0));
}

/** Last Friday (weekday 5) of month `month` (1-12) in `year`. */
export function lastFridayOfMonth(year: number, month: number): Date {
  const last = lastDayOfMonth(year, month);
  // getUTCDay: Sun=0 … Fri=5, Sat=6. Step back to the most recent Friday.
  const offset = (last.getUTCDay() - 5 + 7) % 7;
  return new Date(Date.UTC(year, month - 1, last.getUTCDate() - offset));
}

/**
 * The end-of-period cut-off for the `last_friday` cycle: normally the last
 * Friday of the month, but June is always billed through June 30.
 */
function lastFridayCutoff(year: number, month: number): Date {
  if (month === 6) return new Date(Date.UTC(year, 5, 30)); // June 30
  return lastFridayOfMonth(year, month);
}

function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * 24 * 60 * 60 * 1000);
}

/**
 * Derive the service period for the invoice covering `month`/`year` (month
 * 1-12) under `cycle`.
 */
export function deriveBillingPeriod(
  year: number,
  month: number,
  cycle: BillingCycle,
): BillingPeriod {
  if (cycle === "last_friday") {
    const end = lastFridayCutoff(year, month);
    // Start = day after the prior month's cut-off.
    const prevMonth = month === 1 ? 12 : month - 1;
    const prevYear = month === 1 ? year - 1 : year;
    const start = addDays(lastFridayCutoff(prevYear, prevMonth), 1);
    return { start: iso(start), end: iso(end) };
  }
  // whole_month
  const start = new Date(Date.UTC(year, month - 1, 1));
  const end = lastDayOfMonth(year, month);
  return { start: iso(start), end: iso(end) };
}
