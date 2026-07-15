import { Router, type IRouter } from "express";
import multer from "multer";
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
import { recomputeCarryOverWithAudit, deriveCarryOverFromPriors } from "../../lib/carryover";
import { evaluateBudgetStatus } from "../../lib/financials";
import { recordAudit } from "../../lib/audit";
import { upload, detectDocument, EXTENSION_FORMATS } from "../../lib/upload";
import { parseTimeFile } from "../../lib/timeimport";
import { getProcasConnection } from "../../lib/procas";
import { syncInvoiceFromProcas } from "../../lib/procasSync";
import { linesToLineItems, clearAutoImportedLineItems } from "../../lib/lineMapping";
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
  // or period), so re-derive downstream invoices' carried-forward totals and
  // record an audit trail of any invoices that were auto-updated as a result.
  await recomputeCarryOverWithAudit(row.workPlanId, {
    invoiceId: id,
    invoiceNumber: row.invoiceNumber,
    reason: "an edit to",
  });
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
  await recomputeCarryOverWithAudit(row.workPlanId, {
    invoiceId: id,
    invoiceNumber: row.invoiceNumber,
    reason: "the deletion of",
  });
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
  const ctx = await loadContext(id);
  if (!ctx) {
    res.status(404).json({ error: "Invoice not found" });
    return;
  }
  const { invoice: current } = ctx;
  if (current.status !== "draft" && current.status !== "in_review") {
    res.status(409).json({ error: `Cannot approve an invoice with status '${current.status}'.` });
    return;
  }
  // Hard stop on over-budget approval unless the biller explicitly overrides.
  // An over-budget invoice can only be approved when budgetOverride is set, and
  // the override (with any reason) is captured in the audit log below.
  const budget = evaluateBudgetStatus(buildInvoice(current, ctx.workPlan, ctx.lineItems).financials);
  if (budget.overBudget && !parsed.data.budgetOverride) {
    res.status(422).json({
      error:
        `This invoice is over budget (${budget.message} Remaining balance: ${budget.remainingBalance}). ` +
        `Approval requires an explicit budget override.`,
      code: "BUDGET_OVERRIDE_REQUIRED",
      budgetStatus: budget,
    });
    return;
  }
  // A budget override is a financial control — it must carry a non-blank
  // justification so the audit trail is meaningful.
  if (budget.overBudget && parsed.data.budgetOverride && !parsed.data.budgetOverrideReason?.trim()) {
    res.status(400).json({
      error: "A budget override requires a reason. Provide budgetOverrideReason explaining why this over-budget invoice is being approved.",
      code: "BUDGET_OVERRIDE_REASON_REQUIRED",
    });
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
  await recomputeCarryOverWithAudit(row.workPlanId, {
    invoiceId: id,
    invoiceNumber: row.invoiceNumber,
    reason: "the approval of",
  });
  const [wp] = await db.select().from(workPlansTable).where(eq(workPlansTable.id, row.workPlanId));
  const lineItems = await db.select().from(lineItemsTable).where(eq(lineItemsTable.invoiceId, id));
  await recordAudit({ action: "approved", entityType: "invoice", entityId: id, userName: parsed.data.approvedBy, description: `Invoice ${row.invoiceNumber}` });
  if (budget.overBudget && parsed.data.budgetOverride) {
    const reason = parsed.data.budgetOverrideReason?.trim();
    await recordAudit({
      action: "approved over budget",
      entityType: "invoice",
      entityId: id,
      userName: parsed.data.approvedBy,
      description:
        `Invoice ${row.invoiceNumber} approved over budget (${budget.percentExpended}% expended, ` +
        `remaining ${budget.remainingBalance}).` + (reason ? ` Reason: ${reason}` : ""),
    });
  }
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
      budgetUsedPercent: built.financials.budgetUsedPercent,
      budgetStatus: evaluateBudgetStatus(built.financials),
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
  const budget = evaluateBudgetStatus(built.financials);
  if (budget.level === "over") {
    flags.push({ severity: "warning", field: "budget", message: budget.message });
  } else if (budget.level === "approaching") {
    flags.push({ severity: "info", field: "budget", message: budget.message });
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

router.post(
  "/invoices/:id/time-import",
  (req, res, next) => {
    upload.single("file")(req, res, (err: unknown) => {
      if (err) {
        if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
          res.status(400).json({
            error: "File is too large. The maximum size is 25 MB.",
            code: "FILE_TOO_LARGE",
          });
          return;
        }
        next(err);
        return;
      }
      next();
    });
  },
  async (req, res): Promise<void> => {
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

  // First-pass extension allow-list, then verify the file's actual content
  // (magic bytes) matches the declared extension so a renamed/mislabeled file
  // can't slip past the parser.
  const ext = path.extname(file.originalname || "").toLowerCase();
  if (ext !== ".csv" && ext !== ".xlsx") {
    res.status(400).json({ error: "Unsupported file type. Upload a .csv or .xlsx file." });
    return;
  }
  const detected = detectDocument(file.buffer);
  if (ext === ".csv") {
    // CSV is plain text and has no magic bytes; reject binary documents
    // disguised with a .csv extension.
    if (detected !== null) {
      res.status(400).json({ error: "File content does not match its extension. Upload a genuine CSV text file." });
      return;
    }
  } else {
    const allowed = EXTENSION_FORMATS[ext] ?? [];
    if (!detected || !allowed.includes(detected)) {
      res.status(400).json({ error: "File content does not match its extension. Upload a genuine Excel (.xlsx) file." });
      return;
    }
  }

  const parsedFile = await parseTimeFile(file.buffer, file.originalname);
  if (parsedFile.lines.length === 0) {
    res.status(400).json({ error: "No valid rows found.", warnings: parsedFile.warnings });
    return;
  }

  const employees = await db.select().from(employeesTable);
  const { toInsert, warnings: mapWarnings } = linesToLineItems(parsedFile.lines, id, employees, source);
  const warnings = [...parsedFile.warnings, ...mapWarnings];

  // Replace any previously auto-imported rows so re-importing the same period
  // does not duplicate labor; hand-entered rows are preserved.
  const replacedCount = await clearAutoImportedLineItems(id);
  if (replacedCount > 0) {
    warnings.unshift(`Replaced ${replacedCount} previously imported line item(s) for this period.`);
  }

  const inserted = await db.insert(lineItemsTable).values(toInsert).returning();
  // Persist the warnings so billers can review them after a reload; each new
  // import replaces the previous set.
  await db.update(invoicesTable).set({ importWarnings: warnings }).where(eq(invoicesTable.id, id));
  // New labor changes this invoice's total-to-date; refresh downstream carry-over.
  await recomputeCarryOverWithAudit(ctx.invoice.workPlanId, {
    invoiceId: id,
    invoiceNumber: ctx.invoice.invoiceNumber,
    reason: "a time-data import into",
  });
  await recordAudit({ action: "imported time data", entityType: "invoice", entityId: id, description: `${inserted.length} line items from ${source}${replacedCount > 0 ? ` (replaced ${replacedCount})` : ""}` });

  res.json(
    ImportTimeDataResponse.parse({
      importedCount: inserted.length,
      replacedCount,
      source,
      warnings,
      lineItems: inserted.map(toApiLineItem),
    }),
  );
  },
);

// Live Procas pull: fetch timesheet records for this invoice's billing period
// directly from the connected Procas API and import them as line items.
router.post("/invoices/:id/procas-sync", async (req, res): Promise<void> => {
  const id = pid(req);
  const ctx = await loadContext(id);
  if (!ctx) {
    res.status(404).json({ error: "Invoice not found" });
    return;
  }

  const conn = await getProcasConnection();
  if (!conn || !conn.connected || !conn.companyCode || !conn.username || !conn.password) {
    res.status(409).json({ error: "Procas is not connected. Connect it first or use file upload." });
    return;
  }

  const result = await syncInvoiceFromProcas(ctx.invoice, conn, "procas");
  if (!result.ok) {
    if (result.reason === "fetch_failed") {
      res.status(502).json({ error: result.message });
    } else {
      res.status(400).json({ error: result.message, warnings: result.warnings });
    }
    return;
  }

  res.json(
    ImportTimeDataResponse.parse({
      importedCount: result.importedCount,
      replacedCount: result.replacedCount,
      source: "procas",
      warnings: result.warnings,
      lineItems: result.lineItems.map(toApiLineItem),
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
