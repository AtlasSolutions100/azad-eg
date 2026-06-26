---
name: API server auth & local testing
description: Why curl against /api returns Unauthorized, and how tests bypass it
---

The api-server mounts every route (except /health) behind Clerk `requireAuth`.

**Why:** `routes/index.ts` applies `requireAuth` before all feature routers, and
`getAuth(req)` needs a Clerk session that only the Replit proxy/browser injects.

**How to apply:** Direct `curl https://$REPLIT_DEV_DOMAIN/api/...` returns
`{"error":"Unauthorized"}` — that's auth, not a broken route. To exercise routes
end-to-end, write a vitest + supertest test that `vi.mock("@clerk/express")` to
return a fixed `userId` (see existing `*.test.ts` in `routes/`). Mock `globalThis.fetch`
when a route calls external APIs (e.g. the Procast client).
