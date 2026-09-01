#!/usr/bin/env bash
# Libriant — the server's voice on the operator's phone, over HOSTED ntfy.
#
# Sourced by the host scripts (backup, deploy, install) and mirrored by
# apps/api/src/platform/notify.service.ts, which is the same contract for the
# processes that run inside containers. One priority model, one redaction pass,
# one config block; see THE TABLE below.
#
# WHY HOSTED, AND NOT A CONTAINER IN OUR OWN COMPOSE FILE.
#
# Every other observability limb we have — Prometheus, node-exporter, the
# node-exporter textfile metric _lib/backup-observability.sh writes — lives on
# the box it observes. That is fine for "which query is slow" and useless for
# "the box is gone", which is the state an operator most needs to be told
# about. An ntfy service in infra/compose would have exactly the blind spot
# this file exists to close: it would die with the thing it is alerting about.
# So the publisher is ntfy.sh, run by somebody else, on hardware we do not own,
# and the only thing this file needs from our infrastructure is egress.
#
# *** THE TOPIC IS A CREDENTIAL. ***
#
# On ntfy.sh a topic is a bare string and there is no account check on it: ANY
# person who knows or guesses that string can read every message published to
# it, and publish to it themselves. It is a password that happens to be spelled
# like a channel name. Three consequences, all enforced below:
#
#   1. NTFY_TOPIC must be at least $_NOTIFY_TOPIC_MIN_LEN characters or this
#      library refuses to send at all. `libriant` and `libriant-prod` are the
#      first two strings anybody would try. Generate one with
#      `openssl rand -hex 16`. A token does NOT lift the floor: reserving a
#      topic on ntfy.sh is a paid feature, so on the tier this project uses,
#      obscurity is the entire access control.
#   2. The topic is never printed — not by a log line, not by --test, not by a
#      curl error. It travels in the JSON BODY rather than in the URL path
#      (see _notify_post) precisely so it cannot surface in `ps`, in a proxy
#      access log, or in curl's own diagnostics.
#   3. It is never written into a git-tracked file. .env.prod.example ships the
#      key BLANK and says how to fill it.
#
# *** A NOTIFICATION IS A DOORBELL, NOT A LETTER. ***
#
# It says WHAT happened and WHERE TO LOOK. It leaves the country to a
# third-party server, is retained there, is cached on a phone, and on a public
# topic is world-readable — so it is worse than a container log line in every
# privacy dimension, and the container log line already refuses to carry a
# person (see the comment above `notify()` in applications.service.ts).
# Institutions and towns yes; applicant names, e-mail addresses, phone numbers,
# member data, tenant row contents, tokens and anything out of .env.prod never.
# notify_redact below is the last line of defence when a caller forgets, not a
# licence to stop thinking at the call site.
#
# *** IT MUST NEVER BREAK THE THING IT REPORTS ON. ***
#
# notify_send always returns 0, runs its body in a `set +e` subshell so a
# failing command inside cannot trip the caller's `set -e`, and is bounded by
# _NOTIFY_TIMEOUT_SEC. If ntfy.sh is down, slow, rate-limiting, or the topic is
# wrong, the backup still completes and the deploy still deploys. The failure
# gets one line on stderr and nothing else.
#
# *** OFF BY DEFAULT. ***
#
# No NTFY_TOPIC means no sends, no errors and no log noise. Nothing in this
# repository becomes required because this file exists.
#
# USAGE
#   . "$HERE/_lib/notify.sh"
#   notify_send warn "Backup has no off-site copy" "RCLONE_REMOTE is unset."
#   notify_send error "Backup FAILED" "$(tail -c 400 "$RUNLOG")" "floppy_disk"
#
# VERIFY THE CHANNEL BEFORE RELYING ON IT (this file is runnable, not only
# sourceable — the installer calls it with no arguments to set up):
#   bash scripts/_lib/notify.sh --test
#   bash scripts/_lib/notify.sh --status     # config health, prints no secrets

