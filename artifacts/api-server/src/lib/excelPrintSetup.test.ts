import { describe, it, expect } from "vitest";
import ExcelJS from "exceljs";
import { fitSheetsToOnePage } from "./excel";

// Julie's demo feedback: exported content was clipped, and what printed was
// "too shrunk". Both come from print setup — the templates declare a padded
// dimension (A1:Z1000) that the page-fit maths then tries to honour.
describe("print setup for exported workbooks", () => {
  it("derives the print area from populated cells, not the padded dimension", () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Invoice");
    ws.getCell("A1").value = "REMIT TO";
    ws.getCell("D5").value = 1234.56;
    // Padding the way the reference templates do: a far-flung blank cell that
    // inflates the sheet dimension without adding content.
    ws.getCell("Z1000").value = "";

    fitSheetsToOnePage(wb);

    expect(ws.pageSetup.printArea).toBe("A1:D5");
  });

  it("fits columns to one page wide but lets rows flow so type stays legible", () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Timesheet");
    for (let r = 1; r <= 120; r++) ws.getCell(`A${r}`).value = `row ${r}`;

    fitSheetsToOnePage(wb);

    expect(ws.pageSetup.fitToPage).toBe(true);
    expect(ws.pageSetup.fitToWidth).toBe(1);
    // 0 = "as many pages tall as needed". A 1 here would squeeze 120 rows onto
    // a single page and shrink the font to nothing.
    expect(ws.pageSetup.fitToHeight).toBe(0);
    expect(ws.pageSetup.printArea).toBe("A1:A120");
  });

  // The reference templates define print areas by hand (Invoice!$A$1:$O$46).
  // That range deliberately excludes helper cells parked off to the right, so
  // it must win over anything we would derive — otherwise the page widens to
  // ~15in and the type shrinks to 4pt, which is what Julie reported.
  it("keeps the print area the template defined", () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Invoice");
    ws.getCell("A1").value = "REMIT TO";
    ws.getCell("O46").value = "total";
    ws.getCell("AF60").value = "helper cell, must not print";
    ws.pageSetup = { ...ws.pageSetup, printArea: "A1:O46" };

    fitSheetsToOnePage(wb);

    expect(ws.pageSetup.printArea).toBe("A1:O46");
  });

  it("parses a template print area carrying $ anchors and a sheet name", () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Sub Calc");
    ws.getCell("A1").value = "Budget";
    for (let c = 1; c <= 11; c++) ws.getColumn(c).width = 9;
    ws.pageSetup = { ...ws.pageSetup, printArea: "'Sub Calc'!$A$1:$K$52" };

    fitSheetsToOnePage(wb);

    expect(ws.pageSetup.printArea).toBe("'Sub Calc'!$A$1:$K$52");
    // 11 cols x 9 units x 0.0791in ≈ 7.8in — still fits portrait.
    expect(ws.pageSetup.orientation).toBe("portrait");
  });

  it("turns a wide sheet landscape so its type isn't crushed", () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Invoice");
    // ~15in of columns, the width of the real reference Invoice tab, which the
    // template nonetheless saved as portrait.
    for (let c = 1; c <= 30; c++) {
      ws.getColumn(c).width = 6.3;
      ws.getCell(1, c).value = `h${c}`;
    }
    ws.pageSetup = { ...ws.pageSetup, orientation: "portrait" };

    fitSheetsToOnePage(wb);

    expect(ws.pageSetup.orientation).toBe("landscape");
  });

  it("keeps a narrow sheet portrait", () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Progress Report");
    for (let c = 1; c <= 6; c++) {
      ws.getColumn(c).width = 10;
      ws.getCell(1, c).value = `h${c}`;
    }

    fitSheetsToOnePage(wb);

    expect(ws.pageSetup.orientation).toBe("portrait");
  });

  it("leaves hidden sheets alone", () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Overview");
    ws.getCell("A1").value = "internal";
    ws.state = "hidden";
    ws.pageSetup = { ...ws.pageSetup, printArea: "A1:B2", fitToPage: false };

    fitSheetsToOnePage(wb);

    expect(ws.pageSetup.printArea).toBe("A1:B2");
    expect(ws.pageSetup.fitToPage).toBe(false);
  });

  it("clears the print area on a sheet with no content", () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Empty");
    ws.pageSetup = { ...ws.pageSetup, printArea: "A1:Z1000" };

    fitSheetsToOnePage(wb);

    expect(ws.pageSetup.printArea).toBeUndefined();
  });
});
