#!/usr/bin/env bash
# Libriant — nightly backup.
#
# Captures, ENCRYPTED, to $BACKUP_ROOT/$YYYYMMDD/:
#   1. pg_dumpall of the control + every per-tenant DB → postgres.sql.gz{.age|.gpg}
#   2. tar of the tenant uploads tree            → storage.tar.gz{.age|.gpg}
#   3. Caddy access log (whatever is on disk)    → caddy-logs.tar.gz{.age|.gpg}
#   4. manifest.txt — plaintext index: sizes, sha256 of each artefact, and the
#      id of the key needed to open them
# …then pushes the day to $RCLONE_REMOTE, VERIFIES the push, and prunes the
# remote on the same retention schedule as the local copies.
#
# WHAT CHANGED AND WHY (pre-release audit 2026-08-23):
#
#   privacy-legal-02 (blocker) — every artefact used to be written in plain
#   text and rclone-copied to a Hetzner Storage Box, where nothing ever pruned
#   it. A pg_dumpall is the complete member registry of every library on this
#   host: names, dates of birth, home addresses, phone numbers, staff notes and
#   the loan history of named children, including school libraries. The Art. 28
#   DPA a municipal committee files says "encrypted backups", and the privacy
#   notice says deleted copies "age out of backups". Neither was true.
#   → scripts/_lib/backup-crypt.sh, and the prune in _lib/backup-offsite.sh.
#
#   reliability-09 (high) — the script aborts on eight distinct conditions and
#   every one of them only wrote a line to a log file. The single notification
#   fired on SUCCESS, at the very end, and was unset anyway. A backup that never
#   ran was undetectable. → _lib/backup-observability.sh: a /start + /fail
#   heartbeat AND a node-exporter textfile metric that Prometheus alerts on with
#   `absent()`, which is the only form that fires for a backup that never
#   happened. At least one of the two must be usable or this script refuses.
#
#   launch-readiness-05 (high) — "daily backups and an off-server copy" is a
#   written term of the founding offer. Without RCLONE_REMOTE the old script
#   logged a WARN and exited 0, i.e. reported success while half the promise was
#   false. It now exits NON-ZERO (artefacts are still written — a good local
#   backup is never thrown away) so the dead man's switch reports it. Set
#   BACKUP_ALLOW_LOCAL_ONLY=1 to acknowledge a deliberately local-only host.
#
# SINGLE-HOST ASSUMPTION (INFRA-1): pg_dumpall runs INSIDE the local Postgres
# container, so it captures only databases on THIS host. Tenants relocated to a
# different Postgres host (tenant-relocate.ts) would silently fall out of this
# backup, so we query the control plane and ABORT if any tenant lives off-box.
#
# Cron wiring — do not hand-type it, print it:
#   scripts/backup.sh --print-cron          # to review
#   sudo scripts/backup.sh --install-cron   # writes /etc/cron.d/libriant-backup
# and check a deployed host with:
#   scripts/backup.sh --check-cron          # exit 1 when the cron is missing
#   scripts/backup.sh --preflight           # config only; touches no data
#
# Retention: $BACKUP_KEEP_DAYS days (default 14), applied to the local dailies
# AND to the off-site copy.

set -euo pipefail

# ---------- config ----------------------------------------------------------
BACKUP_ROOT="${BACKUP_ROOT:-/srv/libriant/backups}"
BACKUP_KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"
COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-libriant}"
# DR-003: the deployed layout is /srv/libriant/app/infra/compose/... (see
# .github/workflows/deploy.yml + RUNBOOK.md), NOT /srv/libriant/deploy/.
# The old default pointed at a path that does not exist on the host, so an
# unattended cron without an explicit COMPOSE_FILE got "no configuration file
# provided" and produced NO backup.
LIBRIANT_APP_DIR="${LIBRIANT_APP_DIR:-/srv/libriant/app}"
COMPOSE_FILE="${COMPOSE_FILE:-${LIBRIANT_APP_DIR}/infra/compose/docker-compose.prod.yml}"
RCLONE_REMOTE="${RCLONE_REMOTE:-}" # e.g. "storagebox:libriant-backups"
CADDY_LOG_DIR="${CADDY_LOG_DIR:-/var/lib/docker/volumes/${COMPOSE_PROJECT_NAME}_caddy_logs/_data}"
# Where node-exporter's textfile collector reads from. Must match
# infra/monitoring/docker-compose.monitoring.yml.
BACKUP_TEXTFILE_DIR="${BACKUP_TEXTFILE_DIR:-/var/lib/node_exporter/textfile}"
CRON_FILE="${BACKUP_CRON_FILE:-/etc/cron.d/libriant-backup}"

HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=_lib/backup-crypt.sh
. "$HERE/_lib/backup-crypt.sh"
# shellcheck source=_lib/storage-archive.sh
. "$HERE/_lib/storage-archive.sh"
# shellcheck source=_lib/backup-offsite.sh
. "$HERE/_lib/backup-offsite.sh"
# shellcheck source=_lib/backup-observability.sh
. "$HERE/_lib/backup-observability.sh"

# The run log doubles as the body of the /fail heartbeat, so whoever is woken up
# learns WHY without opening an SSH session.
RUNLOG="$(mktemp "${TMPDIR:-/tmp}/libriant-backup.XXXXXX")"
log() {
  local line
  line="$(printf '[%s] %s' "$(date +'%Y-%m-%d %H:%M:%S')" "$*")"
  printf '%s\n' "$line"
  printf '%s\n' "$line" >> "$RUNLOG" 2>/dev/null || true
}

# ---------- cron: shipped as code, not as a snippet to retype ---------------
# reliability-09 / launch-readiness-05: the schedule existed only as prose in
# two documents, one of which set no BACKUP_ROOT and would have written the
# backups to the small boot disk.
cron_line() {
  cat <<EOF
# Libriant nightly backup — 02:15 host time. Installed by scripts/backup.sh
# --install-cron; edit there, not here, or the next deploy's check will disagree
# with reality.
SHELL=/bin/bash
MAILTO=""
15 2 * * * ${BACKUP_CRON_USER:-deploy} bash -lc 'set -a; . ${BACKUP_ENV_FILE:-/srv/libriant/.env.prod}; set +a; BACKUP_ROOT=${BACKUP_ROOT} COMPOSE_FILE=${COMPOSE_FILE} BACKUP_TEXTFILE_DIR=${BACKUP_TEXTFILE_DIR} ${LIBRIANT_APP_DIR}/scripts/backup.sh >> /var/log/libriant/backup.log 2>&1'
EOF
}

case "${1:-}" in
  --print-cron)
    cron_line
    exit 0
    ;;
  --install-cron)
    [ "$(id -u)" = "0" ] || { echo "backup: --install-cron needs root ($CRON_FILE)" >&2; exit 1; }
    mkdir -p /var/log/libriant
    cron_line > "$CRON_FILE"
    chmod 0644 "$CRON_FILE"
    echo "installed $CRON_FILE"
    exit 0
    ;;
  --check-cron)
    # Intended for deploy-on-host.sh: a green first deploy with no backup cron
    # is the state launch-readiness-05 describes, and it used to pass silently.
    if [ ! -f "$CRON_FILE" ]; then
      echo "backup: NO NIGHTLY BACKUP IS INSTALLED ($CRON_FILE is missing)." >&2
      echo "        The offer terms promise daily backups. Run: sudo $0 --install-cron" >&2
      exit 1
    fi
    newest="$(find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d -mtime -2 2>/dev/null | head -1 || true)"
    if [ -z "$newest" ]; then
      echo "backup: cron exists but there is no backup under $BACKUP_ROOT newer than 48h." >&2
      exit 1
    fi
    echo "backup cron OK ($CRON_FILE); newest backup: $newest"
    exit 0
    ;;
  --preflight) PREFLIGHT=1 ;;
  '') PREFLIGHT=0 ;;
  *) echo "backup: unknown flag: $1" >&2; exit 2 ;;
esac

# ---------- observability, wired before anything can fail -------------------
obs_init "$BACKUP_TEXTFILE_DIR" "${BACKUP_HEARTBEAT_URL:-}"

