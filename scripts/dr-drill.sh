#!/usr/bin/env bash
# Libriant — disaster-recovery drill. Proves backup → restore actually works.
#
# An untested backup is not a backup, and this repo learned that the hard way:
# restore.sh piped a `pg_dumpall --clean` script into psql as the same role the
# dump drops, so under ON_ERROR_STOP=1 it destroyed every database and then
# aborted before restoring a single one. It looked fine until someone needed it.
#
# This drill runs the REAL pipeline — backup.sh's exact pg_dumpall flags and
# restore.sh's exact psql invocation and stream filter — against a throwaway
# cluster, and asserts the restored cluster matches the source. It deliberately
# does NOT use docker compose, so CI can run it against a postgres service
# container.
#
#   PGHOST=127.0.0.1 PGPORT=5432 PGUSER=libriant PGPASSWORD=… scripts/dr-drill.sh
#
# The psql/pg_dumpall on PATH must match the SERVER's major version. A newer
# client emits settings the older server rejects — dumping a Postgres 16 cluster
# with the 18 client produces `SET transaction_timeout = 0;`, which 16 does not
# know, and the restore aborts under ON_ERROR_STOP=1. Production is unaffected
# because backup.sh runs pg_dumpall INSIDE the postgres container, but anything
# driving the cluster from outside has to match deliberately. It is also the
# reason a major-version upgrade must dump with the NEW server's binaries.
#
# DESTRUCTIVE: drops and recreates its own fixture databases (lbrdrill_*) on the
# target cluster. Never point it at production.
set -euo pipefail

PGHOST="${PGHOST:-127.0.0.1}"; PGPORT="${PGPORT:-5432}"
PGUSER="${PGUSER:-libriant}"; export PGHOST PGPORT PGUSER PGPASSWORD
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT

# shellcheck source=_lib/pg-restore-filter.sh
. "$(dirname "$0")/_lib/pg-restore-filter.sh"

CTRL=lbrdrill_control; T1=lbrdrill_tenant_a; T2=lbrdrill_tenant_b
AUX_ROLE=lbrdrill_auditor
ok=0; fail=0
say()  { printf '\n\033[1m▸ %s\033[0m\n' "$*"; }
pass() { printf '  \033[32m✓\033[0m %s\n' "$*"; ok=$((ok+1)); }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$*"; fail=$((fail+1)); }
# An empty expected value compared against an empty actual is the signature of
# a drill that proved nothing — the fixture failed to build, or the database is
# gone. Refuse to call that a pass.
chk()  {
  if [ -z "$3" ]; then bad "$1 — EXPECTED value is empty; the fixture never built"; return; fi
  if [ -z "$2" ]; then bad "$1 — actual is empty (expected [$3])"; return; fi
  if [ "$2" = "$3" ]; then pass "$1 ($3)"; else bad "$1 — expected [$3], got [$2]"; fi
}
q()    { psql -qtAX -v ON_ERROR_STOP=1 -d "$1" -c "$2"; }

say "Building the fixture cluster"
psql -qtAX -d postgres -v ON_ERROR_STOP=1 <<SQL >/dev/null
DROP DATABASE IF EXISTS $CTRL; DROP DATABASE IF EXISTS $T1; DROP DATABASE IF EXISTS $T2;
DROP ROLE IF EXISTS $AUX_ROLE;
CREATE DATABASE $CTRL; CREATE DATABASE $T1; CREATE DATABASE $T2;
CREATE ROLE $AUX_ROLE LOGIN PASSWORD 'drill-pw' CONNECTION LIMIT 3;
SQL
for db in "$CTRL" "$T1" "$T2"; do
  psql -qtAX -d "$db" -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
CREATE EXTENSION IF NOT EXISTS unaccent; CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS pgcrypto;  CREATE EXTENSION IF NOT EXISTS citext;
SQL
done
psql -qtAX -d "$CTRL" -v ON_ERROR_STOP=1 >/dev/null <<SQL
CREATE TABLE cells (id serial PRIMARY KEY, slug text UNIQUE NOT NULL);
CREATE TABLE plans (id serial PRIMARY KEY, slug text UNIQUE NOT NULL, cents int NOT NULL);
INSERT INTO cells (slug) VALUES ('eu-1');
INSERT INTO plans (slug, cents) VALUES ('starter',0),('community',3900),('municipal',7900),
  ('central',11900),('institutional',18900),('on-prem-enterprise',0);
GRANT SELECT ON plans TO $AUX_ROLE;
SQL
# Greek text and a citext column: proves encoding and extension-typed data
# survive, not just row counts.
q "$T1" "CREATE TABLE books (id serial PRIMARY KEY, title citext NOT NULL);
         INSERT INTO books(title) SELECT 'Book '||g FROM generate_series(1,500) g;
         SELECT setval('books_id_seq', 4242);" >/dev/null
q "$T2" "CREATE TABLE books (id serial PRIMARY KEY, title citext NOT NULL);
         INSERT INTO books(title) VALUES ('Δούνη'),('Το Σιτάρι');" >/dev/null