# ---------- THE TABLE -------------------------------------------------------
#
# ntfy has five numeric priorities and the phone treats them differently. The
# operator asked for "errors, warnings, info", so those are the names; the
# numbers are an implementation detail nobody should have to remember at a call
# site.
#
#   level   ntfy  on the phone                              use it for
#   ------- ----  ----------------------------------------  ----------------------
#   debug     1   silent, no pop-up, sits in the history    step-by-step tracing
#   info      3   short vibration + sound, pops up          it worked / it finished
#   warn      4   long vibration + sound, pops up           look at this today
#   error     5   longest alert; CAN BE SET TO IGNORE        something is broken
#                 DO-NOT-DISTURB on Android                  now, or a person is
#                                                            waiting on us
#
# ntfy's level 2 ("low") is deliberately unused. On the handset it is
# indistinguishable from level 1 — both suppress sound and vibration — so a
# fourth name for it would be a distinction the operator cannot perceive and
# would only create arguments at call sites. Four levels, four behaviours.
#
# The discipline that matters is at level 5. It is the only one that can wake
# somebody at 03:00, so it is reserved for states where being woken is better
# than not: the backup failed, the disk is full, the API is down. A new
# application on the public form is a `warn` — the site promises an answer
# within two working days, not within two minutes, and an operator who gets
# woken for a form submission mutes the topic, which turns the whole channel
# off in the one way no code here can detect.
#
# THIS BLOCK IS THE CANONICAL COPY. notify.service.ts carries a compiled one,
# because the API container does not ship scripts/ and cannot read this file at
# runtime. notify.service.spec.ts parses the literal below off disk and fails
# the unit suite if the two ever disagree, so "a single table" is enforced by a
# gate rather than by hoping.
_NTFY_LEVELS='debug:1:mag
info:3:information_source
warn:4:warning
error:5:rotating_light'

# ---------- knobs -----------------------------------------------------------
# Single-digit seconds, on purpose. This runs inside a backup and a deploy; a
# notifier is allowed to be lost, never to be slow.
_NOTIFY_TIMEOUT_SEC="${NTFY_TIMEOUT_SEC:-5}"
_NOTIFY_CONNECT_TIMEOUT_SEC=3
# See "THE TOPIC IS A CREDENTIAL" above. 24 characters is `openssl rand -hex 12`
# and change; the documented recipe gives 32.
_NOTIFY_TOPIC_MIN_LEN=24
# ntfy.sh accepts 4096 bytes of message and 250 of title. These are CHARACTER
# counts, set low enough that even an all-Greek string — two bytes a character,
# four for an emoji — stays inside the byte caps without this file having to
# count bytes. And a doorbell that needs 4096 bytes is a letter: the operator
# reads it on a lock screen that shows four lines.
_NOTIFY_MAX_TITLE=100
_NOTIFY_MAX_BODY=900
# Where to look for NTFY_* when the caller has not already sourced .env.prod —
# so `bash scripts/_lib/notify.sh --test` works on a host with no ceremony.
_NOTIFY_ENV_FILE="${LIBRIANT_ENV_FILE:-/srv/libriant/.env.prod}"

# ---------- resolved state (set by notify_init) -----------------------------
_NOTIFY_READY=0   # 1 once notify_init has run
_NOTIFY_ON=0      # 1 when a usable topic is configured
_NOTIFY_SERVER=""
_NOTIFY_TOPIC=""
_NOTIFY_TOKEN=""
_NOTIFY_MIN_PRIO=3
_NOTIFY_PROBLEM="" # value-free explanation of why we are off, or ''

# An unrecognised level resolves to THIS one, and never to `info` or `error`: a
# typo at a call site must not quietly demote an alert into the history, and
# must not promote a routine line into the one priority that can override
# do-not-disturb. Mirrored by FALLBACK_LEVEL in notify.service.ts.
_NTFY_FALLBACK_LEVEL=warn

# Priority number for a level name.
notify_priority() {
  local want="${1:-}" line
  while IFS= read -r line; do
    case "$line" in
      "${want}:"*)
        line="${line#*:}"
        printf '%s' "${line%%:*}"
        return 0
        ;;
    esac
  done <<EOF
$_NTFY_LEVELS
EOF
  # The fallback's priority is read back out of the SAME table rather than
  # written here as a literal, so editing the table cannot leave a stale number
  # behind in the one path nobody tests by hand. The guard is for the case
  # where the table has lost its fallback row entirely — without it that is an
  # infinite recursion inside a notifier, which is a far worse failure than the
  # missing level it would be reporting.
  if [ "$want" = "$_NTFY_FALLBACK_LEVEL" ]; then
    printf '4'
    return 0
  fi
  notify_priority "$_NTFY_FALLBACK_LEVEL"
}