# A host where a stopped backup cannot be noticed is not a host this product may
# run on. One of the two channels is enough; neither is not.
if ! obs_textfile_enabled && ! obs_heartbeat_enabled; then
  echo "backup: NO DEAD MAN'S SWITCH." >&2
  echo "        Neither BACKUP_HEARTBEAT_URL nor a writable BACKUP_TEXTFILE_DIR" >&2
  echo "        ($BACKUP_TEXTFILE_DIR) is available, so a backup that stops happening" >&2
  echo "        would be discovered only when a restore is needed. Set one:" >&2
  echo "          BACKUP_HEARTBEAT_URL=https://hc-ping.com/<uuid>   (external, survives host loss)" >&2
  echo "          sudo install -d -o ${BACKUP_CRON_USER:-deploy} -g ${BACKUP_CRON_USER:-deploy} $BACKUP_TEXTFILE_DIR" >&2
  exit 1
fi

started_at="$(date +%s)"
degraded=0        # completed, but a promise is unmet — exits non-zero
offsite_ok=0
storage_bytes=0
dump_bytes=0

finish() {
  local rc=$?
  local now; now="$(date +%s)"
  # Metrics are written on EVERY exit path, including the eight aborts. A run
  # that failed must leave evidence that it ran and failed, or the absent()
  # alert cannot tell it apart from a cron that was never installed.
  obs_set libriant_backup_last_run_timestamp_seconds "$now" \
    'Unix time of the last backup attempt, successful or not.'
  obs_set libriant_backup_last_exit_code "$rc" \
    'Exit status of the last backup run. 0 = complete; 1 = aborted or degraded.'
  obs_set libriant_backup_duration_seconds "$((now - started_at))" \
    'Wall-clock seconds of the last backup run.'
  obs_set libriant_backup_degraded "$degraded" \
    'The backup completed but a promised property (off-site copy, encryption) was not met.'
  obs_set libriant_backup_offsite_configured "$([ -n "$RCLONE_REMOTE" ] && echo 1 || echo 0)" \
    'RCLONE_REMOTE is set, so an off-server copy is attempted.'
  obs_set libriant_backup_encrypted "$([ "${crypt_mode:-none}" != "none" ] && echo 1 || echo 0)" \
    'Artefacts are encrypted at rest. The DPA states that they are.'
  obs_set libriant_backup_artefact_bytes_postgres "${dump_bytes:-0}" \
    'Size of the last postgres dump artefact, in bytes.'
  obs_set libriant_backup_artefact_bytes_storage "${storage_bytes:-0}" \
    'Size of the last uploads archive, in bytes.'

  if [ "$rc" = "0" ] && [ "$degraded" = "0" ]; then
    obs_set libriant_backup_last_success_timestamp_seconds "$now" \
      'Unix time of the last fully successful backup. absent() on this metric is the dead man'"'"'s switch.'
  else
    # Carry the old value forward so `time() - last_success` keeps growing
    # through a run of failures instead of resetting to now.
    prev="$(obs_prev libriant_backup_last_success_timestamp_seconds)"
    [ -n "$prev" ] && obs_set libriant_backup_last_success_timestamp_seconds "$prev" \
      'Unix time of the last fully successful backup. absent() on this metric is the dead man'"'"'s switch.'
  fi

  if [ "$offsite_ok" = "1" ]; then
    obs_set libriant_backup_offsite_last_success_timestamp_seconds "$now" \
      'Unix time of the last VERIFIED off-site copy.'
  else
    prev="$(obs_prev libriant_backup_offsite_last_success_timestamp_seconds)"
    [ -n "$prev" ] && obs_set libriant_backup_offsite_last_success_timestamp_seconds "$prev" \
      'Unix time of the last VERIFIED off-site copy.'
  fi
  obs_flush || echo "backup: WARN could not write metrics to $BACKUP_TEXTFILE_DIR" >&2

  if [ "$rc" = "0" ] && [ "$degraded" = "0" ]; then
    obs_heartbeat success || log "WARN: heartbeat ping failed (the backup itself was fine)"
  else
    obs_heartbeat fail "$RUNLOG" || log "WARN: /fail heartbeat ping failed"
  fi
  rm -f "$RUNLOG"
}
trap finish EXIT

obs_heartbeat start || log "WARN: /start heartbeat ping failed"

# ---------- preflight: everything that can be wrong about the CONFIG --------
# All of it BEFORE the first byte is dumped. A key that is not there, a remote
# that is a bare root, an unresolvable storage directory: each of these used to
# be discovered an hour in, or worse, not at all.

if ! crypt_mode="$(backup_crypt_mode)"; then
  log "ABORT: backup encryption is not configured (see the message above)."
  exit 1
