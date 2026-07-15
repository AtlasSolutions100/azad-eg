import { Router, type IRouter } from "express";
import path from "node:path";
import { eq, and, asc } from "drizzle-orm";
import {
  db,
  packagesTable,
  packageWeeksTable,
  timesheetEntriesTable,
  packageProgressReportsTable,
  laborOverridesTable,
  employeesTable,
  workPlansTable,
  signaturesTable,
  type TimesheetEntryRow,
  type WorkPlan,
} from "@workspace/db";
import {
  CreatePackageBody,
  UpdatePackageBody,
  CreatePackageWeekBody,
  UpdatePackageWeekBody,
  CreateTimesheetEntryBody,
  UpdateTimesheetEntryBody,
  SavePackageProgressReportBody,
  SaveLaborOverrideBody,
  ListPackagesResponse,
  CreatePackageResponse,
  ListPackagesGroupedResponse,
  GetPackageResponse,
  UpdatePackageResponse,
  CreatePackageWeekResponse,
  UpdatePackageWeekResponse,
  CreateTimesheetEntryResponse,
  UpdateTimesheetEntryResponse,
  GetPackageProgressReportResponse,
  SavePackageProgressReportResponse,
  ListLaborOverridesResponse,
  SaveLaborOverrideResponse,
  GetPackageValidationsResponse,
  GetPackageRollupResponse,
  GeneratePackageDocumentBody,
  GeneratePackageDocumentResponse,
  ExportPackageResponse,
  UploadProgressReportFileResponse,
} from "@workspace/api-zod";
import {
  toApiPackageSummary,
  toApiWeek,
  toApiTimesheetEntry,
  toApiProgressReport,
  toApiOverride,
  buildPackageRollup,
  entryTotalHours,
} from "../lib/packageMappers";
import {
  generatePackageDocument,
  generatePackageZip,
  packageDocFileName,
  type PackageDocKind,
  type PackageDocContext,
} from "../lib/packageDocs";
import { resolveSignaturePath } from "../lib/excel";
import { evaluateBudgetStatus } from "../lib/financials";
import { getProcasConnection, credsFromConnection } from "../lib/procas";
import { fetchPreviouslyBilledFromProcas } from "../lib/procasSync";
import { recordAudit } from "../lib/audit";
import fs from "node:fs";
import { upload, detectDocument, EXTENSION_FORMATS } from "../lib/upload";
import { uploadsDir, ensureDirs, deleteUploadedFile } from "../lib/paths";

const DOC_KINDS: PackageDocKind[] = ["invoice", "subcalc", "progress", "labor", "timesheets"];

/** Per-document status column on the packages table, keyed by doc kind. */
const DOC_STATUS_COLUMN: Record<PackageDocKind, keyof typeof packagesTable.$inferInsert> = {
  invoice: "invoiceDocStatus",
  subcalc: "subCalcDocStatus",
  progress: "progressReportDocStatus",
  labor: "laborAttachmentDocStatus",
  timesheets: "timesheetsDocStatus",
};

/** Assembles everything the document generators need for a package. */
async function buildDocContext(packageId: number): Promise<PackageDocContext | null> {
  const [pkg] = await db.select().from(packagesTable).where(eq(packagesTable.id, packageId));
  if (!pkg) return null;
  const [emp] = await db.select().from(employeesTable).where(eq(employeesTable.id, pkg.employeeId));
  const [wp] = await db.select().from(workPlansTable).where(eq(workPlansTable.id, pkg.workPlanId));
  if (!emp || !wp) return null;
  const [weeks, entries, progressRows, overrides] = await Promise.all([
    db.select().from(packageWeeksTable).where(eq(packageWeeksTable.packageId, packageId)),
    db.select().from(timesheetEntriesTable).where(eq(timesheetEntriesTable.packageId, packageId)),
    db.select().from(packageProgressReportsTable).where(eq(packageProgressReportsTable.packageId, packageId)),
    db.select().from(laborOverridesTable).where(eq(laborOverridesTable.packageId, packageId)),
  ]);

  let signatureImagePath: string | null = null;
  if (pkg.signatureId) {
    const [sig] = await db.select().from(signaturesTable).where(eq(signaturesTable.id, pkg.signatureId));
    if (sig) signatureImagePath = resolveSignaturePath(sig.imageUrl);
  }

  return {
    pkg,
    employee: { name: emp.name, classification: emp.classification },
    workPlan: wp,
    weeks,
    entries,
    progress: progressRows[0] ?? null,
    overrides,
    signatureImagePath,
  };
}