# Emoji shortcode ntfy renders for a level, so the phone is readable at a
# glance without opening the notification.
notify_level_tag() {
  local want="${1:-}" line
  while IFS= read -r line; do
    case "$line" in
      "${want}:"*)
        printf '%s' "${line##*:}"
        return 0
        ;;
    esac
  done <<EOF
$_NTFY_LEVELS
EOF
  if [ "$want" = "$_NTFY_FALLBACK_LEVEL" ]; then
    printf 'warning'
    return 0
  fi
  notify_level_tag "$_NTFY_FALLBACK_LEVEL"
}

# ---------- redaction -------------------------------------------------------
#
# Runs on EVERY outgoing title and body, after the caller has composed them.
# It is a backstop, and it is deliberately greedy: over-redacting a doorbell
# costs an operator one extra `ssh`, under-redacting it puts a member's e-mail
# address on a third-party server in another country, permanently, where a
# stranger who guessed the topic can read it.
#
# The order is load bearing. Connection strings go first, because
# `postgresql://libriant:hunter2@db.example.com/x` contains something the
# e-mail rule would otherwise match and rewrite into a shape that hides the
# credential from the later rules.
#
# What it strips, and why each one:
#   1. control characters       — JSON safety, and a newline in a title used to
#                                 be an HTTP header injection (see _notify_post
#                                 for why we no longer put the title in a
#                                 header at all)
#   2. scheme://user:pass@host  — every DATABASE_URL, REDIS_URL, SMTP_URL and
#                                 rclone remote in .env.prod has this shape
#   3. JWTs                     — session, admin, impersonation and the signed
#                                 storage-download tokens are all `eyJ…`
#   4. prefixed provider keys   — sk_live_/whsec_/re_/tk_/ghp_/github_pat_/xox…
#   5. NAME=value where NAME    — catches anything the four rules above miss
#      smells of a secret          purely because we have not met it yet
#   6. 32+ hex characters       — every secret ensure-env.sh mints is
#                                 `openssl rand -hex 32`, i.e. 64 of these
#   7. 40+ token-ish characters — the general shape of a bearer credential
#   8. e-mail addresses         — the single most likely personal datum to be
#                                 pasted into an alert by accident
#   9. IPv4 / IPv6              — an IP address is personal data; it is why the
#                                 application form hashes it with a secret
#                                 pepper instead of storing it
#  10. +NN international phones — the applicant's phone number, which the form
#                                 collects and this channel must never carry
#
# KNOWN LIMITS, stated rather than papered over. A BARE ten-digit Greek mobile
# (`6941234567`) is not redacted, because at that shape it is indistinguishable
# from a byte count or a row id and redacting every long digit run would gut
# every useful metric. A person's NAME is not redacted and cannot be — there is
# no regex for "Μαρία Παπαδοπούλου". Those two are why the rule at the call
# site is "never put a person in a notification" and this function is only the
# net under it.
#
# `sed -E` and no `\b`: GNU sed understands the word-boundary escape and the
# BSD sed on a developer's Mac does not, and a redaction rule that silently
# stops matching on one of the two machines is worse than one that never
# existed. Dropping the boundaries makes every rule slightly greedier, which is
# the safe direction.
notify_redact() {
  # Everything below 0x20 EXCEPT the newline becomes a space, and so does DEL.
  # Not `tr -d`: a raw tab or carriage return inside a JSON string is invalid
  # JSON — ntfy would answer 400 and the notification would be lost — and
  # deleting a tab outright would run two words together. The newline is the
  # one control character kept, because a body legitimately has lines;
  # _notify_json escapes it to `\n` a moment later.
  printf '%s' "${1:-}" \
    | tr '\000-\011\013\015-\037\177' ' ' \
    | sed -E \
      -e 's#([A-Za-z][A-Za-z0-9+.-]*)://[^[:space:]/@]*(:[^[:space:]/@]*)?@#\1://[redacted]@#g' \
      -e 's#eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}(\.[A-Za-z0-9_-]+)?#[redacted-token]#g' \
      -e 's#(sk|pk|rk)_(live|test)_[A-Za-z0-9]{6,}#[redacted-token]#g' \
      -e 's#(whsec|tk|re)_[A-Za-z0-9_-]{8,}#[redacted-token]#g' \
      -e 's#(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})#[redacted-token]#g' \
      -e 's#xox[baprs]-[A-Za-z0-9-]{8,}#[redacted-token]#g' \
      -e 's#([A-Za-z0-9_.-]*([Pp][Aa][Ss][Ss][Ww]?[Oo]?[Rr]?[Dd]|[Ss][Ee][Cc][Rr][Ee][Tt]|[Tt][Oo][Kk][Ee][Nn]|[Aa][Pp][Ii][_-]?[Kk][Ee][Yy]|[Aa][Pp][Ii][Kk][Ee][Yy]|[Pp][Ee][Pp][Pp][Ee][Rr]|[Cc][Rr][Ee][Dd][Ee][Nn][Tt][Ii][Aa][Ll]|[Aa][Uu][Tt][Hh])[A-Za-z0-9_.-]*)[[:space:]]*[=:][[:space:]]*[^[:space:],;]+#\1=[redacted]#g' \
      -e 's#[0-9a-fA-F]{32,}#[redacted-hex]#g' \
      -e 's#[A-Za-z0-9_+-]{40,}#[redacted]#g' \
      -e 's#[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}#[email]#g' \
      -e 's#[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}#[ip]#g' \
      -e 's#([0-9a-fA-F]{1,4}:){3,7}[0-9a-fA-F]{0,4}#[ip]#g' \
      -e 's#\+[0-9][0-9 ().-]{6,}[0-9]#[phone]#g' \
    || printf '[redaction failed]'
}

