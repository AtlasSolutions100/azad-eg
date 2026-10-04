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
      if (Object.keys(changes).length === 0) continue;
      await db.update(workPlansTable).set(changes).where(eq(workPlansTable.id, plan.id));
      touched += 1;
      logger.info(
        { workPlan: plan.code, filled: Object.keys(changes) },
        "Filled blank invoice header fields from the work plan's reference invoice",
      );
    }
  }
  return touched;
}
