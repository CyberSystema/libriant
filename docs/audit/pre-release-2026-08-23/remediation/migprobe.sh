#!/usr/bin/env bash
set -u
cd /Users/leontgmusic/Projects/libriant
source docs/audit/pre-release-2026-08-23/env/setup-audit-env.sh >/dev/null 2>&1
DB="$1"; SKIP_FIX="${2:-no}"
psql -h 127.0.0.1 -p 55440 -U libriant -d postgres -qc "DROP DATABASE IF EXISTS $DB WITH (FORCE)" >/dev/null 2>&1
psql -h 127.0.0.1 -p 55440 -U libriant -d postgres -qc "CREATE DATABASE $DB" >/dev/null 2>&1
for e in unaccent pg_trgm pgcrypto citext; do psql -h 127.0.0.1 -p 55440 -U libriant -d $DB -qc "CREATE EXTENSION IF NOT EXISTS $e" >/dev/null 2>&1; done
for m in packages/db-tenant/prisma/migrations/*/migration.sql; do
  case "$m" in *20260826085000*) break ;; esac
  psql -h 127.0.0.1 -p 55440 -U libriant -d $DB -v ON_ERROR_STOP=1 -q -f "$m" >/dev/null 2>&1
done
psql -h 127.0.0.1 -p 55440 -U libriant -d $DB -v ON_ERROR_STOP=1 -q <<'SQL'
INSERT INTO tenant_settings (id,"updatedAt") VALUES (1,now()) ON CONFLICT DO NOTHING;
INSERT INTO books (id,title,"sortTitle","searchText","updatedAt") VALUES ('b','T','t','t',now());
INSERT INTO members (id,"memberNumber","fullName","sortName","searchText","updatedAt") VALUES ('m','M-1','P','p','p',now());
INSERT INTO book_copies (id,"bookId",barcode,status,"updatedAt") VALUES ('c','b','BC-1','available',now());
-- The legacy shape the old importer could write: an orphan `ready` hold dated
-- in the FUTURE, with placedAt equally far ahead.
INSERT INTO reservations (id,"bookId","memberId","placedAt",status,"readyAt","expiresAt","fulfilledByCopyId","updatedAt")
VALUES ('r-future','b','m', now()+interval '400 day','ready', now()+interval '400 day', NULL, NULL, now());
SQL
echo "  fixture rows: $(psql -h 127.0.0.1 -p 55440 -U libriant -d $DB -qtAc "SELECT count(*) FROM reservations WHERE id='r-future'")"
M=packages/db-tenant/prisma/migrations/20260826085000_repair_orphan_ready_holds/migration.sql
if [ "$SKIP_FIX" = "revert" ]; then
  sed 's/GREATEST(stamp_utc, COALESCE("readyAt", "placedAt"))/stamp_utc/' "$M" > /tmp/mig-reverted.sql
  M=/tmp/mig-reverted.sql
fi
psql -h 127.0.0.1 -p 55440 -U libriant -d $DB -v ON_ERROR_STOP=1 --single-transaction -q -f "$M" >/tmp/mig.err 2>&1
echo "  migration exit: $?"
grep -i "ERROR" /tmp/mig.err | head -2 | sed 's/^/    /'
psql -h 127.0.0.1 -p 55440 -U libriant -d $DB -qtAc 'SELECT '"'"'  after: status='"'"'||status||'"'"' expires>ready='"'"'||(("expiresAt" > "readyAt")::text) FROM reservations WHERE id='"'"'r-future'"'"''
psql -h 127.0.0.1 -p 55440 -U libriant -d postgres -qc "DROP DATABASE IF EXISTS $DB WITH (FORCE)" >/dev/null 2>&1
