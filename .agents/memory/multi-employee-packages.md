---
name: Multi-employee package contributors
description: How billing packages identify contributing employees after the job-first reorg
---
Packages are job-level invoices; `employeeId` on a package is a nullable legacy "primary employee" only. The real contributor list is derived from timesheet entries.

**Rule:** Always key contributor grouping by employee identity (`id:<employeeId>`, falling back to `name:<normalized>` only for legacy rows without an ID) — never by name alone.

**Why:** Grouping by name collapses two different employees who share a name, corrupting per-employee contributions and dropping their separate timesheet sheets in exports (caught in code review of the job-first reorg).

**How to apply:** Use the shared contributor-key helper in the api-server package mappers for any new aggregation, doc generation, or display logic over timesheet entries. Timesheet exports emit one sheet per week per contributor; export file names use the employee name only when there is exactly one contributor.

Entry creation/rename resolves `employeeId` from the name server-side (unique match only; ambiguous or unknown names stay null), and startup backfills legacy null-ID rows the same way. Name-to-ID resolution must never guess between employees sharing a name.
