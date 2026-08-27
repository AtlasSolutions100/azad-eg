import { Router, type IRouter } from "express";
import multer from "multer";
import path from "node:path";
import { eq, and, asc, desc, inArray, isNotNull } from "drizzle-orm";
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
  ListBilledLineItemsResponse,
  ReplaceBilledLineItemsBody,
  ReplaceBilledLineItemsResponse,
  PullPackageHoursFromProcasResponse,
  CheckPackageTieOutWithProcasResponse,
  FillPackagePtoTo40Body as FillPtoBody,
  FillPackagePtoTo40Response,
} from "@workspace/api-zod";
import {
  listBilledLineItems,
  replaceBilledLineItems,
  seedBilledLineItemsFromLastApproved,
  toApiBilledLineItem,
  computeBillingSummary,
} from "../lib/billedLineItems";
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
import { fetchPreviouslyBilledFromProcas, fetchBillingRatesFromProcas } from "../lib/procasSync";
import { effectiveWorkPlan, cappedBillRate } from "../lib/billingProfile";
import { deriveBillingPeriod, type BillingCycle } from "../lib/billingPeriod";
import { computePtoFill, totalDayHours } from "../lib/ptoFill";
import { bumpInvoiceNumber } from "../lib/invoiceNumber";
import { pullPackageHoursFromProcas } from "../lib/procasPackageSync";
import { recordAudit } from "../lib/audit";
import { resolveEmployeeIdByName } from "../lib/employeeResolve";
import { canDeletePackages } from "../lib/packageDeletePermission";
import { effectiveRate, loadRateChanges } from "../lib/employeeRates";
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
  const emp =
    pkg.employeeId != null
      ? await db.select().from(employeesTable).where(eq(employeesTable.id, pkg.employeeId)).then((r) => r[0] ?? null)
      : null;
  const wp =
    pkg.workPlanId != null
      ? await db.select().from(workPlansTable).where(eq(workPlansTable.id, pkg.workPlanId)).then((r) => r[0] ?? null)
      : null;
  const [weeks, entries, progressRows, overrides, billedLineItems] = await Promise.all([
    db.select().from(packageWeeksTable).where(eq(packageWeeksTable.packageId, packageId)),
    db.select().from(timesheetEntriesTable).where(eq(timesheetEntriesTable.packageId, packageId)),
    db.select().from(packageProgressReportsTable).where(eq(packageProgressReportsTable.packageId, packageId)),
    db.select().from(laborOverridesTable).where(eq(laborOverridesTable.packageId, packageId)),
    listBilledLineItems(packageId),
  ]);

  let signatureImagePath: string | null = null;
  if (pkg.signatureId) {
    const [sig] = await db.select().from(signaturesTable).where(eq(signaturesTable.id, pkg.signatureId));
    if (sig) signatureImagePath = resolveSignaturePath(sig.imageUrl);
  }

  // Packages may not have a work plan yet — documents then render with the
  // package-level billing profile and blank contract fields.
  const view = effectiveWorkPlan(pkg, wp);
  // Apply the Max Bill Rate cap once, here, so every export engine bills capped
  // rates without each re-implementing it. (The on-screen rollup caps too.)
  const cappedEntries = entries.map((e) => ({
    ...e,
    rate: cappedBillRate(e.rate, view.maxBillRate),
  }));

  return {
    // `pkg` is the full packages row, so it carries `prime` (e.g. "WSP",
    // "AECOM"). The document generators (generateCombinedWorkbook /
    // generateMergedPdf) read `ctx.pkg.prime` to pick the WSP vs AECOM engine,
    // so it must flow through here unchanged.
    pkg,
    employee: emp ? { name: emp.name, classification: emp.classification } : null,
    workPlan: view,
    weeks,
    entries: cappedEntries,
    progress: progressRows[0] ?? null,
    overrides,
    signatureImagePath,
    billedLineItems,
  };
}

const router: IRouter = Router();

function parseId(raw: string | string[]): number {
  return parseInt(Array.isArray(raw) ? raw[0] : raw, 10);
}

/**
 * Loads the work plan a package references (null when the package was started
 * before its work plan exists) plus the legacy primary employee when one is
 * set. `emp` is null for job-level packages whose contributors come solely
 * from timesheet entries.
 */
