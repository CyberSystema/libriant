#!/usr/bin/env bash
# Libriant — disaster-recovery restore (companion to backup.sh).
#
# Restores a single backup day produced by backup.sh:
#   1. Postgres  — gunzip postgres.sql.gz | psql  (pg_dumpall script, --clean)
#   2. Storage   — untar storage.tar.gz → $STORAGE_DIR
#
# The Postgres dump is a self-contained `pg_dumpall` script (created with
# --clean --if-exists), so it DROPs + recreates every database, including the
# per-tenant DBs and their extensions (the dump carries the CREATE EXTENSION
# statements). After restore, verify control-plane row counts and that each
# tenant DB has its extensions.
#
# Usage:
#   scripts/restore.sh <YYYYMMDD|/path/to/backup-dir> [--yes]
#
# DESTRUCTIVE: this overwrites the live databases + storage. Requires --yes.
#
# Drill this periodically against a throwaway host — an untested backup is not
# a backup.

set -euo pipefail

BACKUP_ROOT="${BACKUP_ROOT:-/srv/libriant/backups}"
COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-libriant}"
# DR-003: real deployed path is /srv/libriant/app/infra/compose/... (the old
# /srv/libriant/deploy/compose/... does not exist on the host).
LIBRIANT_APP_DIR="${LIBRIANT_APP_DIR:-/srv/libriant/app}"
COMPOSE_FILE="${COMPOSE_FILE:-${LIBRIANT_APP_DIR}/infra/compose/docker-compose.prod.yml}"
# NOT a literal path any more.
#
# `/srv/libriant/storage` is the IN-CONTAINER mount target. Restoring there put
# every recovered upload on the host at a path nothing serves, and the script
# then logged "storage restored" and exited 0 — a restore that recovered ZERO
# files and reported success (reliability-05). Same shape as the pg_dumpall bug
# that invalidated the June certification, and it survived being marked fixed
# twice because nothing ever counted the files.
#
# storage_resolve_dir() asks Docker where the volume's bind DEVICE is, which is
# correct whether or not a container currently has it mounted — during a restore
# the app containers are stopped, so the volume's `_data` directory is empty and
# unmounted, and writing there is the same total loss one layer deeper. An
# explicit STORAGE_DIR= still wins, for the operator who knows better.
STORAGE_DIR="$(storage_resolve_dir "${COMPOSE_PROJECT_NAME:-libriant}" "${STORAGE_DIR:-}")"
# The superuser the dump was taken as and is restored as.
PG_ROLE="${PG_ROLE:-libriant}"

# shellcheck source=_lib/pg-restore-filter.sh
. "$(dirname "$0")/_lib/pg-restore-filter.sh"
# shellcheck source=_lib/storage-archive.sh
. "$(dirname "$0")/_lib/storage-archive.sh"

log() { printf '[%s] %s\n' "$(date +'%Y-%m-%d %H:%M:%S')" "$*"; }
die() { printf 'restore: %s\n' "$*" >&2; exit 1; }

SRC=""
CONFIRM=0
for a in "$@"; do
  case "$a" in
    --yes) CONFIRM=1 ;;
    -*) die "unknown flag: $a" ;;
    *) SRC="$a" ;;
  esac
done
[ -n "$SRC" ] || die "usage: restore.sh <YYYYMMDD|/path/to/backup-dir> [--yes]"

# Resolve the backup directory: a bare day maps under BACKUP_ROOT.
if [ -d "$SRC" ]; then
  dir="$SRC"
else
  dir="$BACKUP_ROOT/$SRC"
fi
[ -d "$dir" ] || die "backup directory not found: $dir"
[ -f "$dir/postgres.sql.gz" ] || die "no postgres.sql.gz in $dir"

log "restore source: $dir"
log "  postgres.sql.gz: $(stat -c%s "$dir/postgres.sql.gz" 2>/dev/null || stat -f%z "$dir/postgres.sql.gz") bytes"
[ -f "$dir/storage.tar.gz" ] && log "  storage.tar.gz present" || log "  storage.tar.gz MISSING (will skip storage restore)"

if [ "$CONFIRM" != "1" ]; then
  die "this OVERWRITES the live databases and storage. Re-run with --yes to proceed."
fi