fi
if [ "$crypt_mode" = "none" ]; then
  # Deliberate plaintext is allowed for a local-only host — but never off-site.
  # The off-site leg is the exposure that made privacy-legal-02 a blocker.
  if [ -n "$RCLONE_REMOTE" ]; then
    log "ABORT: BACKUP_ALLOW_PLAINTEXT=1 with RCLONE_REMOTE set."
    log "       That would put a plaintext dump of every member registry on a third-party"
    log "       storage box, which is the exact exposure the DPA rules out. Configure"
    log "       BACKUP_AGE_RECIPIENT (preferred) or BACKUP_GPG_PASSPHRASE_FILE."
    exit 1
  fi
  log "WARN: artefacts are NOT encrypted (BACKUP_ALLOW_PLAINTEXT=1). The DPA says they are."
  degraded=1
fi
crypt_ext="$(backup_crypt_ext "$crypt_mode")"
crypt_key_id="$(backup_crypt_key_id "$crypt_mode")"
log "encryption: $crypt_mode (key $crypt_key_id)"
if ! backup_crypt_selftest "$crypt_mode"; then
  log "ABORT: encryption self-test failed — refusing to write archives nobody can open."
  exit 1
fi
if [ "$crypt_mode" != "none" ] && ! backup_crypt_can_decrypt "$crypt_mode"; then
  # This is the correct production posture for age, not a problem — but it must
  # be said out loud, because it means the only proof of decryptability is the
  # drill run with the real identity.
  log "note: this host cannot decrypt its own backups (the identity is held off-host)."
  log "      Encryption is proven; decryption is proven only by the quarterly drill."
fi

if [ -n "$RCLONE_REMOTE" ]; then
  offsite_have_rclone || { log "ABORT: RCLONE_REMOTE is set but rclone is not installed."; exit 1; }
  offsite_remote_is_safe "$RCLONE_REMOTE" || {
    log "ABORT: RCLONE_REMOTE=$RCLONE_REMOTE is not a safe backup target (see above)."
    exit 1
  }
fi

if [ -z "${STORAGE_DIR:-}" ]; then
  if ! STORAGE_DIR="$(storage_resolve_dir "$COMPOSE_PROJECT_NAME")"; then
    if [ "${BACKUP_ALLOW_NO_STORAGE:-0}" = "1" ]; then
      log "WARN: uploads directory unresolvable — DB-only backup (BACKUP_ALLOW_NO_STORAGE=1)"
      STORAGE_DIR=""
    else
      log "ABORT: cannot resolve the uploads directory (see above). Tenant uploads would be"
      log "       MISSING from this backup. Set STORAGE_DIR, or BACKUP_ALLOW_NO_STORAGE=1."
      exit 1
    fi
  fi
fi

if [ "${PREFLIGHT:-0}" = "1" ]; then
  log "preflight OK — encryption $crypt_mode, storage ${STORAGE_DIR:-<none>}, remote ${RCLONE_REMOTE:-<unset>}"
  log "               dead man's switch: textfile=$(obs_textfile_enabled && echo yes || echo no) heartbeat=$(obs_heartbeat_enabled && echo yes || echo no)"
  exit 0
fi

day="$(date +%Y%m%d)"
dest="$BACKUP_ROOT/$day"
mkdir -p "$dest"

dc() { docker compose -f "$COMPOSE_FILE" -p "$COMPOSE_PROJECT_NAME" "$@"; }

# ---------- 0. prune old local dailies --------------------------------------
log "pruning backups older than $BACKUP_KEEP_DAYS days under $BACKUP_ROOT"
find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d -mtime "+$BACKUP_KEEP_DAYS" \
  -print -exec rm -rf {} +

# ---------- 0.5 single-host guard (INFRA-1) --------------------------------
# pg_dumpall only sees databases on THIS Postgres instance. If a tenant has been
# relocated to another host (tenant-relocate.ts rewrites tenants.db_url), its DB
# is NOT in this dump — a silent, total data-loss exposure for that tenant.
# Local hosts are `postgres` (the in-container hostname baked into
# PG_SUPERUSER_URL), `pgbouncer`, `localhost`, `127.0.0.1`.
log "checking all tenant databases live on this host"
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
pg_artefact="$dest/postgres.sql.gz$crypt_ext"
log "dumping postgres (all databases) → $(basename "$pg_artefact")"
# `pg_dumpall` writes a single self-contained script — restoring is `psql -f`.
# It runs INSIDE the container, so no client is needed on the host and client/
# server version skew cannot occur for the nightly.
dc exec -T postgres \
  pg_dumpall -U libriant --clean --if-exists \
  | gzip -9 \
  | backup_crypt_encrypt "$crypt_mode" > "$pg_artefact"

