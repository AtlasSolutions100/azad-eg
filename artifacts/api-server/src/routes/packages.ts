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
  type PackageDocKind,
  type PackageDocContext,
} from "../lib/packageDocs";
import { resolveSignaturePath } from "../lib/excel";
import { recordAudit } from "../lib/audit";

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
  const [row] = await db
    .insert(packagesTable)
    .values({
      employeeId: parsed.data.employeeId,
      workPlanId: parsed.data.workPlanId,
      payPeriodStart: parsed.data.payPeriodStart,
      payPeriodEnd: parsed.data.payPeriodEnd,
      invoiceNumber: parsed.data.invoiceNumber,
      invoiceDate: parsed.data.invoiceDate,
      previouslyBilled: parsed.data.previouslyBilled ?? 0,
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
  const [row] = await db.update(packagesTable).set(parsed.data).where(eq(packagesTable.id, id)).returning();
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
  res.json(UpdatePackageResponse.parse(toApiPackageSummary(row, emp, wp, weekCount, entries)));
});

router.delete("/packages/:id", async (req, res): Promise<void> => {
  const id = parseId(req.params.id);
  // Child rows (weeks, entries, progress report, overrides) are removed
  // atomically via ON DELETE CASCADE foreign keys.
  const [row] = await db.delete(packagesTable).where(eq(packagesTable.id, id)).returning();
  if (!row) {
    res.status(404).json({ error: "Package not found" });
    return;
  }
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
    if (rollup.remainingBalance < 0) {
      flags.push({ severity: "error", field: "budget", message: "Total billed to date exceeds the work plan budget." });
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

  await db
    .update(packagesTable)
    .set({ [DOC_STATUS_COLUMN[doc]]: "ready" })
    .where(eq(packagesTable.id, id));
  await recordAudit({
    action: "generated package document",
    entityType: "package",
    entityId: id,
    description: `${doc} ${parsed.data.format.toUpperCase()} ${filename}`,
  });

  res.json(
    GeneratePackageDocumentResponse.parse({
      url: `/api/files/${encodeURIComponent(filename)}`,
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
