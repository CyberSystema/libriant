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

while [ $# -gt 0 ]; do
  case "$1" in
    --ref) REF="$2"; shift 2 ;;
    --no-fetch) FETCH=0; shift ;;
    --skip-build) BUILD=0; shift ;;
    --dry-run) DRY=1; shift ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

say() { printf '\n\033[1m▸ %s\033[0m\n' "$*"; }
die() { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

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
  die "Cloudflare origin cert missing at $DATA_ROOT/caddy/origin/{origin.crt,origin.key}.
     It is in the password manager — no backup contains it.
     See docs/RUNBOOK.md."
fi

# supply-chain-07. The origin PRIVATE KEY must be owned by root and readable by
# nobody else, and this is the one thing that has to be true for the caddy
# service's `cap_drop: [ALL]` to be safe.
#
# Caddy runs as uid 0 inside that container and now holds no capabilities but
# NET_BIND_SERVICE. Reading a file whose permission bits deny it is what
# CAP_DAC_OVERRIDE is for, and that is gone — so a key owned by `deploy` at
# mode 600 would be unreadable, every HTTPS vhost would fail to load its
# certificate, and the whole edge would be down. Owned by root at 600 it is
# readable as the OWNER, no capability involved.
#
# The same check is also worth having on its own terms: a world-readable origin
# key on a box several people can log into is the Cloudflare Full-strict trust
# relationship handed to any of them, and nothing looked at it before.
#
# Two `stat` dialects because there are two: GNU on the Ubuntu host this
# deploys, BSD on the machine the gate was written and exercised on. Docker is
# not installed there, so this is the one part of the caddy hardening that could
# be driven at all before it ran for real. `-L` on both because they disagree by
# default — GNU follows a symlink, BSD reports the link itself — and what
# matters is the file Caddy will actually open.
key_owner_mode() { stat -L -c '%u %a' "$1" 2>/dev/null || stat -L -f '%u %Lp' "$1"; }
KEY="$DATA_ROOT/caddy/origin/origin.key"
read -r KEY_UID KEY_MODE <<EOF
$(key_owner_mode "$KEY")
EOF
case "${KEY_UID}:${KEY_MODE}" in
  0:600 | 0:400) KEY_OK=1 ;;
  *) KEY_OK=0 ;;
esac
if [ "$KEY_OK" != "1" ]; then
  die "$KEY is uid=$KEY_UID mode=$KEY_MODE; it must be root-owned and 600 (or 400).
     Caddy runs with cap_drop: [ALL] and cannot use CAP_DAC_OVERRIDE to read
     around the permission bits, so anything else fails TLS on every vhost.
     Fix it, then re-run:
       sudo chown 0:0 $KEY && sudo chmod 600 $KEY"
fi

# `ensure-env.sh --auto` below fills in generated secrets but never prompts, so
# these two operator-supplied values stay empty and nothing complains: you get a
# green deploy you cannot log in to.
if ! grep -qE '^ADMIN_BOOTSTRAP_EMAIL=.+' "$ENV_FILE" 2>/dev/null; then
  printf '\033[33m⚠ ADMIN_BOOTSTRAP_EMAIL is empty — no admin will be created.\033[0m\n'
  printf '  Run once, interactively (no --auto):  bash scripts/ensure-env.sh %s\n\n' "$ENV_FILE"
fi

if [ "$FETCH" = "1" ]; then
  say "Syncing to $REF"
  git fetch --quiet origin
  # Host-local edits to TRACKED files are discarded, exactly as CI does it.
  # Anything you need to persist belongs in .env.prod, which is untracked.
  git reset --hard "$REF"
fi