const router: IRouter = Router();

function parseId(raw: string | string[]): number {
  return parseInt(Array.isArray(raw) ? raw[0] : raw, 10);
}

/** Loads the employee + work plan a package references, or null if missing. */
async function loadContext(pkg: { employeeId: number; workPlanId: number }) {
  const [emp, wp] = await Promise.all([
    db.select().from(employeesTable).where(eq(employeesTable.id, pkg.employeeId)).then((r) => r[0]),
    db.select().from(workPlansTable).where(eq(workPlansTable.id, pkg.workPlanId)).then((r) => r[0]),
  ]);
  return { emp, wp };
}

// ---------------------------------------------------------------------------
// Collection
// ---------------------------------------------------------------------------

router.get("/packages", async (req, res): Promise<void> => {
  const filters = [];
  if (req.query.employeeId) filters.push(eq(packagesTable.employeeId, parseId(req.query.employeeId as string)));
  if (req.query.workPlanId) filters.push(eq(packagesTable.workPlanId, parseId(req.query.workPlanId as string)));
  if (req.query.status) filters.push(eq(packagesTable.status, String(req.query.status)));

  const pkgs = await db
    .select()
    .from(packagesTable)
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(asc(packagesTable.id));

  const [employees, workPlans, weeks, entries] = await Promise.all([
    db.select().from(employeesTable),
    db.select().from(workPlansTable),
    db.select().from(packageWeeksTable),
    db.select().from(timesheetEntriesTable),
  ]);

  const empMap = new Map(employees.map((e) => [e.id, e]));
  const wpMap = new Map(workPlans.map((w) => [w.id, w]));
  const weekCountMap = new Map<number, number>();
  for (const w of weeks) weekCountMap.set(w.packageId, (weekCountMap.get(w.packageId) ?? 0) + 1);
  const entriesMap = new Map<number, TimesheetEntryRow[]>();
  for (const e of entries) {
    const arr = entriesMap.get(e.packageId) ?? [];
    arr.push(e);
    entriesMap.set(e.packageId, arr);
  }

  const summaries = pkgs
    .map((p) => {
      const emp = empMap.get(p.employeeId);
      const wp = wpMap.get(p.workPlanId);
      if (!emp || !wp) return null;
      return toApiPackageSummary(p, emp, wp, weekCountMap.get(p.id) ?? 0, entriesMap.get(p.id) ?? []);
    })
    .filter((s): s is NonNullable<typeof s> => s !== null);

  res.json(ListPackagesResponse.parse(summaries));
});

router.post("/packages", async (req, res): Promise<void> => {
  const parsed = CreatePackageBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { emp, wp } = await loadContext(parsed.data);
  if (!emp) {
    res.status(400).json({ error: "Employee not found" });
    return;
  }
  if (!wp) {
    res.status(400).json({ error: "Work plan not found" });
    return;
  }
  // Previously Billed default: an explicit value from the caller is a manual
  // entry; otherwise, when Procas is connected, default it from BillingHistory
  // (what Procas has already invoiced for this job before the period start).
  let previouslyBilled = parsed.data.previouslyBilled ?? 0;
  let previouslyBilledSource: string | null = parsed.data.previouslyBilled != null ? "manual" : null;
  if (parsed.data.previouslyBilled == null) {
    try {
      const conn = await getProcasConnection();
      const creds = conn?.connected ? credsFromConnection(conn) : null;
      if (creds) {
        const fromProcas = await fetchPreviouslyBilledFromProcas(
          creds,
          wp.jobNumber.trim(),
          parsed.data.payPeriodStart,
        );
        // BillingHistory is authoritative — including a legitimate $0.
        previouslyBilled = fromProcas;
        previouslyBilledSource = "procas";
      }
    } catch {
      // Procas being unreachable must never block package creation.
    }
  }

  const [row] = await db
    .insert(packagesTable)
    .values({
      employeeId: parsed.data.employeeId,
      workPlanId: parsed.data.workPlanId,
      payPeriodStart: parsed.data.payPeriodStart,
      payPeriodEnd: parsed.data.payPeriodEnd,
      invoiceNumber: parsed.data.invoiceNumber,
      invoiceDate: parsed.data.invoiceDate,
      previouslyBilled,
      previouslyBilledSource,
      otherDirectCosts: parsed.data.otherDirectCosts ?? 0,
      preparedBy: parsed.data.preparedBy,
    })
    .returning();
  await recordAudit({
    action: "created package",
    entityType: "package",
    entityId: row.id,
    description: `${emp.name} — ${wp.code} (${row.payPeriodStart} → ${row.payPeriodEnd})`,
  });
  res.status(201).json(CreatePackageResponse.parse(toApiPackageSummary(row, emp, wp, 0, [])));
});

