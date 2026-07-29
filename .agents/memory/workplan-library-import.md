---
name: Procas work-plan library import ownership
description: Rules for the work_plans "source" column and library import from Procas.
---

Work plans carry `source` = `manual` | `procas`.

**Rule:** the Procas library import only refreshes display fields (title/client/status) on rows with `source = 'procas'`; a biller PATCH that touches title/client/status flips the row back to `manual`, permanently taking ownership. Budgets are never overwritten once non-zero. A partial unique index (`source='procas' and procas_project not null`) plus `onConflictDoNothing` makes concurrent imports (scheduler vs manual refresh button) race-safe.

**Why:** billers manually link plans to Procas via `procasProject`; treating any linked plan as import-owned would stomp their edits every sync cycle.

**How to apply:** any new sync path that writes work-plan display fields must check `source`; any new "Procas-owned" field should follow the same flip-to-manual-on-edit rule.
