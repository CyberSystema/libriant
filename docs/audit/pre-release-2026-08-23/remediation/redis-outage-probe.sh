#!/usr/bin/env bash
# Boot the API under the SHIPPED production config, get a real session, then
# kill Redis and hit the routes the verifier found still returning 500.
set -u
cd /Users/leontgmusic/Projects/libriant
source docs/audit/pre-release-2026-08-23/env/setup-audit-env.sh >/dev/null 2>&1
PORT=3410
SLUG="redisout$(date +%s | tail -c 6)"
LOG=/tmp/redis-outage-api.log; rm -f "$LOG"
env NODE_ENV=production BILLING_ENABLED=false STRIPE_DRIVER=none EMAIL_DRIVER=console \
    PUBLIC_HOST=app.libriant.com SITE_HOST=libriant.com ADMIN_HOST=admin.libriant.com \
    PUBLIC_APEX_DOMAIN=libriant.com RATE_LIMIT_DISABLED=1 \
    SESSION_SECRET=$(printf 'a%.0s' {1..64}) ADMIN_SESSION_SECRET=$(printf 'b%.0s' {1..64}) \
    IMPERSONATION_SECRET=$(printf 'c%.0s' {1..64}) MFA_MASTER_KEY=$(printf 'd%.0s' {1..64}) \
    STORAGE_SIGNING_SECRET=$(printf 'e%.0s' {1..64}) HASH_PEPPER=$(printf 'f%.0s' {1..64}) \
    PORT=$PORT npx tsx apps/api/src/main.ts >"$LOG" 2>&1 &
W=$!
cleanup() { for pid in $(lsof -tnP -iTCP:$PORT -sTCP:LISTEN 2>/dev/null); do kill -9 $pid 2>/dev/null; done; kill -9 $W 2>/dev/null; }
trap cleanup EXIT
for i in $(seq 1 90); do curl -sf --max-time 2 "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1 && break; kill -0 $W 2>/dev/null || break; sleep 1; done

JAR=/tmp/redisout.cookies; rm -f "$JAR"
curl -s -c "$JAR" -X POST "http://127.0.0.1:$PORT/auth/signup" -H 'content-type: application/json' \
  -d "{\"libraryName\":\"Redis Outage\",\"slug\":\"$SLUG\",\"fullName\":\"Owner\",\"email\":\"o@$SLUG.test\",\"password\":\"probe-password-1\",\"acceptLegal\":true,\"libraryType\":\"public\",\"addressStreet\":\"1 St\",\"addressCity\":\"Athens\",\"addressPostalCode\":\"10000\",\"addressCountry\":\"GR\"}" >/dev/null
echo "  signed up: $SLUG (session $( [ -s "$JAR" ] && echo yes || echo NO ))"

echo "  --- killing Redis ---"
redis-cli -p 6390 shutdown nosave >/dev/null 2>&1; sleep 1

probe() { printf '    %-52s %s\n' "$1" "$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 "${@:2}")"; }
probe "GET  /healthz"                              "http://127.0.0.1:$PORT/healthz"
probe "GET  /readyz"                               "http://127.0.0.1:$PORT/readyz"
probe "GET  /t/$SLUG/billing"                      -b "$JAR" "http://127.0.0.1:$PORT/t/$SLUG/billing"
probe "GET  /t/$SLUG/announcements/active"         -b "$JAR" "http://127.0.0.1:$PORT/t/$SLUG/announcements/active"
probe "GET  /t/$SLUG/catalog/isbn-lookup/978014.." -b "$JAR" "http://127.0.0.1:$PORT/t/$SLUG/catalog/isbn-lookup/9780140328721"
probe "GET  /t/$SLUG/members"                      -b "$JAR" "http://127.0.0.1:$PORT/t/$SLUG/members"
probe "POST /auth/password-reset/request"          -X POST -H 'content-type: application/json' -d "{\"slug\":\"$SLUG\",\"email\":\"o@$SLUG.test\"}" "http://127.0.0.1:$PORT/auth/password-reset/request"

echo "  --- 500s in the log during the outage ---"
grep -c '"statusCode":500' "$LOG" 2>/dev/null | sed 's/^/    count: /'
redis-server --port 6390 --daemonize yes --save '' --appendonly no --dir /tmp/lbraudit --logfile /tmp/lbraudit/redis.log >/dev/null 2>&1
psql -h 127.0.0.1 -p 55440 -U libriant -d libriant_control -qc "DELETE FROM tenants WHERE slug='$SLUG'" >/dev/null 2>&1
