#!/usr/bin/env bash
# Libriant — nightly backup.
#
# Captures:
#   1. pg_dumpall of the control + every per-tenant DB → SQL.gz
#   2. tar of /srv/libriant/storage → storage.tar.gz
#   3. Caddy access log (last day) for audit retention
#
# SINGLE-HOST ASSUMPTION (INFRA-1): pg_dumpall runs INSIDE the local Postgres
# container, so it captures only databases on THIS host. Tenants relocated to a
# different Postgres host (tenant-relocate.ts) would silently fall out of this
# backup. To prevent that silent data-loss exposure we query the control plane
# for every tenant's db_url host and ABORT if any tenant lives off-box, so the
# gap can never pass unnoticed. (Multi-host fan-out backups are a future step.)
#
# Output goes to $BACKUP_ROOT/$YYYYMMDD/, then optionally rclone-copied to
# the configured remote (Hetzner Storage Box by default). Runs idempotently:
# re-running on the same day overwrites the day's artefacts.
#
# Cron wiring (host crontab):
#   15 2 * * * deploy bash -lc 'set -a; . /srv/libriant/.env.prod; set +a; /srv/libriant/app/scripts/backup.sh >> /var/log/libriant/backup.log 2>&1'
#
# Retention: $BACKUP_KEEP_DAYS days of local dailies (default 14). Anything
# older is pruned at the start of each run.

set -euo pipefail

# ---------- config ----------------------------------------------------------
BACKUP_ROOT="${BACKUP_ROOT:-/srv/libriant/backups}"
BACKUP_KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"
COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-libriant}"
# DR-003: the deployed layout is /srv/libriant/app/infra/compose/... (see
# .github/workflows/deploy.yml + deployment-hetzner.md), NOT /srv/libriant/deploy/.
# The old default pointed at a path that does not exist on the host, so an
# unattended cron without an explicit COMPOSE_FILE got "no configuration file
# provided" and produced NO backup. Default to the real path under
# ${LIBRIANT_APP_DIR}; the volume overlay is harmless to omit for an `exec`
# (the named volumes are already mounted in the running containers).
LIBRIANT_APP_DIR="${LIBRIANT_APP_DIR:-/srv/libriant/app}"
COMPOSE_FILE="${COMPOSE_FILE:-${LIBRIANT_APP_DIR}/infra/compose/docker-compose.prod.yml}"
RCLONE_REMOTE="${RCLONE_REMOTE:-}" # e.g. "storagebox:libriant-backups"
CADDY_LOG_DIR="${CADDY_LOG_DIR:-/var/lib/docker/volumes/${COMPOSE_PROJECT_NAME}_caddy_logs/_data}"

# Resolve where tenant uploads live ON THE HOST. `storage` is a named docker
# volume (see compose); its IN-CONTAINER path (/srv/libriant/storage) does NOT
# exist on the host, so defaulting to it silently skipped every upload (book
# covers, attachments) — a DB-only "backup" that looks successful. Ask docker
# for the real mountpoint, then fall back to the conventional volume path, then
# a host bind. A wrong/missing path is treated as a HARD error below.
if [ -z "${STORAGE_DIR:-}" ]; then
  STORAGE_DIR="$(docker volume inspect "${COMPOSE_PROJECT_NAME}_storage" \
    --format '{{.Mountpoint}}' 2>/dev/null || true)"
  if [ -z "$STORAGE_DIR" ] || [ ! -d "$STORAGE_DIR" ]; then
    STORAGE_DIR="/var/lib/docker/volumes/${COMPOSE_PROJECT_NAME}_storage/_data"
  fi
  [ -d "$STORAGE_DIR" ] || STORAGE_DIR="/srv/libriant/storage"
fi

day="$(date +%Y%m%d)"
dest="$BACKUP_ROOT/$day"
mkdir -p "$dest"

log() { printf '[%s] %s\n' "$(date +'%Y-%m-%d %H:%M:%S')" "$*"; }

# ---------- 0. prune old dailies -------------------------------------------
log "pruning backups older than $BACKUP_KEEP_DAYS days under $BACKUP_ROOT"
find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d -mtime "+$BACKUP_KEEP_DAYS" \
  -print -exec rm -rf {} +

dc() { docker compose -f "$COMPOSE_FILE" -p "$COMPOSE_PROJECT_NAME" "$@"; }

