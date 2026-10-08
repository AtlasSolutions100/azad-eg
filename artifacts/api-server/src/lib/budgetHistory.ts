/**
 * A work plan's budget over time.
 *
 * A budget is not one number for the life of a work plan: BART raises it, and
 * the invoices sent before the raise were sent against the old one. The app
 * held a single figure, so the day a biller entered October's increase every
 * earlier invoice was restated against it ("I edited the budget for this
 * invoice for the October invoice, and I see it changed the invoice amount for
 * the September invoice").
 *
 * So a budget can carry the date it took effect. `work_plans.budget_history`
 * holds the versions as JSON, each with the first day it applies to (`from`;
 * null for the one in force from the start), and an invoice is stated against
 * the latest version that had begun by the end of its billing period.
 *
 * A work plan nobody has dated a change on has no history at all: its budget
 * is the columns it always was (total_budget, budget_labor, …), for every
 * period. Those columns always hold the latest version, so everything that
 * reads "the work plan's budget" without a period in mind — the dashboard, the
 * Work Plan screen, the Procas comparison — keeps reading the current one.
 */
export interface BudgetVersion {
  /** First day this budget applies to (YYYY-MM-DD); null = from the start. */
  from: string | null;
  total: number;
  /** The budget by cost category, as the detail page's Budget column prints it. */
  labor: number | null;
  overhead: number | null;
  fixedFee: number | null;
  fccm: number | null;
}

export interface BudgetColumns {
  totalBudget: number;
  budgetLabor: number | null;
  budgetOverhead: number | null;
  budgetFixedFee: number | null;
  budgetFccm: number | null;
}

type BudgetSource = Partial<BudgetColumns> & { budgetHistory?: string | null };

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isDay(value: unknown): value is string {
  return typeof value === "string" && DAY_RE.test(value);
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Oldest first; the undated ("from the start") version sorts before any date. */
function sorted(versions: BudgetVersion[]): BudgetVersion[] {
  return [...versions].sort((a, b) => (a.from ?? "").localeCompare(b.from ?? ""));
}

/** The stored history, oldest first. Anything unreadable counts as none. */
export function parseBudgetHistory(raw: string | null | undefined): BudgetVersion[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: BudgetVersion[] = [];
  for (const v of parsed as Array<Record<string, unknown>>) {
    if (!v || typeof v !== "object") continue;
    const total = num(v.total);
    if (total == null) continue;
    out.push({
      from: isDay(v.from) ? v.from : null,
      total,
      labor: num(v.labor),
      overhead: num(v.overhead),
      fixedFee: num(v.fixedFee),
      fccm: num(v.fccm),
    });
  }
  return sorted(out);
}

export function serializeBudgetHistory(versions: BudgetVersion[]): string | null {
  return versions.length > 0 ? JSON.stringify(sorted(versions)) : null;
}

/** The budget the work plan's own columns hold: the current one. */
export function currentBudget(wp: BudgetSource): BudgetVersion {
  return {
    from: null,
    total: wp.totalBudget ?? 0,
    labor: wp.budgetLabor ?? null,
    overhead: wp.budgetOverhead ?? null,
    fixedFee: wp.budgetFixedFee ?? null,
    fccm: wp.budgetFccm ?? null,
  };
}

export function columnsOf(v: BudgetVersion): BudgetColumns {
  return {
    totalBudget: v.total,
    budgetLabor: v.labor,
    budgetOverhead: v.overhead,
    budgetFixedFee: v.fixedFee,
    budgetFccm: v.fccm,
  };
}

/**
 * The budget an invoice for the period ending `periodEnd` is stated against:
 * the latest version that had begun by then. With no period to go by, or no
 * history, it is the current budget.
 */
export function budgetInForce(wp: BudgetSource, periodEnd?: string | null): BudgetVersion {
  const history = parseBudgetHistory(wp.budgetHistory);
  if (history.length === 0) return currentBudget(wp);
  if (!isDay(periodEnd)) return history[history.length - 1];
  const begun = history.filter((v) => v.from == null || v.from <= periodEnd);
  // A period before the first dated version, on a history with no undated
  // one, gets the earliest there is rather than no budget.
  return begun.length > 0 ? begun[begun.length - 1] : history[0];
}

/**
 * Enters a budget. With a date it starts a new version from that day (or
 * replaces the one already starting then), and what was in force before stays
 * in force for the earlier periods. Without one it restates the budget that
 * has applied from the start.
 */
export function withBudgetVersion(
  wp: BudgetSource,
  version: BudgetVersion,
): { history: BudgetVersion[]; latest: BudgetVersion } {
  let history = parseBudgetHistory(wp.budgetHistory);
  if (history.length === 0) {
    const before = currentBudget(wp);
    // Nothing to keep for the earlier periods: no date given, or no budget
    // had been set until now (a first entry is not a change).
    if (version.from == null || !(before.total > 0)) {
      return { history: [], latest: { ...version, from: null } };
    }
    // The first dated change: what the work plan held until now is the budget
    // for everything before it.
    history = [before];
  }
  history = sorted([...history.filter((v) => v.from !== version.from), version]);
  return { history, latest: history[history.length - 1] };
}

/** Takes a dated version back out, as if that change had not been entered. */
export function withoutBudgetVersion(
  wp: BudgetSource,
  from: string,
): { history: BudgetVersion[]; latest: BudgetVersion } | null {
  const history = parseBudgetHistory(wp.budgetHistory);
  if (!history.some((v) => v.from === from)) return null;
  const rest = history.filter((v) => v.from !== from);
  if (rest.length === 0) return { history: [], latest: currentBudget(wp) };
  // Only the undated one left: no dates to keep track of any more.
  if (rest.length === 1 && rest[0].from == null) return { history: [], latest: rest[0] };
  return { history: rest, latest: rest[rest.length - 1] };
}

/**
 * The history after the work plan's CURRENT budget changes somewhere else —
 * the Work Plan screen, or a new figure from Procas. The latest version is the
 * current one, so the change lands there and the earlier ones are untouched.
 */
export function withCurrentBudget(
  wp: BudgetSource,
  patch: Partial<BudgetColumns>,
): BudgetVersion[] {
  const history = parseBudgetHistory(wp.budgetHistory);
  if (history.length === 0) return history;
  const last = history[history.length - 1];
  history[history.length - 1] = {
    from: last.from,
    total: patch.totalBudget ?? last.total,
    labor: patch.budgetLabor !== undefined ? patch.budgetLabor : last.labor,
    overhead: patch.budgetOverhead !== undefined ? patch.budgetOverhead : last.overhead,
    fixedFee: patch.budgetFixedFee !== undefined ? patch.budgetFixedFee : last.fixedFee,
    fccm: patch.budgetFccm !== undefined ? patch.budgetFccm : last.fccm,
  };
  return history;
}
