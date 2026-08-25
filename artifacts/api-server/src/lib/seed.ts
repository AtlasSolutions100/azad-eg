import { db, workPlansTable, classificationsTable, referenceEntriesTable, columnDefinitionsTable } from "@workspace/db";
import { logger } from "./logger";

/**
 * Seeds baseline reference data the dashboard needs to function: the BART
 * Work Plan A.04-02 (Phase 1), labor classifications, indirect-rate reference
 * entries, and the Column Definitions field reference. Idempotent — it only
 * inserts when a table is empty, so it is safe to run on every startup.
 */
export async function seedDatabase(): Promise<void> {
  const existingWp = await db.select().from(workPlansTable).limit(1);
  if (existingWp.length === 0) {
    await db.insert(workPlansTable).values({
      code: "A.04-02",
      title: "Assistant Resident Engineer / Inspector for BART On-Call Construction Management Services",
      client: "WSP USA INC (BART)",
      jobNumber: "47CJ016, 20LT008",
      agreementNo: "6M8178",
      poNumber: "71994",
      wspProjectNo: "30900569.7859",
      totalBudget: 156185.34,
      fringeRate: 120.58,
      fixedFeeRate: 8,
      // 0.39% matches Julie's real WSP/A.04-02 sample (Sub Calc _revised E49 =
      // 0.0039), which reproduces its $26,189.78 total exactly. The old 0.13%
      // came from a Master File label; confirm the authoritative FCCM % with
      // Julie (it is date-ranged per contract in Procas Billing Item Col O).
      fccmRate: 0.39,
      billingCycle: "whole_month",
      status: "active",
    });
    logger.info("Seeded BART Work Plan A.04-02");
  }

  const existingClass = await db.select().from(classificationsTable).limit(1);
  if (existingClass.length === 0) {
    await db.insert(classificationsTable).values([
      { code: "ARE", description: "Assistant Resident Engineer", regularRate: 95, otRate: 142.5, dtRate: 190, location: "both" },
      { code: "INSP", description: "Inspector", regularRate: 78, otRate: 117, dtRate: 156, location: "field" },
      { code: "SR-INSP", description: "Senior Inspector", regularRate: 88, otRate: 132, dtRate: 176, location: "field" },
      { code: "PM", description: "Project Manager", regularRate: 120, otRate: 180, dtRate: 240, location: "home" },
      { code: "ADMIN", description: "Project Administrator", regularRate: 55, otRate: 82.5, dtRate: 110, location: "home" },
    ]);
    logger.info("Seeded labor classifications");
  }

  const existingRef = await db.select().from(referenceEntriesTable).limit(1);
  if (existingRef.length === 0) {
    await db.insert(referenceEntriesTable).values([
      { category: "rates", key: "fringe", label: "Fringe Benefits", value: "120.58", unit: "%", description: "Applied to direct labor." },
      { category: "rates", key: "fixed_fee", label: "Fixed Fee", value: "8", unit: "%", description: "Applied to labor + fringe + overhead." },
      { category: "rates", key: "fccm_home", label: "FCCM (Home Office)", value: "0.39", unit: "%", description: "Facilities Capital Cost of Money. Always 0.39% (confirmed by Julie 2026-08)." },
      { category: "rates", key: "fccm_field", label: "FCCM (Field Office)", value: "0.39", unit: "%", description: "Facilities Capital Cost of Money. Always 0.39% (confirmed by Julie 2026-08)." },
      { category: "premiums", key: "ot", label: "Overtime Premium", value: "50", unit: "%", description: "Premium portion above straight-time for OT hours." },
      { category: "premiums", key: "dt", label: "Doubletime Premium", value: "100", unit: "%", description: "Premium portion above straight-time for DT hours." },
      { category: "contract", key: "terms", label: "Payment Terms", value: "Net 30", unit: null, description: "Invoice payment terms." },
    ]);
    logger.info("Seeded reference data");
  }

  const existingDefs = await db.select().from(columnDefinitionsTable).limit(1);
  if (existingDefs.length === 0) {
    await db.insert(columnDefinitionsTable).values([
      { sheet: "Invoice", column: "Direct Labor", field: "laborTotal", source: "Computed", formula: "Σ(hours × rate) for all line items", description: "Straight-time direct labor for the period." },
      { sheet: "Invoice", column: "Fringe", field: "fringeTotal", source: "Computed", formula: "Direct Labor × fringe rate", description: "Fringe benefits applied to direct labor." },
      { sheet: "Invoice", column: "Overhead", field: "overheadTotal", source: "Computed", formula: "(Labor + Fringe) × overhead rate", description: "Overhead, applied when an overhead rate is set." },
      { sheet: "Invoice", column: "Fixed Fee", field: "fixedFee", source: "Computed", formula: "(Labor + Fringe + Overhead) × 8%", description: "Fixed fee on the cost base." },
      { sheet: "Invoice", column: "FCCM", field: "fccm", source: "Computed", formula: "(Labor + Fringe + Overhead) × FCCM rate", description: "Facilities Capital Cost of Money." },
      { sheet: "Invoice", column: "OT/DT Premium", field: "otdtPremium", source: "Computed", formula: "OT base × 0.5 + DT base × 1.0", description: "Premium portion of overtime and doubletime." },
      { sheet: "Invoice", column: "Total This Period", field: "totalThisPeriod", source: "Computed", formula: "Sum of all cost components + ODCs", description: "Amount billed for the current period." },
      { sheet: "Invoice", column: "Previously Billed", field: "previouslyBilled", source: "Input", formula: null, description: "Carried-forward amount billed in prior periods." },
      { sheet: "Invoice", column: "Total Billed To Date", field: "totalToDate", source: "Computed", formula: "Total This Period + Previously Billed", description: "Cumulative billing to date." },
      { sheet: "Invoice", column: "Amount Remaining", field: "remainingBalance", source: "Computed", formula: "Work Plan Budget − Total To Date", description: "Remaining budget balance." },
      { sheet: "Invoice", column: "% Expended", field: "percentExpended", source: "Computed", formula: "Total To Date ÷ Budget × 100", description: "Percentage of work plan budget expended." },
      { sheet: "Master File", column: "C3", field: "invoiceNumber", source: "Input", formula: null, description: "Invoice number drives the workbook header." },
      { sheet: "Master File", column: "D6 / G6", field: "period", source: "Input", formula: null, description: "Service period start and end dates." },
      { sheet: "Procas Mapping", column: "Hours", field: "hours", source: "Procas", formula: "GLDetail.GLQty (finalized Labor Journal), Timesheet.HoursWorked as fallback", description: "Labor hours per person and labor category for the billing period, from the daily 6 AM Procas snapshot." },
      { sheet: "Procas Mapping", column: "Billing Rate", field: "rate", source: "Procas", formula: "BillingItem.BillingRate effective for the period (Item.DefaultBillingRate for new employees)", description: "Contract billing rate from Procas Billing Setup for the job's labor category." },
      { sheet: "Procas Mapping", column: "Employee", field: "employeeName", source: "Procas", formula: "Personnel.PersonnelName + labor category / title / active flag", description: "Approved fields only — no addresses, SSNs, or other PII are ever pulled." },
      { sheet: "Procas Mapping", column: "Fringe / Overhead / Fee %", field: "workPlanRates", source: "Procas", formula: "BillingAccount.FringePercent / OverheadPercent / FeePercent by job number", description: "Work plan rates refreshed from Procas Billing Setup. FCCM is not mapped from Procas — pending confirmation of the source field." },
      { sheet: "Procas Mapping", column: "Previously Billed", field: "previouslyBilled", source: "Procas", formula: "Σ BillingHistory.TotalBillingAmount (non-voided, invoiced before period start)", description: "Defaulted from Procas billing history; a manual edit always wins and is never overwritten." },
    ]);
    logger.info("Seeded column definitions");
  }
}
