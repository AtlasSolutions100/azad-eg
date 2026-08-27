/**
 * Tops a weekly timesheet up to a standard 40-hour week.
 *
 * Julie's rule, from the Aug 26 demo: "if you work less than eight hours for
 * the client, then the rest of the hours go to sick time or vacation… we can
 * make it one row so it doesn't matter if it was sick time or PTO."
 *
 * So: for each weekday inside the billing period, whatever is short of eight
 * hours becomes a single combined PTO/Sick row. Two deliberate limits keep the
 * result honest, because a timesheet is a certified document:
 *
 *   1. Only days that fall inside the package's pay period are filled. A week
 *      that overlaps the period by two days must not sprout three phantom PTO
 *      days.
 *   2. A day is only topped up if the employee already charged SOMETHING that
 *      day. Azad staff split time across projects, and Procas only feeds this
 *      project's hours — so a day with nothing here is far more likely to be a
 *      day spent on another job than a day off. Filling those would invent PTO
 *      the person never took. `fillEmptyDays` opts into the looser reading for
 *      single-project staff.
 *
 * The fill is always $0 to the client (PTO bills at zero), so this changes what
 * the timesheet *shows*, never what the invoice charges.
 */

export const STANDARD_DAY_HOURS = 8;

/** Mon-first day offsets, matching the hours* columns on a timesheet entry. */
export const DAY_FIELDS = [
  "hoursMon",
  "hoursTue",
  "hoursWed",
  "hoursThu",
  "hoursFri",
  "hoursSat",
  "hoursSun",
] as const;

export type DayField = (typeof DAY_FIELDS)[number];

/** Only weekdays are topped up to eight hours. */
const WEEKDAY_FIELDS: readonly DayField[] = DAY_FIELDS.slice(0, 5);

export type DayHours = Record<DayField, number>;

export interface PtoFillEntry {
  category: string;
  hoursMon: number;
  hoursTue: number;
  hoursWed: number;
  hoursThu: number;
  hoursFri: number;
  hoursSat: number;
  hoursSun: number;
}

export interface PtoFillOptions {
  /** Monday of the week being filled (YYYY-MM-DD). */
  weekStart: string;
  /** Package pay period; days outside it are never filled. */
  periodStart?: string | null;
  periodEnd?: string | null;
  /** Standard working day, in hours. */
  standardDayHours?: number;
  /**
   * Fill weekdays on which the employee charged nothing to this project. Off by
   * default: an empty day usually means "worked elsewhere", not "took PTO".
   */
  fillEmptyDays?: boolean;
}

function emptyDays(): DayHours {
  return {
    hoursMon: 0,
    hoursTue: 0,
    hoursWed: 0,
    hoursThu: 0,
    hoursFri: 0,
    hoursSat: 0,
    hoursSun: 0,
  };
}

/** `weekStart` plus `offset` days, as YYYY-MM-DD. */
function dayIso(weekStart: string, offset: number): string {
  const [y, m, d] = weekStart.split("-").map(Number);
  const base = Date.UTC(y, m - 1, d);
  const dt = new Date(base + offset * 24 * 60 * 60 * 1000);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(
    dt.getUTCDate(),
  ).padStart(2, "0")}`;
}

/**
 * The PTO/Sick hours to add per day so each in-period weekday reaches a full
 * day. Returns null when nothing needs topping up.
 */
export function computePtoFill(
  entries: readonly PtoFillEntry[],
  opts: PtoFillOptions,
): DayHours | null {
  const standard = opts.standardDayHours ?? STANDARD_DAY_HOURS;
  if (standard <= 0) return null;

  const fill = emptyDays();
  let any = false;

  for (let i = 0; i < WEEKDAY_FIELDS.length; i++) {
    const field = WEEKDAY_FIELDS[i];

    // Days outside the pay period belong to a different invoice.
    const iso = dayIso(opts.weekStart, i);
    if (opts.periodStart && iso < opts.periodStart) continue;
    if (opts.periodEnd && iso > opts.periodEnd) continue;

    // Every category counts toward the eight hours — billable work, existing
    // PTO, holiday, and the internal G&A/B&P codes that Procas classifies as
    // non-billable. Otherwise a day already accounted for would be filled twice.
    let charged = 0;
    for (const e of entries) charged += Number(e[field]) || 0;

    if (charged <= 0 && !opts.fillEmptyDays) continue;
    const short = standard - charged;
    if (short <= 0) continue;

    // Guard against float dust (7.999999 → 8).
    const rounded = Math.round(short * 100) / 100;
    if (rounded <= 0) continue;
    fill[field] = rounded;
    any = true;
  }

  return any ? fill : null;
}

/** Total hours across a day map. */
export function totalDayHours(days: DayHours): number {
  return Math.round(DAY_FIELDS.reduce((s, f) => s + (days[f] || 0), 0) * 100) / 100;
}
