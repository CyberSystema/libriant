#!/usr/bin/env bash
# Libriant — making a backup's absence visible. Shared by backup.sh and
# dr-drill.sh; do not inline a copy.
#
# WHY THIS EXISTS (audit reliability-09, high; reliability-04, high).
#
# backup.sh aborts on six distinct conditions and every one of them wrote to
# stdout, which the documented cron redirects into /var/log/libriant/backup.log.
# The only active notification was BACKUP_HEARTBEAT_URL, which was optional,
# unset, absent from .env.prod.example — and pinged ONLY on success, at the very
# end. So the three states that matter were all silent:
#
#   * the cron was never installed          → nothing ever ran, nothing ever said so
#   * the run aborts every night            → six exits, zero notifications
#   * the run succeeds but has no off-site  → a WARN line in a log file
#
# The fix has to detect a backup that did NOT happen, which a failure
# notification structurally cannot do. Two independent channels, because each
# covers the other's blind spot:
#
#   1. A node-exporter TEXTFILE metric. Prometheus alerts on
#      `absent(libriant_backup_last_success_timestamp_seconds)` — which fires on
#      a host that has never taken a backup at all, the fresh-deploy case — and
#      on `time() - last_success > 26h`. No third-party account needed, and it
#      keeps working when the network to the outside world is down.
#      Blind spot: it needs Prometheus to be up, on this host.
#
#   2. An external heartbeat (BACKUP_HEARTBEAT_URL, e.g. healthchecks.io):
#      /start at the top, the base URL on success, /fail from the exit trap with
#      the tail of the log as the body. Blind spot: it is a third party, and it
#      needs egress. Strength: it is the only one that still speaks when the
#      whole machine is gone.
#
# backup.sh requires AT LEAST ONE of the two to be usable. A host with neither
# is a host where a stopped backup is undetectable, and that is not a
# configuration this product may ship in.

_OBS_TEXTFILE_DIR=""
_OBS_TEXTFILE=""
_OBS_BUF=""
_OBS_PREV=""
_OBS_HEARTBEAT=""

# $1 textfile directory ('' to disable)   $2 heartbeat base URL ('' to disable)
obs_init() {
  _OBS_TEXTFILE_DIR="${1:-}"
  _OBS_HEARTBEAT="${2:-}"
  _OBS_BUF=""
  _OBS_PREV=""
  # Trailing slashes turn "$url/fail" into "$url//fail", which healthchecks.io
  # answers with a 404 that curl -f reports as a failed ping — a broken alarm
  # that looks like a broken backup.
  while [ -n "$_OBS_HEARTBEAT" ]; do
    case "$_OBS_HEARTBEAT" in
      */) _OBS_HEARTBEAT="${_OBS_HEARTBEAT%/}" ;;
      *) break ;;
    esac
  done

  if [ -n "$_OBS_TEXTFILE_DIR" ]; then
    mkdir -p "$_OBS_TEXTFILE_DIR" 2>/dev/null || true
    if [ -d "$_OBS_TEXTFILE_DIR" ] && [ -w "$_OBS_TEXTFILE_DIR" ]; then
      _OBS_TEXTFILE="$_OBS_TEXTFILE_DIR/libriant_backup.prom"
      # Carry the previous run's values forward. On a FAILED run the last
      # successful timestamp must keep its old value so `time() - last_success`
      # goes on growing; zeroing it would make a permanently-failing backup look
      # like one that succeeded at the epoch.
      [ -f "$_OBS_TEXTFILE" ] && _OBS_PREV="$(cat "$_OBS_TEXTFILE" 2>/dev/null || true)"
    else
      _OBS_TEXTFILE=""
    fi
  fi
}

obs_textfile_enabled() { [ -n "$_OBS_TEXTFILE" ]; }
obs_heartbeat_enabled() { [ -n "$_OBS_HEARTBEAT" ]; }
obs_textfile_path() { printf '%s\n' "$_OBS_TEXTFILE"; }

# Previous value of a metric line, or '' — used to carry values across a run
# that failed before it could compute a new one.
obs_prev() {
  local name="${1:?obs_prev: metric name required}"
  printf '%s\n' "$_OBS_PREV" | awk -v n="$name" '$1 == n { print $2; exit }'
}

# obs_set <name> <value> <help text>
obs_set() {
  local name="${1:?}" value="${2:?}" help="${3:-Libriant backup metric.}"
  _OBS_BUF="${_OBS_BUF}# HELP ${name} ${help}
# TYPE ${name} gauge
${name} ${value}
"
}

# obs_set_labelled <name> <labels> <value> <help>
obs_set_labelled() {
  local name="${1:?}" labels="${2:?}" value="${3:?}" help="${4:-Libriant backup metric.}"
  # HELP/TYPE may appear only once per metric name in a textfile, so the caller
  # passes '' as help for the second and later label sets.
  if [ -n "${4:-}" ]; then
    _OBS_BUF="${_OBS_BUF}# HELP ${name} ${help}
# TYPE ${name} gauge
"
  fi
  _OBS_BUF="${_OBS_BUF}${name}{${labels}} ${value}
"
}

# Write the collected metrics atomically. node-exporter reads this directory on
# every scrape; a half-written file is a parse error that takes the whole
# textfile collector down (node_textfile_scrape_error 1), which would replace a
# missing-backup alert with a missing-metric one.
obs_flush() {
  obs_textfile_enabled || return 0
  local tmp="${_OBS_TEXTFILE}.$$.tmp"
  printf '%s' "$_OBS_BUF" > "$tmp" || return 1
  chmod 0644 "$tmp" 2>/dev/null || true
  mv -f "$tmp" "$_OBS_TEXTFILE"
}

# obs_heartbeat <start|success|fail> [body-file]
# Never fatal: a heartbeat provider having a bad day must not fail a backup that
# actually worked. It is logged, and the textfile metric covers the same ground.
obs_heartbeat() {
  local kind="${1:?}" body="${2:-}" url
  obs_heartbeat_enabled || return 0
  command -v curl >/dev/null 2>&1 || return 0
  case "$kind" in
    start) url="$_OBS_HEARTBEAT/start" ;;
    fail) url="$_OBS_HEARTBEAT/fail" ;;
    success) url="$_OBS_HEARTBEAT" ;;
    *) return 1 ;;
  esac
  if [ -n "$body" ] && [ -f "$body" ]; then
    # healthchecks.io keeps up to 10 KiB of body per ping. The tail of the log
    # is what turns "the backup failed" into "the backup failed because the
    # storage dir moved", without an SSH session at 03:00.
    tail -c 9000 "$body" 2>/dev/null | curl -fsS -m 10 --data-binary @- "$url" >/dev/null 2>&1 \
      || return 1
  else
    curl -fsS -m 10 "$url" >/dev/null 2>&1 || return 1
  fi
  return 0
}
