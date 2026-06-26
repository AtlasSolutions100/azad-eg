---
name: db schema change rebuild
description: After editing lib/db schema, both push the DB and rebuild the package's TS declarations.
---

When you change a Drizzle table in `lib/db/src/schema/*`, two separate steps are
needed before downstream artifacts (e.g. `artifacts/api-server`) typecheck:

1. `pnpm --filter @workspace/db push` — applies the column to the live database.
2. `cd lib/db && pnpm exec tsc --build` — regenerates `lib/db/dist/*.d.ts`.

**Why:** `@workspace/db` is a TS project reference. Its package `exports` point at
source, but downstream typecheck (`tsc --noEmit`) resolves the *built* `dist`
declarations. Vitest runs against source so tests can pass even while `tsc` still
reports the new column as missing — only the declaration rebuild fixes typecheck.

**How to apply:** Run both after any schema edit. If a new column "does not exist
on type" errors appear only under tsc (not at runtime/tests), the dist build is stale.
