/**
 * The Purchase Order line schedule behind the cover's "Billed Line Items"
 * table, and the arithmetic that fills it.
 *
 * On Julie's real AECOM invoice (B.50-01-30, June 2026) that table has ten
 * rows — one per PO line — and it is the first thing AECOM's AP reads: PO
 * Amount, Previous Invoiced, Current Invoiced, Total Invoiced, Remaining
 * Balance. On ours it printed empty, with a row of dashes for the total. That
 * is what her note on page 1 meant by "the information is not being populated
 * on this page".
 *
 * It was empty because the rows only ever came from two places — typed in by
 * hand, or carried forward from the last *approved* package — and a work plan
 * with no approved package yet has neither. The split itself was never typed
 * on her side either: it is arithmetic. Scopes that are fully billed sit at
 * their PO amount, and the scope being worked takes what is left, shared
 * across its lines in proportion to each line's PO amount. Run against her
 * June figures that reproduces every row of her table to the cent.
 */

export interface PoLine {
  workScopeNo: string;
  poNo: string | null;
  lineNo: number | null;
  bartProjectNo: string | null;
  poAmount: number;
  /**
   * What her last invoice we hold shows billed to date on this line, part by
   * part. A line's history cannot be worked out from the work plan's total
   * alone (the three A.03.01 lines are not billed in proportion to their
   * budgets), so the split starts from the last one she printed.
   */
  anchor?: { total: number; hours: number; labor: number; fringe: number; fee: number; fccm: number };
  /** How her Invoice Detail splits this line's budget. */
  budgetSplit?: { labor: number; fringe: number };
}

