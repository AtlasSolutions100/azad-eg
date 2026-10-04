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
 * values are on the invoice she sent us.
 *
 * Two kinds of field live here.
 *
 *  - **Stored fields** (Send To, contact, PO, project numbers, terms…) are
 *    written onto the work plan once, only where it is still blank, and never
 *    overwrite anything typed in. See `applyKnownInvoiceHeaders`.
 *  - **Document fields** — the work plan number, title and job number the
 *    CLIENT knows the work by. Procas files T.Y. Lin's work as project "10014";
 *    her invoice calls it work plan "A.02-01" under job number "T4567". Those
 *    are not stored (the Procas import owns `code` and `title` and would put
 *    them back); they are swapped in when a document is built. See
 *    `docWorkPlan`.
 *
 * Sources: the June 2026 invoices in `BART Invoices/` — AECOM B.50-01-30,
 * T.Y. Lin AZAD-20, Parsons B.55 and B.40-02 AZAD-09, WSP AZAD-13/-16/-23.
 */
export interface KnownInvoiceHeader {
  // --- stored on the work plan, fill-if-blank ---
  sendToCompany?: string;
  sendToAddress1?: string;
  sendToAddress2?: string;
  contactPerson?: string;
  poNumber?: string;
  wspProjectNo?: string;
  supplierId?: string;
  clientProjectNo?: string;
  agreementNo?: string;
  bartProjectNumbers?: string;
  terms?: string;
  // --- used when a document is built, never stored ---
  /** The work plan number as the client's paperwork writes it, e.g. "A.02-01". */
  workPlanNo?: string;
  /** The work plan title as it prints on her invoice. */
  title?: string;
  /** The prime's job / contract number for the "Job Number" style boxes. */
  jobNumber?: string;
  /** The full "Agreement No." line when it carries a description. */
  agreementLine?: string;
  /** A further line under the Send To address (WSP: the AP contact email). */
  sendToExtra?: string;
  /**
   * Where every hour on this work plan is billed, when her invoice has it all
   * in one block. Procas does not record home vs field.
   */
  laborLocation?: "home" | "field";
  /**
   * The work plan is charged to several BART projects and her paperwork keeps
   * them apart: as "lines" on one invoice (WSP A.03.01), or as one invoice
   * each ("invoices" — Parsons, from July 2026: "B.40-02-11 (20CE002)").
   * Procas books the time to a leaf project per BART project; with this set,
   * the pull keeps that project on each timesheet entry (its Task No.).
   */
  billsByBartProject?: "lines" | "invoices";
  // --- stored on the work plan, only while its budget is unset ---
  /** The work plan budget printed on her invoice. */
  totalBudget?: number;
}

const WSP_SEND_TO = {
  sendToCompany: "WSP USA INC",
  sendToAddress1: "3260 Lone Tree Way, Suite 104",
  sendToAddress2: "Antioch, CA 94509",
  agreementNo: "6M8178",
  terms: "Net 30",
  sendToExtra: "Email: candelaria.aldan@wsp.com",
} as const;

const PARSONS_SEND_TO = {
  sendToCompany: "Parsons Transport Group, Inc",
  sendToAddress1: "555 12th Street, Suite 2130",
  sendToAddress2: "Oakland, CA  94607",
  contactPerson: "Doug Woodville",
  poNumber: "N/A",
  agreementNo: "6M8146",
  terms: "Net 30",
  jobNumber: "6M8146",
} as const;

const TYLIN: KnownInvoiceHeader = {
  sendToCompany: "T.Y. Lin International + TSE, JV",
  sendToAddress1: "Accounts Payable Department",
  poNumber: "BARTD-0000069210",
  agreementNo: "6M8213",
  terms: "Net 30",
  workPlanNo: "A.02-01",
  title: "A.02-01 &A02-02 Construction Mngment., Design Ovesight & PM Support",
  // Her "Job Number" box reads T4567 — T.Y. Lin's number for the job, not
  // Procas's 10014.
  jobNumber: "T4567",
  agreementLine: "6M8213 General Engineering Services",
  laborLocation: "field",
  totalBudget: 2588054.11,
};

