#!/usr/bin/env bash
# Recreate the audit environment from nothing. Idempotent; safe to re-run.
#
# Stands up a throwaway Postgres 16 + Redis, migrates and seeds both the control
# plane and a tenant schema, and prints the env block every other audit command
# needs. Nothing here touches the developer's own dev containers or /tmp state
# from an earlier session.
#
#   source docs/audit/pre-release-2026-08-23/env/setup-audit-env.sh
#
# It must be SOURCED, not executed, so the exports land in your shell.
set -uo pipefail

AUDIT_DIR=/tmp/lbraudit
PGBIN="$(brew --prefix postgresql@16 2>/dev/null)/bin"
[ -x "$PGBIN/initdb" ] || { echo "need: brew install postgresql@16"; return 1 2>/dev/null || exit 1; }
export PATH="$PGBIN:$PATH" LC_ALL=C LANG=C

if ! "$PGBIN/pg_ctl" -D "$AUDIT_DIR/data" status >/dev/null 2>&1; then
  rm -rf "$AUDIT_DIR"; mkdir -p "$AUDIT_DIR"/{data,sock}
  echo auditpw > "$AUDIT_DIR/pw"
  "$PGBIN/initdb" -D "$AUDIT_DIR/data" -U libriant --pwfile="$AUDIT_DIR/pw" -E UTF8 --locale=C >/dev/null 2>&1
  "$PGBIN/pg_ctl" -D "$AUDIT_DIR/data" -l "$AUDIT_DIR/pg.log" \
    -o "-p 55440 -k $AUDIT_DIR/sock -c listen_addresses=127.0.0.1" -w start >/dev/null 2>&1
fi
redis-cli -p 6390 ping >/dev/null 2>&1 || \
  redis-server --port 6390 --daemonize yes --save '' --appendonly no \
    --dir "$AUDIT_DIR" --logfile "$AUDIT_DIR/redis.log" >/dev/null 2>&1

export PGPASSWORD=auditpw
for db in libriant_control libriant_demo; do
  psql -h 127.0.0.1 -p 55440 -U libriant -d postgres -qc "CREATE DATABASE $db" >/dev/null 2>&1
  for e in unaccent pg_trgm pgcrypto citext; do
    psql -h 127.0.0.1 -p 55440 -U libriant -d "$db" -qc "CREATE EXTENSION IF NOT EXISTS $e" >/dev/null 2>&1
  done
done

export CONTROL_DATABASE_URL="postgresql://libriant:auditpw@127.0.0.1:55440/libriant_control"
export PG_SUPERUSER_URL="$CONTROL_DATABASE_URL"
export TENANT_DATABASE_URL="postgresql://libriant:auditpw@127.0.0.1:55440/libriant_demo"
export REDIS_URL="redis://localhost:6390"
export SESSION_SECRET=audit-only ADMIN_SESSION_SECRET=audit-only IMPERSONATION_SECRET=audit-only
export MFA_MASTER_KEY='0011223344556677889900112233445566778899001122334455667788990011'
export STRIPE_DRIVER=fake STORAGE_ROOT=/tmp/lbraudit/storage EMAIL_DRIVER=console HASH_PEPPER=audit-only-pepper
export TSX_TSCONFIG_PATH="$PWD/apps/api/tsconfig.json"
mkdir -p "$STORAGE_ROOT"

pnpm db:migrate:deploy >/dev/null 2>&1
pnpm db:seed >/dev/null 2>&1
pnpm tenant:migrate:deploy >/dev/null 2>&1
echo "audit env ready — postgres :55440, redis :6390, control+tenant migrated and seeded"
