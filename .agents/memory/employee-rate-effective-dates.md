---
name: Employee rate effective dates
description: How mid-period billing-rate changes flow into the two-row Labor Attachment split.
---

The workbook export splits Labor Attachment rows 19/20 (Overview I17/I18) purely on **distinct `rate` values across timesheet entries** — it has no notion of dates. Rate effective dates live upstream: `employee_rate_changes` (effective-dated home/field rates, base employees row applies before the earliest change; effectiveDate is inclusive).

**Rule:** any code path that assigns a rate to labor rows must resolve it through `effectiveRate()` in `artifacts/api-server/src/lib/employeeRates.ts`, using the week start (package entries) or period start (invoice line-item imports) as the as-of date. If a new import path hardcodes `emp.homeRate`, mid-period changes silently collapse to one labor row again.

**Why:** Julie's reference workbook shows a mid-period rate change as two labor rows (old-rate hours / new-rate hours); more than 2 distinct rates per period throws by design.

Frontend mirrors the same resolution in the timesheet entry dialog (employees list response embeds `rateChanges`).