router.get("/packages/grouped", async (_req, res): Promise<void> => {
  const [pkgs, employees, workPlans, weeks, entries] = await Promise.all([
    db.select().from(packagesTable).orderBy(asc(packagesTable.payPeriodStart)),
    db.select().from(employeesTable),
    db.select().from(workPlansTable),
    db.select().from(packageWeeksTable),
    db.select().from(timesheetEntriesTable),
  ]);

  const empMap = new Map(employees.map((e) => [e.id, e]));
  const wpMap = new Map(workPlans.map((w) => [w.id, w]));
  const weekCountMap = new Map<number, number>();
  for (const w of weeks) weekCountMap.set(w.packageId, (weekCountMap.get(w.packageId) ?? 0) + 1);
  const entriesMap = new Map<number, TimesheetEntryRow[]>();
  for (const e of entries) {
    const arr = entriesMap.get(e.packageId) ?? [];
    arr.push(e);
    entriesMap.set(e.packageId, arr);
  }

  type Summary = ReturnType<typeof toApiPackageSummary>;
  // employeeId -> workPlanId -> summaries
  const grouped = new Map<number, Map<number, Summary[]>>();
  for (const p of pkgs) {
    const emp = empMap.get(p.employeeId);
    const wp = wpMap.get(p.workPlanId);
    if (!emp || !wp) continue;
    const summary = toApiPackageSummary(p, emp, wp, weekCountMap.get(p.id) ?? 0, entriesMap.get(p.id) ?? []);
    const byJob = grouped.get(p.employeeId) ?? new Map<number, Summary[]>();
    const arr = byJob.get(p.workPlanId) ?? [];
    arr.push(summary);
    byJob.set(p.workPlanId, arr);
    grouped.set(p.employeeId, byJob);
  }

  const result = [...grouped.entries()].map(([employeeId, byJob]) => {
    const emp = empMap.get(employeeId)!;
    return {
      employeeId,
      employeeName: emp.name,
      jobs: [...byJob.entries()].map(([workPlanId, summaries]) => {
        const wp = wpMap.get(workPlanId)!;
        return {
          workPlanId,
          workPlanCode: wp.code,
          jobNumber: wp.jobNumber,
          client: wp.client,
          packages: summaries,
        };
      }),
    };
  });

  res.json(ListPackagesGroupedResponse.parse(result));
});

// ---------------------------------------------------------------------------
// Single package
// ---------------------------------------------------------------------------

router.get("/packages/:id", async (req, res): Promise<void> => {
  const id = parseId(req.params.id);
  const [pkg] = await db.select().from(packagesTable).where(eq(packagesTable.id, id));
  if (!pkg) {
    res.status(404).json({ error: "Package not found" });
    return;
  }
  const { emp, wp } = await loadContext(pkg);
  if (!emp || !wp) {
    res.status(404).json({ error: "Package references missing employee or work plan" });
    return;
  }
  const [weeks, entries, progress, overrides] = await Promise.all([
    db.select().from(packageWeeksTable).where(eq(packageWeeksTable.packageId, id)).orderBy(asc(packageWeeksTable.sortOrder), asc(packageWeeksTable.id)),
    db.select().from(timesheetEntriesTable).where(eq(timesheetEntriesTable.packageId, id)).orderBy(asc(timesheetEntriesTable.id)),
    db.select().from(packageProgressReportsTable).where(eq(packageProgressReportsTable.packageId, id)).then((r) => r[0]),
    db.select().from(laborOverridesTable).where(eq(laborOverridesTable.packageId, id)).orderBy(asc(laborOverridesTable.id)),
  ]);

  const rollup = buildPackageRollup(entries, wp, {
    previouslyBilled: pkg.previouslyBilled,
    otherDirectCosts: pkg.otherDirectCosts,
  });

  res.json(
    GetPackageResponse.parse({
      package: toApiPackageSummary(pkg, emp, wp, weeks.length, entries),
      weeks: weeks.map(toApiWeek),
      entries: entries.map(toApiTimesheetEntry),
      progressReport: progress ? toApiProgressReport(progress) : null,
      overrides: overrides.map(toApiOverride),
      rollup,
    }),
  );
});

