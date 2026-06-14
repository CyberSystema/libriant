#!/usr/bin/env bash
# Libriant — nightly backup.
#
# Captures:
#   1. pg_dumpall of the control + every per-tenant DB → SQL.gz
#   2. tar of /srv/libriant/storage → storage.tar.gz
#   3. Caddy access log (last day) for audit retention
#
# Output goes to $BACKUP_ROOT/$YYYYMMDD/, then optionally rclone-copied to
# the configured remote (Hetzner Storage Box by default). Runs idempotently:
# re-running on the same day overwrites the day's artefacts.
#
# Cron wiring (host crontab):
#   15 2 * * * /srv/libriant/deploy/scripts/backup.sh >> /var/log/libriant/backup.log 2>&1
#
# Retention: $BACKUP_KEEP_DAYS days of local dailies (default 14). Anything
# older is pruned at the start of each run.

set -euo pipefail

# ---------- config ----------------------------------------------------------
BACKUP_ROOT="${BACKUP_ROOT:-/srv/libriant/backups}"
BACKUP_KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"
COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-libriant}"
COMPOSE_FILE="${COMPOSE_FILE:-/srv/libriant/deploy/compose/docker-compose.prod.yml}"
RCLONE_REMOTE="${RCLONE_REMOTE:-}" # e.g. "storagebox:libriant-backups"
STORAGE_DIR="${STORAGE_DIR:-/srv/libriant/storage}"
CADDY_LOG_DIR="${CADDY_LOG_DIR:-/var/lib/docker/volumes/${COMPOSE_PROJECT_NAME}_caddy_logs/_data}"

day="$(date +%Y%m%d)"
dest="$BACKUP_ROOT/$day"
mkdir -p "$dest"

log() { printf '[%s] %s\n' "$(date +'%Y-%m-%d %H:%M:%S')" "$*"; }

# ---------- 0. prune old dailies -------------------------------------------
log "pruning backups older than $BACKUP_KEEP_DAYS days under $BACKUP_ROOT"
find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d -mtime "+$BACKUP_KEEP_DAYS" \
  -print -exec rm -rf {} +

# ---------- 1. Postgres ----------------------------------------------------
log "dumping postgres (all databases)"
# Use docker compose exec so we hit the Postgres container without needing
# psql installed on the host. `pg_dumpall` writes a single self-contained
# script — restoring is `psql -f`.
docker compose -f "$COMPOSE_FILE" -p "$COMPOSE_PROJECT_NAME" exec -T postgres \
  pg_dumpall -U libriant --clean --if-exists \
  | gzip -9 > "$dest/postgres.sql.gz"

dump_bytes=$(stat -c%s "$dest/postgres.sql.gz" 2>/dev/null || stat -f%z "$dest/postgres.sql.gz")
if [ "$dump_bytes" -lt 1024 ]; then
  log "ABORT: postgres dump suspiciously small ($dump_bytes bytes)"
  exit 1
fi
log "  postgres.sql.gz $((dump_bytes / 1024)) KiB"

# ---------- 2. Storage -----------------------------------------------------
if [ -d "$STORAGE_DIR" ]; then
  log "tarring storage from $STORAGE_DIR"
  tar -C "$STORAGE_DIR" -czf "$dest/storage.tar.gz" .
  storage_bytes=$(stat -c%s "$dest/storage.tar.gz" 2>/dev/null || stat -f%z "$dest/storage.tar.gz")
  log "  storage.tar.gz $((storage_bytes / 1024 / 1024)) MiB"
else
  log "skipping storage tar — $STORAGE_DIR does not exist"
fi

# ---------- 3. Caddy access log -------------------------------------------
if [ -d "$CADDY_LOG_DIR" ]; then
  log "snapshotting caddy access log"
  # Logs rotate inside the container — we just grab whatever's on disk now.
  tar -C "$CADDY_LOG_DIR" -czf "$dest/caddy-logs.tar.gz" . 2>/dev/null || \
    log "  warning: caddy log snapshot failed"
fi

# ---------- 4. Manifest ----------------------------------------------------
log "writing manifest"
{
  echo "host=$(hostname)"
  echo "completed_at=$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
  echo "image_tag=${IMAGE_TAG:-unknown}"
  printf "files:\n"
  find "$dest" -type f -printf '  - %f (%s bytes)\n' \
    2>/dev/null || find "$dest" -type f -exec wc -c {} +
} > "$dest/manifest.txt"

# ---------- 5. Push to remote ----------------------------------------------
if [ -n "$RCLONE_REMOTE" ]; then
  if command -v rclone >/dev/null; then
    log "rclone-copy → $RCLONE_REMOTE/$day"
    rclone copy --quiet "$dest" "$RCLONE_REMOTE/$day"
  else
    log "WARN: RCLONE_REMOTE set but rclone is not installed"
  fi
else
  # Loud, not silent: a backup that exists only on the same host as the data
  # is not a disaster-recovery backup. Surface this every run so it can't be
  # missed (set RCLONE_REMOTE to push off-site, or BACKUP_ALLOW_LOCAL_ONLY=1
  # to acknowledge a deliberately local-only setup).
  if [ "${BACKUP_ALLOW_LOCAL_ONLY:-0}" = "1" ]; then
    log "WARN: RCLONE_REMOTE unset — backup is LOCAL-ONLY (acknowledged via BACKUP_ALLOW_LOCAL_ONLY=1)"
  else
    log "WARN: RCLONE_REMOTE unset — NO OFF-SITE COPY. This backup lives only on this host."
    log "WARN: Set RCLONE_REMOTE to a remote, or BACKUP_ALLOW_LOCAL_ONLY=1 to silence this."
  fi
fi

# ---------- 6. Success heartbeat -------------------------------------------
# Ping a dead-man's-switch URL (e.g. healthchecks.io) so a silently failing or
# never-running cron is detected. Optional; skipped if unset.
if [ -n "${BACKUP_HEARTBEAT_URL:-}" ] && command -v curl >/dev/null; then
  curl -fsS -m 10 "$BACKUP_HEARTBEAT_URL" >/dev/null 2>&1 \
    && log "heartbeat pinged" \
    || log "WARN: heartbeat ping failed"
fi

log "done → $dest"