GIT_SHA="$(git rev-parse --short=12 HEAD)"
DIRTY=""
git diff --quiet || DIRTY="-dirty"
# CI tags images with the 12-char short SHA so a running image maps back to a
# commit. Keep that property locally. The -dirty suffix is load-bearing: it says
# out loud that this image does not correspond to any commit anyone can check
# out, so never roll back "to" one.
TAG="${GIT_SHA}${DIRTY}"

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

  # Alertmanager refuses to start on a receiver URL it cannot parse, and
  # alertmanager.yml still ships `[PLACEHOLDER: …]` for both of its receivers,
  # because who gets woken up is an owner's decision. Rather than crash-loop it
  # on every deploy, that service sits behind the `alerting` profile and this
  # turns the profile on by itself the moment the file is real.
  #
  # Comments stripped before the grep: the file's own header explains what a
  # [PLACEHOLDER: …] is, and matching that sentence kept the profile off even
  # with both receivers filled in. Also found by running this.
  if sed 's/#.*//' infra/monitoring/alertmanager.yml | grep -q '\[PLACEHOLDER'; then
    COMPOSE_PROFILES=""
  else
    COMPOSE_PROFILES="alerting"
  fi
  # Exported BEFORE the amtool run, not after: `alertmanager` only exists as a
  # service while its profile is active, so the validation below cannot select
  # it otherwise.
  export COMPOSE_PROFILES
  if [ -n "$COMPOSE_PROFILES" ]; then
    mon run --rm --no-deps --entrypoint amtool alertmanager \
      check-config /etc/alertmanager/alertmanager.yml \
      || die "infra/monitoring/alertmanager.yml is invalid — monitoring was not touched."
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
  for svc in prometheus node-exporter; do
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
  else
    printf '\n\033[31m'
    printf '  ══════════════════════════════════════════════════════════════════\n'
    printf '  ALERTS ARE NOT BEING DELIVERED.\n'
    printf '  ══════════════════════════════════════════════════════════════════\033[0m\n'
    printf '\033[33m'
    printf '  infra/monitoring/alertmanager.yml still has [PLACEHOLDER] receivers,\n'
    printf '  so Alertmanager is NOT running. Prometheus IS evaluating all the\n'
    printf '  rules and you can read them at /alerts over an SSH tunnel — but\n'
    printf '  nothing will wake anyone up. That includes BackupNeverRan, the\n'
    printf '  disk-full alerts, and the Watchdog that is supposed to tell you\n'
    printf '  alerting itself has broken.\n'
    printf '  Put a real destination in that file and re-run this script.\033[0m\n\n'
  fi
}

echo "  commit    $(git rev-parse --short=12 HEAD)  $(git log -1 --format=%s | cut -c1-60)"
echo "  IMAGE_TAG $IMAGE_TAG"
echo "  data root $DATA_ROOT"
[ -n "$DIRTY" ] && printf '\033[33m  working tree is DIRTY — this image matches no commit\033[0m\n'

if [ "$DRY" = "1" ]; then say "--dry-run: stopping here"; exit 0; fi

say "Reclaiming disk before the build"
# Every deploy makes new SHA-tagged images; unpruned they fill the disk, which
# has previously broken a deploy at the seed step with ENOSPC. In-use images are
# protected regardless of age. Best-effort: cleanup never fails a deploy.
docker image prune -af --filter 'until=72h' || true
docker builder prune -f --filter 'until=72h' || true

if [ "$BUILD" = "1" ]; then
  say "Building images on this box"
  # Building Next.js here is the memory-hungry step. If it is OOM-killed
  # (exit 137), give the box swap or build one service at a time:
  #   dc build web   then   dc build api
  dc build
fi

say "Validating the Caddyfile before anything is recreated"
# Two vhosts claiming one hostname is an adapter error. Without this check the
# sequence is: up -d succeeds, caddy reload fails, the fallback recreate
# crash-loops, and every host goes dark. With it, the deploy aborts and whatever
# is currently running keeps serving.
dc run --rm --no-deps --entrypoint caddy caddy \
  validate --config /etc/caddy/Caddyfile --adapter caddyfile \
  || die "Caddyfile is invalid — nothing was changed."

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

say "Reloading Caddy"
# Its config is a bind-mount, so `up -d` won't restart it for a Caddyfile-only
# change. Graceful reload, with a recreate as the fallback.
dc exec -T caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile \
  || dc up -d --force-recreate caddy

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

echo
echo "Deployed $IMAGE_TAG. This box is not in DNS yet, so nothing is public."
echo "Point DNS at it only when you want it live — docs/RUNBOOK.md."