router.patch("/packages/:id", async (req, res): Promise<void> => {
  const id = parseId(req.params.id);
  const parsed = UpdatePackageBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [existing] = await db.select().from(packagesTable).where(eq(packagesTable.id, id));
  if (!existing) {
    res.status(404).json({ error: "Package not found" });
    return;
  }
  // budgetOverride / budgetOverrideReason are approval-control flags, not stored
  // columns — pull them out so they never reach the db update.
  const { budgetOverride, budgetOverrideReason, ...updateFields } = parsed.data;

  // Editing Previously Billed by hand marks it as a manual override so future
  // Procas pulls never clobber Julie's value.
  const manualPrevBilled =
    updateFields.previouslyBilled != null && updateFields.previouslyBilled !== existing.previouslyBilled;

  // A package becomes "billed" the moment its status flips to approved. If that
  // transition pushes (or leaves) the package over its work plan budget, block
  // it unless the biller explicitly overrides, and record the override.
  const approving = updateFields.status === "approved" && existing.status !== "approved" && existing.status !== "exported";
  let overBudget: ReturnType<typeof evaluateBudgetStatus> | null = null;
  if (approving) {
    const [wpForBudget] = await db.select().from(workPlansTable).where(eq(workPlansTable.id, existing.workPlanId));
    if (wpForBudget) {
      const entries = await db.select().from(timesheetEntriesTable).where(eq(timesheetEntriesTable.packageId, id));
      const rollup = buildPackageRollup(entries, wpForBudget, {
        previouslyBilled: updateFields.previouslyBilled ?? existing.previouslyBilled,
        otherDirectCosts: updateFields.otherDirectCosts ?? existing.otherDirectCosts,
      });
      const budget = evaluateBudgetStatus(rollup);
      if (budget.overBudget) {
        if (!budgetOverride) {
          res.status(422).json({
            error:
              `This package is over budget (${budget.message} Remaining balance: ${budget.remainingBalance}). ` +
              `Approval requires an explicit budget override.`,
            code: "BUDGET_OVERRIDE_REQUIRED",
            budgetStatus: budget,
          });
          return;
        }
        overBudget = budget;
      }
    }
  }

  const [row] = await db
    .update(packagesTable)
    .set(manualPrevBilled ? { ...updateFields, previouslyBilledSource: "manual" } : updateFields)
    .where(eq(packagesTable.id, id))
    .returning();
  const { emp, wp } = await loadContext(row);
  if (!emp || !wp) {
    res.status(404).json({ error: "Package references missing employee or work plan" });
    return;
  }
  const [weekCount, entries] = await Promise.all([
    db.select().from(packageWeeksTable).where(eq(packageWeeksTable.packageId, id)).then((r) => r.length),
    db.select().from(timesheetEntriesTable).where(eq(timesheetEntriesTable.packageId, id)),
  ]);
  await recordAudit({ action: "updated package", entityType: "package", entityId: id });
  if (overBudget) {
    const reason = budgetOverrideReason?.trim();
    await recordAudit({
      action: "approved over budget",
      entityType: "package",
      entityId: id,
      userName: updateFields.approvedBy,
      description:
        `Package approved over budget (${overBudget.percentExpended}% expended, ` +
        `remaining ${overBudget.remainingBalance}).` + (reason ? ` Reason: ${reason}` : ""),
    });
  }
  res.json(UpdatePackageResponse.parse(toApiPackageSummary(row, emp, wp, weekCount, entries)));
});

router.delete("/packages/:id", async (req, res): Promise<void> => {
  const id = parseId(req.params.id);
  // Capture the attached progress-report file (if any) before the row is gone,
  // so we can clean it off disk after the cascade delete.
  const [progress] = await db
    .select()
    .from(packageProgressReportsTable)
    .where(eq(packageProgressReportsTable.packageId, id));
  // Child rows (weeks, entries, progress report, overrides) are removed
  // atomically via ON DELETE CASCADE foreign keys.
  const [row] = await db.delete(packagesTable).where(eq(packagesTable.id, id)).returning();
  if (!row) {
    res.status(404).json({ error: "Package not found" });
    return;
  }
  deleteUploadedFile(progress?.uploadedFileUrl);
  await recordAudit({ action: "deleted package", entityType: "package", entityId: id });
  res.sendStatus(204);
});

// ---------------------------------------------------------------------------
// Weeks
// ---------------------------------------------------------------------------

