import { describe, it, expect } from "vitest";
import ExcelJS from "exceljs";
import { buildMasterWorkbook } from "./masterWorkbook";
import { buildWspWorkbook } from "./wspWorkbook";
import { buildTylinWorkbook } from "./tylinWorkbook";
import { buildParsonsWorkbook } from "./parsonsWorkbook";
import { deletedRefTokens, dropDeadDefinedNames, freezeUnstableFormulas } from "./excel";
import type { PackageDocContext } from "./packageDocs";

/**
 * Guards the other half of the repair-prompt cause Julie hit (see
 * externalRefs.test.ts for the `[N]` external-workbook half): a formula that
 * points at a sheet the engine deleted.
 *
 * All four engines load one of Julie's real workbooks and delete the
 * internal-only sheets before shipping. Every deletion orphans the formulas and
 * defined names that pointed at the removed tab, and Excel answers an
 * uncompilable reference with "We found a problem with some content… Do you
 * want us to try to recover as much as we can?" — in front of the client.
 *
 * masterWorkbook was the engine without this hardening. It stayed clean only by
 * coincidence: its one cross-sheet exposure is `Cost!H27` (`=ODCs!D22`), and
 * the engine happens to overwrite exactly H27 with the ODC literal just before
 * `ODCs` is deleted. Delete that one line and a dangling `ODCs!D22` ships. The
 * assertion here is structural rather than a list of known-bad names, so a new
 * formula into any removed sheet fails the build instead of reaching a client.
 */

/** Double-quoted string literals — `IF(J46>G46,"Check!!!","")` is not a ref. */
const STRING_LITERAL = /"(?:[^"]|"")*"/g;
/** Excel error literals, which also end in `!` and would parse as sheet names. */
const ERROR_LITERAL = /#(REF|VALUE|DIV\/0|NUM|NULL|NAME|N\/A|SPILL|CALC|GETTING_DATA)[!?]?/gi;
/** `'Sub Calc'!A1`, `Cover!B3`, `[1]Sheet!A1` — the sheet-qualified prefix. */
const SHEET_REF = /(?:\[\d+\])?(?:'((?:[^']|'')*)'|([A-Za-z0-9_.À-￿]+))!/g;

function referencedSheets(formula: string): string[] {
  const cleaned = formula.replace(STRING_LITERAL, " ").replace(ERROR_LITERAL, " ");
  const out: string[] = [];
  for (const m of cleaned.matchAll(SHEET_REF)) {
    out.push(m[1] !== undefined ? m[1].replace(/''/g, "'") : m[2]);
  }
  return out;
}

/** Every formula whose sheet reference names a tab the workbook does not have. */
function danglingSheetRefs(wb: ExcelJS.Workbook): string[] {
  const present = new Set(wb.worksheets.map((w) => w.name));
  const bad: string[] = [];
  for (const ws of wb.worksheets) {
    ws.eachRow({ includeEmpty: false }, (row) => {
      row.eachCell({ includeEmpty: false }, (cell) => {
        const v = cell.value as { formula?: string; sharedFormula?: string } | null;
        if (!v || typeof v !== "object") return;
        for (const f of [v.formula, v.sharedFormula]) {
          if (typeof f !== "string") continue;
          for (const name of referencedSheets(f)) {
            if (!present.has(name)) {
              bad.push(`${ws.name}!${cell.address} references missing sheet [${name}]: ${f}`);
            }
          }
        }
      });
    });
  }
  return bad;
}

/** Defined names still aimed at a sheet that is gone. */
function danglingDefinedNames(wb: ExcelJS.Workbook): string[] {
  const present = new Set(wb.worksheets.map((w) => w.name));
  const bad: string[] = [];
  for (const dn of wb.definedNames.model) {
    for (const range of dn.ranges) {
      for (const name of referencedSheets(range)) {
        if (!present.has(name)) bad.push(`${dn.name} -> ${range}`);
      }
    }
  }
  return bad;
}

/** A formula cell still evaluating to an Excel error literal. */
function errorFormulas(wb: ExcelJS.Workbook): string[] {
  const bad: string[] = [];
  for (const ws of wb.worksheets) {
    ws.eachRow({ includeEmpty: false }, (row) => {
      row.eachCell({ includeEmpty: false }, (cell) => {
        const v = cell.value as { formula?: string } | null;
        if (v && typeof v === "object" && typeof v.formula === "string" && /#REF!/.test(v.formula)) {
          bad.push(`${ws.name}!${cell.address} = ${v.formula}`);
        }
      });
    });
  }
  return bad;
}

