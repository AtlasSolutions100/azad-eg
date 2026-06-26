#!/bin/bash
set -e
pnpm install --frozen-lockfile

# Data-preserving rename for the Procast -> Procas table rename. Runs before the
# drizzle push below so push sees the already-renamed tables and detects no diff,
# instead of dropping the old tables and recreating empty new ones (which would
# discard the stored connection credential and scheduler state). Idempotent:
# only renames when the old table exists and the new one does not, so re-runs and
# fresh databases (where push creates the new tables directly) are both safe.
if [ -n "$DATABASE_URL" ]; then
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL'
DO $$
BEGIN
  IF EXISTS (SELECT FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'procast_connection')
     AND NOT EXISTS (SELECT FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'procas_connection') THEN
    ALTER TABLE procast_connection RENAME TO procas_connection;
  END IF;
  IF EXISTS (SELECT FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'procast_scheduler')
     AND NOT EXISTS (SELECT FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'procas_scheduler') THEN
    ALTER TABLE procast_scheduler RENAME TO procas_scheduler;
  END IF;
END $$;
SQL
fi

pnpm --filter db push
