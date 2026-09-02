#!/usr/bin/env bash
# Deploy Libriant from the server itself, without GitHub Actions.
#
# This is the same sequence .github/workflows/deploy.yml runs remotely, with one
# deliberate difference: it BUILDS the images here instead of pulling them from
# GHCR, because nothing is publishing to GHCR while deploys are manual. Keeping
# the rest identical is the point — manual and CI deploys must not drift.
#
#   ssh deploy@195.201.13.95
#   cd /srv/libriant/app && bash scripts/deploy-on-host.sh
#
# Options:
#   --ref <git-ref>   what to deploy (default: origin/main)
#   --no-fetch        deploy the working tree as-is, skip git fetch/reset
#   --skip-build      reuse the images already on the box
#   --dry-run         print what would happen and stop
#   --notify-test     send one test push to the configured ntfy topic and stop
#
# THIS SCRIPT PUSHES ITS RESULT TO A PHONE, if NTFY_TOPIC is set in .env.prod.
# It runs for 10-20 minutes and the runbook tells the operator to start it under
# tmux and walk away, so "it finished, and how it finished" is exactly the thing
# they cannot get any other way. It also cannot become noise: a deploy is a
# deliberate act, so the ceiling on this channel is the number of times a human
# typed the command. Unset topic = no push and no error; see notify() below.
#
# Prerequisites, all created by the first-run bootstrap (see
# docs/RUNBOOK.md): docker, /srv/libriant/app (this checkout),
# /srv/libriant/.env.prod, and /mnt/libriant for data.
set -euo pipefail

APP_DIR="${APP_DIR:-/srv/libriant/app}"
ENV_FILE="${ENV_FILE:-/srv/libriant/.env.prod}"
DATA_ROOT="${LIBRIANT_DATA_ROOT:-/mnt/libriant}"
REF="origin/main"
FETCH=1
BUILD=1
DRY=0
NOTIFY_TEST=0

while [ $# -gt 0 ]; do
  case "$1" in
    --ref) REF="$2"; shift 2 ;;
    --no-fetch) FETCH=0; shift ;;
    --skip-build) BUILD=0; shift ;;
    --dry-run) DRY=1; shift ;;
    --notify-test) NOTIFY_TEST=1; shift ;;
    -h|--help) sed -n '2,28p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

say() { printf '\n\033[1m▸ %s\033[0m\n' "$*"; }
die() { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

# ════════════════════════════════════════════════════════════════════════════
# ntfy — the owner's phone.
#
# The publisher, the priority table, the redaction pass and the config block all
# live in scripts/_lib/notify.sh, which is also what the API container mirrors.
# One implementation, so a rule tightened in one place cannot stay loose in the
# other. Everything this script adds is policy: WHEN a deploy is worth a push
# and WHAT it is allowed to say.
#
# WHY A DEPLOY PUSHES AT ALL, and why it cannot become noise: this runs for
# 10-20 minutes and the runbook tells the operator to start it under tmux and
# walk away. The ceiling on this channel is therefore the number of times a
# human typed the command.
#
# LIBRIANT_ENV_FILE is exported first because notify.sh falls back to reading
# the NTFY_* keys straight out of the env file when the caller has not sourced
# it — and this script does not source it until a hundred lines below, AFTER the
# preflight checks (a missing origin certificate, an unmounted data root) that
# are the likeliest way it dies. Without this, exactly the failures worth being
# told about would be the ones that never reached the phone.
export LIBRIANT_ENV_FILE="$ENV_FILE"
# shellcheck source=_lib/notify.sh
. "$(dirname "$0")/_lib/notify.sh"

# notify LEVEL TITLE BODY [tags] — a thin wrapper for one reason only: --dry-run
# must print what it would send instead of sending it. notify_send itself always
# returns 0 and swallows every failure, which is the contract that keeps a push
# from ever failing a deploy.
notify() {
  if [ "$DRY" = 1 ]; then printf '  would push [%s]: %s — %s\n' "$1" "$2" "$3"; return 0; fi
  notify_send "$@"
}

# The URL Alertmanager posts to. Built here rather than in notify.sh because
# Alertmanager is not our client and cannot use our shape.
#
# THE DIVERGENCE, STATED. notify.sh deliberately puts the topic in the JSON BODY
# so it never reaches `ps`, a proxy log or a curl error. Alertmanager POSTs its
# OWN envelope and has no body template, so the topic has to go back into the
# URL path — which is why this string is written to a mode-600 file inside a
# Docker volume, piped on stdin, and never passed as an argument to anything.
#
# WHAT ARRIVES, HONESTLY. ntfy takes the request body verbatim as the message
# text, and Alertmanager's body is `{"receiver":…,"status":…,"alerts":[…]}`. So
# the phone shows raw JSON with the alert name about ninety bytes in — past the
# one-line preview, inside the expanded notification. Making it readable needs a
# reshaping proxy between the two: one more service, on the same box, inside the
# alerting path, able to fail on its own. Not worth it for a doorbell.
#
# The query string is the cheap half: `title`, `priority` and `tags` are ntfy's
# documented query aliases for the X-Title / X-Priority / X-Tags headers, so the
# notification gets a readable heading even though its body is JSON. Nothing
# depends on them — a server that ignores them still delivers the message,
# untitled. `%%20` and not `+`, because only one of the two is unambiguous in a
# path-adjacent query string.
ntfy_alert_url() {
  local server="${NTFY_SERVER:-https://ntfy.sh}"
  notify_enabled || return 1
  [ -n "${NTFY_TOPIC:-}" ] || return 1
  while :; do
    case "$server" in */) server="${server%/}" ;; *) break ;; esac
  done
  printf '%s/%s?title=Libriant%%20alert&priority=high&tags=rotating_light' "$server" "$NTFY_TOPIC"
}

