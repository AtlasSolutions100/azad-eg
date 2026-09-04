/**
 * Whether a work plan is one a biller could actually invoice against.
 *
 * The Procas import brings the whole project library across — 533 rows, of
 * which 35 are jobs and the rest are sub-task codes hanging off them
 * ("10002.04.01.0.CA"). Procas marks a project closed with IsClosed, which the
 * import maps to `archived`, but not one of the 532 projects has it set, so
 * that filter never fires and every code Azad has ever used reaches the picker.
 *
 * A job qualifies if it is a top-level code (no dot) or carries a budget. The
 * budget clause matters: 40 of the budgeted plans are sub-codes, and money
 * attached to a code is the strongest signal it gets billed. Together they cut
 * the list from 533 to about 75 while hiding nothing that has a dollar figure
 * against it.
 *
 * This is a default view, never a wall: every screen using it keeps a "show
 * all" escape and lets a search reach the whole library.
 */
export function isBillableJob(wp: { code: string; totalBudget?: number | null }): boolean {
  return !wp.code.includes(".") || (wp.totalBudget ?? 0) > 0;
}
