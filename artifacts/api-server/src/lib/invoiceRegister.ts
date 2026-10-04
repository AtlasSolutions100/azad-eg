import type { BillingCycle } from "./billingPeriod";

/**
 * Julie's invoice register — the "Invoice Numbers and naming conv" and
 * "Billing Periods" tabs of `Procas _ Azad Dashboard.xlsx`, which she pointed
 * to on Aug 27 ("Tab 2 and Tab 3 of this spreadsheet… outlines the billing
 * periods. I listed all of our invoices").
 *
 * For each Procas project it records three things the system had been asking
 * her for, or guessing at:
 *
 *  - **Billing period type.** BART "last Friday" for AECOM, Parsons and WSP;
 *    "Last day of the month" for T.Y. Lin. On Sep 25 last-Friday was made the
 *    default for EVERY imported work plan, and a Procas refresh "corrected"
 *    them all to it — wrong for T.Y. Lin, and unfounded for the Caltrans,
 *    SFCTA, VTA and City work plans the sheet gives no period type for. The
 *    cycle now comes from this register and nothing else; a project it does
 *    not name keeps the calendar-month default it always had.
 *  - **The July 2026 invoice number**, which seeds the series. She was asked
 *    twice to "type the first invoice number"; it was already here.
 *  - **The file name** the invoice is sent under.
 *
 * Keys are Procas project codes as the sheet writes them. Values are
 * transcribed, not derived — the T.Y. Lin number really does carry its
 * agreement prefix, and the WSP numbers really do mix "A.03.01" and "A.04-02".
 */
export interface RegisterEntry {
  billingCycle?: BillingCycle;
  /** Invoice number for the July 2026 billing month. */
  julyInvoiceNumber?: string;
  /** Sent-file name with `{MM}`, `{YYYY}` and `{N}` (the invoice's own number). */
  fileNameTemplate?: string;
}

/** The billing month the register's invoice numbers belong to. */
const REGISTER_YEAR = 2026;
const REGISTER_MONTH = 7;

export const INVOICE_REGISTER: Record<string, RegisterEntry> = {
  // BART / AECOM — Travis Johnson
  "10007": {
    billingCycle: "last_friday",
    julyInvoiceNumber: "B.50-01-31",
    fileNameTemplate: "{MM}-{YYYY}-BART6M8142-AECOM-B.50-01 Invoice_AZAD-{N}",
  },
  // BART / Parsons — Narmadha Gopalasamy. Her sheet lists one file per BART
  // project (20CE002, 20LN003, …) under this number, so no single file name.
  "10009.02": {
    billingCycle: "last_friday",
    julyInvoiceNumber: "B.40-02-11",
    fileNameTemplate: "{MM}-{YYYY}-BART 6M8146-Parsons-B.40-02-001 Invoice_AZAD-{N}",
  },
  // BART / Parsons — Hashmatullah Ahmadzai (likewise one file per project).
  "10009.03": {
    billingCycle: "last_friday",
    julyInvoiceNumber: "B.55-10",
    fileNameTemplate: "{MM}-{YYYY}-BART 6M8146-Parsons-B55 Invoice_AZAD-{N}",
  },
  // BART / WSP — De'Andre Rashad
  "10013.TO01": {
    billingCycle: "last_friday",
    julyInvoiceNumber: "A.03.01-24",
    fileNameTemplate: "{MM}-{YYYY}-BART6M8178-WSP-A.03-01-Invoice_AZAD-{N}",
  },
  // BART / WSP — Imani Lawson. The sheet leaves her period type blank; every
  // other WSP row is last-Friday and Julie described the rule as "by prime".
  "10013.TO02": { billingCycle: "last_friday", julyInvoiceNumber: "A.05.01-17" },
  // BART / WSP — Jordy Peralta
  "10013.TO03": {
    billingCycle: "last_friday",
    julyInvoiceNumber: "A.04-02-14",
    fileNameTemplate: "{MM}-{YYYY}-BART6M8178-WSP-A.04-01-Invoice_AZAD-{N}",
  },
  // BART / T.Y. Lin — "Last day of the month", NOT last Friday.
  "10014": { billingCycle: "whole_month", julyInvoiceNumber: "6M8213 A.02-01-21" },
};

/**
 * The register entry for a work plan: its own project code, or the registered
 * project it is a sub-code of (`10014.01` → `10014`, `10007.00.00.00.CA` →
 * `10007`). The dot keeps `100070` from matching `10007`.
 */
export function registerEntry(...keys: Array<string | null | undefined>): RegisterEntry | null {
  for (const raw of keys) {
    const key = (raw ?? "").trim();
    if (!key) continue;
    if (INVOICE_REGISTER[key]) return INVOICE_REGISTER[key];
    const parent = Object.keys(INVOICE_REGISTER)
      .filter((p) => key.startsWith(p + "."))
      .sort((a, b) => b.length - a.length)[0];
    if (parent) return INVOICE_REGISTER[parent];
  }
  return null;
}

export function knownBillingCycle(...keys: Array<string | null | undefined>): BillingCycle | null {
  return registerEntry(...keys)?.billingCycle ?? null;
}

/** Whole months from the register's month (July 2026) to a `YYYY-MM-DD` date. */
function monthsSinceRegister(date: string): number | null {
  const m = /^(\d{4})-(\d{2})-\d{2}$/.exec(date);
  if (!m) return null;
  return (Number(m[1]) - REGISTER_YEAR) * 12 + (Number(m[2]) - REGISTER_MONTH);
}

/** Adds `by` to the trailing number of an invoice number, keeping its padding. */
function advance(number: string, by: number): string | null {
  const m = number.match(/^(.*?)(\d+)(\s*)$/s);
  if (!m) return null;
  const next = String(Number(m[2]) + by).padStart(m[2].length, "0");
  return `${m[1]}${next}${m[3]}`;
}

/**
 * The invoice number for a billing period on a work plan that has no numbered
 * package yet: July's number, advanced one per month. `B.50-01-31` in July is
 * `B.50-01-32` for the period ending in August. Null before July 2026 or for a
 * project the register does not number.
 */
export function seededInvoiceNumber(
  keys: Array<string | null | undefined>,
  periodEnd: string,
): string | null {
  const july = registerEntry(...keys)?.julyInvoiceNumber;
  const months = monthsSinceRegister(periodEnd);
  if (!july || months == null || months < 0) return null;
  return advance(july, months);
}

/**
 * The name the invoice is sent under, e.g. for the period ending 8/28/2026 and
 * invoice B.50-01-32: `08-2026-BART6M8142-AECOM-B.50-01 Invoice_AZAD-32`. The
 * month is the period's closing month; the number is the invoice's own.
 */
export function clientFileBase(
  keys: Array<string | null | undefined>,
  periodEnd: string,
  invoiceNumber: string | null | undefined,
): string | null {
  const template = registerEntry(...keys)?.fileNameTemplate;
  const date = /^(\d{4})-(\d{2})-\d{2}$/.exec(periodEnd);
  const n = /(\d+)\s*$/.exec(invoiceNumber ?? "");
  if (!template || !date || !n) return null;
  return template.replace("{MM}", date[2]).replace("{YYYY}", date[1]).replace("{N}", n[1]);
}