if [ "$NOTIFY_TEST" = 1 ]; then
  # notify.sh --test is the canonical prover and reports through its exit
  # status. This flag exists on top of it because it runs from THIS script's
  # environment and on this box's checkout, which is what actually deploys, and
  # because the two things below are true only here.
  say "Proving the notification channel"
  notify_test || die "the test notification was not accepted — see the line above.
     The deploy is unaffected by this either way: every push is best-effort."
  echo
  echo "  A real deploy sends exactly one of these, at the end:"
  echo "    info   <tag> deployed and healthy in NmNs"
  echo "    error  stopped in stage '<stage>' — nothing rolled back"
  echo
  echo "  Alertmanager posts to the same topic, but as its own raw JSON envelope"
  echo "  with a query string for the title, because it has no body template:"
  echo "      <server>/<topic>?title=Libriant%20alert&priority=high&tags=rotating_light"
  echo "  That URL is written into the alertmanager_data volume by this script, never"
  echo "  into git and never into a log line — the topic is a credential."
  exit 0
fi

# ── The result push, from an EXIT trap. ─────────────────────────────────────
#
# A trap rather than two calls at the end, because most of the ways this script
# stops are `die` — a missing origin certificate, an invalid Caddyfile, a stack
# that never became healthy — and every one of those exits directly. Wiring the
# failure push to the exit status is the only shape that covers all of them,
# including the `set -e` deaths nobody predicted.
#
# STAGE is a fixed label, never a command's output: it is the difference between
# "where to look" and "here is a paragraph of your container logs, sent to a
# third party". The trap sets no exit status of its own.
STAGE="preflight"
DEPLOY_STARTED_AT="$(date +%s)"
on_exit() {
  local rc=$? elapsed
  set +e
  elapsed=$(( $(date +%s) - DEPLOY_STARTED_AT ))
  if [ "$rc" = 0 ] && [ "$STAGE" = "done" ]; then
    # `info`, not `warn`: this is the "you can stop watching" message and it is
    # the only routine push this script makes. An operator who is woken by a
    # SUCCESSFUL deploy mutes the topic, and a muted topic loses the failures.
    notify info "Libriant deploy ok" \
      "${IMAGE_TAG:-unknown} deployed and healthy in $((elapsed / 60))m $((elapsed % 60))s." \
      "rocket"
  elif [ "$rc" != 0 ]; then
    # `error` is the only level that can get through do-not-disturb, and a
    # half-finished deploy earns it: whatever was serving before is still
    # serving, nothing was rolled back, and nobody knows it yet.
    notify error "Libriant deploy FAILED" \
      "Stopped in stage '$STAGE' (exit $rc) after $((elapsed / 60))m $((elapsed % 60))s${IMAGE_TAG:+, tag $IMAGE_TAG}. Nothing was rolled back. The reason is in the terminal this was started from." \
      "ship"
  fi
  exit "$rc"
}
trap on_exit EXIT

[ -d "$APP_DIR/.git" ] || die "$APP_DIR is not a git checkout. Run the first-run bootstrap first."
cd "$APP_DIR"
[ -f "$ENV_FILE" ] || die "$ENV_FILE is missing. Run: bash scripts/ensure-env.sh $ENV_FILE"
[ -d "$DATA_ROOT" ] || die "$DATA_ROOT does not exist. Create it before the first deploy."
command -v docker >/dev/null || die "docker is not installed."

# The volume overlay bind-mounts these four by absolute path. Docker's local
# driver with `o: bind` does NOT create a missing path — it fails with a message
# naming a volume, not the directory, which is a miserable thing to debug at
# 2am. Check them here instead.
for d in postgres redis storage caddy; do
  [ -d "$DATA_ROOT/$d" ] || die "$DATA_ROOT/$d is missing. Run: sudo mkdir -p $DATA_ROOT/{postgres,redis,storage,caddy,backups}"
done

