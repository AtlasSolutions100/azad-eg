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
   * in one block. Procas does not record home vs field, so a pulled timesheet
   * arrives as Home — and every BART invoice she sends bills its labor under
   * Field. On the Parsons form that printed "Field 0.0 Hrs. $0.00" above an
   * overhead figure, with the hours on a Home line her invoice does not have.
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
  /**
   * The prime this work plan bills through, which decides the invoice form.
   * The package's own "Prime" is free text a biller may leave blank or word
   * differently; for a work plan whose invoice we hold, the form is not a
   * matter of what was typed.
   */
  prime?: KnownPrime;
  /** The agency the work is for. */
  owner?: string;
  /**
   * The indirect burden her invoice applies, in whole percents. Procas holds
   * none for a project whose billing rates are already loaded (see
   * LOADED_RATE_FLOOR), so this is what the work plan gets there; elsewhere it
   * is what a package is checked against.
   */
  burden?: Burden;
  /**
   * Burdens that applied to earlier billing periods: each is in force for a
   * period that starts before its `before` date. A client can change what an
   * invoice carries (BART added FCCM to T.Y. Lin's from September 2026), and
   * an invoice for an earlier month must still bill the way that month did.
   */
  burdenBefore?: Array<{ before: string; burden: Burden }>;
  /**
   * Procas bills this project at loaded hourly rates and holds no burden
   * percentages for it, so the burden here is the only record of it.
   */
  procasRatesLoaded?: boolean;
  /**
   * Her last invoice's "Amount To Date" column, row by row, and the budget
   * column beside it. The detail page prints Budget / Previously Billed /
   * Amount To Date on every row; only the totals can be had from Procas, so
   * the rows start from the last ones she printed.
   */
  detailAnchor?: DetailAnchor;
  // --- stored on the work plan, only while its budget is unset ---
  /** The work plan budget printed on her invoice. */
  totalBudget?: number;
}

export type KnownPrime = "AECOM" | "WSP" | "Parsons" | "T.Y. Lin";

export interface Burden {
  fringeRate: number;
  overheadRate: number;
  fixedFeeRate: number;
  fccmRate: number;
}

/** One column of an invoice detail page, row by row. */
export interface DetailParts {
  labor: number;
  fringe: number;
  odc: number;
  premium: number;
  fee: number;
  fccm: number;
  total: number;
}

export interface DetailAnchor {
  /** Last day of the period the invoice billed (YYYY-MM-DD). */
  through: string;
  toDate: DetailParts;
  budget: DetailParts;
}

const WSP_SEND_TO = {
  prime: "WSP",
  owner: "BART",
  laborLocation: "field",
  // "Fringe Benefits 120.58%", "Fixed Fee 8.00%", "FCCM Field (0.39% x Direct labor)".
  burden: { fringeRate: 120.58, overheadRate: 0, fixedFeeRate: 8, fccmRate: 0.39 },
  sendToCompany: "WSP USA INC",
  sendToAddress1: "3260 Lone Tree Way, Suite 104",
  sendToAddress2: "Antioch, CA 94509",
  agreementNo: "6M8178",
  terms: "Net 30",
  sendToExtra: "Email: candelaria.aldan@wsp.com",
} as const;

