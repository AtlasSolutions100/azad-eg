/**
 * "Johnson, Travis" → "Travis Johnson".
 *
 * Procas stores people surname-first, and that is how names reached the
 * client's paperwork: "Employee Name: Johnson, Travis" on every timesheet and
 * "Submitted by: Johnson, Travis, Program Manager" on the progress report —
 * the second of which reads as three things. Julie's own invoices write the
 * name the way it is said. Only an unambiguous "Last, First" is turned round;
 * anything else is left exactly as it is.
 */
export function toDisplayName(name: string | null | undefined): string {
  const raw = (name ?? "").trim();
  const parts = raw.split(",");
  if (parts.length !== 2) return raw;
  const last = parts[0].trim();
  const first = parts[1].trim();
  if (!last || !first) return raw;
  return `${first} ${last}`;
}
