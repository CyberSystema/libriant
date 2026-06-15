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

# Fail fast + legibly if neither URL is set — otherwise Prisma dies with an
# opaque "Environment variable not found" that, run as a detached one-shot, is
# easy to mistake for a migration error.
if [ -z "${CONTROL_DATABASE_URL:-}" ]; then
  echo "[bootstrap] FATAL: neither PG_SUPERUSER_URL nor CONTROL_DATABASE_URL is set — cannot run migrations or seed." >&2
  exit 1
fi

echo "[bootstrap] applying control-plane migrations ..."
if ! pnpm db:migrate:deploy; then
  echo "[bootstrap] FATAL: control-plane migration failed. If this is a P3009 'failed migration' or drift, inspect with 'prisma migrate status' and resolve with 'prisma migrate resolve' before redeploying." >&2
  exit 1
fi

echo "[bootstrap] seeding cells, feature keys, plans ..."
if ! pnpm db:seed; then
  echo "[bootstrap] FATAL: control-plane seed failed." >&2
  exit 1
fi

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
