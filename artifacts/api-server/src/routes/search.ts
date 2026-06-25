import { Router, type IRouter } from "express";
import { or, ilike, eq, inArray } from "drizzle-orm";
import { db, workPlansTable, employeesTable, invoicesTable, packagesTable } from "@workspace/db";
import { SearchQueryParams, SearchResponse } from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/search", async (req, res): Promise<void> => {
  const parsed = SearchQueryParams.safeParse(req.query);
  if (!parsed.success || !parsed.data.q.trim()) {
    res.json(SearchResponse.parse([]));
    return;
  }
  const term = `%${parsed.data.q.trim()}%`;

  const [wps, emps, invs, pkgs] = await Promise.all([
    db
      .select()
      .from(workPlansTable)
      .where(or(ilike(workPlansTable.client, term), ilike(workPlansTable.code, term), ilike(workPlansTable.jobNumber, term), ilike(workPlansTable.title, term)))
      .limit(10),
    db.select().from(employeesTable).where(or(ilike(employeesTable.name, term), ilike(employeesTable.classification, term))).limit(10),
    db.select().from(invoicesTable).where(ilike(invoicesTable.invoiceNumber, term)).limit(10),
    db.select().from(packagesTable).where(ilike(packagesTable.invoiceNumber, term)).limit(10),
  ]);

  // Surface packages whose referenced employee matched the search term too.
  const matchedEmpIds = emps.map((e) => e.id);
  const pkgsByEmployee = matchedEmpIds.length
    ? await db.select().from(packagesTable).where(inArray(packagesTable.employeeId, matchedEmpIds)).limit(10)
    : [];
  const pkgMap = new Map<number, (typeof pkgs)[number]>();
  for (const p of [...pkgs, ...pkgsByEmployee]) pkgMap.set(p.id, p);

  const empNameMap = new Map(emps.map((e) => [e.id, e.name]));
  const missingEmpIds = [...pkgMap.values()].map((p) => p.employeeId).filter((eid) => !empNameMap.has(eid));
  if (missingEmpIds.length) {
    const extraEmps = await db.select().from(employeesTable).where(inArray(employeesTable.id, missingEmpIds));
    for (const e of extraEmps) empNameMap.set(e.id, e.name);
  }

  const results = [
    ...wps.map((w) => ({ type: "workPlan" as const, id: w.id, label: `${w.code} — ${w.client}`, sublabel: w.title, route: `/work-plans` })),
    ...emps.map((e) => ({ type: "employee" as const, id: e.id, label: e.name, sublabel: e.classification, route: `/employees` })),
    ...invs.map((i) => ({ type: "invoice" as const, id: i.id, label: `Invoice ${i.invoiceNumber}`, sublabel: `${i.periodStart} → ${i.periodEnd}`, route: `/invoices/${i.id}` })),
    ...[...pkgMap.values()].map((p) => ({
      type: "package" as const,
      id: p.id,
      label: `${empNameMap.get(p.employeeId) ?? "Package"} — ${p.invoiceNumber ?? "draft"}`,
      sublabel: `${p.payPeriodStart} → ${p.payPeriodEnd}`,
      route: `/packages/${p.id}`,
    })),
  ];

  res.json(SearchResponse.parse(results));
});

export default router;