# Collapse to one line where one line is required, and cut to length with a
# marker so a truncated body never reads as a complete one.
#
# Bash's own `${#s}` and `${s:0:n}` rather than `cut -c`, which counts BYTES in
# GNU coreutils and characters on BSD — a rule that truncates differently on
# the developer's Mac and the Ubuntu host is a rule nobody can reason about.
# Bash counts characters under a UTF-8 locale and bytes under the C locale a
# bare cron gets; in the second case a truncated Greek body can lose its last
# character to an incomplete sequence, which Go's JSON decoder on the ntfy side
# renders as one replacement character. A doorbell that is one glyph short is
# still a doorbell, and the alternative is byte-counting arithmetic in shell.
_notify_clip() {
  local text="${1:-}" max="${2:-}" oneline="${3:-}"
  [ "$oneline" = "oneline" ] && text="$(printf '%s' "$text" | tr '\n' ' ')"
  [ "${#text}" -gt "$max" ] && text="${text:0:$((max - 1))}…"
  printf '%s' "$text"
}

# JSON string escaping. Only three cases survive notify_redact's control-char
# strip: backslash, double quote, and the newlines we deliberately keep in a
# body. Backslash MUST be first or it doubles the escapes the quote rule adds.
#
# Bash substitution rather than sed, because the idiomatic sed line-joiner
# (`sed -e :a -e N -e '$!ba' -e 's/\n/\\n/g'`) SILENTLY RETURNS AN EMPTY STRING
# on the BSD sed shipped with macOS — measured, not assumed. Every field of the
# notification went through this function, so on a developer's machine the
# whole document came out as `{"topic":"","title":"", …}` and ntfy would have
# been asked to publish to the empty topic. A shell builtin has no such
# dialect, needs no subprocess, and cannot be affected by the locale.
_notify_json() {
  local s="${1:-}"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="${s//$'\n'/\\n}"
  printf '%s' "$s"
}

# ---------- config ----------------------------------------------------------

