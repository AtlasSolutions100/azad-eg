---
name: Procas GLDetail (Labor Journal) returns empty
description: Live GLDetail queries on Julie's Procas OData feed return zero rows — Labor Journal preference silently falls back to Timesheet.
---

Verified live (July 2026): `GLDetail` on the AZADEN Procas OData feed returns HTTP 200 with `value: []` for ALL queries — no filter, project-prefix filter, and TransDate ranges all come back empty. The table exists in $metadata but has no rows exposed to this account.

**Why:** Likely a permissions/export setting on the Procas side (GL data not enabled for the OData user). The legacy invoice sync prefers GLDetail with a Timesheet fallback, so in practice every pull uses raw Timesheet hours.

**How to apply:** Don't assume Labor Journal hours are available; treat Timesheet as the effective source until Procas support enables GL data for Julie's login. Re-probe GLDetail before building anything that depends on it. Also confirmed live: TimesheetPeriod has pay cycles B (bi-weekly) and W (weekly timesheets/biweekly pay), and Procas timesheet weeks run Monday–Sunday while BART wants Saturday-start weeks (user owes a cheat sheet; decision deferred).