router.post("/packages/:id/weeks", async (req, res): Promise<void> => {
  const id = parseId(req.params.id);
  const [pkg] = await db.select().from(packagesTable).where(eq(packagesTable.id, id));
  if (!pkg) {
    res.status(404).json({ error: "Package not found" });
    return;
  }
  const parsed = CreatePackageWeekBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [row] = await db
    .insert(packageWeeksTable)
    .values({
      packageId: id,
      label: parsed.data.label,
      weekStart: parsed.data.weekStart,
      weekEnd: parsed.data.weekEnd,
      sortOrder: parsed.data.sortOrder ?? 0,
    })
    .returning();
  res.status(201).json(CreatePackageWeekResponse.parse(toApiWeek(row)));
});

router.patch("/packages/:id/weeks/:weekId", async (req, res): Promise<void> => {
  const id = parseId(req.params.id);
  const weekId = parseId(req.params.weekId);
  const parsed = UpdatePackageWeekBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [row] = await db
    .update(packageWeeksTable)
    .set(parsed.data)
    .where(and(eq(packageWeeksTable.id, weekId), eq(packageWeeksTable.packageId, id)))
    .returning();
  if (!row) {
    res.status(404).json({ error: "Week not found" });
    return;
  }
  res.json(UpdatePackageWeekResponse.parse(toApiWeek(row)));
});

router.delete("/packages/:id/weeks/:weekId", async (req, res): Promise<void> => {
  const id = parseId(req.params.id);
  const weekId = parseId(req.params.weekId);
  // Entries belonging to this week are removed via ON DELETE CASCADE.
  const [row] = await db
    .delete(packageWeeksTable)
    .where(and(eq(packageWeeksTable.id, weekId), eq(packageWeeksTable.packageId, id)))
    .returning();
  if (!row) {
    res.status(404).json({ error: "Week not found" });
    return;
  }
  res.sendStatus(204);
});

// ---------------------------------------------------------------------------
// Timesheet entries
// ---------------------------------------------------------------------------

router.post("/packages/:id/entries", async (req, res): Promise<void> => {
  const id = parseId(req.params.id);
  const [pkg] = await db.select().from(packagesTable).where(eq(packagesTable.id, id));
  if (!pkg) {
    res.status(404).json({ error: "Package not found" });
    return;
  }
  const parsed = CreateTimesheetEntryBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [week] = await db.select().from(packageWeeksTable).where(eq(packageWeeksTable.id, parsed.data.weekId));
  if (!week || week.packageId !== id) {
    res.status(400).json({ error: "Week does not belong to this package" });
    return;
  }
  const [row] = await db
    .insert(timesheetEntriesTable)
    .values({
      packageId: id,
      weekId: parsed.data.weekId,
      employeeId: parsed.data.employeeId,
      employeeName: parsed.data.employeeName,
      classification: parsed.data.classification,
      category: parsed.data.category,
      location: parsed.data.location,
      hoursMon: parsed.data.hoursMon ?? 0,
      hoursTue: parsed.data.hoursTue ?? 0,
      hoursWed: parsed.data.hoursWed ?? 0,
      hoursThu: parsed.data.hoursThu ?? 0,
      hoursFri: parsed.data.hoursFri ?? 0,
      hoursSat: parsed.data.hoursSat ?? 0,
      hoursSun: parsed.data.hoursSun ?? 0,
      rate: parsed.data.rate ?? 0,
      taskNo: parsed.data.taskNo,
      notes: parsed.data.notes,
    })
    .returning();
  res.status(201).json(CreateTimesheetEntryResponse.parse(toApiTimesheetEntry(row)));
});

router.patch("/packages/:id/entries/:entryId", async (req, res): Promise<void> => {
  const id = parseId(req.params.id);
  const entryId = parseId(req.params.entryId);
  const parsed = UpdateTimesheetEntryBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [existing] = await db
    .select()
    .from(timesheetEntriesTable)
    .where(and(eq(timesheetEntriesTable.id, entryId), eq(timesheetEntriesTable.packageId, id)));
  if (!existing) {
    res.status(404).json({ error: "Timesheet entry not found" });
    return;
  }
  if (parsed.data.weekId !== undefined) {
    const [week] = await db.select().from(packageWeeksTable).where(eq(packageWeeksTable.id, parsed.data.weekId));
    if (!week || week.packageId !== id) {
      res.status(400).json({ error: "Week does not belong to this package" });
      return;
    }
  }
  const [row] = await db
    .update(timesheetEntriesTable)
    .set(parsed.data)
    .where(and(eq(timesheetEntriesTable.id, entryId), eq(timesheetEntriesTable.packageId, id)))
    .returning();
  res.json(UpdateTimesheetEntryResponse.parse(toApiTimesheetEntry(row)));
});