# Every HTTPS vhost imports the cloudflare_origin snippet, which is
# `tls /etc/caddy/origin/origin.crt ...`. Caddy loads file certificates while
# provisioning the config — which `caddy validate` does — so a missing cert
# fails the validation step and reports "Caddyfile is invalid" when the
# Caddyfile is fine. Name the real cause up front.
if [ ! -f "$DATA_ROOT/caddy/origin/origin.crt" ] || [ ! -f "$DATA_ROOT/caddy/origin/origin.key" ]; then
  # "Missing" here can also mean "present but not traversable". This runs as
  # $USER, not root, so a $DATA_ROOT/caddy or .../origin without the `other`
  # execute bit makes `[ -f ]` false on a file that is sitting right there —
  # and the operator then goes looking for a certificate that was never lost.
  # Say both, and name the modes the rest of this file assumes.
  die "Cloudflare origin cert missing at $DATA_ROOT/caddy/origin/{origin.crt,origin.key}.
     It is in the password manager — no backup contains it.
     If you know they ARE there, this is a traversal problem, not a missing file:
       sudo stat -c '%u:%g %a %n' $DATA_ROOT/caddy $DATA_ROOT/caddy/origin $DATA_ROOT/caddy/origin/origin.*
     Expect 0:0 775 on caddy, 0:0 755 on origin, 0:0 640 on the two files.
     See docs/RUNBOOK.md §3.7b and §3.7c."
fi

# supply-chain-07. The origin pair must be owned by root, grouped to root, and
# GROUP-READABLE, and this is the one thing that has to be true for the caddy
# service's `user: '1000:0'` + `cap_drop: [ALL]` to serve TLS at all.
#
# Caddy runs as uid 1000 in group 0 and holds no capabilities whatsoever.
# Reading a file whose permission bits deny you is what CAP_DAC_OVERRIDE is for,
# and it is gone — so the key has to be reachable as the file's OWNER or as its
# GROUP, and 1000 is not the owner. `0:0` at mode 640 is the answer: the file
# stays root-owned, and the only member of group 0 on this host is root, so no
# human login gains a byte of the Cloudflare Full-strict private key by it.
#
# 600 WAS CORRECT AND IS NOW AN OUTAGE — that is the whole reason this gate
# changed shape. It is what every box installed before this change is sitting
# on, it is invisible until the new image starts, and then every HTTPS vhost
# fails to load its certificate at once. The `caddy-validate` stage further down
# would also catch it (it is a real container from the real service, and
# provisioning the config opens the certificate), but the message here names the
# cause and the fix instead of handing over Caddy's.
#
# The check is also worth having on its own terms, which is why the `other` bits
# are still refused: a world-readable origin key on a box several people can log
# into is that trust relationship handed to all of them.
#
# THERE IS A SECOND COPY OF THIS GATE and it moved in the same commit:
# .github/workflows/deploy.yml, step "Pre-flight — the origin private key is
# root-owned". It had to move together with this one, and the reason is the
# opposite of the obvious one. The old CI arm accepted `0:600`, which is the
# state of an UNCONVERTED box — so on the only box that matters it would have
# PASSED and then recreated the stack with the non-root caddy against a key uid
# 1000 cannot open. It failed OPEN in the dangerous direction and closed in the
# harmless one. Anything that edits the arm here edits it there too.
#
# Two `stat` dialects because there are two: GNU on the Ubuntu host this
# deploys, BSD on the machine the gate was written and exercised on. Docker is
# not installed there, so this is the one part of the caddy hardening that could
# be driven at all before it ran for real. `-L` on both because they disagree by
# default — GNU follows a symlink, BSD reports the link itself — and what
# matters is the file Caddy will actually open.
path_owner_mode() { stat -L -c '%u %g %a' "$1" 2>/dev/null || stat -L -f '%u %g %Lp' "$1"; }
KEY="$DATA_ROOT/caddy/origin/origin.key"
CRT="$DATA_ROOT/caddy/origin/origin.crt"
read -r KEY_UID KEY_GID KEY_MODE <<EOF
$(path_owner_mode "$KEY")
EOF
case "${KEY_UID}:${KEY_GID}:${KEY_MODE}" in
  0:0:640 | 0:0:440) KEY_OK=1 ;;
  *) KEY_OK=0 ;;
esac
if [ "$KEY_OK" != "1" ]; then
  case "${KEY_UID}:${KEY_GID}:${KEY_MODE}" in
    0:0:600 | 0:0:400)
      # The exact state of every box installed before this change, so it gets
      # the exact command rather than a rule to interpret. Safe to run while the
      # old uid-0 edge is still serving: 640 does not take away root's own read.
      KEY_FIX="This is the pre-supply-chain-07 layout — correct while Caddy was uid 0,
     unreadable now that it is uid 1000. One command, safe to run while the
     current edge is still serving:
       sudo chmod 640 $KEY
     The two writable volumes need converting in the same pass, and the order
     matters. Do not deploy until you have followed docs/RUNBOOK.md §3.7c." ;;
    *)
      KEY_FIX="It must be owned by root, grouped to root, and mode 640 (or 440):
       sudo chown 0:0 $KEY && sudo chmod 640 $KEY" ;;
  esac
  die "$KEY is uid=$KEY_UID gid=$KEY_GID mode=$KEY_MODE.
     Caddy runs as uid 1000 in group 0 with cap_drop: [ALL], so it cannot use
     CAP_DAC_OVERRIDE to read around the permission bits and anything else here
     fails TLS on every vhost.
     $KEY_FIX"