# One NTFY_* value out of .env.prod, quotes stripped (ensure-env.sh's
# `set_quoted` writes KEY='value'). Never echoed by anything that logs.
_notify_env_get() {
  local key="${1:?}" file="${2:?}" val=""
  val="$(sed -n "s/^${key}=//p" "$file" 2>/dev/null | head -n1)" || val=""
  case "$val" in
    \'*\') val="${val#\'}"; val="${val%\'}" ;;
    \"*\") val="${val#\"}"; val="${val%\"}" ;;
  esac
  printf '%s' "$val"
}

# Resolve NTFY_* into the _NOTIFY_* state above. Idempotent; notify_send calls
# it for you. Re-run it after changing the environment with `notify_init force`.
notify_init() {
  [ "${1:-}" = "force" ] && _NOTIFY_READY=0
  [ "$_NOTIFY_READY" = "1" ] && return 0
  _NOTIFY_READY=1
  _NOTIFY_ON=0
  _NOTIFY_PROBLEM=""

  local server topic token minlevel
  server="${NTFY_SERVER:-}"
  topic="${NTFY_TOPIC:-}"
  token="${NTFY_TOKEN:-}"
  minlevel="${NTFY_MIN_LEVEL:-}"

  # Fall back to the host's env file so an operator (and the installer) can run
  # --test without `set -a; source /srv/libriant/.env.prod` first. Only the four
  # NTFY_ keys are read; sourcing the whole file here would drag POSTGRES_PASSWORD
  # and every secret in it into this shell as a side effect of asking whether
  # notifications are on.
  if [ -z "$topic" ] && [ -r "$_NOTIFY_ENV_FILE" ]; then
    topic="$(_notify_env_get NTFY_TOPIC "$_NOTIFY_ENV_FILE")"
    [ -n "$server" ] || server="$(_notify_env_get NTFY_SERVER "$_NOTIFY_ENV_FILE")"
    [ -n "$token" ] || token="$(_notify_env_get NTFY_TOKEN "$_NOTIFY_ENV_FILE")"
    [ -n "$minlevel" ] || minlevel="$(_notify_env_get NTFY_MIN_LEVEL "$_NOTIFY_ENV_FILE")"
  fi

  _NOTIFY_SERVER="${server:-https://ntfy.sh}"
  # A trailing slash turns the publish URL into `https://ntfy.sh//`, which ntfy
  # answers with a 404 that reads exactly like a wrong topic — the same defect
  # _lib/backup-observability.sh already carries a comment about.
  while :; do
    case "$_NOTIFY_SERVER" in
      */) _NOTIFY_SERVER="${_NOTIFY_SERVER%/}" ;;
      *) break ;;
    esac
  done

  _NOTIFY_MIN_PRIO=3
  if [ -n "$minlevel" ]; then
    case "$minlevel" in
      debug | info | warn | error) _NOTIFY_MIN_PRIO="$(notify_priority "$minlevel")" ;;
      *) _NOTIFY_PROBLEM="NTFY_MIN_LEVEL is not one of debug|info|warn|error; using info" ;;
    esac
  fi

  # Off by default, and silently: a host that never configured this is not
  # misconfigured, so it gets no problem string and nothing to log.
  if [ -z "$topic" ]; then
    # …unless they configured HALF of it, which is an operator who tried and
    # would otherwise wait forever for a notification that can never be sent.
    [ -n "$token" ] && _NOTIFY_PROBLEM="NTFY_TOKEN is set but NTFY_TOPIC is empty — notifications are OFF"
    return 0
  fi

  # A topic travels in a URL path on every other ntfy client, is a filename in
  # ntfy's own cache, and is pasted into a phone by hand. Anything outside
  # ntfy's own character class is a bug that would surface as an unexplained
  # 404 much later.
  case "$topic" in
    *[!A-Za-z0-9_-]*)
      _NOTIFY_PROBLEM="NTFY_TOPIC contains characters ntfy does not accept (allowed: A-Z a-z 0-9 _ -) — notifications are OFF"
      return 0
      ;;
  esac
  if [ "${#topic}" -lt "$_NOTIFY_TOPIC_MIN_LEN" ]; then
    _NOTIFY_PROBLEM="NTFY_TOPIC is shorter than ${_NOTIFY_TOPIC_MIN_LEN} characters — refusing to use it. On ntfy.sh anyone who guesses the topic reads every message on it, so a short one is a public feed. Generate a real one with: openssl rand -hex 16"
    return 0
  fi
  # The token reaches curl through a --config file rather than argv (see
  # _notify_post). curl's config parser has its own quoting rules, so a value
  # containing a quote or a newline could break out of the header line it is
  # written into. Real ntfy tokens are `tk_` + alphanumerics; anything else is
  # refused rather than escaped.
  case "$token" in
    *[!A-Za-z0-9_-]*)
      _NOTIFY_PROBLEM="NTFY_TOKEN contains characters an ntfy access token cannot contain — ignoring it and sending unauthenticated"
      token=""
      ;;
  esac

  _NOTIFY_TOPIC="$topic"
  _NOTIFY_TOKEN="$token"
  _NOTIFY_ON=1
  return 0
}

# True when a usable topic is configured. Safe in an `if`.
notify_enabled() {
  notify_init
  [ "$_NOTIFY_ON" = "1" ]
}

# ---------- sending ---------------------------------------------------------

