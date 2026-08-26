#!/usr/bin/env bash
set -u
cd /Users/leontgmusic/Projects/libriant
source docs/audit/pre-release-2026-08-23/env/setup-audit-env.sh >/dev/null 2>&1
PORT=3424; SLUG="auth$(date +%s | tail -c 6)"; PW='owner-authors-password-1'
env NODE_ENV=production BILLING_ENABLED=false STRIPE_DRIVER=none EMAIL_DRIVER=console \
    PUBLIC_HOST=app.libriant.com SITE_HOST=libriant.com ADMIN_HOST=admin.libriant.com \
    PUBLIC_APEX_DOMAIN=libriant.com RATE_LIMIT_DISABLED=1 \
    SESSION_SECRET=$(printf 'a%.0s' {1..64}) ADMIN_SESSION_SECRET=$(printf 'b%.0s' {1..64}) \
    IMPERSONATION_SECRET=$(printf 'c%.0s' {1..64}) MFA_MASTER_KEY=$(printf 'd%.0s' {1..64}) \
    STORAGE_SIGNING_SECRET=$(printf 'e%.0s' {1..64}) HASH_PEPPER=$(printf 'f%.0s' {1..64}) \
    PORT=$PORT npx tsx apps/api/src/main.ts >/tmp/authors-api.log 2>&1 &
W=$!
trap 'for p in $(lsof -tnP -iTCP:$PORT -sTCP:LISTEN 2>/dev/null); do kill -9 $p 2>/dev/null; done; kill -9 $W 2>/dev/null' EXIT
for i in $(seq 1 90); do curl -sf --max-time 2 "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1 && break; kill -0 $W 2>/dev/null || break; sleep 1; done
J=/tmp/authors.jar; rm -f "$J"
curl -s -c "$J" -X POST "http://127.0.0.1:$PORT/auth/signup" -H 'content-type: application/json' \
  -d "{\"libraryName\":\"A\",\"slug\":\"$SLUG\",\"fullName\":\"Owner\",\"email\":\"o@$SLUG.test\",\"password\":\"$PW\",\"acceptLegal\":true,\"libraryType\":\"public\",\"addressStreet\":\"1 St\",\"addressCity\":\"Athens\",\"addressPostalCode\":\"10000\",\"addressCountry\":\"GR\"}" >/dev/null
psql -h 127.0.0.1 -p 55440 -U libriant -d libriant_control -qc \
  "UPDATE users SET \"emailVerifiedAt\" = now() WHERE email = 'o@'||'$SLUG'||'.test'" >/dev/null 2>&1
A="http://127.0.0.1:$PORT/t/$SLUG/catalog/authors"
r1=$(curl -s -b "$J" -X POST "$A" -H 'content-type: application/json' -d '{"fullName":"Γιώργος Σεφέρης"}')
id1=$(printf '%s' "$r1" | python3 -c "import sys,json;print(json.load(sys.stdin).get('id',''))" 2>/dev/null)
echo "  create 'Γιώργος Σεφέρης'          -> id=${id1:-<none>}"
c2=$(curl -s -o /tmp/a2.json -w '%{http_code}' -b "$J" -X POST "$A" -H 'content-type: application/json' -d '{"fullName":"ΓΙΩΡΓΟΣ ΣΕΦΕΡΗΣ"}')
id2=$(python3 -c "import json;print(json.load(open('/tmp/a2.json')).get('id',''))" 2>/dev/null)
echo "  create 'ΓΙΩΡΓΟΣ ΣΕΦΕΡΗΣ' (folds same) -> $c2  same row: $([ "$id1" = "$id2" ] && echo yes || echo NO)   (was 500)"
r3=$(curl -s -b "$J" -X POST "$A" -H 'content-type: application/json' -d '{"fullName":"Οδυσσέας Ελύτης"}')
id3=$(printf '%s' "$r3" | python3 -c "import sys,json;print(json.load(sys.stdin).get('id',''))" 2>/dev/null)
c4=$(curl -s -o /tmp/a4.json -w '%{http_code}' -b "$J" -X PATCH "$A/$id3" -H 'content-type: application/json' -d '{"fullName":"Γιώργος Σεφέρης"}')
echo "  rename onto the existing name       -> $c4  (want 409, was 500)"
python3 -c "import json;d=json.load(open('/tmp/a4.json'));print('    message:', (d.get('message') or '')[:80])" 2>/dev/null
psql -h 127.0.0.1 -p 55440 -U libriant -d libriant_control -qc "DELETE FROM tenants WHERE slug='$SLUG'" >/dev/null 2>&1
