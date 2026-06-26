---
name: api-spec codegen rebuild
description: After editing the OpenAPI spec (or when generated client types look stale), regenerate the api packages.
---

When `lib/api-spec/openapi.yaml` changes — or when downstream artifacts fail
typecheck with "has no exported member" / "Property X does not exist" against
`@workspace/api-zod` or `@workspace/api-client-react` — regenerate the generated
code:

`pnpm --filter @workspace/api-spec run codegen`

This runs orval (writes `lib/api-zod/src/generated/*` and
`lib/api-client-react/src/generated/*`) and then `tsc --build` for the libs.

**Why:** the api-zod/api-client-react hooks, schemas, and types are codegen
output from the spec, not hand-written. A stale generated tree produces a flood
of missing-export/missing-property errors in artifacts that is unrelated to your
actual change. Regenerating clears them in one step.

**How to apply:** Run it before trusting artifact typecheck after any spec edit,
and as a first diagnostic when an artifact's typecheck shows many
`@workspace/api-*` import errors you didn't introduce.
