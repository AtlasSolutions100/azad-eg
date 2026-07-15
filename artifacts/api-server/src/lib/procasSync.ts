import {
  db,
  invoicesTable,
  employeesTable,
  workPlansTable,
  lineItemsTable,
  type LineItemRow,
  type ProcasConnectionRow,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  fetchProcasTable,
  credsFromConnection,
  markProcasSynced,
  odataString,
  type ProcasCreds,
} from "./procas";
import type { ParsedLine } from "./timeimport";
import { linesToLineItems, clearAutoImportedLineItems } from "./lineMapping";
import { recomputeCarryOverWithAudit } from "./carryover";
import { recordAudit } from "./audit";
import { logger } from "./logger";

type InvoiceRow = typeof invoicesTable.$inferSelect;

export type ProcasSyncResult =
  | { ok: true; importedCount: number; replacedCount: number; warnings: string[]; lineItems: LineItemRow[] }
  | { ok: false; reason: "fetch_failed" | "no_rows"; message: string; warnings: string[] };

function toNum(v: unknown): number {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  if (typeof v === "string") {
    const n = parseFloat(v.replace(/[^0-9.-]/g, ""));
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function toStr(v: unknown): string {
  return v == null ? "" : String(v).trim();
}

function normalizeCategory(payCodeDesc: string): ParsedLine["category"] {
  const v = payCodeDesc.toLowerCase();
  if (v.includes("double") || v.includes("dbl")) return "dt";
  if (v.includes("over") || /\bot\b/.test(v)) return "ot";
  if (v.includes("holiday")) return "holiday";
  if (v.includes("pto") || v.includes("vacation") || v.includes("sick") || v.includes("leave")) return "pto";
  return "regular";
}

// OData datetime bounds for a date-only period (Procas date fields are
// DateTimeOffset). Inputs are validated as strict ISO dates before being
// placed into a $filter expression so untrusted strings can never alter
// filter semantics (OData injection).
function assertIsoDate(date: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m || Number.isNaN(new Date(`${date}T00:00:00Z`).getTime())) {
    throw new Error(`Invalid date "${date}" — expected YYYY-MM-DD.`);
  }
  return date;
}
function dayStart(date: string): string {
  return `${assertIsoDate(date)}T00:00:00Z`;
}
function dayEnd(date: string): string {
  return `${assertIsoDate(date)}T23:59:59Z`;
}

// Picks the billing rate effective for the given period start from BillingItem
// rows (which carry BillingDateBeginning/Ending ranges) keyed by labor category.
function buildRateLookup(
  billingItems: Array<Record<string, unknown>>,
  periodStart: string,
): Map<string, number> {
  const at = new Date(dayStart(periodStart)).getTime();
  // Deterministic choice regardless of response order: among in-range rows the
  // one with the latest BillingDateBeginning wins; out-of-range rows are only a
  // fallback when no in-range rate exists (latest beginning wins there too).
  const best = new Map<string, { rate: number; inRange: boolean; beginAt: number }>();
  for (const row of billingItems) {
    const lcItem = toStr(row.LCItem);
    const rate = toNum(row.BillingRate);
    if (!lcItem || rate <= 0) continue;
    const beg = toStr(row.BillingDateBeginning);
    const end = toStr(row.BillingDateEnding);
    const beginAt = beg ? new Date(beg).getTime() : Number.NEGATIVE_INFINITY;
    const inRange = (!beg || beginAt <= at) && (!end || new Date(end).getTime() >= at);
    const prev = best.get(lcItem);
    if (
      !prev ||
      (inRange && !prev.inRange) ||
      (inRange === prev.inRange && beginAt > prev.beginAt)
    ) {
      best.set(lcItem, { rate, inRange, beginAt });
    }
  }
  const rates = new Map<string, number>();
  for (const [lcItem, { rate }] of best) rates.set(lcItem, rate);
  return rates;
}

// --- Previously Billed from BillingHistory ---

// Sums the non-voided amounts Procas has already invoiced for a project before
// the given date. Used to default "Previously Billed" on invoices and packages.
export async function fetchPreviouslyBilledFromProcas(
  creds: ProcasCreds,
  jobNumber: string,
  beforeDate: string,
): Promise<number> {
  const rows = await fetchProcasTable(creds, "BillingHistory", {
    filter: `Project eq ${odataString(jobNumber)} and IsVoided eq false and InvoiceDate lt ${dayStart(beforeDate)}`,
  });
  return rows.reduce((sum, r) => sum + toNum(r.TotalBillingAmount), 0);
}

// --- Reference data sync (employees + work plan rates) ---

export interface ReferenceSyncResult {
  employeesCreated: number;
  employeesUpdated: number;
  workPlansUpdated: number;
  warnings: string[];
}

// Pulls the approved reference tables and folds them into existing entities:
// Personnel -> employees (name, classification, active, payroll pay rate),
// Item default billing rates for new employees, and Billing Setup percentages
// (BillingAccount) -> work plan fringe/overhead/fee rates for matching jobs.
export async function syncReferenceFromProcas(creds: ProcasCreds): Promise<ReferenceSyncResult> {
  const warnings: string[] = [];
  const [personnel, payRates, items, projects, billingAccounts] = await Promise.all([
    fetchProcasTable(creds, "Personnel"),
    fetchProcasTable(creds, "PayRateInfo"),
    fetchProcasTable(creds, "Item"),
    fetchProcasTable(creds, "Project"),
    fetchProcasTable(creds, "BillingAccount"),
  ]);

  // Latest (preferring active) pay rate per personnel code.
  const payByPersonnel = new Map<string, { rate: number; effective: string; active: boolean }>();
  for (const r of payRates) {
    const code = toStr(r.Personnel);
    const rate = toNum(r.PayRate);
    if (!code || rate <= 0) continue;
    const effective = toStr(r.EffectiveDate);
    const active = r.IsActivePayRateInfo === true;
    const prev = payByPersonnel.get(code);
    const wins =
      !prev ||
      (active && !prev.active) ||
      (active === prev.active && effective > prev.effective);
    if (wins) payByPersonnel.set(code, { rate, effective, active });
  }

  const defaultRateByLc = new Map<string, number>();
  for (const r of items) {
    const lc = toStr(r.LCItem);
    const rate = toNum(r.DefaultBillingRate);
    if (lc && rate > 0) defaultRateByLc.set(lc, rate);
  }

  const existing = await db.select().from(employeesTable);
  const byName = new Map(existing.map((e) => [e.name.toLowerCase().trim(), e]));

  let employeesCreated = 0;
  let employeesUpdated = 0;
  for (const p of personnel) {
    const name = toStr(p.PersonnelName);
    if (!name) continue;
    const code = toStr(p.Personnel);
    const classification = toStr(p.PersonnelLaborCategoryDesc) || toStr(p.PersonnelJobTitle) || "Unspecified";
    const active = p.IsActivePersonnel !== false;
    const payRate = payByPersonnel.get(code)?.rate ?? null;
    const current = byName.get(name.toLowerCase());
    if (current) {
      const changes: Partial<typeof employeesTable.$inferInsert> = {};
      if (classification !== "Unspecified" && classification !== current.classification) {
        changes.classification = classification;
      }
      if (current.active !== active) changes.active = active;
      if (payRate != null && payRate !== current.payRate) changes.payRate = payRate;
      if (Object.keys(changes).length > 0) {
        await db.update(employeesTable).set(changes).where(eq(employeesTable.id, current.id));
        employeesUpdated += 1;
      }
    } else {
      const lcCode = toStr(p.PersonnelLaborCategory);
      const homeRate = defaultRateByLc.get(lcCode) ?? 0;
      if (homeRate <= 0) {
        warnings.push(`${name}: no default billing rate found for labor category "${lcCode || "?"}" — set to 0, correct manually.`);
      }
      await db.insert(employeesTable).values({
        name,
        classification,
        homeRate,
        payRate,
        active,
      });
      employeesCreated += 1;
    }
  }

  // Match local work plans to Procas projects by job number (Project code or
  // contract number) and refresh their billing-setup percentages.
  const projByCode = new Map<string, Record<string, unknown>>();
  for (const pr of projects) {
    const codes = [toStr(pr.Project), toStr(pr.ContractNumber)].filter(Boolean);
    for (const c of codes) if (!projByCode.has(c)) projByCode.set(c, pr);
  }
  const acctByProject = new Map<string, Record<string, unknown>>();
  for (const ba of billingAccounts) {
    const proj = toStr(ba.Project);
    if (proj && !acctByProject.has(proj)) acctByProject.set(proj, ba);
  }

  const workPlans = await db.select().from(workPlansTable);
  let workPlansUpdated = 0;
  for (const wp of workPlans) {
    const proj = projByCode.get(wp.jobNumber.trim());
    if (!proj) continue;
    const acct = acctByProject.get(toStr(proj.Project));
    if (!acct) continue;
    const changes: Partial<typeof workPlansTable.$inferInsert> = {};
    const fringe = toNum(acct.FringePercent);
    const overhead = toNum(acct.OverheadPercent);
    const fee = toNum(acct.FeePercent);
    if (fringe > 0 && fringe !== wp.fringeRate) changes.fringeRate = fringe;
    if (overhead > 0 && overhead !== wp.overheadRate) changes.overheadRate = overhead;
    if (fee > 0 && fee !== wp.fixedFeeRate) changes.fixedFeeRate = fee;
    if (Object.keys(changes).length > 0) {
      await db.update(workPlansTable).set(changes).where(eq(workPlansTable.id, wp.id));
      workPlansUpdated += 1;
    }
  }

  return { employeesCreated, employeesUpdated, workPlansUpdated, warnings };
}

// --- Per-invoice labor sync ---

// Pulls finalized labor for one invoice's billing period from Procas and
// imports it as line items. Finalized Labor Journal hours (GLDetail) are
// preferred — those are invoicing-grade. When the journal has no rows for the
// period yet, we fall back to raw Timesheet hours with a warning. Billing
// rates come from the project's Billing Setup (BillingItem), the authoritative
// source per Procas. Previously Billed is refreshed from BillingHistory unless
// the user has overridden it manually.
export async function syncInvoiceFromProcas(
  invoice: InvoiceRow,
  conn: Pick<ProcasConnectionRow, "companyCode" | "username" | "password">,
  source: "procas" | "procas-scheduled" = "procas",
): Promise<ProcasSyncResult> {
  const creds = credsFromConnection(conn);
  if (!creds) {
    return { ok: false, reason: "fetch_failed", message: "Procas credentials are missing.", warnings: [] };
  }

  const [workPlan] = await db.select().from(workPlansTable).where(eq(workPlansTable.id, invoice.workPlanId));
  if (!workPlan) {
    return { ok: false, reason: "fetch_failed", message: "Invoice has no work plan; cannot determine the Procas project.", warnings: [] };
  }
  const job = workPlan.jobNumber.trim();
  const warnings: string[] = [];

  let lines: ParsedLine[];
  try {
    const projectFilter = `Project eq ${odataString(job)}`;
    const glRows = await fetchProcasTable(creds, "GLDetail", {
      filter: `${projectFilter} and TransDate ge ${dayStart(invoice.periodStart)} and TransDate le ${dayEnd(invoice.periodEnd)} and GLQty gt 0 and LCItem ne null`,
    });

    let raw: Array<{ name: string; hours: number; lcItem: string; lcDesc: string; payCodeDesc: string }>;
    if (glRows.length > 0) {
      raw = glRows.map((r) => ({
        name: toStr(r.OrganizationDesc) || toStr(r.Organization),
        hours: toNum(r.GLQty),
        lcItem: toStr(r.LCItem),
        lcDesc: toStr(r.LCItemDesc),
        payCodeDesc: toStr(r.PayCodeDesc) || toStr(r.PayCode),
      }));
    } else {
      const tsRows = await fetchProcasTable(creds, "Timesheet", {
        filter: `${projectFilter} and WorkDate ge ${dayStart(invoice.periodStart)} and WorkDate le ${dayEnd(invoice.periodEnd)}`,
      });
      if (tsRows.length > 0) {
        warnings.push(
          "Labor Journal (GLDetail) has no finalized hours for this period yet — using raw Timesheet hours instead. Re-sync after payroll finalizes.",
        );
      }
      raw = tsRows.map((r) => ({
        name: toStr(r.PersonnelName) || toStr(r.Personnel),
        hours: toNum(r.HoursWorked),
        lcItem: toStr(r.LCItem),
        lcDesc: toStr(r.LCItemDesc),
        payCodeDesc: toStr(r.PayCodeDesc) || toStr(r.PayCode),
      }));
    }

    if (raw.length === 0) {
      return {
        ok: false,
        reason: "no_rows",
        message: `Procas has no labor for project ${job} between ${invoice.periodStart} and ${invoice.periodEnd} (data is a daily 6 AM snapshot).`,
        warnings,
      };
    }

    // Billing rates from Billing Setup for this project, effective for the period.
    const billingItems = await fetchProcasTable(creds, "BillingItem", { filter: projectFilter });
    const rateByLc = buildRateLookup(billingItems, invoice.periodStart);

    // Aggregate by employee + labor category + pay category so one line item
    // per person/category lands on the invoice instead of one per day.
    const agg = new Map<string, ParsedLine>();
    for (const r of raw) {
      if (!r.name || r.hours === 0) continue;
      const category = normalizeCategory(r.payCodeDesc);
      const rate = rateByLc.get(r.lcItem) ?? 0;
      const key = `${r.name.toLowerCase()}|${r.lcItem}|${category}`;
      const existing = agg.get(key);
      if (existing) {
        existing.hours += r.hours;
      } else {
        agg.set(key, {
          employeeName: r.name,
          classification: r.lcDesc,
          category,
          location: "home",
          hours: r.hours,
          rate,
          notes: r.lcItem ? `Procas LC ${r.lcItem}` : null,
        });
      }
    }
    lines = Array.from(agg.values());
    const missingRates = new Set(
      lines.filter((l) => l.rate <= 0).map((l) => l.classification || l.employeeName),
    );
    if (missingRates.size > 0) {
      warnings.push(
        `No Procas billing rate found for: ${Array.from(missingRates).join(", ")} — falling back to local employee rates.`,
      );
    }
  } catch (e) {
    return {
      ok: false,
      reason: "fetch_failed",
      message: e instanceof Error ? e.message : "Failed to pull from Procas.",
      warnings,
    };
  }

  if (lines.length === 0) {
    return { ok: false, reason: "no_rows", message: "No valid labor rows returned by Procas.", warnings };
  }

  const employees = await db.select().from(employeesTable);
  const { toInsert, warnings: mapWarnings } = linesToLineItems(lines, invoice.id, employees, "procas");
  warnings.push(...mapWarnings);

  // Replace any previously auto-imported rows so re-syncing the same period
  // does not duplicate labor; hand-entered rows are preserved.
  const replacedCount = await clearAutoImportedLineItems(invoice.id);
  if (replacedCount > 0) {
    warnings.unshift(`Replaced ${replacedCount} previously imported line item(s) for this period.`);
  }

  const inserted = await db.insert(lineItemsTable).values(toInsert).returning();
  // New labor changes this invoice's total-to-date; refresh downstream carry-over.
  await recomputeCarryOverWithAudit(invoice.workPlanId, {
    invoiceId: invoice.id,
    invoiceNumber: invoice.invoiceNumber,
    reason: source === "procas-scheduled" ? "a scheduled Procas sync of" : "a Procas sync of",
  });

  // Previously Billed from Procas BillingHistory — authoritative over locally
  // derived carry-over, but never overrides a manual user-entered value.
  if (!invoice.carryOverManual) {
    try {
      const prevBilled = await fetchPreviouslyBilledFromProcas(creds, job, invoice.periodStart);
      // BillingHistory is authoritative (including a legitimate $0) unless the
      // user has manually overridden the value.
      await db
        .update(invoicesTable)
        .set({ previouslyBilled: prevBilled, carryOverManual: false })
        .where(eq(invoicesTable.id, invoice.id));
      warnings.push(
        `Previously Billed set to $${prevBilled.toFixed(2)} from Procas BillingHistory (override it on the invoice if needed).`,
      );
    } catch (e) {
      logger.warn({ err: e, invoiceId: invoice.id }, "Could not refresh Previously Billed from Procas BillingHistory");
      warnings.push("Could not refresh Previously Billed from Procas BillingHistory; kept the locally derived value.");
    }
  }

  await markProcasSynced(new Date());
  await recordAudit({
    action: source === "procas-scheduled" ? "auto-synced from Procas" : "synced from Procas",
    entityType: "invoice",
    entityId: invoice.id,
    description:
      source === "procas-scheduled"
        ? `${inserted.length} line items pulled by scheduled Procas refresh${replacedCount > 0 ? ` (replaced ${replacedCount})` : ""}`
        : `${inserted.length} line items pulled live from Procas${replacedCount > 0 ? ` (replaced ${replacedCount})` : ""}`,
  });

  return { ok: true, importedCount: inserted.length, replacedCount, warnings, lineItems: inserted };
}

export async function getInvoiceById(id: number): Promise<InvoiceRow | null> {
  const [row] = await db.select().from(invoicesTable).where(eq(invoicesTable.id, id));
  return row ?? null;
}