dc() { docker compose -f "$COMPOSE_FILE" -p "$COMPOSE_PROJECT_NAME" "$@"; }

# ---------- 0. Validate the archives BEFORE touching live data --------------
# Decompress-test every archive up front. A corrupt/truncated dump would
# otherwise only fail partway through the DROP+recreate wave — the worst
# possible moment, leaving a half-restored cluster. `gunzip -t` reads the whole
# stream and verifies the gzip integrity without writing anything; abort if it
# fails so a bad archive never reaches a DROP.
log "validating backup archives (gzip integrity)…"
gunzip -t "$dir/postgres.sql.gz" 2>/dev/null \
  || die "postgres.sql.gz is corrupt/truncated — refusing to restore (no databases were touched)."
if [ -f "$dir/storage.tar.gz" ]; then
  gunzip -t "$dir/storage.tar.gz" 2>/dev/null \
    || die "storage.tar.gz is corrupt/truncated — refusing to restore (no databases were touched)."
fi
log "  archives OK"

# ---------- 1. Postgres ----------------------------------------------------
# The pg_dumpall script DROPs every database. Postgres refuses to DROP a DB that
# still has open connections, so the api/worker/web containers MUST be stopped
# first — otherwise the restore aborts under ON_ERROR_STOP=1 ("database is being
# accessed by other users"). Postgres itself stays up to receive the restore.
# Pre-flight the stream filter while everything is still intact. If the
# patterns no longer match — a quoted role name, a future pg_dumpall wording
# change — the filter silently removes nothing and the restore wipes the
# cluster exactly as it used to. Refuse here, having touched nothing.
matches="$(gunzip -c "$dir/postgres.sql.gz" | pg_restore_filter_count "$PG_ROLE")"
if [ "$matches" != "2" ]; then
  die "stream filter matched $matches self-role statements for '$PG_ROLE', expected 2.
     The dump's role prologue is not the shape this filter knows, so restoring
     would drop every database and then abort. Nothing was touched.
     Inspect: gunzip -c '$dir/postgres.sql.gz' | sed -n '1,60p'"
fi
log "  stream filter pre-flight OK (2 self-role statements for '$PG_ROLE')"

log "stopping application services so databases can be dropped…"
# pgbouncer too: it is `restart: unless-stopped` and holds pooled server
# connections to libriant_control, which will block the DROP wave.
dc stop api worker web pgbouncer 2>/dev/null || true
# Belt-and-braces: terminate any other lingering backends (manual psql, etc.)
# against the non-system databases before the DROP wave.
# Terminate EVERY other backend, not just the ones on tenant databases. The
# dump drops `postgres` and `template1` with a bare DROP DATABASE (no IF
# EXISTS), and both are dropped LATE — so one lingering session there aborts
# the restore after every tenant database is already gone. A `psql -d postgres`
# left open to watch the restore is the likeliest session in the building.
# template0 is exempt only because datallowconn=false makes it unconnectable.
dc exec -T postgres psql -U "$PG_ROLE" -d postgres -v ON_ERROR_STOP=0 -c \
  "SELECT pg_terminate_backend(pid) FROM pg_stat_activity
   WHERE datname IS NOT NULL AND datname <> 'template0' AND pid <> pg_backend_pid();" \
  >/dev/null 2>&1 || true

# Bring the apps back up even if the restore fails partway, so we never leave the
# stack down silently.
restart_apps() {
  log "restarting application services…"
  dc up -d api worker web 2>/dev/null || dc start api worker web 2>/dev/null || \
    log "  WARN: could not restart app services — bring them up manually."
}
trap restart_apps EXIT

log "restoring postgres (DROP + recreate via pg_dumpall script)…"
# The stream is filtered: a pg_dumpall --clean script tries to DROP and CREATE
# the very role it is restored as, which aborts psql under ON_ERROR_STOP=1
# AFTER the DROP DATABASE wave. See scripts/_lib/pg-restore-filter.sh.
{ pg_restore_preamble "$PG_ROLE"; gunzip -c "$dir/postgres.sql.gz" | pg_restore_filter "$PG_ROLE"; } \
  | dc exec -T postgres psql -U "$PG_ROLE" -d postgres -v ON_ERROR_STOP=1
log "  postgres restored"