fi

# The certificate, by the same rule and for the same failure. It is already
# 640 root:root everywhere this repo installs it, so this asserts the state
# rather than asking for a change — but a crt narrowed to 600 by hand takes the
# edge down exactly as the key does, and nothing looked at it before.
read -r CRT_UID CRT_GID CRT_MODE <<EOF
$(path_owner_mode "$CRT")
EOF
case "${CRT_UID}:${CRT_GID}:${CRT_MODE}" in
  0:0:640 | 0:0:644 | 0:0:440 | 0:0:444) : ;;
  *) die "$CRT is uid=$CRT_UID gid=$CRT_GID mode=$CRT_MODE; Caddy reads it as a
     member of group 0, so it must be root-owned, grouped to root and
     group-readable:
       sudo chown 0:0 $CRT && sudo chmod 640 $CRT" ;;
esac

# `ensure-env.sh --auto` below fills in generated secrets but never prompts, so
# these two operator-supplied values stay empty and nothing complains: you get a
# green deploy you cannot log in to.
if ! grep -qE '^ADMIN_BOOTSTRAP_EMAIL=.+' "$ENV_FILE" 2>/dev/null; then
  printf '\033[33m⚠ ADMIN_BOOTSTRAP_EMAIL is empty — no admin will be created.\033[0m\n'
  printf '  Run once, interactively (no --auto):  bash scripts/ensure-env.sh %s\n\n' "$ENV_FILE"
fi

if [ "$FETCH" = "1" ]; then
  STAGE="git-sync"
  say "Syncing to $REF"
  git fetch --quiet origin
  # Host-local edits to TRACKED files are discarded, exactly as CI does it.
  # Anything you need to persist belongs in .env.prod, which is untracked.
  git reset --hard "$REF"
fi

# ─────────────────────────────────────────────────────────────────────────────
# AFTER the sync, and that placement is the point: on a fetching deploy the
# tree these checks judge is the one `git reset --hard` just wrote, which is the
# tree that gets bind-mounted. Run before the sync they would grade the previous
# commit's file modes. Nothing has been built or recreated yet either way.
# supply-chain-07, the half of the uid change that is not about the key: every
# path bind-mounted read-only into the caddy container is owned by `deploy` on
# the host, and the container is uid 1000 in group 0. A checkout made under a
# tightened umask (027 gives 0640, 077 gives 0600) therefore produces an edge
# that cannot open its own configuration and exits at start — with the images
# built and the old container already gone.
#
# MODELLED EXACTLY RATHER THAN APPROXIMATED BY THE `other` BIT, because the
# approximation has a false positive that would refuse an emergency deploy on a
# box that is perfectly fine: if `deploy` happens to BE uid 1000 — which it is on
# any image where it was the first ordinary user — the container matches the
# OWNER and reads a 0600 file happily. Getting this wrong in the safe direction
# costs a warning; getting it wrong in the other direction costs a deploy at 3am.
CADDY_UID=1000
CADDY_GID=0
# readable_by_edge PATH — true when uid 1000 / gid 0 can read PATH through
# whichever of owner / group / other actually applies to it.
readable_by_edge() {
  local u g m
  read -r u g m <<EOF2
$(path_owner_mode "$1" 2>/dev/null)
EOF2
  [ -n "$m" ] || return 1
  # Normalise to exactly three digits: BSD `%Lp` drops leading zeroes (`0`, `40`)
  # and both dialects prepend a fourth for setuid/setgid/sticky (`4755`).
  while [ "${#m}" -lt 3 ]; do m="0${m}"; done
  while [ "${#m}" -gt 3 ]; do m="${m#?}"; done
  local owner="${m%??}" group="${m#?}"; group="${group%?}"; local other="${m#??}"
  # `if`, not `[ … ] && case …`: this file runs under `set -e`, and an && list
  # whose left side is false returns non-zero. Harmless while every caller is a
  # `||` (which suspends -e through the whole body), a silent exit the first time
  # someone calls it bare.
  if [ "$u" = "$CADDY_UID" ]; then case "$owner" in *[4567]) return 0 ;; esac; fi
  if [ "$g" = "$CADDY_GID" ]; then case "$group" in *[4567]) return 0 ;; esac; fi
  case "$other" in *[4567]) return 0 ;; esac
  return 1
}
CADDYFILE="$APP_DIR/infra/caddy/Caddyfile"
[ -f "$CADDYFILE" ] || die "$CADDYFILE is missing from the checkout. The caddy container bind-mounts
     it as its only configuration and would exit at start."
readable_by_edge "$CADDYFILE" || die "$CADDYFILE cannot be read by the caddy container, which runs as uid
     ${CADDY_UID} in group ${CADDY_GID} — neither this file's owner nor its group. Caddy would
     exit at start with 'permission denied' on its own config.
       chmod o+r $CADDYFILE
     If the whole checkout looks like this, the umask that made it is the cause:
       find $APP_DIR/infra $APP_DIR/assets ! -perm -o+r"
