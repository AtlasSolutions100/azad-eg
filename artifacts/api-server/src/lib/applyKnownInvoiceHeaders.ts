import { eq, or } from "drizzle-orm";
import { db, workPlansTable } from "@workspace/db";
import { logger } from "./logger";
import { KNOWN_INVOICE_HEADERS, STORED_HEADER_FIELDS, sameBurden } from "./knownInvoiceHeaders";

/**
 * Fills blank header fields on the work plans we hold real invoices for.
 * Idempotent and fill-if-blank only, so it is safe to run at every startup: a
 * value the biller has typed is never replaced. Returns how many work plans it
 * touched.
 */
export async function applyKnownInvoiceHeaders(): Promise<number> {
  let touched = 0;
  for (const [project, header] of Object.entries(KNOWN_INVOICE_HEADERS)) {
    const plans = await db
      .select()
      .from(workPlansTable)
      .where(or(eq(workPlansTable.procasProject, project), eq(workPlansTable.jobNumber, project)));
    for (const plan of plans) {
      const changes: Partial<Record<(typeof STORED_HEADER_FIELDS)[number], string>> = {};
      for (const field of STORED_HEADER_FIELDS) {
        const known = header[field];
        if (known && !String(plan[field] ?? "").trim()) changes[field] = known;
      }
      // The budget is on her invoice too. A Procas import leaves it at 0, and
      // every "% expended" and "amount remaining" then printed as 0 / negative.
      const budget = header.totalBudget && !(plan.totalBudget > 0) ? header.totalBudget : null;
      // A Procas-owned plan with no burden at all is one Procas bills at
      // loaded rates; its invoice still shows the burden (see procasSync's
      // burdenFromAccount, which does the same on every sync).
      const noBurden =
        !plan.fringeRate && !plan.overheadRate && !plan.fixedFeeRate && !plan.fccmRate;
      // Where Procas holds no percentages at all (procasRatesLoaded), this is
      // the only place the burden comes from, so a change to it — FCCM on
      // T.Y. Lin's from September 2026 — has to reach the work plan from here.
      // A plan still carrying one of the burdens we knew before is brought up
      // to date; one a biller has set to something else is left alone.
      const stale =
        !!header.burden &&
        !!header.procasRatesLoaded &&
        !sameBurden(plan, header.burden) &&
        (plan.source === "procas" || (header.burdenBefore ?? []).some((b) => sameBurden(plan, b.burden)));
      const burden =
        header.burden && ((plan.source === "procas" && noBurden) || stale) ? header.burden : null;
      if (Object.keys(changes).length === 0 && budget == null && burden == null) continue;
      await db
        .update(workPlansTable)
        .set({
          ...changes,
          ...(budget == null ? {} : { totalBudget: budget }),
          ...(burden ?? {}),
        })
        .where(eq(workPlansTable.id, plan.id));
      touched += 1;
      logger.info(
        { workPlan: plan.code, filled: [
            ...Object.keys(changes),
            ...(budget == null ? [] : ["totalBudget"]),
            ...(burden == null ? [] : ["burden"]),
          ],
        },
        "Filled blank invoice header fields from the work plan's reference invoice",
      );
    }
  }
  return touched;
}
