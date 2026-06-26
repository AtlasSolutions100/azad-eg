---
name: Labor Attachment template bounds
description: The Sub Labor Excel template has fixed-capacity row ranges; UI and overrides must respect them.
---

The Azad invoice "Sub Labor" Excel template that backs the Labor Attachment has
fixed row capacity: Home labor lines occupy rows 7–17 (11 lines) and Field labor
lines occupy rows 20–25 (6 lines). Override cell keys are Excel refs on that sheet
(D=hours, E=rate, F=amount, H=billed).

**Rule:** Any UI that lets users override labor cells must cap editable rows to that
capacity (home 11, field 6). Rows beyond the cap must be read-only — never generate
an override cellKey for them.

**Why:** The backend document generator truncates extra lines and the next rows are
subtotal cells. An override keyed to row 18 (just past home capacity) would land on a
subtotal cell and corrupt exported totals.

**How to apply:** Capacity constants live in `artifacts/azad-invoice/src/lib/package-ui.ts`
(LABOR_HOME_START/END, LABOR_FIELD_START/END). The labor editor
(`src/components/package/labor-tab.tsx`) derives HOME_CAPACITY/FIELD_CAPACITY from them
and renders overflow rows as read-only with a warning.