# Not fatal, so not a `die`: a maintenance page or an icon that 404s is a
# blemish, not an outage. Named anyway, because the cause is the same one and it
# would otherwise be found during a takeover, which is the worst possible moment.
for ro_path in "$APP_DIR/infra/caddy/maintenance.html" "$APP_DIR/assets"; do
  [ -e "$ro_path" ] || continue
  readable_by_edge "$ro_path" \
    || printf '\033[33m⚠ %s is not readable by the caddy container (uid %s, gid %s).\033[0m\n' "$ro_path" "$CADDY_UID" "$CADDY_GID"
done

GIT_SHA="$(git rev-parse --short=12 HEAD)"
DIRTY=""
git diff --quiet || DIRTY="-dirty"
# CI tags images with the 12-char short SHA so a running image maps back to a
# commit. Keep that property locally. The -dirty suffix is load-bearing: it says
# out loud that this image does not correspond to any commit anyone can check
# out, so never roll back "to" one.
TAG="${GIT_SHA}${DIRTY}"

STAGE="env"
say "Loading $ENV_FILE"
# Generate any MISSING secrets; never overwrites existing values.
bash scripts/ensure-env.sh --auto "$ENV_FILE"
set -a; . "$ENV_FILE"; set +a
# AFTER sourcing, deliberately. .env.prod ships an IMAGE_TAG (default `latest`)
# and `set -a` would otherwise overwrite the tag computed above — silently
# deploying `latest` instead of this commit. CI has the same ordering for the
# same reason.
export IMAGE_TAG="$TAG"
export COMPOSE_PROJECT_NAME=libriant
export LIBRIANT_DATA_ROOT="$DATA_ROOT"

FILES="-f infra/compose/docker-compose.prod.yml -f infra/compose/docker-compose.volume.yml"
# shellcheck disable=SC2086
dc() { docker compose $FILES "$@"; }

# The monitoring stack, which until now was in NO deploy path.
#
# infra/monitoring/alerts.yml holds 25 rules — the Postgres and Redis capacity
# alerts, the API error-rate and latency alerts, the backup dead-man's switches,
# and the Watchdog whose entire job is to prove the pipeline is alive. This line
# and its twin in .github/workflows/deploy.yml composed two files and never the
# monitoring one, so every one of those rules was evaluated by nothing while
# `pnpm check:alerts` printed a green line about them. That is the failure the
# Watchdog exists to catch, applied to the Watchdog.
#
# A SEPARATE compose project, not a third `-f`: the app deploy runs `up -d
# --remove-orphans` under project `libriant`, and the monitoring file declares
# the `app` network as external — the same network the prod file creates. One
# invocation cannot hold both.
#
# It runs LAST, after the app is already healthy — deliberately, so a monitoring
# problem never rolls a working application back. It CAN still fail the deploy:
# the function below carries five `die` calls (an invalid alertmanager.yml, a
# stack that will not come up, a service that is not running ten seconds later)
# and a `sleep 10`. That is the intent — a monitoring stack that silently did
# not start is the failure this whole section exists to end — but it is not the
# same thing as "nothing here can fail a deploy", which is what this comment
# used to claim.
MON_FILES="-f infra/monitoring/docker-compose.monitoring.yml"
# shellcheck disable=SC2086
mon() { docker compose -p libriant-monitoring $MON_FILES "$@"; }