# ---------- 0.5 single-host guard (INFRA-1) --------------------------------
# pg_dumpall only sees databases on THIS Postgres instance. If a tenant has been
# relocated to another host (tenant-relocate.ts rewrites tenants.db_url), its DB
# is NOT in this dump — a silent, total data-loss exposure for that tenant. Ask
# the control plane for every tenant's db_url host and ABORT loudly if any of
# them is not the local Postgres. Local hosts are `postgres` (the in-container
# hostname baked into PG_SUPERUSER_URL), `pgbouncer`, `localhost`, `127.0.0.1`.
# Set BACKUP_ALLOW_OFFHOST_TENANTS=1 only after wiring per-host fan-out backups.
log "checking all tenant databases live on this host"
# Strip credentials + path, keep just the host[:port], then drop the port —
# substring_index over '@' then '/' then ':'. Returns one host per line.
# NB: the column is Prisma camelCase `"dbUrl"` (created quoted) — unquoted
# `db_url` would fold to lowercase, error "column does not exist", and abort
# EVERY backup, not just off-host ones (INFRA-1).
offhost="$(dc exec -T postgres psql -U libriant -d libriant_control -tAc \
  "SELECT DISTINCT split_part(split_part(split_part(\"dbUrl\", '@', 2), '/', 1), ':', 1)
     FROM tenants
    WHERE split_part(split_part(split_part(\"dbUrl\", '@', 2), '/', 1), ':', 1)
          NOT IN ('postgres', 'pgbouncer', 'localhost', '127.0.0.1');" 2>/dev/null || echo '__QUERY_FAILED__')"
if [ "$offhost" = "__QUERY_FAILED__" ]; then
  log "ABORT: could not query the control DB to verify tenant DB hosts."
  log "       (Is the postgres container up and is COMPOSE_FILE=$COMPOSE_FILE correct?)"
  exit 1
fi
offhost="$(printf '%s\n' "$offhost" | grep -v '^[[:space:]]*$' || true)"
if [ -n "$offhost" ]; then
  if [ "${BACKUP_ALLOW_OFFHOST_TENANTS:-0}" = "1" ]; then
    log "WARN: tenant DB(s) on other host(s): $(echo "$offhost" | tr '\n' ' ')— NOT in this backup (acknowledged via BACKUP_ALLOW_OFFHOST_TENANTS=1)"
  else
    log "ABORT: one or more tenants live on a Postgres host other than this one:"
    echo "$offhost" | while IFS= read -r h; do [ -n "$h" ] && log "         - $h"; done
    log "       This single-host backup would SILENTLY OMIT those tenants' databases."
    log "       Run a per-host backup against each cell, or set BACKUP_ALLOW_OFFHOST_TENANTS=1"
    log "       to acknowledge an intentionally local-only backup."
    exit 1
  fi
fi

# ---------- 1. Postgres ----------------------------------------------------
log "dumping postgres (all databases)"
# Use docker compose exec so we hit the Postgres container without needing
# psql installed on the host. `pg_dumpall` writes a single self-contained
# script — restoring is `psql -f`.
dc exec -T postgres \
  pg_dumpall -U libriant --clean --if-exists \
  | gzip -9 > "$dest/postgres.sql.gz"

dump_bytes=$(stat -c%s "$dest/postgres.sql.gz" 2>/dev/null || stat -f%z "$dest/postgres.sql.gz")
if [ "$dump_bytes" -lt 1024 ]; then
  log "ABORT: postgres dump suspiciously small ($dump_bytes bytes)"
  exit 1
fi
# Verify the gzip stream is intact: a disk-full / truncated write can leave a
# >1KB file that still passes the size check but is unrestorable. `gzip -t`
# decompresses to /dev/null and fails on a corrupt/truncated archive, so a bad
# dump aborts the backup now instead of surfacing mid-restore.
if ! gzip -t "$dest/postgres.sql.gz" 2>/dev/null; then
  log "ABORT: postgres.sql.gz failed gzip integrity check (truncated/corrupt) — discarding."
  rm -f "$dest/postgres.sql.gz"
  exit 1
fi
log "  postgres.sql.gz $((dump_bytes / 1024)) KiB"

# ---------- 2. Storage -----------------------------------------------------
# A missing storage dir means tenant uploads would be MISSING from the backup.
# That must NOT pass silently (the whole point of DR-002): abort unless the
# operator explicitly acknowledges a DB-only backup.
if [ ! -d "$STORAGE_DIR" ]; then
  if [ "${BACKUP_ALLOW_NO_STORAGE:-0}" = "1" ]; then
    log "WARN: storage dir not found ($STORAGE_DIR) — DB-only backup (acknowledged via BACKUP_ALLOW_NO_STORAGE=1)"
  else
    log "ABORT: storage dir not found ($STORAGE_DIR). Tenant uploads would be MISSING from this backup."
    log "       Set STORAGE_DIR to the correct host path (try: docker volume inspect ${COMPOSE_PROJECT_NAME}_storage),"
    log "       or set BACKUP_ALLOW_NO_STORAGE=1 to take a deliberate DB-only backup."
    exit 1
  fi
else
  log "tarring storage from $STORAGE_DIR"
  if [ -z "$(ls -A "$STORAGE_DIR" 2>/dev/null)" ]; then
    log "  WARN: $STORAGE_DIR is EMPTY — archive will contain no uploads. Verify STORAGE_DIR if that's unexpected."
  fi
  tar -C "$STORAGE_DIR" -czf "$dest/storage.tar.gz" .
  # Same integrity gate as the Postgres dump: a truncated tarball must not pass
  # as a valid backup (the failure would otherwise only surface during restore).
  if ! gzip -t "$dest/storage.tar.gz" 2>/dev/null; then
    log "ABORT: storage.tar.gz failed gzip integrity check (truncated/corrupt) — discarding."
    rm -f "$dest/storage.tar.gz"
    exit 1
  fi
  storage_bytes=$(stat -c%s "$dest/storage.tar.gz" 2>/dev/null || stat -f%z "$dest/storage.tar.gz")
  log "  storage.tar.gz $((storage_bytes / 1024 / 1024)) MiB"
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
