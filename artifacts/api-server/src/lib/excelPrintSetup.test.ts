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

    // Rewritten in plain A1 form once parsed: the area is re-stated after
    // being grown to cover any pictures at its foot (see confinePrintArea).
    expect(ws.pageSetup.printArea).toBe("A1:K52");
    // 11 cols x 9 units x 0.0791in ≈ 7.8in — still fits portrait.
    expect(ws.pageSetup.orientation).toBe("portrait");
  });

  it("keeps even a wide sheet upright — no page of the packet is rotated", () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Invoice");
    // ~15in of columns. Mahsa's brief for the PDF: "must print correctly on
    // 8.5 x 11… pages must not rotate" — and every page Julie sends is upright.
    for (let c = 1; c <= 30; c++) {
      ws.getColumn(c).width = 6.3;
      ws.getCell(1, c).value = `h${c}`;
    }
    ws.pageSetup = { ...ws.pageSetup, orientation: "landscape" };

    fitSheetsToOnePage(wb);

    expect(ws.pageSetup.orientation).toBe("portrait");
    expect(ws.pageSetup.fitToWidth).toBe(1);
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

/**
 * Julie's 10007 review, pages 1, 3 and 5. The cover printed with "still big
 * blank space", the Labor Attachment was "not centered on page", and the
 * Progress Report's last six lines came out alone on a page 5.
 */
describe("one-page forms: orientation and centering", () => {
  function form(name: string, cols: number, rows: number, colWidth = 12, rowHeight = 15) {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(name);
    for (let c = 1; c <= cols; c++) ws.getColumn(c).width = colWidth;
    for (let r = 1; r <= rows; r++) {
      ws.getRow(r).height = rowHeight;
      ws.getCell(r, 1).value = "x";
    }
    ws.getCell(rows, cols).value = "y";
    fitSheetsToOnePage(wb);
    return ws;
  }

  it("prints a form that is taller than it is wide in portrait", () => {
    // The AECOM cover: ~11in wide, ~12.7in tall. Landscape fits it by height
    // at 62% and leaves ~3.5in of empty page either side; portrait fits it by
    // width at 72%, edge to edge.
    const ws = form("Invoice", 12, 61); // 12 × 12 units ≈ 11.4in; 61 × 15pt ≈ 12.7in
    expect(ws.pageSetup.orientation).toBe("portrait");
    expect(ws.pageSetup.fitToHeight).toBe(1);
  });

  it("prints a wide, short form upright too", () => {
    // The Sub Calc: ~12.9in wide, ~9.2in tall. It printed larger sideways, but
    // her own invoices keep it upright with the rest of the packet.
    const ws = form("Sub Calc", 14, 44);
    expect(ws.pageSetup.orientation).toBe("portrait");
  });

  it("pins every engine's progress report to one page, matched by prefix", () => {
    for (const name of ["Progress Report", "Progress Report - Jordy", "Progress Report-Hash"]) {
      const ws = form(name, 8, 70);
      expect(ws.pageSetup.fitToHeight, name).toBe(1);
    }
  });

  it("centers one-page forms on the page but keeps flowing sheets top-anchored", () => {
    expect(form("Labor Attachment", 5, 23).pageSetup.verticalCentered).toBe(true);
    // A timesheet list flows across pages; centering it vertically would leave
    // a half-empty page floating at every break.
    expect(form("Week 1", 15, 120).pageSetup.verticalCentered).toBe(false);
  });
});