deploy_monitoring() {
  STAGE="monitoring"
  say "Starting the monitoring stack"

  # Same shape as the Caddyfile gate above, and for the same reason: a rule file
  # that does not parse takes Prometheus down on start, and a Prometheus that is
  # down is the component that was supposed to tell you things are down.
  mon run --rm --no-deps --entrypoint promtool prometheus \
    check rules /etc/prometheus/alerts.yml \
    || die "infra/monitoring/alerts.yml is invalid — monitoring was not touched."

  # Existence first, because the test below is a `grep -q` and grep exits 1 on a
  # file it cannot open — the same code as "no placeholders found". Without this
  # line a deleted or mistyped alertmanager.yml read as a fully configured one
  # and the script announced that alerting was live. Found by running this
  # function against a checkout that did not have the file.
  [ -f infra/monitoring/alertmanager.yml ] \
    || die "infra/monitoring/alertmanager.yml is missing — Prometheus has nowhere to deliver to."

  # Alertmanager refuses to start on a receiver URL it cannot parse, so the
  # service sits behind the `alerting` profile and this turns the profile on by
  # itself once the file is real AND there is somewhere for it to post.
  #
  # TWO conditions now, not one:
  #
  #   1. no [PLACEHOLDER] left in the CONFIG. Comments stripped before the grep:
  #      the file's own header explains what a [PLACEHOLDER: …] is, and matching
  #      that sentence kept the profile off even with the receivers filled in.
  #      That still matters — alertmanager.yml's header explains what a
  #      [PLACEHOLDER: …] is, in prose — and it is why the marker lives in a
  #      comment there rather than inside a URL. The `watchdog` receiver is no
  #      longer one of them: it reads `url_file` like `default`, and its URL is
  #      materialised below from WATCHDOG_PING_URL.
  #
  #   2. an ntfy topic to post to. `default` reads its URL from a file in the
  #      alertmanager_data volume (see alertmanager.yml), and this script is what
  #      writes it. Starting Alertmanager without that file gives an alerting
  #      stack that looks healthy in `docker compose ps` and fails every single
  #      notification into its own container log — silent non-delivery wearing a
  #      green badge, which is worse than the honest red banner below.
  COMPOSE_PROFILES=""
  if sed 's/#.*//' infra/monitoring/alertmanager.yml | grep -q '\[PLACEHOLDER'; then
    ALERTING_OFF_BECAUSE="alertmanager.yml still has a [PLACEHOLDER] in a receiver"
  elif ! notify_enabled; then
    # notify_enabled is the library's own verdict, not a `-n` test: it also
    # rejects a topic short enough to guess and one with characters ntfy will
    # not accept. Either way the receiver would have no destination it can use,
    # and `notify_status` below prints the reason without printing the value.
    #
    # `|| true` inside the substitution is load-bearing: notify_status exits 1
    # when notifications are off, this script runs under `set -euo pipefail`,
    # and the exit status of `VAR=$(pipeline)` is the pipeline's — so without it
    # the deploy would die at the exact moment it was trying to explain why
    # alerting is not on.
    ALERTING_OFF_BECAUSE="ntfy is not usable — $({ notify_status 2>&1 || true; } | head -n1)"
  else
    COMPOSE_PROFILES="alerting"
    ALERTING_OFF_BECAUSE=""
  fi
  # Exported BEFORE the amtool run, not after: `alertmanager` only exists as a
  # service while its profile is active, so the validation below cannot select
  # it otherwise.
  export COMPOSE_PROFILES
  if [ -n "$COMPOSE_PROFILES" ]; then
    mon run --rm --no-deps --entrypoint amtool alertmanager \
      check-config /etc/alertmanager/alertmanager.yml \
      || die "infra/monitoring/alertmanager.yml is invalid — monitoring was not touched."

    # ── The topic URL, into the volume, on every deploy. ────────────────────
    #
    # WHY IT IS NOT IN alertmanager.yml: that file is in git, and on ntfy.sh the
    # topic name is the whole credential — anyone holding the string can read
    # every alert and publish forged ones. So Alertmanager reads `url_file`, and
    # the only writable path that container has is its own data volume.
    #
    # Written through the container rather than into /var/lib/docker/volumes/…
    # directly: this script runs as `deploy`, which cannot read that tree, and
    # pre-creating the volume from the host would make Compose refuse it as a
    # volume it did not create. It reaches the container on STDIN, and the only
    # thing that ever holds it here is `printf`, which is a bash builtin and
    # forks no process — so the topic never becomes a process argument and never
    # appears in this box's `ps`. No trailing newline: Alertmanager trims the
    # file, but a URL with a stray byte on the end is not a thing to be relaxed
    # about.
    #
    # A failure here turns alerting OFF rather than failing the deploy — the
    # notification channel must never be the thing that breaks the deploy — and
    # the banner below then says so in full. The empty-string guard is the same
    # rule: writing an empty file would leave Alertmanager posting to nowhere
    # while every dashboard says it is up.
    alert_url="$(ntfy_alert_url || true)"
    if [ -z "$alert_url" ]; then
      COMPOSE_PROFILES=""
      export COMPOSE_PROFILES
      ALERTING_OFF_BECAUSE="the receiver URL came out empty, so there is nothing to post to"
    elif ! printf '%s' "$alert_url" \
      | mon run --rm --no-deps -T --entrypoint sh alertmanager \
          -c 'umask 077; cat > /alertmanager/ntfy-url' >/dev/null 2>&1; then
      COMPOSE_PROFILES=""
      export COMPOSE_PROFILES
      ALERTING_OFF_BECAUSE="the receiver URL could not be written into the alertmanager_data volume"
    fi
    unset alert_url
  fi

  # The watchdog's destination, by the same route and for the same reason. A
  # healthchecks.io ping URL is a BEARER credential: anyone holding it can ping
  # the check and keep it green, which silences the one alarm that fires when
  # everything else has already stopped talking. So it lives in .env.prod, not
  # in the git-tracked alertmanager.yml, and is materialised here.
  #
  # Unset is a supported state, not an error. Without it Alertmanager cannot
  # open `url_file` and each heartbeat fails into its own container log — which
  # is honest, and is named in the closing banner rather than left to be
  # discovered. It does NOT gate the `alerting` profile: `default` carries the
  # real alerts and must not be held hostage to the dead man's switch being
  # configured.
  WATCHDOG_OFF_BECAUSE=""
  if [ -n "${WATCHDOG_PING_URL:-}" ]; then
    if ! printf '%s' "$WATCHDOG_PING_URL" \
      | mon run --rm --no-deps -T --entrypoint sh alertmanager \
          -c 'umask 077; cat > /alertmanager/watchdog-url' >/dev/null 2>&1; then
      WATCHDOG_OFF_BECAUSE="the ping URL could not be written into the alertmanager_data volume"
    fi
  else
    WATCHDOG_OFF_BECAUSE="WATCHDOG_PING_URL is unset in ${ENV_FILE}"
  fi

  mon up -d || die "the monitoring stack failed to start."

  # No healthchecks on these images — nothing in this repo can verify what a
  # third-party image ships to probe itself with, and an unverifiable probe that
  # goes permanently red is worse than none. Container STATE needs no such
  # assumption: Prometheus exits non-zero on a config it cannot load, so "still
  # running, not restarting, ten seconds later" is a real signal. It does not
  # prove delivery — that is what the banner below is for.
  sleep 10
  local svc id state
  # alertmanager joins the list the moment it is supposed to be running. Without
  # it, the one component whose failure is invisible by definition was the one
  # component nothing checked: a crash-looping Alertmanager leaves Prometheus
  # green, every rule evaluating, and every alert going nowhere.
  local mon_services="prometheus node-exporter"
  [ -n "$COMPOSE_PROFILES" ] && mon_services="$mon_services alertmanager"
  # shellcheck disable=SC2086
  for svc in $mon_services; do
    id="$(docker ps -aq --filter "label=com.docker.compose.project=libriant-monitoring" \
                        --filter "label=com.docker.compose.service=$svc" | head -n1)"
    state="$(docker inspect -f '{{.State.Status}}' "$id" 2>/dev/null || echo missing)"
    if [ "$state" != "running" ]; then
      mon logs --no-color --tail 50 "$svc" >&2 || true
      die "monitoring service '$svc' is '$state', not running."
    fi
  done
  mon ps

  if [ -n "$COMPOSE_PROFILES" ]; then
    say "Alerting is live: Prometheus is evaluating alerts.yml and Alertmanager is delivering it"
    printf '  Alerts go to the ntfy topic in %s, as raw Alertmanager JSON with a\n' "$ENV_FILE"
    printf '  title — a doorbell, not a letter. Read the alert itself at /alerts.\n'
    # Stated either way. "Alerting is live" is about `default`; the dead man's
    # switch is a separate promise, and the one whose absence is invisible by
    # construction — nothing fires when it is missing, which is exactly what a
    # working one looks like from here.
    if [ -z "${WATCHDOG_OFF_BECAUSE:-}" ]; then
      printf '  Dead man'"'"'s switch: the Watchdog heartbeat is being delivered.\n'
    else
      printf '\033[33m  Dead man'"'"'s switch NOT armed: %s.\n' "$WATCHDOG_OFF_BECAUSE"
      printf '  Every other alert here needs this stack alive to send it, and\n'
      printf '  nothing tells you when it stops. See docs/RUNBOOK.md 7.3.\033[0m\n'
    fi
  else
    printf '\n\033[31m'
    printf '  ══════════════════════════════════════════════════════════════════\n'
    printf '  ALERTS ARE NOT BEING DELIVERED.\n'
    printf '  ══════════════════════════════════════════════════════════════════\033[0m\n'
    printf '\033[33m'
    printf '  Alertmanager is NOT running: %s.\n' "$ALERTING_OFF_BECAUSE"
    printf '  Prometheus IS evaluating all the rules and you can read them at\n'
    printf '  /alerts over an SSH tunnel — but nothing will wake anyone up. That\n'
    printf '  includes BackupNeverRan, the disk-full alerts, and the Watchdog\n'
    printf '  that is supposed to tell you alerting itself has broken.\n'
    printf '  Fix that and re-run this script.\033[0m\n\n'
  fi

}