const workPlan = {
  id: 1,
  code: "B.50-03",
  title: "B.50-03",
  client: "AECOM",
  jobNumber: "6M8142-B50",
  agreementNo: "6M8142",
  poNumber: "1638681",
  totalBudget: 1381971.85,
  fringeRate: 120.58,
  overheadRate: 0,
  fixedFeeRate: 8,
  fccmRate: 0.39,
  supplierId: "12345",
  clientProjectNo: "60723341.03",
  sendToCompany: "AECOM",
  sendToAddress1: "300 Lakeside Drive, Suite 400",
  sendToAddress2: "Oakland, CA 94612",
  contactPerson: "Chris Berilla, Program Manager",
  bartProjectNumbers: "(15CQ002, 15TC002, 45GA000) 15NL004",
  terms: "Net 30 Days",
} as unknown as PackageDocContext["workPlan"];

/**
 * A package with `weekCount` weeks. The week count is the variable that matters:
 * it decides how many of the template's five week tabs are reused, how many are
 * deleted (each one a fresh chance to orphan a reference), and whether the
 * engine has to clone extra tabs beyond what the template carries.
 */
function makeCtx(weekCount: number): PackageDocContext {
  const weeks = Array.from({ length: weekCount }, (_, i) => ({
    id: i + 1,
    packageId: 1,
    label: `Week ${i + 1}`,
    weekStart: `2026-06-${String(i * 7 + 1).padStart(2, "0")}`,
    weekEnd: `2026-06-${String(i * 7 + 5).padStart(2, "0")}`,
    sortOrder: i + 1,
  })) as unknown as PackageDocContext["weeks"];
  const entries = weeks.map((w) => ({
    id: w.id,
    packageId: 1,
    weekId: w.id,
    employeeId: 7,
    employeeName: "Travis Johnson",
    classification: "Project Manager",
    category: "regular",
    location: "field",
    hoursMon: 8,
    hoursTue: 8,
    hoursWed: 8,
    hoursThu: 8,
    hoursFri: 8,
    hoursSat: 0,
    hoursSun: 0,
    rate: 92.5,
  })) as unknown as PackageDocContext["entries"];
  return {
    pkg: {
      id: 1,
      employeeId: 7,
      workPlanId: 1,
      payPeriodStart: "2026-05-30",
      payPeriodEnd: "2026-06-30",
      invoiceNumber: "B.50-01-30",
      invoiceDate: "2026-07-08",
      previouslyBilled: 1135877.49,
      otherDirectCosts: 250,
      approvedBy: "Mahsa Azad, President",
    } as unknown as PackageDocContext["pkg"],
    employee: { name: "Travis Johnson", classification: "Project Manager" },
    workPlan,
    weeks,
    entries,
    progress: {
      id: 1,
      packageId: 1,
      workPerformed: "15CH001 (Millbrae)\n- Performed routine reporting",
      concerns: null,
      correctiveAction: null,
    } as unknown as PackageDocContext["progress"],
    overrides: [],
    signatureImagePath: null,
    billedLineItems: [] as unknown as PackageDocContext["billedLineItems"],
  };
}

describe("no formula survives an export pointing at a deleted sheet", () => {
  // 1..7 weeks spans every removal shape: four template week tabs deleted, none
  // deleted, and two cloned past the end of the template.
  for (const weekCount of [1, 2, 3, 5, 7]) {
    it(`master workbook, ${weekCount}-week package`, async () => {
      const { wb } = await buildMasterWorkbook(makeCtx(weekCount));
      expect(danglingSheetRefs(wb)).toEqual([]);
      expect(danglingDefinedNames(wb)).toEqual([]);
      expect(errorFormulas(wb)).toEqual([]);
    }, 120000);
  }

  const others = [
    ["WSP", buildWspWorkbook],
    ["TYLin", buildTylinWorkbook],
    ["Parsons", buildParsonsWorkbook],
  ] as const;
  for (const [label, build] of others) {
    it(`${label} workbook`, async () => {
      const { wb } = await build(makeCtx(5));
      expect(danglingSheetRefs(wb)).toEqual([]);
      expect(danglingDefinedNames(wb)).toEqual([]);
      expect(errorFormulas(wb)).toEqual([]);
    }, 120000);
  }
});

/**
 * Pins the shared helpers directly, so they keep working even if every template
 * happens to be clean on the day the suite runs.
 */