async function loadContext(pkg: { employeeId: number | null; workPlanId: number | null }) {
  const [emp, wp] = await Promise.all([
    pkg.employeeId == null
      ? Promise.resolve(null)
      : db.select().from(employeesTable).where(eq(employeesTable.id, pkg.employeeId)).then((r) => r[0] ?? null),
    pkg.workPlanId == null
      ? Promise.resolve(null)
      : db.select().from(workPlansTable).where(eq(workPlansTable.id, pkg.workPlanId)).then((r) => r[0] ?? null),
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

  const summaries = pkgs.map((p) => {
    const emp = p.employeeId != null ? empMap.get(p.employeeId) ?? null : null;
    const wp = p.workPlanId != null ? wpMap.get(p.workPlanId) ?? null : null;
    return toApiPackageSummary(p, emp, effectiveWorkPlan(p, wp), weekCountMap.get(p.id) ?? 0, entriesMap.get(p.id) ?? []);
  });

  res.json(ListPackagesResponse.parse(summaries));
});

router.post("/packages", async (req, res): Promise<void> => {
  const parsed = CreatePackageBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { emp, wp } = await loadContext({
    employeeId: parsed.data.employeeId ?? null,
    workPlanId: parsed.data.workPlanId ?? null,
  });
  if (parsed.data.employeeId != null && !emp) {
    res.status(400).json({ error: "Employee not found" });
    return;
  }
  if (parsed.data.workPlanId != null && !wp) {
    res.status(400).json({ error: "Work plan not found" });
    return;
  }
  // A work plan is optional — a package can be started before its work plan
  // exists, anchored to a Procas job instead. But it needs at least one of
  // the two so billing has something to hang off.
  const procasProject = parsed.data.procasProject?.trim() || null;
  if (!wp && !procasProject) {
    res.status(400).json({
      error: "Pick a work plan or a Procas job number so the package knows what it bills against.",
    });
    return;
  }
  const billingJob = wp ? wp.jobNumber.trim() : procasProject;

  // Resolve the service period. Explicit dates always win; otherwise derive
  // them from `billingMonth` (YYYY-MM) and the work plan's billing cycle, so the
  // biller can create a package for "May 2026" without hand-typing the Sat→Fri
  // boundary dates.
  let payPeriodStart = parsed.data.payPeriodStart;
  let payPeriodEnd = parsed.data.payPeriodEnd;
  if (!payPeriodStart || !payPeriodEnd) {
    const bm = parsed.data.billingMonth?.trim();
    if (!bm || !/^\d{4}-\d{2}$/.test(bm)) {
      res.status(400).json({
        error:
          "Provide payPeriodStart and payPeriodEnd, or a billingMonth (YYYY-MM) to derive the service period.",
      });
      return;
    }
    const [y, mo] = bm.split("-").map(Number);
    const cycle: BillingCycle = wp?.billingCycle === "last_friday" ? "last_friday" : "whole_month";
    const period = deriveBillingPeriod(y, mo, cycle);
    payPeriodStart = payPeriodStart || period.start;
    payPeriodEnd = payPeriodEnd || period.end;
  }

  // Invoice number: keep an explicit value; otherwise auto-suggest the next one
  // by bumping the trailing number on the work plan's most recent invoice
  // (prefix stays constant, suffix increments). The biller can still edit it.
  let invoiceNumber = parsed.data.invoiceNumber;
  if (!invoiceNumber && parsed.data.workPlanId != null) {
    const [prev] = await db
      .select({ n: packagesTable.invoiceNumber })
      .from(packagesTable)
      .where(
        and(
          eq(packagesTable.workPlanId, parsed.data.workPlanId),
          isNotNull(packagesTable.invoiceNumber),
        ),
      )
      .orderBy(desc(packagesTable.createdAt))
      .limit(1);
    invoiceNumber = bumpInvoiceNumber(prev?.n) ?? invoiceNumber;
  }

  const conn = await getProcasConnection().catch(() => null);
  const creds = conn?.connected ? credsFromConnection(conn) : null;

  // Rate overrides: explicit values from the caller win. For work-plan-less
  // packages with no explicit rates, pre-fill from Procas Billing Setup so
  // the invoice math starts from the authoritative percentages.
  let { fringeRate, overheadRate, fixedFeeRate, fccmRate } = parsed.data;
  let clientName = parsed.data.clientName?.trim() || null;
  const noExplicitRates =
    fringeRate == null && overheadRate == null && fixedFeeRate == null && fccmRate == null;
  if (!wp && procasProject && creds && (noExplicitRates || !clientName)) {
    try {
      const rates = await fetchBillingRatesFromProcas(creds, procasProject);
      if (rates) {
        if (noExplicitRates) {
          fringeRate = rates.fringeRate ?? undefined;
          overheadRate = rates.overheadRate ?? undefined;
          fixedFeeRate = rates.fixedFeeRate ?? undefined;
          fccmRate = rates.fccmRate ?? undefined;
        }
        if (!clientName) clientName = rates.client;
      }
    } catch {
      // Procas being unreachable must never block package creation.
    }
  }

  // Previously Billed default, in priority order:
  //   1. an explicit value from the caller (manual entry)
  //   2. carry-forward: Total Billed To Date of the last approved/exported
  //      package for the same work plan — matches the previous approved invoice
  //   3. Procas BillingHistory (what Procas already invoiced before the start)
  let previouslyBilled = parsed.data.previouslyBilled ?? 0;
  let previouslyBilledSource: string | null = parsed.data.previouslyBilled != null ? "manual" : null;
  if (previouslyBilledSource == null && parsed.data.workPlanId != null) {
    const carried = await carryForwardPreviouslyBilled(parsed.data.workPlanId);
    if (carried != null) {
      previouslyBilled = carried;
      previouslyBilledSource = "carryforward";
    }
  }
  if (previouslyBilledSource == null && billingJob) {
    try {
      if (creds) {
        const fromProcas = await fetchPreviouslyBilledFromProcas(creds, billingJob);
        // BillingHistory is authoritative — including a legitimate $0.
        previouslyBilled = fromProcas;
        previouslyBilledSource = "procas";
      }
    } catch {
      // Procas being unreachable must never block package creation.
    }
  }

  let row: typeof packagesTable.$inferSelect;
  try {
    [row] = await db
      .insert(packagesTable)
      .values({
        employeeId: parsed.data.employeeId ?? null,
        workPlanId: parsed.data.workPlanId ?? null,
        procasProject,
        clientName,
        owner: parsed.data.owner?.trim() || null,
        prime: parsed.data.prime?.trim() || null,
        totalBudget: parsed.data.totalBudget ?? null,
        fringeRate: fringeRate ?? null,
        overheadRate: overheadRate ?? null,
        fixedFeeRate: fixedFeeRate ?? null,
        fccmRate: fccmRate ?? null,
        payPeriodStart,
        payPeriodEnd,
        invoiceNumber,
        invoiceDate: parsed.data.invoiceDate,
        previouslyBilled,
        previouslyBilledSource,
        otherDirectCosts: parsed.data.otherDirectCosts ?? 0,
        preparedBy: parsed.data.preparedBy,
      })
      .returning();
  } catch (err) {
    // packages_job_period_unique: one invoice/package per job per pay period.
    // Drizzle may wrap the driver error, so walk the cause chain for 23505.
    const isUniqueViolation = (e: unknown): boolean => {
      for (let cur = e; cur instanceof Error; cur = cur.cause) {
        if ((cur as { code?: string }).code === "23505") return true;
      }
      return false;
    };
    if (isUniqueViolation(err)) {
      res.status(409).json({
        error: "A package already exists for this work plan and pay period.",
      });
      return;
    }
    throw err;
  }
  const view = effectiveWorkPlan(row, wp);
  // Mandatory per-line carry-forward: pull Billed Line Items forward from the
  // last approved invoice for this work plan (Previous += prior Total,
  // Current resets to 0). Carry-forward is part of the creation contract — if
  // seed data exists but cannot be applied, creation must fail rather than
  // silently produce a package with wrong Previous Invoiced figures. Only
  // applies when a work plan is linked — work-plan-less packages have no
  // prior approved invoices to carry from.
  if (row.workPlanId != null) {
    try {
      const seeded = await seedBilledLineItemsFromLastApproved(row.id, row.workPlanId);
      if (seeded.length > 0) {
        await recordAudit({
          action: "carried forward billed line items",
          entityType: "package",
          entityId: row.id,
          description: `${seeded.length} line item(s) carried forward from the last approved ${view.code} invoice`,
        });
      }
    } catch (err) {
      // Roll back the freshly created package so a retry starts clean.
      await db.delete(packagesTable).where(eq(packagesTable.id, row.id));
      throw err;
    }
  }
  await recordAudit({
    action: "created package",
    entityType: "package",
    entityId: row.id,
    description: `${emp ? `${emp.name} — ` : ""}${view.code} (${row.payPeriodStart} → ${row.payPeriodEnd})`,
  });
  res.status(201).json(CreatePackageResponse.parse(toApiPackageSummary(row, emp, view, 0, [])));
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
  type JobGroup = {
    workPlanId: number;
    workPlanCode: string;
    jobNumber: string;
    client: string;
    packages: Summary[];
  };
  // client -> job key -> group (job-first: each package is one invoice for a
  // job; contributing employees live inside the summary). Packages without a
  // work plan group by their Procas job under the package's client name, with
  // workPlanId 0 marking "no work plan yet".
  const grouped = new Map<string, Map<string, JobGroup>>();
  for (const p of pkgs) {
    const emp = p.employeeId != null ? empMap.get(p.employeeId) ?? null : null;
    const wp = p.workPlanId != null ? wpMap.get(p.workPlanId) ?? null : null;
    const view = effectiveWorkPlan(p, wp);
    const summary = toApiPackageSummary(p, emp, view, weekCountMap.get(p.id) ?? 0, entriesMap.get(p.id) ?? []);
    const jobKey = wp ? `wp:${wp.id}` : `job:${view.jobNumber}`;
    const byJob = grouped.get(view.client) ?? new Map<string, JobGroup>();
    const group =
      byJob.get(jobKey) ??
      {
        workPlanId: wp ? wp.id : 0,
        workPlanCode: view.code,
        jobNumber: view.jobNumber,
        client: view.client,
        packages: [],
      };
    group.packages.push(summary);
    byJob.set(jobKey, group);
    grouped.set(view.client, byJob);
  }

  const result = [...grouped.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([client, byJob]) => ({
      client,
      jobs: [...byJob.values()].sort((a, b) => a.jobNumber.localeCompare(b.jobNumber)),
    }));

  res.json(ListPackagesGroupedResponse.parse(result));
});

// ---------------------------------------------------------------------------
// Single package
// ---------------------------------------------------------------------------

/**
 * Total Billed To Date of the most recent approved/exported package for a
 * work plan — the authoritative Previously Billed for the next package, so
 * each new period carries forward exactly what the last approved invoice
 * billed (Previously Billed + This Period).
 */
async function carryForwardPreviouslyBilled(workPlanId: number): Promise<number | null> {
  const [prior] = await db
    .select()
    .from(packagesTable)
    .where(
      and(
        eq(packagesTable.workPlanId, workPlanId),
        inArray(packagesTable.status, ["approved", "exported"]),
      ),
    )
    .orderBy(desc(packagesTable.payPeriodEnd), desc(packagesTable.id))
    .limit(1);
  if (!prior) return null;
  const [wp] = await db.select().from(workPlansTable).where(eq(workPlansTable.id, workPlanId));
  const entries = await db
    .select()
    .from(timesheetEntriesTable)
    .where(eq(timesheetEntriesTable.packageId, prior.id));
  const rollup = buildPackageRollup(entries, effectiveWorkPlan(prior, wp ?? null), {
    previouslyBilled: prior.previouslyBilled,
    otherDirectCosts: prior.otherDirectCosts,
  });
  return rollup.totalToDate;
}

router.get("/packages/:id", async (req, res): Promise<void> => {
  const id = parseId(req.params.id);
  const [pkg] = await db.select().from(packagesTable).where(eq(packagesTable.id, id));
  if (!pkg) {
    res.status(404).json({ error: "Package not found" });
    return;
  }
  const { emp, wp } = await loadContext(pkg);
  const view = effectiveWorkPlan(pkg, wp);
  const [weeks, entries, progress, overrides, billedItems] = await Promise.all([
    db.select().from(packageWeeksTable).where(eq(packageWeeksTable.packageId, id)).orderBy(asc(packageWeeksTable.sortOrder), asc(packageWeeksTable.id)),
    db.select().from(timesheetEntriesTable).where(eq(timesheetEntriesTable.packageId, id)).orderBy(asc(timesheetEntriesTable.id)),
    db.select().from(packageProgressReportsTable).where(eq(packageProgressReportsTable.packageId, id)).then((r) => r[0]),
    db.select().from(laborOverridesTable).where(eq(laborOverridesTable.packageId, id)).orderBy(asc(laborOverridesTable.id)),
    listBilledLineItems(id),
  ]);

  const rollup = buildPackageRollup(entries, view, {
    previouslyBilled: pkg.previouslyBilled,
    otherDirectCosts: pkg.otherDirectCosts,
  });

  res.json(
    GetPackageResponse.parse({
      package: toApiPackageSummary(pkg, emp, view, weeks.length, entries),
      billedLineItems: billedItems.map(toApiBilledLineItem),
      billingSummary: computeBillingSummary(billedItems),
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
  // Attaching (or switching) a work plan must point at a real one.
  if (updateFields.workPlanId != null) {
    const [wpNew] = await db.select().from(workPlansTable).where(eq(workPlansTable.id, updateFields.workPlanId));
    if (!wpNew) {
      res.status(400).json({ error: "Work plan not found" });
      return;
    }
  }

  const approving = updateFields.status === "approved" && existing.status !== "approved" && existing.status !== "exported";
  let overBudget: ReturnType<typeof evaluateBudgetStatus> | null = null;
  if (approving) {
    const budgetWpId = updateFields.workPlanId ?? existing.workPlanId;
    const wpForBudget =
      budgetWpId != null
        ? await db.select().from(workPlansTable).where(eq(workPlansTable.id, budgetWpId)).then((r) => r[0] ?? null)
        : null;
    // Evaluate the budget against the package state this PATCH will produce,
    // not the pre-update row — the same call may change the budget or rates.
    const prospective = { ...existing, ...updateFields };
    const budgetView = effectiveWorkPlan(prospective, wpForBudget);
    // Budget gate only applies when a budget is actually tracked; a
    // work-plan-less package with no known ceiling can't be "over budget".
    if (budgetView.totalBudget > 0) {
      const entries = await db.select().from(timesheetEntriesTable).where(eq(timesheetEntriesTable.packageId, id));
      const rollup = buildPackageRollup(entries, budgetView, {
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
        // A budget override is a financial control — it must carry a non-blank
        // justification so the audit trail is meaningful.
        if (!budgetOverrideReason?.trim()) {
          res.status(400).json({
            error: "A budget override requires a reason. Provide budgetOverrideReason explaining why this over-budget package is being approved.",
            code: "BUDGET_OVERRIDE_REASON_REQUIRED",
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
  const view = effectiveWorkPlan(row, wp);
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
  res.json(UpdatePackageResponse.parse(toApiPackageSummary(row, emp, view, weekCount, entries)));
});

router.delete("/packages/:id", async (req, res): Promise<void> => {
  // Deleting a package destroys billing history — restricted to the approved
  // billers (Griselda, Mahsa, Julie; see packageDeletePermission).
  if (!(await canDeletePackages(req))) {
    res.status(403).json({
      error: "Only Griselda, Mahsa, or Julie can delete packages.",
    });
    return;
  }
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
// Procas hours pull
// ---------------------------------------------------------------------------

router.post("/packages/:id/procas-hours", async (req, res): Promise<void> => {
  const id = parseId(req.params.id);
  const [pkg] = await db.select().from(packagesTable).where(eq(packagesTable.id, id));
  if (!pkg) {
    res.status(404).json({ error: "Package not found" });
    return;
  }
  const wp =
    pkg.workPlanId != null
      ? await db.select().from(workPlansTable).where(eq(workPlansTable.id, pkg.workPlanId)).then((r) => r[0] ?? null)
      : null;
  const conn = await getProcasConnection();
  const creds = conn?.connected ? credsFromConnection(conn) : null;
  if (!creds) {
    res.status(409).json({ error: "Procas is not connected. Connect it from the header indicator first." });
    return;
  }
  const result = await pullPackageHoursFromProcas(pkg, effectiveWorkPlan(pkg, wp), creds);
  if (!result.ok) {
    res.status(422).json({ error: result.error ?? "Procas pull failed." });
    return;
  }
  res.json(
    PullPackageHoursFromProcasResponse.parse({
      importedCount: result.importedCount,
      replacedCount: result.replacedCount,
      weeksCreated: result.weeksCreated,
      warnings: result.warnings,
    }),
  );
});

// ---------------------------------------------------------------------------
// 40-hour top-up. Julie's rule from the Aug 26 demo: "if you work less than
// eight hours for the client, then the rest of the hours go to sick time or
// vacation… we can make it one row". This is an explicit, previewable action
// rather than something that happens silently on every pull — a timesheet is a
// certified document, and the biller should see the rows before they land.
// ---------------------------------------------------------------------------

const PTO_FILL_LABEL = "PTO/Sick";

router.post("/packages/:id/fill-pto", async (req, res): Promise<void> => {
  const id = parseId(req.params.id);
  const [pkg] = await db.select().from(packagesTable).where(eq(packagesTable.id, id));
  if (!pkg) {
    res.status(404).json({ error: "Package not found" });
    return;
  }
  const parsed = FillPtoBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { preview = false, standardDayHours, fillEmptyDays = false } = parsed.data;

  const [weeks, entries] = await Promise.all([
    db
      .select()
      .from(packageWeeksTable)
      .where(eq(packageWeeksTable.packageId, id))
      .orderBy(asc(packageWeeksTable.sortOrder)),
    db.select().from(timesheetEntriesTable).where(eq(timesheetEntriesTable.packageId, id)),
  ]);

  const warnings: string[] = [];
  const weekResults: { weekId: number; weekLabel: string; employeeName: string; hoursAdded: number }[] = [];
  let rowsCreated = 0;
  let rowsUpdated = 0;
  let rowsRemoved = 0;
  let hoursAdded = 0;

  for (const week of weeks) {
    const weekEntries = entries.filter((e) => e.weekId === week.id);
    if (weekEntries.length === 0) continue;

    // The top-up is per employee: two people on one week each owe their own
    // eight-hour days.
    const byEmployee = new Map<string, TimesheetEntryRow[]>();
    for (const e of weekEntries) {
      const key = e.employeeName;
      const list = byEmployee.get(key);
      if (list) list.push(e);
      else byEmployee.set(key, [e]);
    }

    for (const [employeeName, rows] of byEmployee) {
      // This employee's own auto-fill row from a previous run, if any. It is
      // excluded from the shortfall maths and then rewritten — otherwise it
      // would count toward its own eight hours, so a later correction to the
      // real hours could never shrink or clear it (an 8h day plus a stale 3h
      // fill would silently show as 11).
      const existing = rows.find((e) => e.category === "pto" && e.source === "auto_pto");
      const charged = existing ? rows.filter((e) => e.id !== existing.id) : rows;

      const fill = computePtoFill(charged, {
        weekStart: week.weekStart,
        periodStart: pkg.payPeriodStart,
        periodEnd: pkg.payPeriodEnd,
        standardDayHours,
        fillEmptyDays,
      });

      // Nothing to add: clear a stale auto-fill row if one is left over.
      if (!fill) {
        if (existing) {
          if (!preview) {
            await db.delete(timesheetEntriesTable).where(eq(timesheetEntriesTable.id, existing.id));
          }
          rowsRemoved += 1;
        }
        continue;
      }

      const added = totalDayHours(fill);
      hoursAdded += added;
      weekResults.push({ weekId: week.id, weekLabel: week.label, employeeName, hoursAdded: added });

      if (preview) {
        if (existing) rowsUpdated += 1;
        else rowsCreated += 1;
        continue;
      }

      const note = `Auto-filled to ${standardDayHours ?? 8}h/day`;
      if (existing) {
        await db
          .update(timesheetEntriesTable)
          .set({ ...fill, notes: note })
          .where(eq(timesheetEntriesTable.id, existing.id));
        rowsUpdated += 1;
      } else {
        // A PTO row the biller typed by hand is never touched — its hours
        // already counted toward the eight, so the fill sits alongside it.
        const template = charged[0] ?? rows[0];
        await db.insert(timesheetEntriesTable).values({
          packageId: id,
          weekId: week.id,
          employeeId: template.employeeId,
          employeeName,
          classification: template.classification,
          category: "pto",
          location: template.location,
          ...fill,
          rate: 0, // PTO bills at $0
          source: "auto_pto",
          notes: note,
        });
        rowsCreated += 1;
      }
    }
  }

  if (weeks.length === 0) warnings.push("This package has no weeks yet — pull hours first.");
  else if (weekResults.length === 0)
    warnings.push(
      fillEmptyDays
        ? "Every weekday in the period is already at a full day."
        : "Nothing to top up. Weekdays with no hours charged to this project are skipped — turn on “fill empty days” if this employee works only this job.",
    );

  if (!preview && (rowsCreated > 0 || rowsUpdated > 0 || rowsRemoved > 0)) {
    await recordAudit({
      action: "filled PTO to standard week",
      entityType: "package",
      entityId: id,
      description: `${PTO_FILL_LABEL}: ${rowsCreated} row(s) added, ${rowsUpdated} updated, ${rowsRemoved} removed, ${hoursAdded} hour(s)`,
    });
  }

  res.json(
    FillPackagePtoTo40Response.parse({
      preview,
      rowsCreated,
      rowsUpdated,
      rowsRemoved,
      hoursAdded: Math.round(hoursAdded * 100) / 100,
      weeks: weekResults,
      warnings,
    }),
  );
});

// ---------------------------------------------------------------------------
// Procas tie-out check: compare the package's Previously Billed against what
// Procas BillingHistory says was invoiced for this job before the period start.
// ---------------------------------------------------------------------------

router.post("/packages/:id/procas-tie-out", async (req, res): Promise<void> => {
  const id = parseId(req.params.id);
  const [pkg] = await db.select().from(packagesTable).where(eq(packagesTable.id, id));
  if (!pkg) {
    res.status(404).json({ error: "Package not found" });
    return;
  }
  const wp =
    pkg.workPlanId != null
      ? await db.select().from(workPlansTable).where(eq(workPlansTable.id, pkg.workPlanId)).then((r) => r[0] ?? null)
      : null;
  const tieOutJob = effectiveWorkPlan(pkg, wp).jobNumber.trim();
  if (!tieOutJob) {
    res.status(422).json({ error: "This package has no job number to tie out against." });
    return;
  }
  const conn = await getProcasConnection();
  const creds = conn?.connected ? credsFromConnection(conn) : null;
  if (!creds) {
    res.status(409).json({ error: "Procas is not connected. Connect it from the header indicator first." });
    return;
  }
  let procasBilled: number;
  try {
    procasBilled = await fetchPreviouslyBilledFromProcas(creds, tieOutJob);
  } catch {
    res.status(502).json({ error: "Could not reach Procas billing history. Try again in a moment." });
    return;
  }
  const previouslyBilled = pkg.previouslyBilled;
  const difference = previouslyBilled - procasBilled;
  // "Ties out" means agreeing within a cent: round the difference to whole
  // cents to avoid floating-point noise, then allow at most one cent apart.
  const matches = Math.abs(Math.round(difference * 100)) <= 1;
  res.json(
    CheckPackageTieOutWithProcasResponse.parse({
      previouslyBilled,
      procasBilled,
      difference,
      matches,
      source: pkg.previouslyBilledSource ?? null,
    }),
  );
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
  // Resolve the employee ID from the name when the client didn't supply one,
  // so legacy name-only rows don't merge two people who share a name.
  const employeeId =
    parsed.data.employeeId ?? (await resolveEmployeeIdByName(parsed.data.employeeName));
  // No rate supplied: use the employee's billing rate effective for this
  // week's start date, honoring effective-dated rate changes so a mid-period
  // rate change lands as different rates on pre/post-change weeks (which the
  // export renders as two Labor Attachment rows).
  let rate = parsed.data.rate ?? 0;
  if (rate <= 0 && employeeId != null) {
    const [emp] = await db.select().from(employeesTable).where(eq(employeesTable.id, employeeId));
    if (emp) {
      const changes = await loadRateChanges([employeeId]);
      rate = effectiveRate(emp, changes.get(employeeId) ?? [], parsed.data.location, week.weekStart);
    }
  }
  const [row] = await db
    .insert(timesheetEntriesTable)
    .values({
      packageId: id,
      weekId: parsed.data.weekId,
      employeeId,
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
      rate,
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
  const updates: Omit<typeof parsed.data, "employeeId"> & { employeeId?: number | null } = {
    ...parsed.data,
  };
  if (
    updates.employeeId === undefined &&
    typeof updates.employeeName === "string" &&
    updates.employeeName.trim().toLowerCase() !== existing.employeeName.trim().toLowerCase()
  ) {
    // Renaming an entry re-resolves its employee link so the old ID doesn't
    // stick to the wrong person (null when unknown or ambiguous).
    updates.employeeId = await resolveEmployeeIdByName(updates.employeeName);
  }
  const [row] = await db
    .update(timesheetEntriesTable)
    .set(updates)
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
    const id = parseId(req.params.id);
    const [pkg] = await db.select().from(packagesTable).where(eq(packagesTable.id, id));
    if (!pkg) {
      res.status(404).json({ error: "Package not found" });
      return;
    }
    const file = (req as unknown as { file?: { buffer: Buffer; originalname: string } }).file;
    if (!file) {
      res.status(400).json({
        error: "No file uploaded (expected an Excel, Word, or PDF in field 'file').",
        code: "NO_FILE",
      });
      return;
    }
    const originalName = path.basename(file.originalname);
    const ext = path.extname(originalName).toLowerCase();
    if (!PROGRESS_REPORT_EXTENSIONS.has(ext)) {
      res.status(400).json({
        error: "Unsupported file type. Upload an Excel, Word, or PDF document.",
        code: "UNSUPPORTED_EXTENSION",
      });
      return;
    }
    // Content-based check: confirm the bytes really are the document type the
    // extension claims, so a renamed/mislabeled file can't slip past the
    // extension allow-list above.
    const detected = detectDocument(file.buffer);
    if (!detected || !EXTENSION_FORMATS[ext]?.includes(detected)) {
      res.status(400).json({
        error: "File content does not match its extension. Upload a genuine Excel, Word, or PDF document.",
        code: "CONTENT_MISMATCH",
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
  const wp =
    pkg.workPlanId != null
      ? await db.select().from(workPlansTable).where(eq(workPlansTable.id, pkg.workPlanId)).then((r) => r[0] ?? null)
      : null;
  const entries = await db.select().from(timesheetEntriesTable).where(eq(timesheetEntriesTable.packageId, id));
  const rollup = buildPackageRollup(entries, effectiveWorkPlan(pkg, wp), {
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
  const wp =
    pkg.workPlanId != null
      ? await db.select().from(workPlansTable).where(eq(workPlansTable.id, pkg.workPlanId)).then((r) => r[0] ?? null)
      : null;
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

  const view = effectiveWorkPlan(pkg, wp);
  if (pkg.workPlanId != null && !wp) {
    flags.push({ severity: "error", field: "workPlan", message: "Package references a missing work plan." });
  } else if (view.totalBudget > 0) {
    const rollup = buildPackageRollup(entries, view, {
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
  } else if (!wp) {
    flags.push({ severity: "info", field: "workPlan", message: "No work plan linked yet — rates come from this package's billing settings." });
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

// ---------------------------------------------------------------------------
// Billed line items (Invoice cover table + billing summary)
// ---------------------------------------------------------------------------

router.get("/packages/:id/billed-line-items", async (req, res): Promise<void> => {
  const id = parseId(req.params.id);
  const [pkg] = await db.select().from(packagesTable).where(eq(packagesTable.id, id));
  if (!pkg) {
    res.status(404).json({ error: "Package not found" });
    return;
  }
  const rows = await listBilledLineItems(id);
  res.json(
    ListBilledLineItemsResponse.parse({
      items: rows.map(toApiBilledLineItem),
      summary: computeBillingSummary(rows),
    }),
  );
});

router.put("/packages/:id/billed-line-items", async (req, res): Promise<void> => {
  const id = parseId(req.params.id);
  const parsed = ReplaceBilledLineItemsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  // The invoice cover carries exactly 10 line rows (25–34); reject early
  // rather than letting the export fail later.
  if (parsed.data.items.length > 10) {
    res.status(400).json({ error: "The invoice cover supports at most 10 billed line items" });
    return;
  }
  const [pkg] = await db.select().from(packagesTable).where(eq(packagesTable.id, id));
  if (!pkg) {
    res.status(404).json({ error: "Package not found" });
    return;
  }
  const rows = await replaceBilledLineItems(id, parsed.data.items);
  await recordAudit({
    action: "updated billed line items",
    entityType: "package",
    entityId: id,
    description: `${rows.length} line item(s) saved`,
  });
  res.json(
    ReplaceBilledLineItemsResponse.parse({
      items: rows.map(toApiBilledLineItem),
      summary: computeBillingSummary(rows),
    }),
  );
});

router.post("/packages/:id/export", async (req, res): Promise<void> => {
  const id = parseId(req.params.id);

  // ── Pre-flight validation ─────────────────────────────────────────────────
  // Only error-severity issues block the export (warnings are non-blocking).
  const [pkgRow] = await db.select().from(packagesTable).where(eq(packagesTable.id, id));
  if (!pkgRow) {
    res.status(404).json({ error: "Package not found" });
    return;
  }
  const [wpRow, weeks, entries] = await Promise.all([
    pkgRow.workPlanId != null
      ? db.select().from(workPlansTable).where(eq(workPlansTable.id, pkgRow.workPlanId)).then((r) => r[0] ?? null)
      : Promise.resolve(null),
    db.select().from(packageWeeksTable).where(eq(packageWeeksTable.packageId, id)),
    db.select().from(timesheetEntriesTable).where(eq(timesheetEntriesTable.packageId, id)),
  ]);
  const blockers: string[] = [];
  if (weeks.length === 0) blockers.push("Package has no billing weeks.");
  if (entries.length === 0) blockers.push("Package has no timesheet entries.");
  if (pkgRow.workPlanId != null && !wpRow) blockers.push("Package references a missing work plan.");
  if (blockers.length > 0) {
    res.status(422).json({ error: "Fix these issues before exporting.", issues: blockers });
    return;
  }

  // Approval gate: hours pulled from Procas before a supervisor signs off carry
  // approved=false. They may be previewed, but the FINAL export is blocked until
  // the biller explicitly confirms ("run anyway") by resending with
  // allowUnapproved=true. This keeps a human in the loop over unapproved billing.
  const unapprovedHoursRaw = entries.reduce(
    (s, e) =>
      e.approved
        ? s
        : s + e.hoursMon + e.hoursTue + e.hoursWed + e.hoursThu + e.hoursFri + e.hoursSat + e.hoursSun,
    0,
  );
  const unapprovedHours = Math.round((unapprovedHoursRaw + Number.EPSILON) * 100) / 100;
  const allowUnapproved = req.body?.allowUnapproved === true;
  if (unapprovedHours > 0 && !allowUnapproved) {
    res.status(409).json({
      error: `${unapprovedHours} hour(s) on this package are not yet approved in Procas. Review them, or export anyway to proceed.`,
      code: "UNAPPROVED_HOURS",
      unapprovedHours,
    });
    return;
  }
  // ─────────────────────────────────────────────────────────────────────────

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
    action: unapprovedHours > 0 ? "exported package (unapproved hours overridden)" : "exported package",
    entityType: "package",
    entityId: id,
    description:
      `ZIP ${result.zipName} (${result.documents.length} files)` +
      (unapprovedHours > 0 ? ` — exported with ${unapprovedHours} unapproved hour(s) by explicit override` : ""),
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
