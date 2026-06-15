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
STORAGE_DIR="${STORAGE_DIR:-/srv/libriant/storage}"

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
log "stopping application services so databases can be dropped…"
dc stop api worker web 2>/dev/null || true
# Belt-and-braces: terminate any other lingering backends (manual psql, etc.)
# against the non-system databases before the DROP wave.
dc exec -T postgres psql -U libriant -d postgres -v ON_ERROR_STOP=0 -c \
  "SELECT pg_terminate_backend(pid) FROM pg_stat_activity
   WHERE datname NOT IN ('postgres','template0','template1') AND pid <> pg_backend_pid();" \
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
gunzip -c "$dir/postgres.sql.gz" \
  | dc exec -T postgres psql -U libriant -d postgres -v ON_ERROR_STOP=1
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
  if [ -n "$(ls -A "$STORAGE_DIR" 2>/dev/null)" ]; then
    # Move the EXISTING CONTENTS (not the directory itself — $STORAGE_DIR is
    # often a bind-mount root that can't be renamed) into a timestamped sibling
    # under the same dir, so the target is clean for the untar but the old tree
    # is kept for recovery. `.pre-restore.*` is excluded from the move so a
    # re-run doesn't nest snapshots.
    aside="$STORAGE_DIR/.pre-restore.$(date +%Y%m%d%H%M%S)"
    log "  existing storage is non-empty — moving aside to $aside (delete it once the restore is verified)"
    mkdir -p "$aside"
    find "$STORAGE_DIR" -mindepth 1 -maxdepth 1 ! -name '.pre-restore.*' \
      -exec mv -t "$aside" {} +
  fi
  tar -C "$STORAGE_DIR" -xzf "$dir/storage.tar.gz"
  log "  storage restored"
fi

# ---------- 3. Sanity checks ----------------------------------------------
log "verifying control-plane seed counts…"
counts="$(docker compose -f "$COMPOSE_FILE" -p "$COMPOSE_PROJECT_NAME" exec -T postgres \
  psql -U libriant -d libriant_control -tAc \
  "SELECT (SELECT count(*) FROM cells) || ',' || (SELECT count(*) FROM plans);" 2>/dev/null || true)"
log "  cells,plans = ${counts:-<unavailable>}"

log "verifying per-tenant DB extensions…"
tenant_dbs="$(docker compose -f "$COMPOSE_FILE" -p "$COMPOSE_PROJECT_NAME" exec -T postgres \
  psql -U libriant -d postgres -tAc \
  "SELECT datname FROM pg_database WHERE datname LIKE 'tenant_%';" 2>/dev/null || true)"
for db in $tenant_dbs; do
  ext="$(docker compose -f "$COMPOSE_FILE" -p "$COMPOSE_PROJECT_NAME" exec -T postgres \
    psql -U libriant -d "$db" -tAc \
    "SELECT count(*) FROM pg_extension WHERE extname IN ('unaccent','pg_trgm','pgcrypto','citext');" 2>/dev/null || echo 0)"
  if [ "${ext:-0}" -lt 4 ]; then
    log "  WARN: $db has only ${ext:-0}/4 expected extensions — re-run extension install."
  else
    log "  $db extensions OK (4/4)"
  fi
done

log "restore complete from $dir"