const PARSONS_SEND_TO = {
  prime: "Parsons",
  owner: "BART",
  laborLocation: "field",
  // "H&B Overhead Pool on Labor 120.58%", fee 8%, FCCM 0.39%.
  burden: { fringeRate: 0, overheadRate: 120.58, fixedFeeRate: 8, fccmRate: 0.39 },
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
  prime: "T.Y. Lin",
  owner: "BART",
  // "Fringe Benefits 120.58%", fee 8%, and — from the September 2026 invoice,
  // at BART's request — FCCM at 0.39% of direct labor. Procas's loaded rates
  // for the project changed on the same day: Field Inspector went from 197.73
  // ($83.00 x 2.2058 x 1.08) to 198.051612 (the same plus $83.00 x 0.0039).
  burden: { fringeRate: 120.58, overheadRate: 0, fixedFeeRate: 8, fccmRate: 0.39 },
  burdenBefore: [
    { before: "2026-09-01", burden: { fringeRate: 120.58, overheadRate: 0, fixedFeeRate: 8, fccmRate: 0 } },
  ],
  procasRatesLoaded: true,
  // Invoice 6M8213 A.02-01-20, period 6/01/2026 - 6/30/2026.
  detailAnchor: {
    through: "2026-06-30",
    toDate: {
      labor: 993573.03,
      fringe: 1104007.23,
      odc: 7304.25,
      premium: 3358.8,
      fee: 167806.44,
      fccm: 0,
      total: 2276049.75,
    },
    budget: {
      labor: 1145407.63,
      fringe: 1248494.32,
      odc: 2640,
      premium: 0,
      fee: 191512.16,
      fccm: 0,
      total: 2588054.11,
    },
  },
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
    prime: "AECOM",
    owner: "BART",
  laborLocation: "field",
    // "Field OH 120.58%", fee 8%, FCCM 0.39% (invoice B.50-01-30, June 2026).
    burden: { fringeRate: 0, overheadRate: 120.58, fixedFeeRate: 8, fccmRate: 0.39 },
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
    procasRatesLoaded: true,
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
    procasRatesLoaded: true,
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
  // Matched on the number alone: Procas files T.Y. Lin's as "6M8213 GEC", and
  // her invoice reads "6M8213 General Engineering Services".
  if (own && (!no || own.startsWith(agreementNumber(no)))) return own;
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

/** True when two burdens bill the same percentages. */
export function sameBurden(
  a: { fringeRate?: number | null; overheadRate?: number | null; fixedFeeRate?: number | null; fccmRate?: number | null },
  b: { fringeRate?: number | null; overheadRate?: number | null; fixedFeeRate?: number | null; fccmRate?: number | null },
): boolean {
  const near = (x?: number | null, y?: number | null) => Math.abs((x ?? 0) - (y ?? 0)) < 0.0005;
  return (
    near(a.fringeRate, b.fringeRate) &&
    near(a.overheadRate, b.overheadRate) &&
    near(a.fixedFeeRate, b.fixedFeeRate) &&
    near(a.fccmRate, b.fccmRate)
  );
}

/**
 * The earlier burden in force for a period that starts on `periodStart`, or
 * null when the work plan's current burden applies.
 */
export function historicalBurden(
  keys: Array<string | null | undefined>,
  periodStart: string | null | undefined,
): Burden | null {
  if (!periodStart) return null;
  const earlier = (knownHeader(...keys)?.burdenBefore ?? [])
    .filter((b) => periodStart < b.before)
    .sort((a, b) => a.before.localeCompare(b.before))[0];
  return earlier?.burden ?? null;
}

/** The burden her invoices carry for a period: the earlier one if it applies, else today's. */
export function knownBurden(
  keys: Array<string | null | undefined>,
  periodStart?: string | null,
): Burden | null {
  return historicalBurden(keys, periodStart) ?? knownHeader(...keys)?.burden ?? null;
}

/**
 * The prime a package's documents are built for.
 *
 * Which invoice form is produced hangs on this, and it used to be read from
 * the package's free-text "Prime" alone. Left blank — it is optional, and the
 * first package on a work plan has nothing to suggest it from — every package
 * fell through to the AECOM form: a T.Y. Lin package then failed to export at
 * all ("at most 2 billing rates"), and a Parsons or WSP one exported on the
 * wrong prime's paperwork without a word.
 *
 * A work plan whose invoice we hold bills through the prime on that invoice.
 * Otherwise what the biller typed stands, and failing that the client's name
 * is read for one of the four primes.
 */
export function formPrime(opts: {
  typed?: string | null;
  keys: Array<string | null | undefined>;
  client?: string | null;
}): string | null {
  const known = knownHeader(...opts.keys)?.prime;
  if (known) return known;
  const typed = (opts.typed ?? "").trim();
  if (typed) return typed;
  const client = opts.client ?? "";
  if (/\bwsp\b/i.test(client)) return "WSP";
  if (/t\.?\s*y\.?\s*lin|tylin/i.test(client)) return "T.Y. Lin";
  if (/parsons/i.test(client)) return "Parsons";
  if (/aecom/i.test(client)) return "AECOM";
  return null;
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
