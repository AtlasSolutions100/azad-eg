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