router.delete("/packages/:id/entries/:entryId", async (req, res): Promise<void> => {
  const id = parseId(req.params.id);
  const entryId = parseId(req.params.entryId);
  const [row] = await db
    .delete(timesheetEntriesTable)
    .where(and(eq(timesheetEntriesTable.id, entryId), eq(timesheetEntriesTable.packageId, id)))
    .returning();
  if (!row) {
    res.status(404).json({ error: "Timesheet entry not found" });
    return;
  }
  res.sendStatus(204);
});

// ---------------------------------------------------------------------------
// Progress report
// ---------------------------------------------------------------------------

router.get("/packages/:id/progress-report", async (req, res): Promise<void> => {
  const id = parseId(req.params.id);
  const [report] = await db.select().from(packageProgressReportsTable).where(eq(packageProgressReportsTable.packageId, id));
  if (!report) {
    res.status(404).json({ error: "Progress report not found" });
    return;
  }
  res.json(GetPackageProgressReportResponse.parse(toApiProgressReport(report)));
});

router.put("/packages/:id/progress-report", async (req, res): Promise<void> => {
  const id = parseId(req.params.id);
  const [pkg] = await db.select().from(packagesTable).where(eq(packagesTable.id, id));
  if (!pkg) {
    res.status(404).json({ error: "Package not found" });
    return;
  }
  const parsed = SavePackageProgressReportBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [existing] = await db.select().from(packageProgressReportsTable).where(eq(packageProgressReportsTable.packageId, id));
  let row;
  if (existing) {
    // When the attachment is replaced (new URL) or cleared (empty/null), remove
    // the previously stored file so it doesn't linger as an orphan on disk.
    const nextUrl = parsed.data.uploadedFileUrl;
    if (
      existing.uploadedFileUrl &&
      nextUrl !== undefined &&
      nextUrl !== existing.uploadedFileUrl
    ) {
      deleteUploadedFile(existing.uploadedFileUrl);
    }
    [row] = await db
      .update(packageProgressReportsTable)
      .set(parsed.data)
      .where(eq(packageProgressReportsTable.packageId, id))
      .returning();
  } else {
    [row] = await db
      .insert(packageProgressReportsTable)
      .values({
        packageId: id,
        percentComplete: parsed.data.percentComplete ?? 0,
        summary: parsed.data.summary ?? "",
        workPerformed: parsed.data.workPerformed,
        concerns: parsed.data.concerns,
        correctiveAction: parsed.data.correctiveAction,
        scheduleComment: parsed.data.scheduleComment,
        costForecast: parsed.data.costForecast,
        preparedBy: parsed.data.preparedBy,
        reportDate: parsed.data.reportDate,
        uploadedFileUrl: parsed.data.uploadedFileUrl,
        uploadedFileName: parsed.data.uploadedFileName,
      })
      .returning();
  }
  res.json(SavePackageProgressReportResponse.parse(toApiProgressReport(row)));
});

// Documents that may be attached as a progress-report narrative. Anything else
// is rejected so untrusted uploads can't smuggle an executable type past the
// /api/files serving route.
const PROGRESS_REPORT_EXTENSIONS = new Set([".xlsx", ".xls", ".doc", ".docx", ".pdf"]);

router.post(
  "/packages/:id/progress-report/upload",
  upload.single("file"),
  async (req, res): Promise<void> => {
    const id = parseId(req.params.id);
    const [pkg] = await db.select().from(packagesTable).where(eq(packagesTable.id, id));
    if (!pkg) {
      res.status(404).json({ error: "Package not found" });
      return;
    }
    const file = (req as unknown as { file?: { buffer: Buffer; originalname: string } }).file;
    if (!file) {
      res.status(400).json({ error: "No file uploaded (expected an Excel, Word, or PDF in field 'file')." });
      return;
    }
    const originalName = path.basename(file.originalname);
    const ext = path.extname(originalName).toLowerCase();
    if (!PROGRESS_REPORT_EXTENSIONS.has(ext)) {
      res.status(400).json({ error: "Unsupported file type. Upload an Excel, Word, or PDF document." });
      return;
    }
    // Content-based check: confirm the bytes really are the document type the
    // extension claims, so a renamed/mislabeled file can't slip past the
    // extension allow-list above.
    const detected = detectDocument(file.buffer);
    if (!detected || !EXTENSION_FORMATS[ext]?.includes(detected)) {
      res.status(400).json({
        error: "File content does not match its extension. Upload a genuine Excel, Word, or PDF document.",
      });
      return;
    }
    ensureDirs();
    const filename = `progress_${id}_${Date.now()}${ext}`;
    fs.writeFileSync(path.resolve(uploadsDir, filename), file.buffer);

    res.json(
      UploadProgressReportFileResponse.parse({
        uploadedFileUrl: `/api/files/${encodeURIComponent(filename)}`,
        uploadedFileName: originalName,
      }),
    );
  },
);