export interface AllocatedPoLine extends PoLine {
  previousInvoiced: number;
  currentInvoiced: number;
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * PO schedules read off Julie's own invoices, keyed by Procas project. A work
 * plan listed here gets its table filled without anyone retyping the PO.
 *
 * 10007 — AECOM, PO 1638681, from invoice B.50-01-30. The ten PO amounts sum
 * to 1,381,971.85, which is the work plan budget.
 */
export const KNOWN_PO_SCHEDULES: Record<string, PoLine[]> = {
  "10007": [
    { workScopeNo: "B.50-01", poNo: "1638681", lineNo: 1, bartProjectNo: "15TC002/PJMGT", poAmount: 179582.83 },
    { workScopeNo: "B.50-01", poNo: "1638681", lineNo: 2, bartProjectNo: "15CQ002/PJMGT", poAmount: 538748.5 },
    { workScopeNo: "B.50-02", poNo: "1638681", lineNo: 1, bartProjectNo: "15TC002/PJMGT", poAmount: 170267.55 },
    { workScopeNo: "B.50-02", poNo: "1638681", lineNo: 2, bartProjectNo: "15CQ002/PJMGT", poAmount: 34053.51 },
    { workScopeNo: "B.50-02", poNo: "1638681", lineNo: 3, bartProjectNo: "45GA000/SUPPT", poAmount: 32307.16 },
    { workScopeNo: "B.50-03", poNo: "1638681", lineNo: 1, bartProjectNo: "15NL004/PJMGT", poAmount: 115293.32 },
    { workScopeNo: "B.50-03", poNo: "1638681", lineNo: 2, bartProjectNo: "15TC002/PJMGT", poAmount: 149454.31 },
    { workScopeNo: "B.50-03", poNo: "1638681", lineNo: 3, bartProjectNo: "15TC012/PJMGT", poAmount: 76862.21 },
    { workScopeNo: "B.50-03", poNo: "1638681", lineNo: 4, bartProjectNo: "15CQ002/PJMGT", poAmount: 42701.23 },
    { workScopeNo: "B.50-03", poNo: "1638681", lineNo: 5, bartProjectNo: "15QN004/PJMGT", poAmount: 42701.23 },
  ],
  // 10013.TO01 — WSP, PO 66869, work plan A.03.01 (De'Andre Rashad), from
  // invoice A.03.01-23 (period ending 6/30/2026). Three lines, one per BART
  // project, 37.5% / 37.5% / 25% of the 1,205,717.24 budget. The anchors are
  // that invoice's "Amount To Date" column.
  "10013.TO01": [
    {
      workScopeNo: "A.03.01", poNo: "66869", lineNo: 1, bartProjectNo: "15EJRRC", poAmount: 452143.97,
      anchor: { total: 313358.75, hours: 1844.5, labor: 137962.6, fringe: 152129.79, fee: 23207.4, fccm: 58.96 },
      budgetSplit: { labor: 200311.88, fringe: 218339.95 },
    },
    {
      workScopeNo: "A.03.01", poNo: "66869", lineNo: 2, bartProjectNo: "15EJRRK", poAmount: 452143.97,
      anchor: { total: 309865.65, hours: 1848, labor: 136467, fringe: 150394.32, fee: 22948.92, fccm: 55.41 },
      budgetSplit: { labor: 200311.88, fringe: 218339.95 },
    },
    {
      workScopeNo: "A.03.01", poNo: "66869", lineNo: 3, bartProjectNo: "49GH006", poAmount: 301429.3,
      anchor: { total: 181803.33, hours: 1118, labor: 79461.2, fringe: 88806.8, fee: 13461.44, fccm: 73.89 },
      budgetSplit: { labor: 133541.25, fringe: 145559.96 },
    },
  ],
};

/** The schedule for a work plan, matched on its Procas project / job number. */
export function knownPoSchedule(...keys: Array<string | null | undefined>): PoLine[] | null {
  for (const key of keys) {
    const k = (key ?? "").trim();
    if (k && KNOWN_PO_SCHEDULES[k]) return KNOWN_PO_SCHEDULES[k];
  }
  return null;
}

/**
 * Shares `amount` across `weights` in proportion, to the cent, with any
 * rounding residue landing on the last line so the parts always sum to the
 * whole.
 */
export function splitProRata(amount: number, weights: number[]): number[] {
  const total = weights.reduce((s, w) => s + w, 0);
  if (weights.length === 0) return [];
  if (total <= 0) {
    const even = weights.map(() => 0);
    even[even.length - 1] = round2(amount);
    return even;
  }
  const parts = weights.map((w) => round2((amount * w) / total));
  const residue = round2(amount - parts.reduce((s, p) => s + p, 0));
  parts[parts.length - 1] = round2(parts[parts.length - 1] + residue);
  return parts;
}

/** Consecutive lines sharing a work scope, as index ranges in line order. */
function scopeGroups(lines: PoLine[]): Array<{ scope: string; indexes: number[] }> {
  const groups: Array<{ scope: string; indexes: number[] }> = [];
  lines.forEach((line, i) => {
    const last = groups[groups.length - 1];
    if (last && last.scope === line.workScopeNo) last.indexes.push(i);
    else groups.push({ scope: line.workScopeNo, indexes: [i] });
  });
  return groups;
}

/**
 * Fills Previous and Current Invoiced for every PO line.
 *
 * `previouslyBilled` runs down the scopes in order: a scope it covers in full
 * is closed (each line at its PO amount), the first scope it does not cover is
 * the one being worked, and its lines share the remainder pro rata. `current`
 * — this invoice — goes to that same scope, pro rata. Once every scope is
 * closed (the work plan is over its PO), the last scope takes both.
 */
export function allocateAcrossPoLines(
  lines: PoLine[],
  previouslyBilled: number,
  current: number,
): AllocatedPoLine[] {
  const out: AllocatedPoLine[] = lines.map((l) => ({ ...l, previousInvoiced: 0, currentInvoiced: 0 }));
  const groups = scopeGroups(lines);
  if (groups.length === 0) return out;

  let remaining = round2(previouslyBilled);
  let active = groups[groups.length - 1];
  let foundActive = false;
  for (const group of groups) {
    const scopePo = round2(group.indexes.reduce((s, i) => s + lines[i].poAmount, 0));
    if (!foundActive && remaining >= scopePo - 0.005) {
      for (const i of group.indexes) out[i].previousInvoiced = round2(lines[i].poAmount);
      remaining = round2(remaining - scopePo);
      continue;
    }
    if (!foundActive) {
      foundActive = true;
      active = group;
      // Lines whose last printed to-date figures we hold start from those;
      // only what has been billed since is shared out.
      const anchors = group.indexes.map((i) => lines[i].anchor?.total ?? 0);
      const anchored = round2(anchors.reduce((s, a) => s + a, 0));
      const useAnchors =
        group.indexes.every((i) => lines[i].anchor != null) && remaining >= anchored - 0.005;
      const parts = splitProRata(
        useAnchors ? round2(remaining - anchored) : remaining,
        group.indexes.map((i) => lines[i].poAmount),
      );
      group.indexes.forEach(
        (i, n) => (out[i].previousInvoiced = round2(parts[n] + (useAnchors ? anchors[n] : 0))),
      );
      remaining = 0;
    }
  }
  // Over the PO: nothing is left open, so the overage sits on the last scope.
  if (!foundActive && remaining > 0) {
    const parts = splitProRata(remaining, active.indexes.map((i) => lines[i].poAmount));
    active.indexes.forEach((i, n) => (out[i].previousInvoiced = round2(out[i].previousInvoiced + parts[n])));
  }

  const currentParts = splitProRata(round2(current), active.indexes.map((i) => lines[i].poAmount));
  active.indexes.forEach((i, n) => (out[i].currentInvoiced = currentParts[n]));
  return out;
}

/**
 * Shares this invoice's amount across rows whose Previous Invoiced is already
 * known (carried forward from the last approved package). The scope being
 * worked is the first one with balance left.
 */
export function allocateCurrent<T extends PoLine & { previousInvoiced: number }>(
  lines: T[],
  current: number,
): number[] {
  const out = lines.map(() => 0);
  const groups = scopeGroups(lines);
  if (groups.length === 0) return out;
  const open = groups.find(
    (g) =>
      round2(g.indexes.reduce((s, i) => s + lines[i].poAmount - lines[i].previousInvoiced, 0)) > 0.005,
  );
  const active = open ?? groups[groups.length - 1];
  const parts = splitProRata(round2(current), active.indexes.map((i) => lines[i].poAmount));
  active.indexes.forEach((i, n) => (out[i] = parts[n]));
  return out;
}
