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
# --cross-cluster additionally restores the SOURCE cluster's dump into a SECOND,
# independently-initialised cluster whose superuser password differs. That is
# the rebuilt-host case from docs/RUNBOOK.md, and it has a consequence
# nobody expects until it happens. Needs TARGET_PGPORT (and TARGET_PGPASSWORD,
# TARGET_PGHOST, TARGET_SOCKET_DIR).
#
# DESTRUCTIVE: drops and recreates its own fixture databases (lbrdrill_*) on the
# target cluster. Never point it at production.
set -euo pipefail

PGHOST="${PGHOST:-127.0.0.1}"; PGPORT="${PGPORT:-5432}"
PGUSER="${PGUSER:-libriant}"; export PGHOST PGPORT PGUSER PGPASSWORD
WORK="$(mktemp -d)"
ORIG_PW="${PGPASSWORD:-}"
restore_password() {
  [ -n "$ORIG_PW" ] || return 0
  for pw in "$ORIG_PW" "$DRIFT_PW"; do
    PGPASSWORD="$pw" psql -qtAX -h "${PGHOST:-127.0.0.1}" -p "${PGPORT:-5432}" -U "${PGUSER:-libriant}" \
      -d postgres -c "ALTER ROLE \"${PGUSER:-libriant}\" PASSWORD '$ORIG_PW'" >/dev/null 2>&1 && return 0
  done
  printf '  \033[31m!\033[0m could not restore the superuser password — it may still be the drifted one\n' >&2
}
trap 'restore_password; rm -rf "$WORK"' EXIT
DRIFT_PW='drifted-not-the-real-one'
CROSS=0
for a in "$@"; do
  case "$a" in
    --cross-cluster) CROSS=1 ;;
    *) printf 'dr-drill: unknown flag: %s\n' "$a" >&2; exit 2 ;;
  esac
done

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

# --- structural fingerprints ---------------------------------------------
# Every table's row count, from the catalogue rather than a hand-picked list.
# The failure this catches is "schema restored, data not", which a fixed set of
# spot-checks walks straight past.
row_census() {
  q "$1" "SELECT coalesce(string_agg(t||'='||n, ',' ORDER BY t), '(none)') FROM (
            SELECT (xpath('/row/c/text()',
                     query_to_xml(format('SELECT count(*) AS c FROM %I.%I', table_schema, table_name),
                                  false, true, '')))[1]::text::bigint AS n,
                   table_schema||'.'||table_name AS t
            FROM information_schema.tables
            WHERE table_schema NOT IN ('pg_catalog','information_schema') AND table_type='BASE TABLE'
          ) x"
}
# Exact set WITH versions and schema. `count(*) >= 4` passes on four of a
# different four, and misses one relocated out of the app's search_path.
ext_set() {
  q "$1" "SELECT coalesce(string_agg(e.extname||'@'||e.extversion||'@'||n.nspname, ',' ORDER BY e.extname), '(none)')
          FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace"
}
# Every sequence, not just the one we happen to remember. A reset sequence
# surfaces hours later as duplicate-key errors that look like an app bug.
seq_set() {
  q "$1" "SELECT coalesce(string_agg(schemaname||'.'||sequencename||'='||coalesce(last_value,0)::text, ',' ORDER BY sequencename), '(none)')
          FROM pg_sequences"
}
# Schema, ownership, ACLs, indexes and constraints in one artefact — the
# cheapest assertion that catches a stream filter corrupting a function body.
schema_dump() {
  # pg_dump 16.15+ prefixes a per-invocation random token (`\restrict <rand>`,
  # the CVE-2025-8714 hardening), so two dumps of one database never match
  # byte-for-byte. Drop those lines; everything else is the schema.
  pg_dump --schema-only --no-comments -d "$1" | grep -vE '^\\(un)?restrict '
}