// ---------------------------------------------------------------------------
// Labor attachment overrides
// ---------------------------------------------------------------------------

router.get("/packages/:id/overrides", async (req, res): Promise<void> => {
  const id = parseId(req.params.id);
  const rows = await db.select().from(laborOverridesTable).where(eq(laborOverridesTable.packageId, id)).orderBy(asc(laborOverridesTable.id));
  res.json(ListLaborOverridesResponse.parse(rows.map(toApiOverride)));
});

router.put("/packages/:id/overrides", async (req, res): Promise<void> => {
  const id = parseId(req.params.id);
  const [pkg] = await db.select().from(packagesTable).where(eq(packagesTable.id, id));
  if (!pkg) {
    res.status(404).json({ error: "Package not found" });
    return;
  }
  const parsed = SaveLaborOverrideBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [row] = await db
    .insert(laborOverridesTable)
    .values({ packageId: id, cellKey: parsed.data.cellKey, value: parsed.data.value, editedBy: parsed.data.editedBy })
    .onConflictDoUpdate({
      target: [laborOverridesTable.packageId, laborOverridesTable.cellKey],
      set: { value: parsed.data.value, editedBy: parsed.data.editedBy },
    })
    .returning();
  res.json(SaveLaborOverrideResponse.parse(toApiOverride(row)));
});

router.delete("/packages/:id/overrides/:cellKey", async (req, res): Promise<void> => {
  const id = parseId(req.params.id);
  const cellKey = Array.isArray(req.params.cellKey) ? req.params.cellKey[0] : req.params.cellKey;
  const [row] = await db
    .delete(laborOverridesTable)
    .where(and(eq(laborOverridesTable.packageId, id), eq(laborOverridesTable.cellKey, cellKey)))
    .returning();
  if (!row) {
    res.status(404).json({ error: "Override not found" });
    return;
  }
  res.sendStatus(204);
});

// ---------------------------------------------------------------------------
// Rollup + validations
// ---------------------------------------------------------------------------

router.get("/packages/:id/rollup", async (req, res): Promise<void> => {
  const id = parseId(req.params.id);
  const [pkg] = await db.select().from(packagesTable).where(eq(packagesTable.id, id));
  if (!pkg) {
    res.status(404).json({ error: "Package not found" });
    return;
  }
  const [wp] = await db.select().from(workPlansTable).where(eq(workPlansTable.id, pkg.workPlanId));
  if (!wp) {
    res.status(404).json({ error: "Work plan not found" });
    return;
  }
  const entries = await db.select().from(timesheetEntriesTable).where(eq(timesheetEntriesTable.packageId, id));
  const rollup = buildPackageRollup(entries, wp, {
    previouslyBilled: pkg.previouslyBilled,
    otherDirectCosts: pkg.otherDirectCosts,
  });
  res.json(GetPackageRollupResponse.parse(rollup));
});

