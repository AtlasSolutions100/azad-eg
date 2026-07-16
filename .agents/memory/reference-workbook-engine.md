---
name: Reference-workbook export engine
description: Lessons from building exports by mutating Julie's ground-truth xlsx template
---

- The package export mutates a populated ground-truth workbook, not a blank template. **Rule:** every data cell must be explicitly written (or zeroed) — conditional "only write if value > 0" logic silently leaves Julie's original numbers in the output. **Why:** null/zero work-plan rates once risked leaking template OH/fee/FCCM rates into Sub Calc. **How to apply:** when injecting into any reference-derived sheet, write unconditionally.
- Work-plan rates are stored as percentages (120.58); reference cells hold fractions — divide by 100 on injection.
- ExcelJS worksheet renames do NOT rewrite formulas or defined names; the engine rewrites them manually. Comments must be scrubbed via the cell `_comment` property (cell.model is rebuilt per access).
- LibreOffice PDF conversion skips hidden sheets — hiding Overview yields the client page order in one convert call.
- Invoice cover holds exactly 10 billed line item rows (25–34); the limit is enforced at the PUT API boundary, not just export time.
- Work-plan billingCycle enum is `whole_month` | `last_friday` (not weekly/biweekly).