# Negative control: if the server is not actually checking passwords, every
# auth assertion below is a tautology. Under `trust` a deliberately wrong
# password succeeds — prove it fails before trusting anything that follows.
# Count real errors in a psql -v VERBOSITY=verbose log, without depending on
# the English word ERROR — compose sets LANG=el_GR.UTF-8 and psql localises
# every severity. Verbose mode prints the SQLSTATE code, which is not
# localised: `ERROR:  42809: ...`. NOTICE lines carry 00000 ("successful
# completion"), so those are excluded rather than counted as failures.
sqlstate_errors() {
  grep -E '^[^:]+:[[:space:]]+[0-9A-Z]{5}:' "$1" 2>/dev/null | grep -vcE '[[:space:]]00000:' || true
}

auth_is_enforced() {
  PGPASSWORD='definitely-not-the-password' \
    psql -qtAX -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d postgres -c 'SELECT 1' >/dev/null 2>&1 \
    && return 1 || return 0
}

say "Building the fixture cluster"
# Start from a known-clean self role. A previous run leaves it drifted, and a
# dump taken from a drifted role bakes the drift in as the expected value —
# which made an earlier version of this drill pass while proving nothing.
psql -qtAX -d postgres -v ON_ERROR_STOP=1 >/dev/null <<SQL
ALTER ROLE $PGUSER RESET ALL;
ALTER ROLE $PGUSER WITH CONNECTION LIMIT -1 VALID UNTIL 'infinity';
-- The password too. The drift below changes it, the restore is supposed to put
-- it back, and if it does not the NEXT run dumps the drifted hash as its
-- expected value and the assertion compares it against itself. Resetting to
-- the password we are connecting with makes the run idempotent and gives the
-- comparison something real to prove.
ALTER ROLE $PGUSER PASSWORD '$PGPASSWORD';
SQL
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
-- A dollar-quoted body containing the exact line the stream filter targets.
-- An unanchored filter deletes it here, silently, and psql still exits 0; only
-- the schema diff notices.
CREATE FUNCTION dr_canary() RETURNS void LANGUAGE plpgsql AS \$_\$
BEGIN
CREATE ROLE $PGUSER;
END;
\$_\$;
SQL
# Greek text through citext, and a sequence far from its default so a reset is
# detectable — a fixture whose sequences all sit near 1 structurally cannot
# catch one.
q "$T1" "CREATE TABLE books (id serial PRIMARY KEY, title citext NOT NULL);
         INSERT INTO books(title) SELECT 'Book '||g FROM generate_series(1,500) g;
         SELECT setval('books_id_seq', 4242);" >/dev/null
q "$T2" "CREATE TABLE books (id serial PRIMARY KEY, title citext NOT NULL);
         INSERT INTO books(title) VALUES ('Δούνη'),('Το Σιτάρι');" >/dev/null