router.get("/packages/:id/validations", async (req, res): Promise<void> => {
  const id = parseId(req.params.id);
  const [pkg] = await db.select().from(packagesTable).where(eq(packagesTable.id, id));
  if (!pkg) {
    res.status(404).json({ error: "Package not found" });
    return;
  }
  const [wp] = await db.select().from(workPlansTable).where(eq(workPlansTable.id, pkg.workPlanId));
  const [weeks, entries] = await Promise.all([
    db.select().from(packageWeeksTable).where(eq(packageWeeksTable.packageId, id)),
    db.select().from(timesheetEntriesTable).where(eq(timesheetEntriesTable.packageId, id)),
  ]);

  const flags: { severity: "error" | "warning" | "info"; field?: string | null; message: string }[] = [];

  if (!pkg.invoiceNumber) {
    flags.push({ severity: "warning", field: "invoiceNumber", message: "Invoice number is not set." });
  }
  if (!pkg.invoiceDate) {
    flags.push({ severity: "warning", field: "invoiceDate", message: "Invoice date is not set." });
  }
  if (weeks.length === 0) {
    flags.push({ severity: "error", field: "weeks", message: "Package has no weeks." });
  }
  if (entries.length === 0) {
    flags.push({ severity: "error", field: "entries", message: "Package has no timesheet entries." });
  }
  for (const e of entries) {
    if (entryTotalHours(e) <= 0) {
      flags.push({ severity: "warning", field: "entries", message: `${e.employeeName} has an entry with zero hours.` });
    }
    if (e.rate <= 0) {
      flags.push({ severity: "warning", field: "entries", message: `${e.employeeName} has an entry with a zero rate.` });
    }
  }

  if (wp) {
    const rollup = buildPackageRollup(entries, wp, {
      previouslyBilled: pkg.previouslyBilled,
      otherDirectCosts: pkg.otherDirectCosts,
    });
    const budget = evaluateBudgetStatus(rollup);
    if (budget.overBudget) {
      // Over budget is a warning (not a blocking error): approval is still
      // possible, but only with an explicit budget override that is audited.
      flags.push({ severity: "warning", field: "budget", message: "Total billed to date exceeds the work plan budget." });
    } else if (budget.level === "approaching") {
      flags.push({ severity: "info", field: "budget", message: budget.message });
    }
  } else {
    flags.push({ severity: "error", field: "workPlan", message: "Package references a missing work plan." });
  }

  const isValid = !flags.some((f) => f.severity === "error");
  res.json(GetPackageValidationsResponse.parse({ packageId: id, isValid, flags }));
});

// ---------------------------------------------------------------------------
// Document generation + export
// ---------------------------------------------------------------------------

router.post("/packages/:id/documents/:doc/generate", async (req, res): Promise<void> => {
  const id = parseId(req.params.id);
  const doc = (Array.isArray(req.params.doc) ? req.params.doc[0] : req.params.doc) as PackageDocKind;
  if (!DOC_KINDS.includes(doc)) {
    res.status(400).json({ error: `Unknown document type: ${doc}` });
    return;
  }
  const parsed = GeneratePackageDocumentBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const ctx = await buildDocContext(id);
  if (!ctx) {
    res.status(404).json({ error: "Package not found" });
    return;
  }

  const outPath = await generatePackageDocument(ctx, doc, parsed.data.format);
  const filename = path.basename(outPath);
  // Friendly, identifiable download name (EmployeeName_Job#_DocumentName.ext).
  // The on-disk file keeps its unique name to avoid collisions; the file route
  // honors the `download` query param for the Content-Disposition filename.
  const downloadName = packageDocFileName(ctx, doc, parsed.data.format);

  await db
    .update(packagesTable)
    .set({ [DOC_STATUS_COLUMN[doc]]: "ready" })
    .where(eq(packagesTable.id, id));
  await recordAudit({
    action: "generated package document",
    entityType: "package",
    entityId: id,
    description: `${doc} ${parsed.data.format.toUpperCase()} ${downloadName}`,
  });

  res.json(
    GeneratePackageDocumentResponse.parse({
      url: `/api/files/${encodeURIComponent(filename)}?download=${encodeURIComponent(downloadName)}`,
      filename,
      format: parsed.data.format,
    }),
  );
});

router.post("/packages/:id/export", async (req, res): Promise<void> => {
  const id = parseId(req.params.id);
  const ctx = await buildDocContext(id);
  if (!ctx) {
    res.status(404).json({ error: "Package not found" });
    return;
  }

  const result = await generatePackageZip(ctx);

  await db
    .update(packagesTable)
    .set({
      status: ctx.pkg.status === "approved" ? "exported" : ctx.pkg.status,
      invoiceDocStatus: "ready",
      subCalcDocStatus: "ready",
      progressReportDocStatus: "ready",
      laborAttachmentDocStatus: "ready",
      timesheetsDocStatus: "ready",
    })
    .where(eq(packagesTable.id, id));
  await recordAudit({
    action: "exported package",
    entityType: "package",
    entityId: id,
    description: `ZIP ${result.zipName} (${result.documents.length} files)`,
  });

  res.json(
    ExportPackageResponse.parse({
      url: `/api/files/${encodeURIComponent(result.zipName)}`,
      filename: result.zipName,
      documentCount: result.documents.length,
      documents: result.documents.map((d) => ({
        doc: d.doc,
        filename: d.filename,
        format: d.format,
      })),
    }),
  );
});

export default router;
