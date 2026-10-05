import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * A calendar day ("2026-08-01") as a Date at local midnight.
 *
 * `new Date("2026-08-01")` is midnight UTC, which is the evening before
 * anywhere in the Americas — so every billing period, week and effective date
 * was shown a day early ("Jul 31 – Aug 30" for a package billing August 1 to
 * 31). Use this for values that are days; timestamps keep `new Date()`.
 */
export function parseDay(value: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(value);
}