echo "  commit    $(git rev-parse --short=12 HEAD)  $(git log -1 --format=%s | cut -c1-60)"
echo "  IMAGE_TAG $IMAGE_TAG"
echo "  data root $DATA_ROOT"
[ -n "$DIRTY" ] && printf '\033[33m  working tree is DIRTY — this image matches no commit\033[0m\n'

if [ "$DRY" = "1" ]; then STAGE="dry-run"; say "--dry-run: stopping here"; exit 0; fi

if [ "$BUILD" = "1" ]; then
  STAGE="prune"
  say "Reclaiming disk before the build"
  # Every deploy makes new SHA-tagged images; unpruned they fill the disk, which
  # has previously broken a deploy at the seed step with ENOSPC. In-use images
  # are protected regardless of age. Best-effort: cleanup never fails a deploy.
  #
  # GUARDED BY --skip-build SINCE supply-chain-07, and the reason is a rollback
  # that ate its own parachute. This ran unconditionally, ABOVE the build guard,
  # so `--skip-build` — the flag whose entire purpose is "use the images already
  # on this box" — pruned first. `-a` removes TAGGED images no container is
  # using, and after a failed deploy's `up -d --force-recreate` the previous
  # containers are gone, so the previous release's images are unused; `until=72h`
  # protects only what was built in the last three days. A rollback to a release
  # older than that therefore deleted the images it was about to start, and
  # Compose fell through to pulling from GHCR, which publishes nothing while
  # deploys are manual. There is nothing to reclaim ahead of a build that is not
  # happening, so the guard costs nothing and removes that entirely.
  docker image prune -af --filter 'until=72h' || true
  docker builder prune -f --filter 'until=72h' || true
