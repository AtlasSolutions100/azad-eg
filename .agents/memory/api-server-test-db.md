---
name: api-server tests share the seeded dev DB
description: Gotchas when writing api-server vitest specs against the real Postgres dev database
---

api-server vitest specs run against the **real shared dev Postgres**, not an isolated/in-memory DB.

Consequences:
- Seed data is present. Any code path that queries *globally* (no invoice/workplan filter) — e.g. the
  Procas scheduled-sync cycle that pulls every open (`draft`/`in_review`) invoice — will also touch seed
  rows. Scope assertions and test fixtures by unique keys (random suffixes) or unique periods so seed rows
  don't inflate counts or get mutated. Example: give a test invoice a far-future `periodStart` and have the
  mocked feed return rows only for that period.
- A brand-new table won't exist until the schema is pushed. If tests fail with `relation "..." does not
  exist`, run `pnpm push` in `lib/db` (in addition to the dist rebuild noted in db-schema-change-rebuild).

**Why:** avoids flaky counts and silent seed-data corruption across test files that share the DB.
