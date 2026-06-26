---
name: Excel invoice template injection
description: Why backend financials are written as values (not left as formulas) into the BART invoice template, and how labor lines map.
---

# Injecting computed financials into the BART invoice template

The BART invoice `.xlsm` template's billing-summary cells (Invoice sheet
J35/J37/J38 etc.) contain formulas that reference a deep cross-sheet chain built
for a single hard-coded employee. They cannot recompute correctly for an
arbitrary multi-employee invoice.

**Rule:** write the authoritative backend-computed financials in as plain values
(L27 this-period, J34 budget, J35 this-period, J36 previously-billed, J37
total-to-date, J38 remaining), overwriting the template formulas. Do the same for
the "Sub Labor" attachment rows (Home rows 7-17, Field rows 20-25): clear the
sample rows, then write classification/employee/hours/rate/amount and a burden
column = amount * (1 + fringe/100) * (1 + fixedFee/100).

**Why:** two compounding problems make leaving the formulas in place unsafe:
1. exceljs does NOT recalculate formulas — it preserves the *stale cached result*
   that was saved with the template (e.g. a single-employee total like 26,189.77
   instead of the real 37,001.18).
2. headless `soffice --convert-to pdf` may not recalc on load either, so a reader
   could see the stale cached number.
Writing values sidesteps both and makes the backend financials the single source
of truth.

**How to apply:** any time you populate this template, inject values, never rely
on the template's own formula chain for totals. Preserve cell styling when
overwriting (setValuePreserveStyle).

## SubCalc exception: inject leaves, keep SUBTOTAL roll-ups

The SubCalc sheet ("Sub Calc _revised") is xlsx-only (not in the PDF set), so
Excel *does* recalc it on open (fullCalcOnLoad). There, prefer injecting only the
**leaf** H-column cells (labor/fringe/overhead at H7-9 home & H11-13 field, ODC at
H23, OT/DT premium at H24/H25, fixed fee H43, FCCM H48/H49) and leaving the
in-file SUBTOTAL roll-up rows (H10/H14/H20/H31/H47) untouched so they recompute.

**Why:** `H51 = SUBTOTAL(9, H7:H50)` and SUBTOTAL(9,…) *ignores other SUBTOTAL
cells inside its range*. So if you overwrite an intermediate subtotal (e.g. H31)
with a plain number, it stops being skipped and gets double-counted into H51.
Two rules follow: (1) never static-overwrite an intermediate SUBTOTAL cell while
leaving H51 as a formula; (2) zero every unused sample leaf row (H16-18, H25-30,
H39, H44, H50) or stale template figures leak into the recomputed total. The
headline H51 is still force-set to the authoritative total as a belt-and-braces
guard for non-recalculating viewers.
