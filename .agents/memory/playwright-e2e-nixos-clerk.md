---
name: Playwright e2e on NixOS with Clerk
description: How to run committed Playwright tests in this workspace (browser + auth)
---
- Playwright's downloaded Chromium fails to launch on NixOS ("Target page, context or browser has been closed"). Install the Nix `chromium` system package and pass its path as `launchOptions.executablePath` (see artifacts/azad-invoice/playwright.config.ts).
- Clerk sign-in works programmatically with `@clerk/testing/playwright`: `clerkSetup()` in globalSetup (uses CLERK_SECRET_KEY / CLERK_PUBLISHABLE_KEY env), create a `+clerk_test@example.com` user via the Clerk backend API, then `clerk.signIn({ strategy: "email_code" })` — the code auto-verifies, no email sent.
- Radix toasts: the `role="status"` element is a transient screen-reader announce node that unmounts after ~1s — locate the real toast via `getByRole("listitem")` (inside the "Notifications" region) or persistence assertions falsely fail.
- Tests run against the dev proxy at http://localhost:80 (web at "/", API at "/api"); get a Bearer token via `window.Clerk.session.getToken()` for API seeding/cleanup.
- Long e2e runs exceed the 120s bash tool limit; a killed run skips afterAll cleanup and strands seeded rows in the shared dev DB. Launch via `nohup … &` inside a subshell and poll the log file, then verify seeded data is gone (leftovers usually mean the run was killed, not that cleanup is broken).
**How to apply:** any future committed browser e2e test in this repo; run via `pnpm --filter @workspace/azad-invoice test:e2e` with workflows running.
