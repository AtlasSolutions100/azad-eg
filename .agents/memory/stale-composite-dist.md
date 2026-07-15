---
name: Stale composite dist types
description: api-client-react dist .d.ts can lag src and hide/introduce type errors in artifacts
---
The web artifacts resolve @workspace/api-client-react types via TS project references (composite, outDir dist), not the src exports. If dist is stale, new schema fields appear "missing" and old real errors stay hidden.

**Why:** dist .d.ts is only refreshed by `pnpm exec tsc -b lib/api-client-react`; there is no package build script.

**How to apply:** after codegen or schema changes, rebuild with `tsc -b lib/api-client-react` before trusting artifact type checks.