# ---------- 2. Storage -----------------------------------------------------
# DR-004: untar into a CLEAN tree. A bare `tar -x` is additive — restoring an
# older backup onto a newer/non-empty $STORAGE_DIR would leave orphaned files
# (uploads for records the restored DB no longer references, or previously
# deleted files reappearing), so the restore would not be a faithful
# point-in-time copy. Move any existing tree aside first (kept, not deleted, so
# a botched restore is recoverable), then untar into a fresh directory.
if [ -f "$dir/storage.tar.gz" ]; then
  log "restoring storage → $STORAGE_DIR"
  mkdir -p "$STORAGE_DIR"
  storage_assert_visible_to_containers "$STORAGE_DIR" ||
    die "refusing to restore uploads to a path the app containers cannot see: $STORAGE_DIR"

  # COUNT WHAT THE ARCHIVE HOLDS BEFORE UNPACKING, and refuse if fewer files
  # land. "storage restored" used to be printed unconditionally, which is how a
  # restore that recovered nothing looked identical to one that worked. The
  # number is the only thing that tells them apart.
  # storage_archive_file_count reads tar's LISTING on stdin, and
  # storage_untar_into wants the GZIPPED stream (it runs `tar -xzf -`). Getting
  # either of those backwards produces a confident count of zero or an untar of
  # nothing — both of which look exactly like the bug being fixed.
  want="$(tar -tzf "$dir/storage.tar.gz" | storage_archive_file_count)"
  log "  archive holds ${want} file(s)"
  storage_untar_into "$STORAGE_DIR" "$want" < "$dir/storage.tar.gz" ||
    die "upload restore did not complete — do NOT return this cluster to service."
  storage_warn_ownership "$STORAGE_DIR"
  log "  storage restored: $(storage_dir_file_count "$STORAGE_DIR") file(s) under $STORAGE_DIR"
fi

# ---------- 3. Sanity checks ----------------------------------------------
log "verifying control-plane seed counts…"
counts="$(docker compose -f "$COMPOSE_FILE" -p "$COMPOSE_PROJECT_NAME" exec -T postgres \
  psql -U "$PG_ROLE" -d libriant_control -tAc \
  "SELECT (SELECT count(*) FROM cells) || ',' || (SELECT count(*) FROM plans);" 2>/dev/null || true)"
log "  cells,plans = ${counts:-<unavailable>}"

# A restore that recovered ZERO tenant databases used to print nothing here and
# exit 0 — the same silent success as the bug this script was fixed for. Compare
# against what the control plane says should exist.
expected_tenants="$(docker compose -f "$COMPOSE_FILE" -p "$COMPOSE_PROJECT_NAME" exec -T postgres \
  psql -U "$PG_ROLE" -d libriant_control -tAc "SELECT count(*) FROM tenants;" 2>/dev/null | tr -d '[:space:]' || echo '')"

log "verifying per-tenant DB extensions…"
tenant_dbs="$(docker compose -f "$COMPOSE_FILE" -p "$COMPOSE_PROJECT_NAME" exec -T postgres \
  psql -U "$PG_ROLE" -d postgres -tAc \
  "SELECT datname FROM pg_database WHERE datname LIKE 'tenant_%';" 2>/dev/null || true)"
for db in $tenant_dbs; do
  ext="$(docker compose -f "$COMPOSE_FILE" -p "$COMPOSE_PROJECT_NAME" exec -T postgres \
    psql -U "$PG_ROLE" -d "$db" -tAc \
    "SELECT count(*) FROM pg_extension WHERE extname IN ('unaccent','pg_trgm','pgcrypto','citext');" 2>/dev/null || echo 0)"
  if [ "${ext:-0}" -lt 4 ]; then
    log "  WARN: $db has only ${ext:-0}/4 expected extensions — re-run extension install."
  else
    log "  $db extensions OK (4/4)"
  fi
done

actual_tenants="$(printf '%s\n' $tenant_dbs | grep -c . || true)"
if [ -n "$expected_tenants" ] && [ "$expected_tenants" != "0" ] \
   && [ "${actual_tenants:-0}" -lt "$expected_tenants" ]; then
  die "control plane lists $expected_tenants tenant(s) but only ${actual_tenants:-0} tenant database(s) were restored.
     The restore did NOT complete correctly — do not put this cluster back into service."
fi

log "restore complete from $dir"
