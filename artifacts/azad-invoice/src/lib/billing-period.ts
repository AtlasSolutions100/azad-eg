/**
 * Client-side mirror of the server's service-period derivation
 * (artifacts/api-server/src/lib/billingPeriod.ts — the source of truth, which
 * re-derives whenever a package is created from a billingMonth instead of
 * explicit dates). Kept in sync deliberately: the wizard shows the biller the
 * two dates it is about to send, so it must compute them the same way.
 *
 *   whole_month  — the full calendar month: 1st → last day.
 *   last_friday  — BART's Sat→Fri cycle: the period ENDS on the last Friday of
 *                  the month and STARTS the day after the prior month's last
 *                  Friday. Exception: June always bills through June 30.
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
  return new Date(Date.UTC(year, month, 0));
}

/** Last Friday (weekday 5) of month `month` (1-12) in `year`. */
function lastFridayOfMonth(year: number, month: number): Date {
  const last = lastDayOfMonth(year, month);
  const offset = (last.getUTCDay() - 5 + 7) % 7;
  return new Date(Date.UTC(year, month - 1, last.getUTCDate() - offset));
}

/** Cut-off for `last_friday`: last Friday, except June bills through June 30. */
function lastFridayCutoff(year: number, month: number): Date {
  if (month === 6) return new Date(Date.UTC(year, 5, 30));
  return lastFridayOfMonth(year, month);
}

function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * 24 * 60 * 60 * 1000);
}

/** Service period for the invoice covering `month` (1-12) of `year`. */
export function deriveBillingPeriod(
  year: number,
  month: number,
  cycle: BillingCycle,
): BillingPeriod {
  if (cycle === "last_friday") {
    const end = lastFridayCutoff(year, month);
    const prevMonth = month === 1 ? 12 : month - 1;
    const prevYear = month === 1 ? year - 1 : year;
    const start = addDays(lastFridayCutoff(prevYear, prevMonth), 1);
    return { start: iso(start), end: iso(end) };
  }
  const start = new Date(Date.UTC(year, month - 1, 1));
  const end = lastDayOfMonth(year, month);
  return { start: iso(start), end: iso(end) };
}

export const BILLING_CYCLE_LABELS: Record<BillingCycle, string> = {
  whole_month: "Last day of the month (whole calendar month)",
  last_friday: "Last Friday of the month (Sat→Fri cycle)",
};