# POST one already-built JSON document.
#
# THE PUBLISH SHAPE, because it is not the obvious one. ntfy's headline API is
# `curl -H "Title: …" -H "Priority: 4" -d "body" https://ntfy.sh/<topic>`, and
# we use none of it:
#
#   * The TOPIC would be in the URL. A URL reaches `ps` (curl's argv), any
#     proxy's access log, and curl's own error text. The topic is a credential,
#     so it goes in the body, where none of those three can see it.
#   * The TITLE would be an HTTP header. Header values are ASCII; a Greek
#     library's name — which is most of them — comes out mangled at best, and
#     ntfy documents RFC 2047 encoding as the workaround. A JSON body is UTF-8
#     and needs no workaround.
#   * A newline in a header value is request splitting. In the JSON body it is
#     an escaped `\n` and nothing more.
#
#   * The TOKEN goes in a --config file, mode 600, not in `-H`. Everything in
#     argv is world-readable in `ps` on a shared host, and an ntfy access token
#     is a publish credential for the topic.
_notify_post() {
  local json="${1:?}" dir rc=0 out=""
  command -v curl >/dev/null 2>&1 || {
    printf 'ntfy: curl is not installed — notification dropped.\n' >&2
    return 1
  }
  dir="$(mktemp -d "${TMPDIR:-/tmp}/libriant-ntfy.XXXXXX")" || return 1
  # mktemp -d already gives 0700, so the two files below are unreachable by
  # anyone but this user whatever the umask is.
  printf '%s' "$json" > "$dir/body" || { rm -rf "$dir"; return 1; }
  # `if` rather than `[ -n … ] && printf …`: with no token the `&&` short-
  # circuits, that test becomes the LAST command of the group, and the group's
  # exit status is then 1 — which took the `|| return 1` below and aborted the
  # send before curl ever ran. Every unauthenticated send silently did nothing,
  # and because it returned before the reporting code, it did so without a
  # single line on stderr. Measured against the stub: zero requests arrived.
  {
    printf 'header = "Content-Type: application/json"\n'
    if [ -n "$_NOTIFY_TOKEN" ]; then
      printf 'header = "Authorization: Bearer %s"\n' "$_NOTIFY_TOKEN"
    fi
  } > "$dir/cfg" || { rm -rf "$dir"; return 1; }

  # `--fail-with-body` is deliberately NOT used: it is curl >= 7.76 and the
  # status code is what we want to report anyway. -w prints it, -o discards the
  # response, and every message curl writes goes to stderr where our caller's
  # log can catch it.
  out="$(curl -sS \
    --config "$dir/cfg" \
    --data-binary "@$dir/body" \
    --connect-timeout "$_NOTIFY_CONNECT_TIMEOUT_SEC" \
    --max-time "$_NOTIFY_TIMEOUT_SEC" \
    -o /dev/null \
    -w '%{http_code}' \
    "$_NOTIFY_SERVER/" 2>&1)" || rc=$?
  rm -rf "$dir"
  # -w writes the status onto the same stream as curl's diagnostics, so a
  # failed transfer arrives as two lines ("curl: (28) …" then "000"). One log
  # line per failed send is the contract; fold it.
  out="$(printf '%s' "$out" | tr '\n' ' ')"

  if [ "$rc" != "0" ]; then
    # curl's exit code is the diagnosis: 6 DNS, 7 refused, 28 timeout, 35 TLS.
    # The URL is the bare server and carries no topic, so quoting curl's own
    # message back leaks nothing.
    printf 'ntfy: send failed (curl exit %s): %s\n' "$rc" "$out" >&2
    return 1
  fi
  case "$out" in
    2*) return 0 ;;
    429)
      printf 'ntfy: send rejected 429 — rate limited by the server. Notification dropped; the run is unaffected.\n' >&2
      return 1
      ;;
    401 | 403)
      printf 'ntfy: send rejected %s — the topic is protected and NTFY_TOKEN is missing or wrong.\n' "$out" >&2
      return 1
      ;;
    *)
      printf 'ntfy: send rejected with HTTP %s.\n' "$out" >&2
      return 1
      ;;
  esac
}

