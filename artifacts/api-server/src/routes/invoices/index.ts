import { Router, type IRouter } from "express";
import { eq, and, inArray, desc } from "drizzle-orm";
import {
  db,
  invoicesTable,
  workPlansTable,
  lineItemsTable,
  employeesTable,
  progressReportsTable,
  signaturesTable,
  type WorkPlan,
  type LineItemRow,
} from "@workspace/db";
import {
  CreateInvoiceBody,
  UpdateInvoiceBody,
  ApproveInvoiceBody,
  SaveProgressReportBody,
  ListInvoicesResponse,
  CreateInvoiceResponse,
  GetInvoiceResponse,
  UpdateInvoiceResponse,
  ApproveInvoiceResponse,
  GetInvoicePreviewResponse,
  GetInvoiceValidationsResponse,
  ImportTimeDataResponse,
  GenerateInvoiceFileBody,
  GenerateInvoiceFileResponse,
  GetProgressReportResponse,
  SaveProgressReportResponse,
  ListInvoicesQueryParams,
} from "@workspace/api-zod";
import { buildInvoice, toApiLineItem } from "../../lib/mappers";
import { recomputeCarryOver, deriveCarryOverFromPriors } from "../../lib/carryover";
import { recordAudit } from "../../lib/audit";
import { upload } from "../../lib/upload";
import { parseTimeFile } from "../../lib/timeimport";
import { buildInvoiceWorkbook, convertToPdf, resolveSignaturePath } from "../../lib/excel";
import path from "node:path";

const router: IRouter = Router();

function pid(req: { params: Record<string, string | string[]> }): number {
  const raw = req.params.id;
  return parseInt(Array.isArray(raw) ? raw[0] : raw, 10);
}

async function loadContext(invoiceId: number): Promise<
  | { invoice: typeof invoicesTable.$inferSelect; workPlan: WorkPlan; lineItems: LineItemRow[] }
  | null
> {
  const [invoice] = await db.select().from(invoicesTable).where(eq(invoicesTable.id, invoiceId));
  if (!invoice) return null;
  const [workPlan] = await db.select().from(workPlansTable).where(eq(workPlansTable.id, invoice.workPlanId));
  if (!workPlan) return null;
  const lineItems = await db.select().from(lineItemsTable).where(eq(lineItemsTable.invoiceId, invoiceId)).orderBy(lineItemsTable.id);
  return { invoice, workPlan, lineItems };
}

