import { Router, type IRouter } from "express";
import { or, ilike } from "drizzle-orm";
import { db, workPlansTable, employeesTable, invoicesTable } from "@workspace/db";
import { SearchQueryParams, SearchResponse } from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/search", async (req, res): Promise<void> => {
  const parsed = SearchQueryParams.safeParse(req.query);
  if (!parsed.success || !parsed.data.q.trim()) {
    res.json(SearchResponse.parse([]));
    return;
  }
  const term = `%${parsed.data.q.trim()}%`;

  const [wps, emps, invs] = await Promise.all([
    db
      .select()
      .from(workPlansTable)
      .where(or(ilike(workPlansTable.client, term), ilike(workPlansTable.code, term), ilike(workPlansTable.jobNumber, term), ilike(workPlansTable.title, term)))
      .limit(10),
    db.select().from(employeesTable).where(or(ilike(employeesTable.name, term), ilike(employeesTable.classification, term))).limit(10),
    db.select().from(invoicesTable).where(ilike(invoicesTable.invoiceNumber, term)).limit(10),
  ]);

  const results = [
    ...wps.map((w) => ({ type: "workPlan" as const, id: w.id, label: `${w.code} — ${w.client}`, sublabel: w.title, route: `/work-plans` })),
    ...emps.map((e) => ({ type: "employee" as const, id: e.id, label: e.name, sublabel: e.classification, route: `/employees` })),
    ...invs.map((i) => ({ type: "invoice" as const, id: i.id, label: `Invoice ${i.invoiceNumber}`, sublabel: `${i.periodStart} → ${i.periodEnd}`, route: `/invoices/${i.id}` })),
  ];

  res.json(SearchResponse.parse(results));
});

export default router;
