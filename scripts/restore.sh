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
COMPOSE_FILE="${COMPOSE_FILE:-/srv/libriant/deploy/compose/docker-compose.prod.yml}"
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

# ---------- 1. Postgres ----------------------------------------------------
log "restoring postgres (DROP + recreate via pg_dumpall script)…"
gunzip -c "$dir/postgres.sql.gz" \
  | docker compose -f "$COMPOSE_FILE" -p "$COMPOSE_PROJECT_NAME" exec -T postgres \
      psql -U libriant -d postgres -v ON_ERROR_STOP=1
log "  postgres restored"

# ---------- 2. Storage -----------------------------------------------------
if [ -f "$dir/storage.tar.gz" ]; then
  log "restoring storage → $STORAGE_DIR"
  mkdir -p "$STORAGE_DIR"
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