router.get("/invoices", async (req, res): Promise<void> => {
  const q = ListInvoicesQueryParams.safeParse(req.query);
  const filters = [];
  if (q.success && q.data.status) filters.push(eq(invoicesTable.status, q.data.status));
  if (q.success && q.data.workPlanId) filters.push(eq(invoicesTable.workPlanId, q.data.workPlanId));
  const invoices = await db
    .select()
    .from(invoicesTable)
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(desc(invoicesTable.createdAt));

  if (invoices.length === 0) {
    res.json(ListInvoicesResponse.parse([]));
    return;
  }

  const wpRows = await db.select().from(workPlansTable);
  const wpMap = new Map(wpRows.map((w) => [w.id, w]));
  const liRows = await db.select().from(lineItemsTable).where(inArray(lineItemsTable.invoiceId, invoices.map((i) => i.id)));
  const liByInvoice = new Map<number, LineItemRow[]>();
  for (const li of liRows) {
    const arr = liByInvoice.get(li.invoiceId) ?? [];
    arr.push(li);
    liByInvoice.set(li.invoiceId, arr);
  }

  const result = invoices
    .map((inv) => {
      const wp = wpMap.get(inv.workPlanId);
      if (!wp) return null;
      return buildInvoice(inv, wp, liByInvoice.get(inv.id) ?? []).api;
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  res.json(ListInvoicesResponse.parse(result));
});

router.post("/invoices", async (req, res): Promise<void> => {
  const parsed = CreateInvoiceBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [wp] = await db.select().from(workPlansTable).where(eq(workPlansTable.id, parsed.data.workPlanId));
  if (!wp) {
    res.status(400).json({ error: "Work plan not found" });
    return;
  }
  // Carry-over: when no "previously billed" was supplied, derive it from the
  // most recent already-billed (approved/exported) invoice on the same work
  // plan — its total-to-date is the new invoice's previously-billed amount.
  // An explicitly supplied value is flagged manual so later recomputes keep it.
  const carryOverManual = parsed.data.previouslyBilled != null;
  let previouslyBilled = parsed.data.previouslyBilled ?? 0;
  if (!carryOverManual) {
    const priors = await db.select().from(invoicesTable).where(eq(invoicesTable.workPlanId, wp.id));
    const li = priors.length
      ? await db.select().from(lineItemsTable).where(inArray(lineItemsTable.invoiceId, priors.map((p) => p.id)))
      : [];
    const liByInvoice = new Map<number, LineItemRow[]>();
    for (const item of li) {
      const arr = liByInvoice.get(item.invoiceId) ?? [];
      arr.push(item);
      liByInvoice.set(item.invoiceId, arr);
    }
    previouslyBilled = deriveCarryOverFromPriors(priors, liByInvoice, wp);
  }
  const [row] = await db.insert(invoicesTable).values({ ...parsed.data, previouslyBilled, carryOverManual }).returning();
  await recordAudit({ action: "created", entityType: "invoice", entityId: row.id, description: `Invoice ${row.invoiceNumber}` });
  res.status(201).json(CreateInvoiceResponse.parse(buildInvoice(row, wp, []).api));
});

router.get("/invoices/:id", async (req, res): Promise<void> => {
  const ctx = await loadContext(pid(req));
  if (!ctx) {
    res.status(404).json({ error: "Invoice not found" });
    return;
  }
  res.json(GetInvoiceResponse.parse(buildInvoice(ctx.invoice, ctx.workPlan, ctx.lineItems).api));
});

router.patch("/invoices/:id", async (req, res): Promise<void> => {
  const id = pid(req);
  const parsed = UpdateInvoiceBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { status: _ignoredStatus, ...fields } = parsed.data;
  // A directly-edited carry-over is treated as manual so it survives recompute.
  const patchFields: Partial<typeof invoicesTable.$inferInsert> =
    fields.previouslyBilled != null ? { ...fields, carryOverManual: true } : fields;
  let row;
  if (Object.keys(patchFields).length > 0) {
    [row] = await db.update(invoicesTable).set(patchFields).where(eq(invoicesTable.id, id)).returning();
  } else {
    [row] = await db.select().from(invoicesTable).where(eq(invoicesTable.id, id));
  }
  if (!row) {
    res.status(404).json({ error: "Invoice not found" });
    return;
  }
  // The edit may have changed this invoice's total-to-date (e.g. otherDirectCosts
  // or period), so re-derive downstream invoices' carried-forward totals.
  await recomputeCarryOver(row.workPlanId);
  [row] = await db.select().from(invoicesTable).where(eq(invoicesTable.id, id));
  const [wp] = await db.select().from(workPlansTable).where(eq(workPlansTable.id, row.workPlanId));
  const lineItems = await db.select().from(lineItemsTable).where(eq(lineItemsTable.invoiceId, id));
  await recordAudit({ action: "updated", entityType: "invoice", entityId: id, description: `Invoice ${row.invoiceNumber}` });
  res.json(UpdateInvoiceResponse.parse(buildInvoice(row, wp, lineItems).api));
});

router.delete("/invoices/:id", async (req, res): Promise<void> => {
  const id = pid(req);
  await db.delete(lineItemsTable).where(eq(lineItemsTable.invoiceId, id));
  await db.delete(progressReportsTable).where(eq(progressReportsTable.invoiceId, id));
  const [row] = await db.delete(invoicesTable).where(eq(invoicesTable.id, id)).returning();
  if (!row) {
    res.status(404).json({ error: "Invoice not found" });
    return;
  }
  // Removing an invoice changes the chain for any later invoices on the plan.
  await recomputeCarryOver(row.workPlanId);
  await recordAudit({ action: "deleted", entityType: "invoice", entityId: id, description: `Invoice ${row.invoiceNumber}` });
  res.sendStatus(204);
});

router.post("/invoices/:id/approve", async (req, res): Promise<void> => {
  const id = pid(req);
  const parsed = ApproveInvoiceBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [current] = await db.select().from(invoicesTable).where(eq(invoicesTable.id, id));
  if (!current) {
    res.status(404).json({ error: "Invoice not found" });
    return;
  }
  if (current.status !== "draft" && current.status !== "in_review") {
    res.status(409).json({ error: `Cannot approve an invoice with status '${current.status}'.` });
    return;
  }
  const [row] = await db
    .update(invoicesTable)
    .set({ status: "approved", approvedBy: parsed.data.approvedBy, signatureId: parsed.data.signatureId ?? null })
    .where(eq(invoicesTable.id, id))
    .returning();
  if (!row) {
    res.status(404).json({ error: "Invoice not found" });
    return;
  }
  // Approval makes this invoice "billed", so downstream carry-over may shift.
  await recomputeCarryOver(row.workPlanId);
  const [wp] = await db.select().from(workPlansTable).where(eq(workPlansTable.id, row.workPlanId));
  const lineItems = await db.select().from(lineItemsTable).where(eq(lineItemsTable.invoiceId, id));
  await recordAudit({ action: "approved", entityType: "invoice", entityId: id, userName: parsed.data.approvedBy, description: `Invoice ${row.invoiceNumber}` });
  res.json(ApproveInvoiceResponse.parse(buildInvoice(row, wp, lineItems).api));
});

router.get("/invoices/:id/preview", async (req, res): Promise<void> => {
  const ctx = await loadContext(pid(req));
  if (!ctx) {
    res.status(404).json({ error: "Invoice not found" });
    return;
  }
  const built = buildInvoice(ctx.invoice, ctx.workPlan, ctx.lineItems);
  res.json(
    GetInvoicePreviewResponse.parse({
      invoice: built.api,
      lineItems: ctx.lineItems.map(toApiLineItem),
      financials: built.financials.financials,
    }),
  );
});

router.get("/invoices/:id/validations", async (req, res): Promise<void> => {
  const id = pid(req);
  const ctx = await loadContext(id);
  if (!ctx) {
    res.status(404).json({ error: "Invoice not found" });
    return;
  }
  const built = buildInvoice(ctx.invoice, ctx.workPlan, ctx.lineItems);
  const flags: Array<{ severity: "error" | "warning" | "info"; field?: string | null; message: string }> = [];

  if (ctx.lineItems.length === 0) {
    flags.push({ severity: "error", field: "lineItems", message: "No labor line items have been added or imported." });
  }
  for (const li of ctx.lineItems) {
    if (li.rate <= 0) {
      flags.push({ severity: "error", field: "rate", message: `${li.employeeName}: rate is missing or zero.` });
    }
    if (li.hours <= 0) {
      flags.push({ severity: "warning", field: "hours", message: `${li.employeeName}: hours is zero.` });
    }
  }
  if (new Date(ctx.invoice.periodStart) > new Date(ctx.invoice.periodEnd)) {
    flags.push({ severity: "error", field: "periodEnd", message: "Period end is before period start." });
  }
  if (built.financials.percentExpended > 100) {
    flags.push({ severity: "warning", field: "budget", message: `Total billed to date is ${built.financials.percentExpended}% of the work plan budget.` });
  } else if (built.financials.percentExpended > 90) {
    flags.push({ severity: "info", field: "budget", message: `Budget is ${built.financials.percentExpended}% expended.` });
  }
  const [pr] = await db.select().from(progressReportsTable).where(eq(progressReportsTable.invoiceId, id));
  if (!pr) {
    flags.push({ severity: "info", field: "progressReport", message: "No progress report has been completed for this period." });
  }

  res.json(
    GetInvoiceValidationsResponse.parse({
      invoiceId: id,
      isValid: !flags.some((f) => f.severity === "error"),
      flags,
    }),
  );
});

router.post("/invoices/:id/time-import", upload.single("file"), async (req, res): Promise<void> => {
  const id = pid(req);
  const ctx = await loadContext(id);
  if (!ctx) {
    res.status(404).json({ error: "Invoice not found" });
    return;
  }
  const file = (req as unknown as { file?: { buffer: Buffer; originalname: string } }).file;
  if (!file) {
    res.status(400).json({ error: "No file uploaded (expected field 'file')." });
    return;
  }
  const source = typeof req.body?.source === "string" ? req.body.source : "timesheet";

  const parsedFile = await parseTimeFile(file.buffer, file.originalname);
  if (parsedFile.lines.length === 0) {
    res.status(400).json({ error: "No valid rows found.", warnings: parsedFile.warnings });
    return;
  }

  const employees = await db.select().from(employeesTable);
  const empByName = new Map(employees.map((e) => [e.name.toLowerCase().trim(), e]));
  const warnings = [...parsedFile.warnings];

  const toInsert = parsedFile.lines.map((line) => {
    const emp = empByName.get(line.employeeName.toLowerCase().trim());
    let rate = line.rate;
    let classification = line.classification;
    if (rate <= 0 && emp) {
      rate = line.location === "field" ? emp.fieldRate ?? emp.homeRate : emp.homeRate;
    }
    if (!classification && emp) classification = emp.classification;
    if (rate <= 0) warnings.push(`${line.employeeName}: no rate available, set to 0 — please correct manually.`);
    return {
      invoiceId: id,
      employeeId: emp?.id ?? null,
      employeeName: line.employeeName,
      classification: classification || "Unspecified",
      category: line.category,
      location: line.location,
      hours: line.hours,
      rate,
      amount: line.hours * rate,
      taskNo: line.taskNo ?? emp?.defaultTaskNo ?? null,
      notes: line.notes ?? null,
    };
  });

  const inserted = await db.insert(lineItemsTable).values(toInsert).returning();
  // New labor changes this invoice's total-to-date; refresh downstream carry-over.
  await recomputeCarryOver(ctx.invoice.workPlanId);
  await recordAudit({ action: "imported time data", entityType: "invoice", entityId: id, description: `${inserted.length} line items from ${source}` });

  res.json(
    ImportTimeDataResponse.parse({
      importedCount: inserted.length,
      source,
      warnings,
      lineItems: inserted.map(toApiLineItem),
    }),
  );
});

router.post("/invoices/:id/generate", async (req, res): Promise<void> => {
  const id = pid(req);
  const parsed = GenerateInvoiceFileBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const ctx = await loadContext(id);
  if (!ctx) {
    res.status(404).json({ error: "Invoice not found" });
    return;
  }
  const built = buildInvoice(ctx.invoice, ctx.workPlan, ctx.lineItems);
  const [pr] = await db.select().from(progressReportsTable).where(eq(progressReportsTable.invoiceId, id));

  let signatureImagePath: string | null = null;
  if (ctx.invoice.signatureId) {
    const [sig] = await db.select().from(signaturesTable).where(eq(signaturesTable.id, ctx.invoice.signatureId));
    if (sig) signatureImagePath = resolveSignaturePath(sig.imageUrl);
  }

  const xlsxPath = await buildInvoiceWorkbook({
    invoiceNumber: ctx.invoice.invoiceNumber,
    invoiceDate: ctx.invoice.invoiceDate,
    periodStart: ctx.invoice.periodStart,
    periodEnd: ctx.invoice.periodEnd,
    poNumber: ctx.workPlan.poNumber,
    totalBudget: ctx.workPlan.totalBudget,
    fringeRate: ctx.workPlan.fringeRate ?? 0,
    fixedFeeRate: ctx.workPlan.fixedFeeRate ?? 0,
    lineItems: ctx.lineItems.map((li) => ({
      classification: li.classification,
      employeeName: li.employeeName,
      hours: li.hours,
      rate: li.rate,
      location: li.location,
    })),
    financials: {
      laborTotal: built.financials.laborTotal,
      fringeTotal: built.financials.fringeTotal,
      fixedFee: built.financials.fixedFee,
      fccm: built.financials.fccm,
      otdtPremium: built.financials.otdtPremium,
      otherDirectCosts: built.financials.otherDirectCosts,
      totalThisPeriod: built.financials.totalThisPeriod,
      previouslyBilled: built.financials.previouslyBilled,
      totalToDate: built.financials.totalToDate,
      remainingBalance: built.financials.remainingBalance,
    },
    progress: pr
      ? { summary: pr.summary, workCompleted: pr.workCompleted, issues: pr.issues, percentComplete: pr.percentComplete }
      : null,
    signatureImagePath,
  });

  let outPath = xlsxPath;
  if (parsed.data.format === "pdf") {
    outPath = await convertToPdf(xlsxPath);
  }

  const filename = path.basename(outPath);
  if (ctx.invoice.status === "approved") {
    await db.update(invoicesTable).set({ status: "exported" }).where(eq(invoicesTable.id, id));
  }
  await recordAudit({ action: "generated file", entityType: "invoice", entityId: id, description: `${parsed.data.format.toUpperCase()} ${filename}` });

  res.json(
    GenerateInvoiceFileResponse.parse({
      url: `/api/files/${encodeURIComponent(filename)}`,
      filename,
      format: parsed.data.format,
    }),
  );
});

router.get("/invoices/:id/progress-report", async (req, res): Promise<void> => {
  const id = pid(req);
  const [pr] = await db.select().from(progressReportsTable).where(eq(progressReportsTable.invoiceId, id));
  if (!pr) {
    res.status(404).json({ error: "No progress report found" });
    return;
  }
  res.json(
    GetProgressReportResponse.parse({
      id: pr.id,
      invoiceId: pr.invoiceId,
      percentComplete: pr.percentComplete,
      summary: pr.summary,
      workCompleted: pr.workCompleted,
      workPlanned: pr.workPlanned,
      issues: pr.issues,
      scheduleStatus: pr.scheduleStatus,
      budgetStatus: pr.budgetStatus,
      preparedBy: pr.preparedBy,
      reportDate: pr.reportDate,
    }),
  );
});

router.put("/invoices/:id/progress-report", async (req, res): Promise<void> => {
  const id = pid(req);
  const parsed = SaveProgressReportBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [existing] = await db.select().from(progressReportsTable).where(eq(progressReportsTable.invoiceId, id));
  let row;
  if (existing) {
    [row] = await db.update(progressReportsTable).set(parsed.data).where(eq(progressReportsTable.invoiceId, id)).returning();
  } else {
    [row] = await db.insert(progressReportsTable).values({ ...parsed.data, invoiceId: id }).returning();
  }
  await recordAudit({ action: "saved progress report", entityType: "invoice", entityId: id, description: `${row.percentComplete}% complete` });
  res.json(
    SaveProgressReportResponse.parse({
      id: row.id,
      invoiceId: row.invoiceId,
      percentComplete: row.percentComplete,
      summary: row.summary,
      workCompleted: row.workCompleted,
      workPlanned: row.workPlanned,
      issues: row.issues,
      scheduleStatus: row.scheduleStatus,
      budgetStatus: row.budgetStatus,
      preparedBy: row.preparedBy,
      reportDate: row.reportDate,
    }),
  );
});

export default router;