# Fingerprint the source so the comparison is data, not vibes.
src_plans=$(q "$CTRL" "SELECT count(*)||':'||coalesce(sum(cents),0) FROM plans")
src_books1=$(q "$T1" "SELECT count(*) FROM books")
src_books2=$(q "$T2" "SELECT string_agg(title::text,'|' ORDER BY id) FROM books")
src_seq=$(q "$T1" "SELECT last_value FROM books_id_seq")
src_grant=$(q "$CTRL" "SELECT count(*) FROM information_schema.table_privileges
                       WHERE grantee='$AUX_ROLE' AND table_name='plans'")
src_pw=$(q postgres "SELECT substr(rolpassword,1,24) FROM pg_authid WHERE rolname='$PGUSER'")
src_aux=$(q postgres "SELECT rolconnlimit||':'||rolcanlogin||':'||rolsuper FROM pg_roles WHERE rolname='$AUX_ROLE'")
src_self=$(q postgres "SELECT rolsuper||':'||rolcreatedb||':'||rolreplication FROM pg_roles WHERE rolname='$PGUSER'")

for v in src_plans src_books1 src_books2 src_seq src_grant src_pw src_aux src_self; do
  eval "val=\${$v}"
  [ -n "$val" ] || { printf '  \033[31m✗\033[0m fixture fingerprint %s is empty — aborting\n' "$v"; exit 1; }
done

say "Taking a backup with backup.sh's exact flags"
pg_dumpall --clean --if-exists | gzip -9 > "$WORK/postgres.sql.gz"
printf '  dump: %s bytes\n' "$(wc -c < "$WORK/postgres.sql.gz" | tr -d ' ')"

say "Drifting the restoring role, so its assertions cannot be tautologies"
# The self role is never dropped by the restore (that is the whole fix), so
# asserting its attributes proves nothing unless they are wrong beforehand.
# Verified: without this, both role checks pass even when every database is
# destroyed and nothing is restored.
psql -qtAX -d postgres -v ON_ERROR_STOP=1 >/dev/null <<SQL
ALTER ROLE $PGUSER CONNECTION LIMIT 7;
ALTER ROLE $PGUSER PASSWORD 'drifted-not-the-real-one';
SQL
chk "role drifted before restore" "$(q postgres "SELECT rolconnlimit FROM pg_roles WHERE rolname='$PGUSER'")" "7"

say "Destroying the source (this is the disaster)"
psql -qtAX -d postgres -v ON_ERROR_STOP=1 >/dev/null <<SQL
DROP DATABASE $CTRL; DROP DATABASE $T1; DROP DATABASE $T2; DROP ROLE $AUX_ROLE;
SQL
chk "databases gone before restore" \
    "$(q postgres "SELECT count(*) FROM pg_database WHERE datname LIKE 'lbrdrill%'")" "0"

say "Restoring with restore.sh's exact pipeline"
chk "filter pre-flight match count" \
    "$(gunzip -c "$WORK/postgres.sql.gz" | pg_restore_filter_count "$PGUSER")" "2"
set +e
{ pg_self_role_reset_sql "$PGUSER"; gunzip -c "$WORK/postgres.sql.gz" | pg_restore_filter "$PGUSER"; } \
  | psql -qtAX -d postgres -v ON_ERROR_STOP=1 >"$WORK/out.txt" 2>"$WORK/err.txt"
rc=$?
set -e
chk "psql exit code" "$rc" "0"
if [ "$rc" != "0" ]; then printf '  --- stderr ---\n'; sed 's/^/  /' "$WORK/err.txt" | head -20; fi
if [ -s "$WORK/err.txt" ]; then printf '  stderr (non-fatal):\n'; sed 's/^/    /' "$WORK/err.txt" | head -10; fi

say "Verifying the restored cluster matches the source"
chk "control plans (count:sum)" "$(q "$CTRL" "SELECT count(*)||':'||coalesce(sum(cents),0) FROM plans")" "$src_plans"
chk "tenant A row count"        "$(q "$T1" "SELECT count(*) FROM books")" "$src_books1"
chk "tenant B Greek text"       "$(q "$T2" "SELECT string_agg(title::text,'|' ORDER BY id) FROM books")" "$src_books2"
chk "sequence position"         "$(q "$T1" "SELECT last_value FROM books_id_seq")" "$src_seq"
chk "grant to $AUX_ROLE"        "$(q "$CTRL" "SELECT count(*) FROM information_schema.table_privileges
                                              WHERE grantee='$AUX_ROLE' AND table_name='plans'")" "$src_grant"
chk "other role recreated"      "$(q postgres "SELECT rolconnlimit||':'||rolcanlogin||':'||rolsuper FROM pg_roles WHERE rolname='$AUX_ROLE'")" "$src_aux"
# The whole reason the ALTER ROLE line is kept rather than filtered with the rest.
chk "restoring role attributes" "$(q postgres "SELECT rolsuper||':'||rolcreatedb||':'||rolreplication FROM pg_roles WHERE rolname='$PGUSER'")" "$src_self"
chk "self-role drift undone"    "$(q postgres "SELECT rolconnlimit||':'||coalesce(array_to_string(rolconfig,','),'none') FROM pg_roles WHERE rolname='$PGUSER'")" "-1:none"
chk "restoring role password"   "$(q postgres "SELECT substr(rolpassword,1,24) FROM pg_authid WHERE rolname='$PGUSER'")" "$src_pw"
for db in "$CTRL" "$T1" "$T2"; do
  chk "extensions in $db" "$(q "$db" "SELECT count(*) FROM pg_extension
      WHERE extname IN ('unaccent','pg_trgm','pgcrypto','citext')")" "4"
done

say "Cleaning up"
psql -qtAX -d postgres >/dev/null 2>&1 <<SQL || true
DROP DATABASE IF EXISTS $CTRL; DROP DATABASE IF EXISTS $T1; DROP DATABASE IF EXISTS $T2;
DROP ROLE IF EXISTS $AUX_ROLE;
SQL

printf '\n  %s checks passed, %s failed\n' "$ok" "$fail"
[ "$fail" = "0" ] || { printf '  \033[31mDR DRILL FAILED\033[0m\n'; exit 1; }
printf '  \033[32mDR DRILL PASSED\033[0m — backup → restore round trip is sound\n'
