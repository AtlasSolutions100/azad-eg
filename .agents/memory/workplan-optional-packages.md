---
name: Work-plan-optional packages
description: Packages can bill without a work plan via Procas job + rate overrides; precedence and UI pitfalls.
---

Packages may have `workPlanId = null` and instead carry `procasProject`, `clientName`, `totalBudget`, and rate overrides (fringe/overhead/fixedFee/fccm, stored as percent, ÷100 at rollup). `effectiveWorkPlan(pkg, wp)` in billingProfile.ts synthesizes the billing view — **package-level overrides always beat linked work-plan values**.

**Why:** rates come from Procas BillingAccount as a prefill the biller can correct; overrides must win or manual corrections are ignored.

**How to apply:**
- Any form that hides the override fields (e.g. when the user switches to a real work plan) must also CLEAR them, or stale hidden values silently override work-plan rates.
- Budget/approval gates in PATCH must evaluate the prospective state (`{...existing, ...updateFields}`), not the pre-update row.
- `totalBudget <= 0` means "no budget tracked" — budget gates are skipped, not treated as over budget.
- Grouped dashboard endpoint keys wp-less packages by `job:${jobNumber}` with `workPlanId: 0`; frontend keys need a jobNumber fallback.
- Unique constraint (workPlanId, period) does not dedupe wp-less packages (nulls distinct) — accepted.
