---
name: azad-invoice vite build env
description: azad-invoice vite.config throws unless PORT and BASE_PATH env vars are set
---

The azad-invoice `vite.config.ts` reads `process.env.PORT` and `process.env.BASE_PATH` at config-load time and throws if either is missing. The dev workflow injects both, but a bare `pnpm run build` from a shell fails with "PORT environment variable is required" then "BASE_PATH environment variable is required".

**How to apply:** to build/verify the frontend manually, run `PORT=5000 BASE_PATH=/azad-invoice pnpm run build`. For type-only validation, `pnpm -w run typecheck` (tsc --noEmit) needs no env and is the faster check.