dump_bytes=$(stat -c%s "$pg_artefact" 2>/dev/null || stat -f%z "$pg_artefact")
if [ "$dump_bytes" -lt 1024 ]; then
  log "ABORT: postgres dump suspiciously small ($dump_bytes bytes)"
  exit 1
fi
# Integrity, through the encryption. A disk-full or truncated write leaves a
# >1KB file that passes the size check and is unrestorable; a broken key leaves
# a file that is not even openable. One check now catches both, instead of the
# restore catching them at the worst possible moment.
if backup_crypt_can_decrypt "$crypt_mode"; then
  if ! backup_crypt_verify_gz "$crypt_mode" "$pg_artefact"; then
    log "ABORT: $(basename "$pg_artefact") did not decrypt to a valid gzip stream — discarding."
    rm -f "$pg_artefact"
    exit 1
  fi
  log "  verified: decrypts and the gzip stream is intact"
else
  # age with the identity off-host. Assert what is assertable: it is a real age
  # file, addressed to a recipient, and not the plaintext we started with.
  head -c 64 "$pg_artefact" | grep -aq 'age-encryption.org' || {
    log "ABORT: $(basename "$pg_artefact") does not look like an age archive."
    rm -f "$pg_artefact"; exit 1; }
fi
log "  postgres artefact $((dump_bytes / 1024)) KiB"

# ---------- 2. Storage (tenant uploads) ------------------------------------
# A missing uploads tree means every cover, logo and export is absent from this
# backup. That must NOT pass silently (DR-002).
if [ -z "${STORAGE_DIR:-}" ]; then
  log "WARN: DB-only backup — no uploads captured (BACKUP_ALLOW_NO_STORAGE=1)"
  degraded=1
elif [ ! -d "$STORAGE_DIR" ]; then
  if [ "${BACKUP_ALLOW_NO_STORAGE:-0}" = "1" ]; then
    log "WARN: storage dir not found ($STORAGE_DIR) — DB-only backup (BACKUP_ALLOW_NO_STORAGE=1)"
    degraded=1
  else
    log "ABORT: storage dir not found ($STORAGE_DIR). Tenant uploads would be MISSING."
    log "       Try: docker volume inspect ${COMPOSE_PROJECT_NAME}_storage"
    exit 1
  fi
else
  storage_artefact="$dest/storage.tar.gz$crypt_ext"
  log "tarring uploads from $STORAGE_DIR"
  if [ -z "$(ls -A "$STORAGE_DIR" 2>/dev/null)" ]; then
    log "  WARN: $STORAGE_DIR is EMPTY — the archive will contain no uploads."
    log "        If this host has tenants with covers or branding, STORAGE_DIR is wrong."
  fi
  storage_tar_stream "$STORAGE_DIR" | backup_crypt_encrypt "$crypt_mode" > "$storage_artefact"
  if backup_crypt_can_decrypt "$crypt_mode"; then
    backup_crypt_verify_gz "$crypt_mode" "$storage_artefact" || {
      log "ABORT: $(basename "$storage_artefact") failed the decrypt+gzip check — discarding."
      rm -f "$storage_artefact"; exit 1; }
  fi
  storage_bytes=$(stat -c%s "$storage_artefact" 2>/dev/null || stat -f%z "$storage_artefact")
  log "  uploads artefact $((storage_bytes / 1024 / 1024)) MiB"
fi

# ---------- 3. Caddy access log -------------------------------------------
# This one is encrypted for a specific reason, not for symmetry: the JSON access
# log records full request URIs, and password-reset and email-verification links
# carry their raw token in the query string. A plaintext copy of this file is a
# stack of live account-takeover tokens.
if [ -d "$CADDY_LOG_DIR" ]; then
  log "snapshotting caddy access log"
  tar -C "$CADDY_LOG_DIR" -czf - . 2>/dev/null \
    | backup_crypt_encrypt "$crypt_mode" > "$dest/caddy-logs.tar.gz$crypt_ext" \
    || log "  warning: caddy log snapshot failed"
