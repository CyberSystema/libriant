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
# docs/deploy-from-the-server.md): docker, /srv/libriant/app (this checkout),
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
     See docs/deploy-from-the-server.md."
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
while [ "$(date +%s)" -lt "$deadline" ]; do
  edge="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 http://localhost/healthz 2>/dev/null || true)"
  # --resolve, not -H: curl takes SNI from the URL host, so `-H 'Host: ...'`
  # against https://localhost/ offers SNI `localhost`, which the origin
  # certificate (libriant.com, *.libriant.com) does not cover — the server
  # aborts the handshake and a perfectly healthy stack reads as down. `-k`
  # disables client-side verification; it does not fix SNI.
  site="$(curl -sk --resolve libriant.com:443:127.0.0.1 -o /dev/null -w '%{http_code}' --max-time 5 https://libriant.com/ 2>/dev/null || true)"
  api="$(svc_health api)"; web="$(svc_health web)"; worker="$(svc_health worker)"
  if [ "$edge" = "200" ] && [ "$site" = "200" ] && [ "$api" = "healthy" ] && [ "$web" = "healthy" ] && [ "$worker" = "healthy" ]; then
    say "Healthy: origin + marketing site + api + web + worker"
    dc ps
    echo
    echo "Deployed $IMAGE_TAG. This box is not in DNS yet, so nothing is public."
    echo "Point DNS at it only when you want it live — docs/cutover-three-hosts.md."
    exit 0
  fi
  echo "  waiting… edge=$edge site=$site api=$api web=$web worker=$worker"
  sleep 5
done

echo "stack did not become healthy within 180s (edge=${edge:-?} site=${site:-?} api=${api:-?} web=${web:-?} worker=${worker:-?})" >&2
dc ps >&2 || true
die "Deploy finished but the stack is not healthy. Nothing was rolled back — inspect and re-run."
