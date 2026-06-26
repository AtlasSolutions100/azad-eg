import type { DocStatus } from "@workspace/api-client-react";

export type DocKind = "invoice" | "subcalc" | "progress" | "labor" | "timesheets";

export interface DocMeta {
  kind: DocKind;
  label: string;
  shortLabel: string;
  description: string;
  statusField:
    | "invoiceDocStatus"
    | "subCalcDocStatus"
    | "progressReportDocStatus"
    | "laborAttachmentDocStatus"
    | "timesheetsDocStatus";
}

export const DOC_METAS: DocMeta[] = [
  {
    kind: "invoice",
    label: "Invoice",
    shortLabel: "Invoice",
    description: "Cover invoice with billing summary and signature.",
    statusField: "invoiceDocStatus",
  },
  {
    kind: "subcalc",
    label: "Sub Calc",
    shortLabel: "Sub Calc",
    description: "Burden, fringe, overhead and fee roll-up.",
    statusField: "subCalcDocStatus",
  },
  {
    kind: "progress",
    label: "Progress Report",
    shortLabel: "Progress",
    description: "Narrative report of work performed this period.",
    statusField: "progressReportDocStatus",
  },
  {
    kind: "labor",
    label: "Labor Attachment",
    shortLabel: "Labor",
    description: "Per-employee labor detail with burden applied.",
    statusField: "laborAttachmentDocStatus",
  },
  {
    kind: "timesheets",
    label: "Timesheets",
    shortLabel: "Timesheets",
    description: "Weekly timesheets backing the labor detail.",
    statusField: "timesheetsDocStatus",
  },
];

export const DOC_STATUS_STYLES: Record<
  DocStatus,
  { label: string; dot: string; badge: string }
> = {
  not_started: {
    label: "Not started",
    dot: "bg-gray-300",
    badge: "bg-gray-100 text-gray-600 border-gray-200",
  },
  in_progress: {
    label: "In progress",
    dot: "bg-amber-400",
    badge: "bg-amber-50 text-amber-700 border-amber-200",
  },
  ready: {
    label: "Ready",
    dot: "bg-emerald-500",
    badge: "bg-emerald-50 text-emerald-700 border-emerald-200",
  },
};

export const PACKAGE_STATUS_STYLES: Record<string, string> = {
  draft: "bg-gray-100 text-gray-700 border-gray-200",
  in_review: "bg-blue-50 text-blue-700 border-blue-200",
  approved: "bg-emerald-50 text-emerald-700 border-emerald-200",
  exported: "bg-violet-50 text-violet-700 border-violet-200",
};

export function formatCurrency(value: number): string {
  return value.toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function formatHours(value: number): string {
  return value.toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });
}

// ---------------------------------------------------------------------------
// Labor Attachment cell mapping. Mirrors the "Sub Labor" template layout used
// by the backend generator: home rows 7-17, field rows 20-25. Columns:
// B=classification, C=employee, D=hours, E=rate, F=amount, H=billed.
// ---------------------------------------------------------------------------

export const LABOR_HOME_START = 7;
export const LABOR_HOME_END = 17;
export const LABOR_FIELD_START = 20;
export const LABOR_FIELD_END = 25;

export type LaborColumn = "hours" | "rate" | "amount" | "billed";

const LABOR_COLUMN_LETTER: Record<LaborColumn, string> = {
  hours: "D",
  rate: "E",
  amount: "F",
  billed: "H",
};

export function laborCellKey(
  block: "home" | "field",
  rowIndex: number,
  column: LaborColumn,
): string {
  const base = block === "home" ? LABOR_HOME_START : LABOR_FIELD_START;
  return `${LABOR_COLUMN_LETTER[column]}${base + rowIndex}`;
}
