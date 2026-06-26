---
name: Excel export repair warning from broken defined names
description: Why generated BART/package workbooks trigger Excel's "Removed Records: Named range" repair prompt, and the fix.
---

# Excel "repair / Removed Records: Named range" on generated workbooks

The source xlsx/xlsm templates carry leftover **defined (named) ranges** whose
target is invalid: an external-workbook ref like `'[1]Sub Calc'!$H$51` (the `[1]`
is an external workbook index) or a `#REF!`. When ExcelJS regenerates the
workbook, Excel detects these on open and strips them, showing an alarming
"Removed Records: Named range from /xl/workbook.xml" repair prompt. None of the
broken names are used by the generated documents.

**Fix:** strip defined names whose any range matches `#REF!` or `\[...\]`
(external token) before writing the workbook. Valid in-workbook names (e.g.
subcalc `BALANCE`/`FIXFEE` → `'Sub Calc _revised'`, labor `consultant` →
`'Sub Labor'`) must be preserved — they back template formulas.

**Why explicit filtering, not a no-op reassign:** ExcelJS `definedNames` model
setter re-adds any range whose A1 part passes its regex, so just reading and
re-assigning the model does NOT drop external/`#REF!` names. You must
`.filter(...)` the model array, then assign the filtered list.

**How to apply:** any new export template added to the package/invoice pipeline
inherits this risk — route every generated workbook through the shared
`stripBrokenDefinedNames` before write. The five package generators funnel
through one write chokepoint; the legacy invoice builder has its own.
