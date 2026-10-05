import { eq, or } from "drizzle-orm";
import { db, workPlansTable } from "@workspace/db";
import { logger } from "./logger";
import { KNOWN_INVOICE_HEADERS, STORED_HEADER_FIELDS } from "./knownInvoiceHeaders";

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
      const burden = header.burden && plan.source === "procas" && noBurden ? header.burden : null;
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