export const KNOWN_INVOICE_HEADERS: Record<string, KnownInvoiceHeader> = {
  // BART / AECOM — invoice B.50-01-30. Supplier ID is absent on purpose: her
  // invoice prints "--" there. The work scope ("B.50-03") comes from the PO
  // schedule rather than from here.
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
  // BART / Parsons — Narmadha Gopalasamy, work plan B.40-02-001.
  "10009.02": {
    ...PARSONS_SEND_TO,
    workPlanNo: "B.40-02-001",
    title: "Provide Project Management and Support for Mechanical, Train Control, & Communication Projects",
    totalBudget: 363069.55,
    billsByBartProject: "invoices",
    agreementLine: "6M8146 PM Support for Electrical &Train Control Projects",
  },
  // BART / Parsons — Hashmatullah Ahmadzai, work plan B.55.
  "10009.03": {
    ...PARSONS_SEND_TO,
    workPlanNo: "B.55",
    title: "Scheduling Support for Capital Projects",
    totalBudget: 294815.33,
    billsByBartProject: "invoices",
    agreementLine: "6M8146 – Scheduling Support for Capital Projects",
  },
  // BART / WSP — De'Andre Rashad, work plan A.03.01.
  "10013.TO01": {
    ...WSP_SEND_TO,
    contactPerson: "Candelaria Aldan",
    poNumber: "66869",
    supplierId: "0000003167",
    bartProjectNumbers: "15EJRRC, 15EJRRK, 49GH006",
    workPlanNo: "A.03.01",
    title: "Material Procurement & Warehouse Management Support",
    // Three PO lines: 452,143.97 + 452,143.97 + 301,429.30.
    totalBudget: 1205717.24,
    billsByBartProject: "lines",
  },
  // BART / WSP — Imani Lawson, work plan A.05-01.
  "10013.TO02": {
    ...WSP_SEND_TO,
    contactPerson: "Candelaria (Cindy) Aldan - Project Financial Analyst",
    poNumber: "71262",
    wspProjectNo: "30900569.4687",
    bartProjectNumbers: "60C004",
    workPlanNo: "A.05-01",
    title: "MOCC & LMA HVAC",
    totalBudget: 448277.84,
  },
  // BART / WSP — Jordy Peralta, work plan A.04-02.
  "10013.TO03": {
    ...WSP_SEND_TO,
    contactPerson: "Candelaria (Cindy) Aldan - Project Financial Analyst",
    poNumber: "71994",
    wspProjectNo: "30900569.7859",
    bartProjectNumbers: "47CJ016, 20LT008",
    workPlanNo: "A.04-02",
    title: "Assistant Resident Engineer / Inspector for Train Control and Communication Projects",
    totalBudget: 156185.34,
  },
  // BART / T.Y. Lin — Procas carries it as both 10014 and 10014.01.
  "10014": TYLIN,
  "10014.01": TYLIN,
};

/**
 * The header entry for a work plan: its own project code, or the registered
 * project it is a sub-code of. The dot keeps `100070` from matching `10007`.
 */
export function knownHeader(...keys: Array<string | null | undefined>): KnownInvoiceHeader | null {
  for (const raw of keys) {
    const key = (raw ?? "").trim();
    if (!key) continue;
    if (KNOWN_INVOICE_HEADERS[key]) return KNOWN_INVOICE_HEADERS[key];
    const parent = Object.keys(KNOWN_INVOICE_HEADERS)
      .filter((p) => key.startsWith(p + "."))
      .sort((a, b) => b.length - a.length)[0];
    if (parent) return KNOWN_INVOICE_HEADERS[parent];
  }
  return null;
}

/**
 * The work plan as the CLIENT'S paperwork names it.
 *
 * Every engine prints `code`, `title` and `jobNumber` in a dozen places — the
 * invoice line ("Work Plan A.02-01"), the timesheets' contract column
 * ("6M8213 A.02-01"), the labor attachment, the progress report. With a work
 * plan imported from Procas those all came out as Procas's own identifiers:
 * "Work Plan 10014", "Job Number 10014". This swaps in the client's, once, so
 * every engine gets them without each having to look them up. `procasProject`
 * is left alone — it is still how the register and the PO schedule are found.
 */
export function docWorkPlan<
  T extends { code: string; title: string; jobNumber: string; procasProject?: string | null },
>(view: T): T {
  const header = knownHeader(view.procasProject, view.jobNumber, view.code);
  if (!header) return view;
  return {
    ...view,
    code: header.workPlanNo ?? view.code,
    title: header.title ?? view.title,
    jobNumber: header.jobNumber ?? view.jobNumber,
  };
}

/**
 * The service description BART's agreements carry after their number on the
 * cover's "Agreement No." line ("6M8142 Architectural and General Engineering
 * Services"). Her template builds that line from the number plus this text.
 */
export const AGREEMENT_TITLES: Record<string, string> = {
  "6M8142": "Architectural and General Engineering Services",
};

/**
 * The cover's "Agreement No." line. A work plan whose invoice words it its own
 * way (Parsons: "6M8146 – Scheduling Support for Capital Projects") uses that;
 * otherwise the number plus the agreement's description, if we hold one.
 */
export function agreementLine(
  agreementNo: string | null | undefined,
  ...projectKeys: Array<string | null | undefined>
): string {
  const no = (agreementNo ?? "").trim();
  const own = knownHeader(...projectKeys)?.agreementLine;
  if (own && (!no || own.startsWith(no))) return own;
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

/** The fields `applyKnownInvoiceHeaders` may write onto a work plan. */
export const STORED_HEADER_FIELDS = [
  "sendToCompany",
  "sendToAddress1",
  "sendToAddress2",
  "contactPerson",
  "poNumber",
  "wspProjectNo",
  "supplierId",
  "clientProjectNo",
  "agreementNo",
  "bartProjectNumbers",
  "terms",
] as const;
