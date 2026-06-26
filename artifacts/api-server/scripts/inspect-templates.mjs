import ExcelJS from "exceljs";
import path from "node:path";

const files = {
  Invoice: "Professional_Service_Agreement_Invoice_1782427988348.xlsx",
  SubCalc: "Invoice_Detail_Attachment__1782427988348.xlsx",
  ProgressReport: "Progress_Report__1782427988347.xlsx",
  LaborAttachment: "Labor_Attachment__1782427988347.xlsx",
  Timesheets: "Timesheets__1782427988333.xlsx",
};

const root = path.resolve(process.cwd(), "../..");
const target = process.argv[2];

function fmtVal(v) {
  if (v == null) return "";
  if (typeof v === "object") {
    if ("formula" in v) return `=${v.formula}${v.result !== undefined ? ` [${JSON.stringify(v.result)}]` : ""}`;
    if ("richText" in v) return v.richText.map((r) => r.text).join("");
    if ("result" in v) return JSON.stringify(v.result);
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    return JSON.stringify(v);
  }
  return String(v);
}

for (const [name, file] of Object.entries(files)) {
  if (target && name !== target) continue;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path.resolve(root, "attached_assets", file));
  console.log(`\n========== ${name} (${file}) ==========`);
  wb.eachSheet((ws) => {
    console.log(`\n--- SHEET: "${ws.name}" rows=${ws.rowCount} cols=${ws.columnCount} dim=${ws.dimensions?.toString?.() ?? ""} ---`);
    if (ws.model?.merges?.length) console.log(`MERGES: ${ws.model.merges.join(", ")}`);
    ws.eachRow({ includeEmpty: false }, (row, rn) => {
      const cells = [];
      row.eachCell({ includeEmpty: false }, (cell, cn) => {
        const val = fmtVal(cell.value);
        if (val !== "") cells.push(`${cell.address}=${val.slice(0, 60)}`);
      });
      if (cells.length) console.log(`R${rn}: ${cells.join(" | ")}`);
    });
  });
}