describe("hardening helpers", () => {
  function workbookWithDeadRefs(): ExcelJS.Workbook {
    const wb = new ExcelJS.Workbook();
    const keep = wb.addWorksheet("Invoice");
    const doomed = wb.addWorksheet("ODCs");
    doomed.getCell("D22").value = 42;

    // A plain formula into the doomed sheet, with a usable cached result.
    keep.getCell("A1").value = { formula: "ODCs!D22", result: 42 } as ExcelJS.CellValue;
    // The quoted spelling of the same reference.
    keep.getCell("A2").value = { formula: "SUM('ODCs'!D1:D22)", result: 99 } as ExcelJS.CellValue;
    // A shared-formula master into the doomed sheet, plus its child. Freezing
    // the master alone would make exceljs throw on write.
    keep.getCell("A3").value = {
      formula: "ODCs!D22*2",
      result: 84,
      shareType: "shared",
      ref: "A3:A4",
    } as unknown as ExcelJS.CellValue;
    keep.getCell("A4").value = { sharedFormula: "A3", result: 84 } as unknown as ExcelJS.CellValue;
    // An already-broken formula whose cached result is the *text* "#REF!".
    keep.getCell("A5").value = { formula: "#REF!*B5", result: "#REF!" } as ExcelJS.CellValue;
    // A formula that must survive untouched.
    keep.getCell("A6").value = { formula: "Invoice!B1+1", result: 7 } as ExcelJS.CellValue;

    wb.definedNames.add("Invoice!Z1", "LiveName");
    wb.definedNames.model = [
      ...wb.definedNames.model,
      { name: "DeadName", ranges: ["'ODCs'!$D$22"] },
    ];
    return wb;
  }

  it("freezes formulas into a removed sheet, and their shared children", () => {
    const wb = workbookWithDeadRefs();
    wb.removeWorksheet(wb.getWorksheet("ODCs")!.id);
    freezeUnstableFormulas(wb, deletedRefTokens(["ODCs"]));

    const ws = wb.getWorksheet("Invoice")!;
    expect(ws.getCell("A1").value).toBe(42);
    expect(ws.getCell("A2").value).toBe(99);
    expect(ws.getCell("A3").value).toBe(84);
    // The shared child must lose its `sharedFormula` too, or exceljs throws
    // "Shared Formula master must exist above and or left of clone" on write.
    expect(ws.getCell("A4").value).toBe(84);
    expect(danglingSheetRefs(wb)).toEqual([]);
  });

  it("blanks a #REF! formula rather than shipping the text '#REF!'", () => {
    const wb = workbookWithDeadRefs();
    freezeUnstableFormulas(wb, []);
    // Freezing to the cached result would put the literal string "#REF!" in
    // front of the client, which is no better than the broken formula.
    expect(wb.getWorksheet("Invoice")!.getCell("A5").value).toBeNull();
  });

  it("leaves formulas that reference surviving sheets alone", () => {
    const wb = workbookWithDeadRefs();
    wb.removeWorksheet(wb.getWorksheet("ODCs")!.id);
    freezeUnstableFormulas(wb, deletedRefTokens(["ODCs"]));
    const v = wb.getWorksheet("Invoice")!.getCell("A6").value as { formula?: string };
    expect(v.formula).toBe("Invoice!B1+1");
  });

  it("drops defined names aimed at a removed sheet and keeps live ones", () => {
    const wb = workbookWithDeadRefs();
    wb.removeWorksheet(wb.getWorksheet("ODCs")!.id);
    dropDeadDefinedNames(wb, deletedRefTokens(["ODCs"]), "test");
    const names = wb.definedNames.model.map((dn) => dn.name);
    expect(names).toContain("LiveName");
    expect(names).not.toContain("DeadName");
  });

  it("writes a workbook whose dead references were severed", async () => {
    const wb = workbookWithDeadRefs();
    wb.removeWorksheet(wb.getWorksheet("ODCs")!.id);
    freezeUnstableFormulas(wb, deletedRefTokens(["ODCs"]));
    dropDeadDefinedNames(wb, deletedRefTokens(["ODCs"]), "test");
    // Round-trips cleanly: no shared-formula master error, nothing dangling.
    const buf = await wb.xlsx.writeBuffer();
    const reread = new ExcelJS.Workbook();
    await reread.xlsx.load(buf as ArrayBuffer);
    expect(danglingSheetRefs(reread)).toEqual([]);
    expect(danglingDefinedNames(reread)).toEqual([]);
  });
});