# Build the JSON document for one notification. Split out so --test and
# notify_send cannot compose it differently.
_notify_body_json() {
  local level="${1:?}" title="${2:-}" body="${3:-}" extra_tags="${4:-}"
  local prio tag tags_json t

  prio="$(notify_priority "$level")"
  tag="$(notify_level_tag "$level")"
  title="$(_notify_clip "$(notify_redact "$title")" "$_NOTIFY_MAX_TITLE" oneline)"
  body="$(_notify_clip "$(notify_redact "$body")" "$_NOTIFY_MAX_BODY")"

  tags_json="\"$(_notify_json "$tag")\""
  if [ -n "$extra_tags" ]; then
    local IFS=','
    for t in $extra_tags; do
      [ -n "$t" ] || continue
      tags_json="${tags_json},\"$(_notify_json "$t")\""
    done
  fi

  printf '{"topic":"%s","priority":%s,"tags":[%s],"title":"%s","message":"%s"}' \
    "$(_notify_json "$_NOTIFY_TOPIC")" "$prio" "$tags_json" \
    "$(_notify_json "$title")" "$(_notify_json "$body")"
}

# notify_send LEVEL TITLE BODY [comma,separated,extra,tags]
#
# ALWAYS returns 0. The body runs in a `set +e` subshell so that no command
# inside can trip a caller's `set -euo pipefail`, and the outer `|| :` catches
# the subshell's own status. This is the whole point: a notification about a
# backup must not be able to fail the backup.
notify_send() {
  local level="${1:-info}" title="${2:-}" body="${3:-}" tags="${4:-}"
  (
    set +e
    notify_init
    [ "$_NOTIFY_ON" = "1" ] || exit 0
    [ "$(notify_priority "$level")" -ge "$_NOTIFY_MIN_PRIO" ] || exit 0
    _notify_post "$(_notify_body_json "$level" "$title" "$body" "$tags")"
  ) || :
  return 0
}

# ---------- operator-facing verification ------------------------------------

# What is configured, with no value ever printed. Exit 0 when a send would be
# attempted, 1 when it would not.
notify_status() {
  notify_init
  if [ "$_NOTIFY_ON" = "1" ]; then
    printf 'ntfy: ON — server %s, topic configured (%s characters, not shown), token %s, floor %s.\n' \
      "$_NOTIFY_SERVER" "${#_NOTIFY_TOPIC}" \
      "$([ -n "$_NOTIFY_TOKEN" ] && printf 'set' || printf 'not set')" \
      "$_NOTIFY_MIN_PRIO"
    [ -n "$_NOTIFY_PROBLEM" ] && printf 'ntfy: %s\n' "$_NOTIFY_PROBLEM" >&2
    return 0
  fi
  if [ -n "$_NOTIFY_PROBLEM" ]; then
    printf 'ntfy: OFF — %s\n' "$_NOTIFY_PROBLEM" >&2
  else
    printf 'ntfy: OFF — NTFY_TOPIC is not set. Nothing is sent and nothing is broken.\n'
  fi
  return 1
}

# Prove the channel end to end, before anybody relies on it.
#
# The ONE place in this file that reports failure through its exit status. A
# test whose failure is swallowed is not a test, and this is what the installer
# runs to turn "I configured ntfy" into "I watched my phone light up".
notify_test() {
  notify_init
  notify_status || return 1
  printf 'ntfy: sending a test notification …\n'
  if _notify_post "$(_notify_body_json warn \
    "Libriant test notification" \
    "If this is on your phone, the channel works. Sent by $(hostname 2>/dev/null || printf 'this server') at $(date -u +'%Y-%m-%dT%H:%M:%SZ'). Nothing is wrong." \
    "white_check_mark")"; then
    printf 'ntfy: accepted by the server. CHECK YOUR PHONE — the server accepting it is not the same as the handset showing it (a muted topic, a revoked notification permission or a phone with no data will all still look like this).\n'
    return 0
  fi
  printf 'ntfy: the test notification was NOT accepted. See the line above.\n' >&2
  return 1
}

# Runnable as well as sourceable, so the installer has one command to call and
# no new file to learn. `${BASH_SOURCE[0]:-}` is guarded for `set -u`.
if [ "${BASH_SOURCE[0]:-}" = "${0:-}" ]; then
  case "${1:---test}" in
    --test) notify_test ;;
    --status) notify_status ;;
    --send)
      shift
      notify_send "${1:-info}" "${2:-Libriant}" "${3:-}" "${4:-}"
      ;;
    *)
      printf 'usage: notify.sh [--test|--status|--send LEVEL TITLE BODY [TAGS]]\n' >&2
      exit 2
      ;;
  esac
fi