fi

# ---------- 4. Manifest ----------------------------------------------------
# Deliberately NOT encrypted: it holds no personal data, and during a recovery
# you need to know which key opens the archives BEFORE you have the key.
# sha256 per artefact so the off-site copy can be verified independently of
# rclone, and so a silently-corrupted transfer is provable after the fact.
log "writing manifest"
{
  echo "host=$(hostname)"
  echo "completed_at=$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
  echo "image_tag=${IMAGE_TAG:-unknown}"
  echo "encryption=$crypt_mode"
  echo "encryption_key_id=$crypt_key_id"
  echo "storage_dir=${STORAGE_DIR:-<none>}"
  echo "keep_days=$BACKUP_KEEP_DAYS"
  printf 'files:\n'
  for f in "$dest"/*; do
    case "$f" in *"/manifest.txt") continue ;; esac
    [ -f "$f" ] || continue
    printf '  - %s (%s bytes) sha256=%s\n' \
      "$(basename "$f")" \
      "$(stat -c%s "$f" 2>/dev/null || stat -f%z "$f")" \
      "$(backup_crypt_sha256 < "$f")"
  done
} > "$dest/manifest.txt"

# ---------- 5. Off-site copy ------------------------------------------------
# Push → VERIFY → prune, in that order and never any other. Pruning before
# verifying is how one bad night plus one good prune becomes no backup at all.
if [ -n "$RCLONE_REMOTE" ]; then
  log "rclone copy → $RCLONE_REMOTE/$day"
  if ! offsite_push "$dest" "$RCLONE_REMOTE" "$day"; then
    log "ABORT: the off-site copy failed. The local backup in $dest is intact."
    exit 1
  fi
  log "verifying the off-site copy (size + presence, one-way)"
  if ! offsite_verify "$dest" "$RCLONE_REMOTE" "$day"; then
    log "ABORT: the off-site copy does not match the local one — NOT pruning the remote."
    exit 1
  fi
  offsite_ok=1
  log "  off-site copy verified"

  # privacy-legal-02: without this the remote grew forever, so an Art. 17
  # erasure or a tenant hard-delete never reached the backups while the privacy
  # notice said deleted copies age out after BACKUP_KEEP_DAYS. Logged in full,
  # because "we delete off-site copies on a rolling cycle" is a claim that has
  # to be evidenced to a supervisory authority.
  log "pruning the off-site copy older than $BACKUP_KEEP_DAYS days"
  pruning="$(offsite_prune_preview "$RCLONE_REMOTE" "$BACKUP_KEEP_DAYS")"
  if [ -n "$pruning" ]; then
    printf '%s\n' "$pruning" | while IFS= read -r f; do [ -n "$f" ] && log "  prune: $f"; done
  else
    log "  nothing older than $BACKUP_KEEP_DAYS days on the remote"
  fi
  offsite_prune "$RCLONE_REMOTE" "$BACKUP_KEEP_DAYS" || {
    log "WARN: the remote retention delete failed — off-site copies are NOT ageing out."
    degraded=1
  }
else
  if [ "${BACKUP_ALLOW_LOCAL_ONLY:-0}" = "1" ]; then
    log "WARN: RCLONE_REMOTE unset — backup is LOCAL-ONLY (acknowledged via BACKUP_ALLOW_LOCAL_ONLY=1)"
  else
    # launch-readiness-05. This used to be a WARN and exit 0. The offer terms a
    # municipal committee files say "daily backups and an off-server copy"; a
    # backup that lives only on the machine it protects is not that, and
    # reporting success for it is how the claim stayed false for months.
    log "FAIL: RCLONE_REMOTE is unset — THERE IS NO OFF-SERVER COPY."
    log "      This backup lives only on the host it is protecting. The offer terms"
    log "      promise an off-server copy, so this run is reported as FAILED."
    log "      Provision the remote and set RCLONE_REMOTE, or set BACKUP_ALLOW_LOCAL_ONLY=1"
    log "      to acknowledge — in writing, on this host — that the promise is not met."
    degraded=1
  fi
fi

# ---------- 6. Result -------------------------------------------------------
if [ "$degraded" != "0" ]; then
  log "DEGRADED: the artefacts in $dest are complete and usable, but see the FAIL/WARN above."
  exit 1
fi
log "done → $dest"
