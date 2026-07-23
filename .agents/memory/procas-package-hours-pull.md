---
name: Procas package hours pull
description: How labor hours are pulled from the Procas OData feed into billing packages, and the feed quirks that matter.
---

- Work plans map to Procas via a project *prefix* (`work_plans.procas_project`, e.g. "10007"); timesheets are booked at leaf codes ("10007.01.01.0.CA"), so queries use `startswith(Project, prefix)` — verified live that Procas supports `startswith`.
- Weeks come from Procas `TimePeriodBeginningDate/EndingDate` (Mon–Sun); parse only the date part before "T" (feed timestamps are midnight-anchored ET like `2026-06-01T00:00:00-04:00`) and compute weekday in UTC to avoid TZ drift.
- Re-pull idempotency: only `timesheet_entries.source='procas'` rows are replaced (delete+insert in one transaction); manual entries are never touched.
- Finalized Procas statuses seen live include "Locked" (also Processed/Approved/Posted); "Unsubmitted" is non-final and should warn.
- Feed is a daily 6 AM Eastern snapshot — today's hours appear tomorrow.
- PersonnelName has trailing spaces; always trim before employee matching.
- Rates: BillingItem lookup per LCItem effective at period start, fallback to local employee effectiveRate; warn and use $0 when neither exists.
