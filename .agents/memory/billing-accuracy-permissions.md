---
name: Billing accuracy + delete permissions
description: Previously Billed carry-forward precedence, PTO/holiday zeroing, budget override precedence, and the verified-email delete allowlist.
---

- **Previously Billed precedence at package creation:** manual value > carry-forward (Total Billed To Date of the last approved/exported package for the same work plan, computed via the rollup) > Procas BillingHistory. Source string `carryforward` marks the middle case.
  **Why:** Griselda requires the new period's Previously Billed to equal exactly what the last approved invoice billed; Procas BillingHistory can lag or diverge.
- **PTO/holiday rows are non-billable everywhere:** their `amount` is zeroed inside the rollup's laborLines (not just excluded from totals), so labor attachment / sub calc exports can never disagree with the headline totals. Never re-derive amount as hours×rate downstream.
- **Budget precedence trap:** a package-level totalBudget override beats the linked work plan. Any UI that edits the work-plan budget for a linked package must also clear the package override (PATCH package `totalBudget: null` — nullable in the API for exactly this).
- **Package deletion allowlist:** only Griselda/Mahsa/Julie may delete packages. Authorization uses ONLY verified emails fetched server-side from Clerk (exact email or local-part match, `PACKAGE_DELETE_ALLOWLIST` env override). Never authorize on display names or session-claim names — users can edit those freely to impersonate.
- Auto-reconnect from Procas secrets is disabled under `NODE_ENV=test`/`VITEST`; otherwise "not connected" test paths hit the real network and hang.
