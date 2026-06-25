import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, employeesTable } from "@workspace/db";
import {
  CreateEmployeeBody,
  UpdateEmployeeBody,
  ListEmployeesResponse,
  GetEmployeeResponse,
  CreateEmployeeResponse,
  UpdateEmployeeResponse,
} from "@workspace/api-zod";
import { recordAudit } from "../lib/audit";

const router: IRouter = Router();

function toApi(e: typeof employeesTable.$inferSelect) {
  return {
    id: e.id,
    name: e.name,
    classification: e.classification,
    homeRate: e.homeRate,
    fieldRate: e.fieldRate,
    defaultTaskNo: e.defaultTaskNo,
    active: e.active,
    createdAt: e.createdAt.toISOString(),
  };
}

router.get("/employees", async (_req, res): Promise<void> => {
  const rows = await db.select().from(employeesTable).orderBy(employeesTable.name);
  res.json(ListEmployeesResponse.parse(rows.map(toApi)));
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
  res.json(GetEmployeeResponse.parse(toApi(row)));
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
  res.json(UpdateEmployeeResponse.parse(toApi(row)));
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

export default router;
