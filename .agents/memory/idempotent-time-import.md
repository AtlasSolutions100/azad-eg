---
name: Idempotent time import / Procas sync
description: How line_items.source keeps re-imports from duplicating labor rows
---

Line items carry a `source` column: `"manual"` for hand-entered rows, or the
import origin (`"timesheet"` / `"procas"`) for auto-imported rows.

**Rule:** any time-import or Procas sync first deletes the invoice's prior
auto-imported rows (`source != "manual"`) before inserting the fresh pull, then
reports `replacedCount` in the ImportResult and a warning. Manual rows survive.

**Why:** both importers used to blindly append, so re-syncing a period stacked
duplicate labor and inflated invoice totals. Replacing makes import idempotent
while preserving biller corrections.

**How to apply:** keep `clearAutoImportedLineItems` (in the invoices route) as the
single choke point — if a new import path is added, route it through the same
delete-then-insert, set `source` on inserted rows, and surface replacedCount.