fi

if [ "$BUILD" = "1" ]; then
  STAGE="build"
  say "Building images on this box"
  # Building Next.js here is the memory-hungry step. If it is OOM-killed
  # (exit 137), give the box swap or build one service at a time:
  #   dc build web   then   dc build api
  dc build
fi

STAGE="caddy-validate"
say "Validating the Caddyfile before anything is recreated"
# Two vhosts claiming one hostname is an adapter error. Without this check the
# sequence is: up -d succeeds, caddy reload fails, the fallback recreate
# crash-loops, and every host goes dark. With it, the deploy aborts and whatever
# is currently running keeps serving.
dc run --rm --no-deps --entrypoint caddy caddy \
  validate --config /etc/caddy/Caddyfile --adapter caddyfile \
  || die "Caddyfile is invalid — nothing was changed."

STAGE="compose-up"
say "Starting the stack"
# --force-recreate for the same reason CI uses it: `up -d` alone may decide
# nothing changed for a re-used tag and leave OLD code running.
if ! dc up -d --remove-orphans --force-recreate; then
  echo "===== deploy failed: 'migrate' logs =====" >&2
  dc logs --no-color --timestamps migrate 2>&1 | tail -n 200 >&2 || true
  echo "===== container status =====" >&2
  dc ps >&2 || true
  die "compose up failed."
fi

STAGE="caddy-reload"
say "Reloading Caddy"
# Its config is a bind-mount, so `up -d` won't restart it for a Caddyfile-only
# change. Graceful reload, with a recreate as the fallback.
dc exec -T caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile \
  || dc up -d --force-recreate caddy

STAGE="health"
say "Waiting for health"
# Local checks only. The CI gate gets to assume public DNS and a Cloudflare
# origin cert; a box that is not yet in DNS has neither, so asking for those
# here would fail a stack that is actually fine.
svc_health() {
  local id
  id="$(docker ps -q --filter "label=com.docker.compose.project=libriant" \
                     --filter "label=com.docker.compose.service=$1" | head -n1)"
  [ -n "$id" ] || { echo "missing"; return; }
  docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$id" 2>/dev/null || echo "missing"
}
deadline=$(( $(date +%s) + 180 ))
HEALTHY=0
while [ "$(date +%s)" -lt "$deadline" ]; do
  edge="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 http://localhost/healthz 2>/dev/null || true)"
  # --resolve, not -H: curl takes SNI from the URL host, so `-H 'Host: ...'`
  # against https://localhost/ offers SNI `localhost`, which the origin
  # certificate (libriant.com, *.libriant.com) does not cover — the server
  # aborts the handshake and a perfectly healthy stack reads as down. `-k`
  # disables client-side verification; it does not fix SNI.
  site="$(curl -sk --resolve libriant.com:443:127.0.0.1 -o /dev/null -w '%{http_code}' --max-time 5 https://libriant.com/ 2>/dev/null || true)"
  api="$(svc_health api)"; web="$(svc_health web)"; worker="$(svc_health worker)"
  # boot-and-config-15. The pooler every control-plane query goes through. Its
  # sidecar runs `psql -c 'select 1'` THROUGH pgbouncer, which is the only probe
  # that can tell "the pooler answers" from "the pooler can reach Postgres" —
  # `pg_isready`, the probe this replaces, is satisfied by pgbouncer's own
  # startup-packet reply and stayed green with the backend gone. Asserted here
  # so the result has a consumer rather than only an operator who happens to run
  # `docker compose ps`.
  pooler="$(svc_health pgbouncer-probe)"
  if [ "$edge" = "200" ] && [ "$site" = "200" ] && [ "$api" = "healthy" ] && [ "$web" = "healthy" ] \
     && [ "$worker" = "healthy" ] && [ "$pooler" = "healthy" ]; then
    HEALTHY=1
    break
  fi
  echo "  waiting… edge=$edge site=$site api=$api web=$web worker=$worker pooler=$pooler"
  sleep 5
done

if [ "$HEALTHY" != "1" ]; then
  echo "stack did not become healthy within 180s (edge=${edge:-?} site=${site:-?} api=${api:-?} web=${web:-?} worker=${worker:-?} pooler=${pooler:-?})" >&2
  dc ps >&2 || true
  die "Deploy finished but the stack is not healthy. Nothing was rolled back — inspect and re-run."
fi

say "Healthy: origin + marketing site + api + web + worker + pooler path"
dc ps

deploy_monitoring

# The last thing before the summary. `done` is what the EXIT trap reads to tell
# a finished deploy from one that stopped somewhere in the middle, and the push
# it sends is the whole point of the tmux-and-walk-away instruction in the
# runbook.
STAGE="done"

echo
echo "Deployed $IMAGE_TAG. This box is not in DNS yet, so nothing is public."
echo "Point DNS at it only when you want it live — docs/RUNBOOK.md."
