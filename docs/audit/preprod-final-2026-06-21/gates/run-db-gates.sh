#!/usr/bin/env bash
# DB-backed gates against a DEDICATED libriant_audit DB (dev data untouched).
# Waits for the static runner's G1 (install + prisma generate) to finish so the
# two don't race on writing the generated clients.
set -uo pipefail
cd /Users/leontgmusic/Projects/libriant
A=docs/audit/preprod-final-2026-06-21/gates
R="$A/RESULTS-db.txt"
: > "$R"

# Wait up to 20 min for G1 to pass (install+generate done by the static runner).
for i in $(seq 1 240); do
  grep -q "G1: PASS" "$A/RESULTS.txt" 2>/dev/null && break
  grep -q "G1: FAIL" "$A/RESULTS.txt" 2>/dev/null && { echo "G1 failed; aborting DB gates" | tee -a "$R"; exit 1; }
  sleep 5
done

PG="PGPASSWORD=libriant docker exec libriant-postgres psql -U libriant"
say () { echo "$@" | tee -a "$R"; }

# Fresh dedicated control + tenant DBs
docker exec -e PGPASSWORD=libriant libriant-postgres psql -U libriant -d libriant_control \
  -c "DROP DATABASE IF EXISTS libriant_audit" -c "DROP DATABASE IF EXISTS libriant_audit_demo" \
  -c "CREATE DATABASE libriant_audit" -c "CREATE DATABASE libriant_audit_demo" >> "$R" 2>&1
for db in libriant_audit libriant_audit_demo; do
  docker exec -e PGPASSWORD=libriant libriant-postgres psql -U libriant -d "$db" -c \
    "CREATE EXTENSION IF NOT EXISTS unaccent; CREATE EXTENSION IF NOT EXISTS pg_trgm; CREATE EXTENSION IF NOT EXISTS pgcrypto; CREATE EXTENSION IF NOT EXISTS citext;" >> "$R" 2>&1
done

export CONTROL_DATABASE_URL=postgresql://libriant:libriant@localhost:5432/libriant_audit
export PG_SUPERUSER_URL=postgresql://libriant:libriant@localhost:5432/libriant_audit
export REDIS_URL=redis://localhost:6379
export SESSION_SECRET=ci-only-test
export ADMIN_SESSION_SECRET=ci-only-test
export IMPERSONATION_SECRET=ci-only-test
export MFA_MASTER_KEY=0011223344556677889900112233445566778899001122334455667788990011
export STRIPE_DRIVER=fake
export STORAGE_ROOT=/tmp/libriant-audit-storage
export EMAIL_DRIVER=console
export TSX_TSCONFIG_PATH=/Users/leontgmusic/Projects/libriant/apps/api/tsconfig.json

# G10 — control migrate + seed + idempotency + tenant smoke
{
  echo "### control migrate:deploy"; pnpm db:migrate:deploy
  echo "### control seed (1)"; pnpm db:seed
  C1=$(docker exec -e PGPASSWORD=libriant libriant-postgres psql -U libriant -d libriant_audit -tAc \
    "SELECT (SELECT count(*) FROM cells)||','||(SELECT count(*) FROM plan_features)||','||(SELECT count(*) FROM plans)||','||(SELECT count(*) FROM plan_feature_values)")
  echo "counts after seed: $C1 (expect 1,15,5,75)"
  echo "### control seed (2 — idempotency)"; pnpm db:seed
  C2=$(docker exec -e PGPASSWORD=libriant libriant-postgres psql -U libriant -d libriant_audit -tAc \
    "SELECT (SELECT count(*) FROM cells)||','||(SELECT count(*) FROM plan_features)||','||(SELECT count(*) FROM plans)||','||(SELECT count(*) FROM plan_feature_values)")
  echo "counts after re-seed: $C2 (must equal first)"
  echo "### tenant migrate + seed + smoke"
  TENANT_DATABASE_URL=postgresql://libriant:libriant@localhost:5432/libriant_audit_demo pnpm tenant:migrate:deploy
  TENANT_DATABASE_URL=postgresql://libriant:libriant@localhost:5432/libriant_audit_demo pnpm tenant:seed:defaults
  TENANT_DATABASE_URL=postgresql://libriant:libriant@localhost:5432/libriant_audit_demo pnpm tenant:smoke
} > "$A/G10.log" 2>&1
if grep -q "1,15,5,75" "$A/G10.log" && tail -n 40 "$A/G10.log" | grep -qiE "smoke|invariant|pass|ok|✓" && ! tail -n 5 "$A/G10.log" | grep -qiE "error|fail"; then
  say "G10: see log (counts + smoke) — review G10.log tail"
else
  say "G10: REVIEW G10.log"
fi
tail -n 15 "$A/G10.log" | sed 's/^/    /' >> "$R"

# G8 — integration suite (real PG + Redis)
if pnpm --filter @libriant/api exec vitest run --project integration > "$A/G8.log" 2>&1; then
  say "G8 integration: PASS"
else
  say "G8 integration: FAIL — tail:"; tail -n 20 "$A/G8.log" | sed 's/^/    /' >> "$R"
fi

# G11 — dependency CVE audit (don't fail the script on advisories)
pnpm audit > "$A/G11.log" 2>&1 || true
say "G11 audit: see G11.log"
tail -n 20 "$A/G11.log" | sed 's/^/    /' >> "$R"

say "ALL DB GATES DONE"