src_plans=$(q "$CTRL" "SELECT count(*)||':'||coalesce(sum(cents),0) FROM plans")
src_books2=$(q "$T2" "SELECT string_agg(title::text,'|' ORDER BY id) FROM books")
src_grant=$(q "$CTRL" "SELECT count(*) FROM information_schema.table_privileges
                       WHERE grantee='$AUX_ROLE' AND table_name='plans'")
src_pw=$(q postgres "SELECT substr(rolpassword,1,24) FROM pg_authid WHERE rolname='$PGUSER'")
src_aux=$(q postgres "SELECT rolconnlimit||':'||rolcanlogin||':'||rolsuper FROM pg_roles WHERE rolname='$AUX_ROLE'")
src_self=$(q postgres "SELECT rolsuper||':'||rolcreatedb||':'||rolreplication FROM pg_roles WHERE rolname='$PGUSER'")
# Databases as an exact set with encoding and collation: a restore under a
# different collation quietly changes Greek sort order and breaks the unaccent
# search the product exists for.
src_dbset=$(q postgres "SELECT string_agg(datname||'@'||pg_encoding_to_char(encoding)||'@'||datcollate||'@'||datctype, ',' ORDER BY datname)
                        FROM pg_database WHERE datname LIKE 'lbrdrill%'")
for db in "$CTRL" "$T1" "$T2"; do
  eval "src_rows_${db}=\$(row_census "$db")"
  eval "src_ext_${db}=\$(ext_set "$db")"
  eval "src_seqs_${db}=\$(seq_set "$db")"
  schema_dump "$db" > "$WORK/schema.$db.before.sql"
done
for v in src_plans src_books2 src_grant src_pw src_aux src_self src_dbset; do
  eval "val=\${$v}"
  [ -n "$val" ] || { printf '  \033[31m✗\033[0m fixture fingerprint %s is empty — aborting\n' "$v"; exit 1; }
done

if auth_is_enforced; then
  pass "password auth is enforced (negative control)"
else
  bad "server accepts ANY password (trust auth) — every auth assertion here would be meaningless"
fi

say "Taking a backup with backup.sh's exact flags"
pg_dumpall --clean --if-exists | gzip -9 > "$WORK/postgres.sql.gz"
printf '  dump: %s bytes\n' "$(wc -c < "$WORK/postgres.sql.gz" | tr -d ' ')"

say "Drifting the restoring role, so its assertions cannot be tautologies"
# The self role is never dropped by the restore — that is the fix — so
# asserting its state proves nothing unless it is wrong beforehand. Verified:
# without this, the role checks passed even in a total-loss run.
psql -qtAX -d postgres -v ON_ERROR_STOP=1 >/dev/null <<SQL
ALTER ROLE $PGUSER CONNECTION LIMIT 7;
ALTER ROLE $PGUSER SET statement_timeout = '1s';
SQL
# NOTE: the password is deliberately NOT drifted here. The dump restores the
# role's password in its prologue and every `\connect` after that
# re-authenticates, so over TCP the remainder of the stream would fail to
# connect with the old one. Production restores over the container's local
# socket and never meets this. The password swap is proven by --cross-cluster,
# where it is the whole point.
chk "role drifted before restore" "$(q postgres "SELECT rolconnlimit FROM pg_roles WHERE rolname='$PGUSER'")" "7"

say "The disaster: corrupt two LIVE databases, delete a third"
# Deliberately NOT a clean wipe. Dropping every fixture first makes each
# `DROP DATABASE IF EXISTS` in the dump a no-op, so the drill never exercises
# the path that actually bites — dropping a database that exists.
q "$CTRL" "DELETE FROM plans WHERE slug <> 'starter'; INSERT INTO cells(slug) VALUES ('rogue-cell');" >/dev/null
q "$T1" "DROP TABLE books; CREATE TABLE junk (id int);" >/dev/null
q "$CTRL" "DROP OWNED BY $AUX_ROLE" >/dev/null
psql -qtAX -d postgres -v ON_ERROR_STOP=1 >/dev/null <<SQL
DROP DATABASE $T2; DROP ROLE $AUX_ROLE;
SQL
chk "two databases LIVE at restore time" \
    "$(q postgres "SELECT count(*) FROM pg_database WHERE datname IN ('$CTRL','$T1')")" "2"
chk "third database deleted" "$(q postgres "SELECT count(*) FROM pg_database WHERE datname='$T2'")" "0"
chk "live data is corrupted"  "$(q "$CTRL" "SELECT count(*) FROM plans")" "1"
# Dropping a live database needs every other backend off it — what restore.sh's
# terminate step is for. Our own session is on `postgres`.
psql -qtAX -d postgres -v ON_ERROR_STOP=0 -c \
  "SELECT pg_terminate_backend(pid) FROM pg_stat_activity
   WHERE datname IS NOT NULL AND datname <> 'template0' AND pid <> pg_backend_pid();" >/dev/null 2>&1 || true

say "Restoring with restore.sh's exact pipeline"
chk "filter pre-flight match count" \
    "$(gunzip -c "$WORK/postgres.sql.gz" | pg_restore_filter_count "$PGUSER")" "2"
set +e
{ pg_restore_preamble "$PGUSER"; gunzip -c "$WORK/postgres.sql.gz" | pg_restore_filter "$PGUSER"; } \
  | psql -qtAX -d postgres -v ON_ERROR_STOP=1 -v VERBOSITY=verbose >"$WORK/out.txt" 2>"$WORK/err.txt"
rc=$?
set -e
chk "psql exit code" "$rc" "0"
[ "$rc" = "0" ] || { printf '  --- stderr ---\n'; sed 's/^/  /' "$WORK/err.txt" | head -20; }
# Do NOT grep for the word "ERROR": compose sets LANG=el_GR.UTF-8 and psql
# localises — this session's own client reported failures in Greek.
# VERBOSITY=verbose prints a locale-independent SQLSTATE line instead.
chk "no SQLSTATE errors in stderr" "$(sqlstate_errors "$WORK/err.txt" || true)" "0"

say "Verifying the restored cluster matches the source"
chk "control plans (count:sum)" "$(q "$CTRL" "SELECT count(*)||':'||coalesce(sum(cents),0) FROM plans")" "$src_plans"
chk "tenant B Greek text"       "$(q "$T2" "SELECT string_agg(title::text,'|' ORDER BY id) FROM books")" "$src_books2"
chk "grant to $AUX_ROLE"        "$(q "$CTRL" "SELECT count(*) FROM information_schema.table_privileges
                                              WHERE grantee='$AUX_ROLE' AND table_name='plans'")" "$src_grant"
chk "other role recreated"      "$(q postgres "SELECT rolconnlimit||':'||rolcanlogin||':'||rolsuper FROM pg_roles WHERE rolname='$AUX_ROLE'")" "$src_aux"
chk "restoring role attributes" "$(q postgres "SELECT rolsuper||':'||rolcreatedb||':'||rolreplication FROM pg_roles WHERE rolname='$PGUSER'")" "$src_self"
chk "self-role drift undone"    "$(q postgres "SELECT rolconnlimit||':'||coalesce(array_to_string(rolconfig,','),'none') FROM pg_roles WHERE rolname='$PGUSER'")" "-1:none"
chk "restoring role password"   "$(q postgres "SELECT substr(rolpassword,1,24) FROM pg_authid WHERE rolname='$PGUSER'")" "$src_pw"
# A matching hash is necessary but not sufficient — prove the verifier
# authenticates, over TCP so scram is exercised rather than a trust socket.
chk "role can still authenticate" \
    "$(PGPASSWORD="$PGPASSWORD" psql -qtAX -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d postgres -c 'SELECT 1' 2>/dev/null || echo AUTH-FAILED)" "1"
chk "other role can authenticate" \
    "$(PGPASSWORD='drill-pw' psql -qtAX -h "$PGHOST" -p "$PGPORT" -U "$AUX_ROLE" -d postgres -c 'SELECT 1' 2>/dev/null || echo AUTH-FAILED)" "1"
chk "database set (encoding+collation)" \
    "$(q postgres "SELECT string_agg(datname||'@'||pg_encoding_to_char(encoding)||'@'||datcollate||'@'||datctype, ',' ORDER BY datname)
                   FROM pg_database WHERE datname LIKE 'lbrdrill%'")" "$src_dbset"
for db in "$CTRL" "$T1" "$T2"; do
  eval "want_rows=\${src_rows_${db}}"; eval "want_ext=\${src_ext_${db}}"; eval "want_seqs=\${src_seqs_${db}}"
  chk "row census $db"    "$(row_census "$db")" "$want_rows"
  chk "extension set $db" "$(ext_set "$db")"    "$want_ext"
  chk "sequences $db"     "$(seq_set "$db")"    "$want_seqs"
  schema_dump "$db" > "$WORK/schema.$db.after.sql"
  if diff -q "$WORK/schema.$db.before.sql" "$WORK/schema.$db.after.sql" >/dev/null; then
    pass "schema identical $db"
  else
    bad "schema DIFFERS $db"; diff "$WORK/schema.$db.before.sql" "$WORK/schema.$db.after.sql" | head -12 | sed 's/^/      /'
  fi
done

if [ "$CROSS" = "1" ]; then
  say "Cross-cluster: restoring this dump into a SECOND cluster with a DIFFERENT superuser password"
  # The rebuilt-host case. ensure-env.sh mints a fresh POSTGRES_PASSWORD on a
  # host with no .env.prod, initdb uses it — and then the backup's role hash
  # silently replaces it. Before the stream filter existed this path aborted
  # loudly having restored nothing; now it succeeds and hands you a cluster
  # your own .env.prod cannot log into. That is a WORSE failure, so it is
  # pinned here rather than left to be discovered during an outage.
  T_HOST="${TARGET_PGHOST:-127.0.0.1}"; T_PORT="${TARGET_PGPORT:?--cross-cluster needs TARGET_PGPORT}"
  T_PW="${TARGET_PGPASSWORD:?--cross-cluster needs TARGET_PGPASSWORD}"
  T_SOCK="${TARGET_SOCKET_DIR:-}"

  tq() { PGPASSWORD="$1" psql -qtAX -v ON_ERROR_STOP=1 -h "$T_HOST" -p "$T_PORT" -U "$PGUSER" -d "$2" -c "$3"; }

  # Precondition, checked before anything is touched. The dump swaps this
  # role's password in its prologue and every `\connect` after that
  # re-authenticates, so a password-authenticated TCP restore breaks halfway
  # through with a bare "password authentication failed" that says nothing
  # about the cause. Either restore over a local socket (what production does,
  # via `dc exec -T postgres psql`) or point at a trust target.
  if [ -z "$T_SOCK" ] && ! PGPASSWORD='definitely-not-the-password' \
       psql -qtAX -h "$T_HOST" -p "$T_PORT" -U "$PGUSER" -d postgres -c 'SELECT 1' >/dev/null 2>&1; then
    bad "cross-cluster needs TARGET_SOCKET_DIR, or a target that does not password-authenticate.
     The dump changes this role's password mid-stream, so every \\connect after
     that would fail. Give it the target's unix socket directory, or run the
     target with POSTGRES_HOST_AUTH_METHOD=trust."
    printf '\n  %s checks passed, %s failed\n' "$ok" "$fail"
    printf '  \033[31mDR DRILL FAILED\033[0m\n'
    exit 1
  fi
  # Put the target back to its OWN password first. A previous cross-cluster run
  # ends with the target holding the SOURCE's — that is the finding — so without
  # this the second run fails on its own leftovers rather than on anything real.
  # CI gets a fresh container each time and would never notice; a re-run does.
  for pw in "$T_PW" "$PGPASSWORD"; do
    PGPASSWORD="$pw" psql -qtAX -h "$T_HOST" -p "$T_PORT" -U "$PGUSER" -d postgres \
      -c "ALTER ROLE \"$PGUSER\" PASSWORD '$T_PW'" >/dev/null 2>&1 && break
  done
  [ -z "$T_SOCK" ] || psql -qtAX -h "$T_SOCK" -p "$T_PORT" -U "$PGUSER" -d postgres \
    -c "ALTER ROLE \"$PGUSER\" PASSWORD '$T_PW'" >/dev/null 2>&1 || true

  chk "target reachable with ITS OWN password" "$(tq "$T_PW" postgres 'SELECT 1' 2>/dev/null || echo AUTH-FAILED)" "1"
  chk "target password differs from source"    "$([ "$T_PW" != "$PGPASSWORD" ] && echo differs || echo same)" "differs"

  # Restore over a local socket where available, mirroring `dc exec -T postgres
  # psql` inside the container; otherwise TCP with the target's own password.
  if [ -n "$T_SOCK" ]; then t_psql=(psql -qtAX -h "$T_SOCK" -p "$T_PORT" -U "$PGUSER" -d postgres)
  else t_psql=(env PGPASSWORD="$T_PW" psql -qtAX -h "$T_HOST" -p "$T_PORT" -U "$PGUSER" -d postgres); fi
  set +e
  { pg_restore_preamble "$PGUSER"; gunzip -c "$WORK/postgres.sql.gz" | pg_restore_filter "$PGUSER"; } \
    | "${t_psql[@]}" -v ON_ERROR_STOP=1 -v VERBOSITY=verbose >"$WORK/x.out" 2>"$WORK/x.err"
  xrc=$?
  set -e
  chk "cross-cluster restore exit code" "$xrc" "0"
  [ "$xrc" = "0" ] || { printf '  --- target stderr ---\n'; sed 's/^/  /' "$WORK/x.err" | tail -12; }
  chk "no SQLSTATE errors" "$(sqlstate_errors "$WORK/x.err" || true)" "0"

  # The data is genuinely there — this is a successful-looking restore.
  chk "data landed on the target" \
      "$(PGPASSWORD="$PGPASSWORD" psql -qtAX -h "$T_HOST" -p "$T_PORT" -U "$PGUSER" -d "$T1" \
           -c 'SELECT count(*) FROM books' 2>/dev/null || echo UNREACHABLE)" "500"

  # …and this is the sting. Documented as the expected outcome, not a bug:
  # a pg_dumpall backup carries role passwords, so restoring it makes the
  # target's superuser password the SOURCE's.
  # The substantive claim, assertable regardless of how the target
  # authenticates: the stored verifier is now the SOURCE cluster's.
  src_hash=$(q postgres "SELECT substr(rolpassword,1,24) FROM pg_authid WHERE rolname='$PGUSER'")
  tgt_hash=$(PGPASSWORD="$T_PW" psql -qtAX -h "$T_HOST" -p "$T_PORT" -U "$PGUSER" -d postgres \
               -c "SELECT substr(rolpassword,1,24) FROM pg_authid WHERE rolname='$PGUSER'" 2>/dev/null \
             || psql -qtAX -h "${T_SOCK:-$T_HOST}" -p "$T_PORT" -U "$PGUSER" -d postgres \
               -c "SELECT substr(rolpassword,1,24) FROM pg_authid WHERE rolname='$PGUSER'" 2>/dev/null)
  chk "target's stored verifier is now the SOURCE's" "$tgt_hash" "$src_hash"

  # And the lived consequence — only observable where the target actually
  # checks passwords. Under trust (a CI throwaway) every password "works", so
  # asserting the flip there would be a tautology.
  if PGPASSWORD='definitely-not-the-password' \
       psql -qtAX -h "$T_HOST" -p "$T_PORT" -U "$PGUSER" -d postgres -c 'SELECT 1' >/dev/null 2>&1; then
    printf '  \033[33m~\033[0m target uses trust auth — skipping the live password-flip assertions\n'
  else
    after_src=$(PGPASSWORD="$PGPASSWORD" psql -qtAX -h "$T_HOST" -p "$T_PORT" -U "$PGUSER" -d postgres -c 'SELECT 1' 2>/dev/null || echo AUTH-FAILED)
    after_tgt=$(PGPASSWORD="$T_PW"       psql -qtAX -h "$T_HOST" -p "$T_PORT" -U "$PGUSER" -d postgres -c 'SELECT 1' 2>/dev/null || echo AUTH-FAILED)
    chk "target now accepts the BACKUP's password" "$after_src" "1"
    chk "target REJECTS its own former password"   "$after_tgt" "AUTH-FAILED"
  fi
  printf '  \033[33m!\033[0m After a cross-host restore the superuser password is the one\n'
  printf '      from the BACKUP, not the one this host was initialised with.\n'
  printf "      POSTGRES_PASSWORD in the rebuilt host's .env.prod is now wrong; take it\n"
  printf '      from the password manager entry for the SOURCE host. See RUNBOOK.md §8.\n'
fi

say "Cleaning up"
psql -qtAX -d postgres >/dev/null 2>&1 <<SQL || true
DROP DATABASE IF EXISTS $CTRL; DROP DATABASE IF EXISTS $T1; DROP DATABASE IF EXISTS $T2;
DROP ROLE IF EXISTS $AUX_ROLE;
ALTER ROLE $PGUSER RESET ALL;
ALTER ROLE $PGUSER WITH CONNECTION LIMIT -1 VALID UNTIL 'infinity';
ALTER ROLE $PGUSER PASSWORD '$PGPASSWORD';
SQL

printf '\n  %s checks passed, %s failed\n' "$ok" "$fail"
[ "$fail" = "0" ] || { printf '  \033[31mDR DRILL FAILED\033[0m\n'; exit 1; }
printf '  \033[32mDR DRILL PASSED\033[0m — backup → restore round trip is sound\n'
