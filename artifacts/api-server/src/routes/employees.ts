import { Router, type IRouter } from "express";
import { asc, eq, and } from "drizzle-orm";
import { db, employeesTable, employeeRateChangesTable, type EmployeeRateChange } from "@workspace/db";
import {
  CreateEmployeeBody,
  UpdateEmployeeBody,
  ListEmployeesResponse,
  GetEmployeeResponse,
  CreateEmployeeResponse,
  UpdateEmployeeResponse,
  CreateEmployeeRateChangeBody,
  CreateEmployeeRateChangeResponse,
  ListEmployeeRateChangesResponse,
} from "@workspace/api-zod";
import { recordAudit } from "../lib/audit";

const router: IRouter = Router();

function toApi(e: typeof employeesTable.$inferSelect, rateChanges: EmployeeRateChange[] = []) {
  return {
    id: e.id,
    name: e.name,
    classification: e.classification,
    homeRate: e.homeRate,
    fieldRate: e.fieldRate,
    defaultTaskNo: e.defaultTaskNo,
    active: e.active,
    createdAt: e.createdAt.toISOString(),
    rateChanges: rateChanges.map(toApiRateChange),
  };
}

function toApiRateChange(rc: EmployeeRateChange) {
  return {
    id: rc.id,
    employeeId: rc.employeeId,
    effectiveDate: rc.effectiveDate,
    homeRate: rc.homeRate,
    fieldRate: rc.fieldRate,
    createdAt: rc.createdAt.toISOString(),
  };
}

async function rateChangesFor(employeeId: number): Promise<EmployeeRateChange[]> {
  return db
    .select()
    .from(employeeRateChangesTable)
    .where(eq(employeeRateChangesTable.employeeId, employeeId))
    .orderBy(asc(employeeRateChangesTable.effectiveDate), asc(employeeRateChangesTable.id));
}

router.get("/employees", async (_req, res): Promise<void> => {
  const rows = await db.select().from(employeesTable).orderBy(employeesTable.name);
  const allChanges = await db
    .select()
    .from(employeeRateChangesTable)
    .orderBy(asc(employeeRateChangesTable.effectiveDate), asc(employeeRateChangesTable.id));
  const byEmployee = new Map<number, EmployeeRateChange[]>();
  for (const rc of allChanges) {
    const list = byEmployee.get(rc.employeeId);
    if (list) list.push(rc);
    else byEmployee.set(rc.employeeId, [rc]);
  }
  res.json(ListEmployeesResponse.parse(rows.map((r) => toApi(r, byEmployee.get(r.id) ?? []))));
});

router.post("/employees", async (req, res): Promise<void> => {
  const parsed = CreateEmployeeBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [row] = await db.insert(employeesTable).values(parsed.data).returning();
  await recordAudit({ action: "created", entityType: "employee", entityId: row.id, description: row.name });
  res.status(201).json(CreateEmployeeResponse.parse(toApi(row)));
});

router.get("/employees/:id", async (req, res): Promise<void> => {
  const id = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  const [row] = await db.select().from(employeesTable).where(eq(employeesTable.id, id));
  if (!row) {
    res.status(404).json({ error: "Employee not found" });
    return;
  }
  res.json(GetEmployeeResponse.parse(toApi(row, await rateChangesFor(id))));
});

router.patch("/employees/:id", async (req, res): Promise<void> => {
  const id = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  const parsed = UpdateEmployeeBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [row] = await db.update(employeesTable).set(parsed.data).where(eq(employeesTable.id, id)).returning();
  if (!row) {
    res.status(404).json({ error: "Employee not found" });
    return;
  }
  await recordAudit({ action: "updated", entityType: "employee", entityId: id, description: row.name });
  res.json(UpdateEmployeeResponse.parse(toApi(row, await rateChangesFor(id))));
});

router.delete("/employees/:id", async (req, res): Promise<void> => {
  const id = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  const [row] = await db.delete(employeesTable).where(eq(employeesTable.id, id)).returning();
  if (!row) {
    res.status(404).json({ error: "Employee not found" });
    return;
  }
  await recordAudit({ action: "deleted", entityType: "employee", entityId: id, description: row.name });
  res.sendStatus(204);
});

// ---------------------------------------------------------------------------
// Effective-dated rate changes. Base rates on the employee row apply before
// the earliest change; each change applies from its effectiveDate (inclusive)
// until a later change supersedes it. A mid-period change is what makes the
// export split the Labor Attachment into two rate rows.
// ---------------------------------------------------------------------------

router.get("/employees/:id/rate-changes", async (req, res): Promise<void> => {
  const id = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  const [emp] = await db.select().from(employeesTable).where(eq(employeesTable.id, id));
  if (!emp) {
    res.status(404).json({ error: "Employee not found" });
    return;
  }
  const rows = await rateChangesFor(id);
  res.json(ListEmployeeRateChangesResponse.parse(rows.map(toApiRateChange)));
});

router.post("/employees/:id/rate-changes", async (req, res): Promise<void> => {
  const id = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  const [emp] = await db.select().from(employeesTable).where(eq(employeesTable.id, id));
  if (!emp) {
    res.status(404).json({ error: "Employee not found" });
    return;
  }
  const parsed = CreateEmployeeRateChangeBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  // Two changes on the same day would make "which rate applies" ambiguous.
  const existing = await rateChangesFor(id);
  if (existing.some((rc) => rc.effectiveDate === parsed.data.effectiveDate)) {
    res.status(400).json({
      error: `A rate change effective ${parsed.data.effectiveDate} already exists — delete it first or pick a different date.`,
    });
    return;
  }
  const [row] = await db
    .insert(employeeRateChangesTable)
    .values({
      employeeId: id,
      effectiveDate: parsed.data.effectiveDate,
      homeRate: parsed.data.homeRate,
      fieldRate: parsed.data.fieldRate ?? null,
    })
    .returning();
  await recordAudit({
    action: "updated",
    entityType: "employee",
    entityId: id,
    description: `${emp.name}: rate change effective ${row.effectiveDate} (home $${row.homeRate}${row.fieldRate != null ? `, field $${row.fieldRate}` : ""})`,
  });
  res.status(201).json(CreateEmployeeRateChangeResponse.parse(toApiRateChange(row)));
});

router.delete("/employees/:id/rate-changes/:rateChangeId", async (req, res): Promise<void> => {
  const id = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  const rcId = parseInt(
    Array.isArray(req.params.rateChangeId) ? req.params.rateChangeId[0] : req.params.rateChangeId,
    10,
  );
  const [row] = await db
    .delete(employeeRateChangesTable)
    .where(and(eq(employeeRateChangesTable.id, rcId), eq(employeeRateChangesTable.employeeId, id)))
    .returning();
  if (!row) {
    res.status(404).json({ error: "Rate change not found" });
    return;
  }
  await recordAudit({
    action: "updated",
    entityType: "employee",
    entityId: id,
    description: `Rate change effective ${row.effectiveDate} removed`,
  });
  res.sendStatus(204);
});

export default router;
