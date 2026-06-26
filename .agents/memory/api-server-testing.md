---
name: api-server testing setup
description: How to write HTTP-level tests for the api-server (vitest + supertest + Clerk auth mock)
---

# API server tests

The api-server has no emit step for tests — vitest runs the TS `src/**/*.test.ts` directly against the real Postgres (`DATABASE_URL`). Config: `artifacts/api-server/vitest.config.ts` with `fileParallelism: false` (tests share one DB).

## Bypassing / toggling Clerk auth
The router mounts `requireAuth` after the public health route, so every `/api/*` route except `/api/healthz` needs a user. To test both authed and unauthed paths in one file, mock `@clerk/express` with a hoisted mutable state:

```ts
const authState = vi.hoisted(() => ({ userId: "test-user" as string | null }));
vi.mock("@clerk/express", () => ({
  clerkMiddleware: () => (_req, _res, next) => next(),
  getAuth: () => ({ userId: authState.userId, sessionClaims: authState.userId ? { name: "Test User" } : undefined }),
}));
```
Set `authState.userId = null` inside a test for the 401 path; reset in `afterEach`. No need to mock `@clerk/shared/keys` — its function is only called inside the real clerkMiddleware callback, which the passthrough mock never invokes.

**Why:** `vi.mock` factories are hoisted above imports, so they can't close over normal module-scope vars; `vi.hoisted` is the supported way to share toggleable state with the factory.

## Cleanup
Tests create work plans/invoices directly via `db` and must clean up by tracked id in `afterAll` (line_items, audit_logs by entityId, invoices, work_plans) since the DB is the shared dev DB. The `generate` route with `format: "xlsx"` writes a real workbook into `storage/generated/` — delete those by invoice number too, or they accumulate. Use `format: "xlsx"` not `pdf` in tests to avoid the ~14s soffice render.
