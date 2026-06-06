#!/bin/sh
# Libriant - one-shot production bootstrap.
#
# Run by the compose `migrate` service before api/worker start (gated via
# `depends_on: condition: service_completed_successfully`). Idempotent, so it
# is safe to run on every deploy - that is exactly what makes deploys
# self-bootstrapping:
#
#   1. control-plane migrations     (FATAL - api can't serve without the schema)
#   2. seed cells/plans/feature-keys (FATAL - signup needs a cell + plans)
#   3. help-centre ingest           (best-effort)
#   4. existing-tenant migrations   (best-effort; new tenants self-migrate at
#                                    signup, and a manual fan-out always exists)
#   5. first admin                  (only if ADMIN_BOOTSTRAP_* are set)
#
# Migrations + seed run against Postgres DIRECTLY (PG_SUPERUSER_URL), never
# through pgbouncer: Prisma Migrate takes a session-level advisory lock that a
# transaction-mode pooler silently breaks.
set -eu

cd /app

# Point the Prisma CLI + seed client straight at Postgres for DDL.
export CONTROL_DATABASE_URL="${PG_SUPERUSER_URL:-${CONTROL_DATABASE_URL:-}}"

echo "[bootstrap] applying control-plane migrations ..."
pnpm db:migrate:deploy

echo "[bootstrap] seeding cells, feature keys, plans ..."
pnpm db:seed

echo "[bootstrap] ingesting help-centre articles (best-effort) ..."
pnpm ingest:help || echo "[bootstrap] help ingest skipped (non-fatal)"

echo "[bootstrap] migrating existing tenant databases (best-effort) ..."
pnpm tenant:migrate || echo "[bootstrap] tenant migrate skipped (non-fatal)"

if [ -n "${ADMIN_BOOTSTRAP_EMAIL:-}" ] && [ -n "${ADMIN_BOOTSTRAP_PASSWORD:-}" ]; then
  echo "[bootstrap] ensuring first admin (${ADMIN_BOOTSTRAP_EMAIL}) ..."
  pnpm admin:bootstrap || echo "[bootstrap] admin bootstrap failed (non-fatal)"
else
  echo "[bootstrap] ADMIN_BOOTSTRAP_* not set - skipping admin creation"
fi

echo "[bootstrap] done."
