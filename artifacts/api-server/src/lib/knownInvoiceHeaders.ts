/**
 * Invoice header details read off Julie's own invoices, keyed by Procas
 * project.
 *
 * The cover's Send To block, contact person, PO number, client project number
 * and BART project numbers are the prime's paperwork — Procas does not hold
 * them — so a work plan imported from Procas arrives with all of them blank
 * and the invoice prints an empty Send To and "--" for the PO. The app warns
 * about that and points at the Work Plan screen, but for a work plan whose real
 * invoice we already hold there is nothing for the biller to look up: the
 * values are on the invoice she sent us. They are filled in once, only where
 * the field is still blank, and never overwrite anything she has typed.
 *
 * 10007 — AECOM, from invoice B.50-01-30 (June 2026). Supplier ID is absent on
 * purpose: her invoice prints "--" there.
 */
export interface KnownInvoiceHeader {
  sendToCompany?: string;
  sendToAddress1?: string;
  sendToAddress2?: string;
  contactPerson?: string;
  poNumber?: string;
  clientProjectNo?: string;
  agreementNo?: string;
  bartProjectNumbers?: string;
}

export const KNOWN_INVOICE_HEADERS: Record<string, KnownInvoiceHeader> = {
  "10007": {
    sendToCompany: "AECOM",
    sendToAddress1: "300 Lakeside Drive, Suite 400",
    sendToAddress2: "Oakland, CA 94612",
    contactPerson: "Chris Berilla, Program Manager",
    poNumber: "1638681",
    clientProjectNo: "60723341.03",
    agreementNo: "6M8142",
    bartProjectNumbers: "(15CQ002, 15TC002, 45GA000) 15NL004, 15TC002, 15TC012,15CQ002, 15QN004",
  },
};

/**
 * The service description BART's agreements carry after their number on the
 * cover's "Agreement No." line ("6M8142 Architectural and General Engineering
 * Services"). Her template builds that line from the number plus this text.
 */
export const AGREEMENT_TITLES: Record<string, string> = {
  "6M8142": "Architectural and General Engineering Services",
};

/** "6M8142" → "6M8142 Architectural and General Engineering Services". */
export function agreementLine(agreementNo: string | null | undefined): string {
  const no = (agreementNo ?? "").trim();
  if (!no) return "";
  const title = AGREEMENT_TITLES[no];
  return title ? `${no} ${title}` : no;
}

/**
 * The agreement's number alone, for the places that print it as a short code
 * (the timesheet's "Contract / Workplan" column, the progress report header).
 */
export function agreementNumber(agreementNo: string | null | undefined): string {
  return (agreementNo ?? "").trim().split(/\s+/)[0] ?? "";
}
