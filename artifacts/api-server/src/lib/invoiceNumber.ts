/**
 * Invoice numbers keep a static prefix and increment a trailing suffix, e.g.
 *   "A.04-02-12"        -> "A.04-02-13"
 *   "6M8213 A.02-01-21" -> "6M8213 A.02-01-22"
 *   "Invoice_AZAD-9"    -> "Invoice_AZAD-10"
 * We bump the last run of digits, preserving any zero-padding width, and leave
 * everything before it untouched. Returns null when there's no trailing number
 * to increment (the biller then types it).
 */
export function bumpInvoiceNumber(prev: string | null | undefined): string | null {
  if (!prev) return null;
  // Trailing digits, ignoring trailing whitespace.
  const m = prev.match(/^(.*?)(\d+)(\s*)$/s);
  if (!m) return null;
  const [, head, digits, trailingWs] = m;
  const next = String(Number(digits) + 1);
  // Preserve zero-padding width (e.g. "09" -> "10", "009" -> "010").
  const padded = next.padStart(digits.length, "0");
  return `${head}${padded}${trailingWs}`;
}
