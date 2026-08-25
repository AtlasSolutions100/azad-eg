# Azad Invoice Automation

Internal billing workspace for Azad Engineering PC to manage work plans, generate invoices, and export BART progress billings.

## Run & Operate

- Use the managed **Project** workflow to run the frontend at `/` and the API at `/api`; it starts the associated `artifacts/azad-invoice: web` and `artifacts/api-server: API Server` services.
- `PORT=8080 pnpm --filter @workspace/api-server run dev` — run the API server directly (port 8080)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages (sets the Vite build-time runtime variables automatically)
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string
- Development auth uses Replit-managed Clerk; its development keys are provisioned automatically and do not need to be copied into files.

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

_Populate as you build — short repo map plus pointers to the source-of-truth file for DB schema, API contracts, theme files, etc._

## Architecture decisions

_Populate as you build — non-obvious choices a reader couldn't infer from the code (3-5 bullets)._

## Product

_Describe the high-level user-facing capabilities of this app once they exist._

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

- Rotating the Procas encryption master key: set `PROCAS_ENC_KEY_OLD` to the previous key value, set `PROCAS_ENC_KEY` to the new value, restart the API server. It re-seals the stored credential under the new key automatically (logged at startup); then remove `PROCAS_ENC_KEY_OLD`. Full procedure documented in `artifacts/api-server/src/lib/crypto.ts`.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
