---
name: Stale composite dist types
description: api-client-react dist .d.ts can lag src and hide/introduce type errors in artifacts
---
The web artifacts resolve @workspace/api-client-react types via TS project references (composite, outDir dist), not the src exports. If dist is stale, new schema fields appear "missing" and old real errors stay hidden.

**Why:** dist .d.ts is only refreshed by a `tsc --build`; there is no package build script.

**How to apply:** the artifact `typecheck` scripts (azad-invoice, api-server) now run `tsc --build ../../tsconfig.json` first, so stale dist can't skew checks. Keep that prefix if adding new artifacts with lib references; libs can still be rebuilt manually with `tsc -b lib/api-client-react` when only codegen changed.
