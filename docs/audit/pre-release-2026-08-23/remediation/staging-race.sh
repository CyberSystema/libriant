#!/usr/bin/env bash
# input-and-files-06: the per-tenant staging budget must hold under concurrency.
set -u
cd /Users/leontgmusic/Projects/libriant
source docs/audit/pre-release-2026-08-23/env/setup-audit-env.sh >/dev/null 2>&1
PORT=3423; SLUG="race$(date +%s | tail -c 6)"; PW='owner-race-password-1'
env NODE_ENV=production BILLING_ENABLED=false STRIPE_DRIVER=none EMAIL_DRIVER=console \
    PUBLIC_HOST=app.libriant.com SITE_HOST=libriant.com ADMIN_HOST=admin.libriant.com \
    PUBLIC_APEX_DOMAIN=libriant.com RATE_LIMIT_DISABLED=1 \
    SESSION_SECRET=$(printf 'a%.0s' {1..64}) ADMIN_SESSION_SECRET=$(printf 'b%.0s' {1..64}) \
    IMPERSONATION_SECRET=$(printf 'c%.0s' {1..64}) MFA_MASTER_KEY=$(printf 'd%.0s' {1..64}) \
    STORAGE_SIGNING_SECRET=$(printf 'e%.0s' {1..64}) HASH_PEPPER=$(printf 'f%.0s' {1..64}) \
    PORT=$PORT npx tsx apps/api/src/main.ts >/tmp/race-api.log 2>&1 &
W=$!
trap 'for p in $(lsof -tnP -iTCP:$PORT -sTCP:LISTEN 2>/dev/null); do kill -9 $p 2>/dev/null; done; kill -9 $W 2>/dev/null' EXIT
for i in $(seq 1 90); do curl -sf --max-time 2 "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1 && break; kill -0 $W 2>/dev/null || break; sleep 1; done
J=/tmp/race.jar; rm -f "$J"
curl -s -c "$J" -X POST "http://127.0.0.1:$PORT/auth/signup" -H 'content-type: application/json' \
  -d "{\"libraryName\":\"R\",\"slug\":\"$SLUG\",\"fullName\":\"Owner\",\"email\":\"o@$SLUG.test\",\"password\":\"$PW\",\"acceptLegal\":true,\"libraryType\":\"public\",\"addressStreet\":\"1 St\",\"addressCity\":\"Athens\",\"addressPostalCode\":\"10000\",\"addressCountry\":\"GR\"}" >/dev/null
psql -h 127.0.0.1 -p 55440 -U libriant -d libriant_control -qc \
  "UPDATE users SET \"emailVerifiedAt\" = now() WHERE email = 'o@'||'$SLUG'||'.test'" >/dev/null 2>&1
printf 'title,isbn13\nA,9780000000001\n' > /tmp/race.csv
echo "  single probe first:"
curl -s -b "$J" -X POST "http://127.0.0.1:$PORT/t/$SLUG/imports" \
  -F 'entityKind=book' -F 'file=@/tmp/race.csv;type=text/csv' | head -c 300 | sed 's/^/    /'
echo
echo "  firing 20 concurrent uploads against a cap of 3 ..."
# `wait` with no arguments waits for EVERY child, and one of them is the API
# server, which never exits. Collect the curl pids and wait only on those.
: > /tmp/race-codes.txt
pids=()
for i in $(seq 1 20); do
  ( curl -s -o /dev/null -w '%{http_code}\n' -b "$J" -X POST "http://127.0.0.1:$PORT/t/$SLUG/imports" \
      -F 'entityKind=book' -F 'file=@/tmp/race.csv;type=text/csv' >> /tmp/race-codes.txt 2>&1 ) &
  pids+=($!)
done
for pid in "${pids[@]}"; do wait "$pid" 2>/dev/null; done
sort /tmp/race-codes.txt | uniq -c | sed 's/^/    /'
echo "  batches actually staged: $(psql -h 127.0.0.1 -p 55440 -U libriant -d libriant_control -qtAc "SELECT count(*) FROM import_batches b JOIN tenants t ON t.id=b.\"tenantId\" WHERE t.slug='$SLUG'")"
psql -h 127.0.0.1 -p 55440 -U libriant -d libriant_control -qc "DELETE FROM tenants WHERE slug='$SLUG'" >/dev/null 2>&1
