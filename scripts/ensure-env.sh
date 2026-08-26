#!/usr/bin/env bash
# Libriant - idempotent production secret + config initializer.
#
# Fills any MISSING secret with a fresh random value and records the few
# operator-supplied settings (domain + admin login). It NEVER overwrites an
# existing non-empty value - so a Postgres password the database already uses
# is preserved (regenerating it would lock you out of your own DB).
#
# Usage:
#   scripts/ensure-env.sh                # interactive: prompts for missing
#                                        #   IMAGE_OWNER + admin login
#   scripts/ensure-env.sh --auto [FILE]  # non-interactive (used by deploy CI):
#                                        #   generate randoms only, never prompt
#
# FILE defaults to /srv/libriant/.env.prod.
set -euo pipefail

AUTO=0
ENV_FILE=/srv/libriant/.env.prod
for a in "$@"; do
  case "$a" in
    --auto) AUTO=1 ;;
    -*) echo "unknown flag: $a" >&2; exit 2 ;;
    *) ENV_FILE="$a" ;;
  esac
done

umask 077
mkdir -p "$(dirname "${ENV_FILE}")"
touch "${ENV_FILE}"
chmod 600 "${ENV_FILE}"

getv() { sed -n "s/^$1=//p" "${ENV_FILE}" | head -n1; }

# setv KEY VALUE - replace the key's line (or append). Value written verbatim;
# use only for shell-safe values (hex, hostnames, emails, numbers).
setv() {
  local k="$1" v="$2" tmp
  tmp="$(mktemp)"
  grep -v "^${k}=" "${ENV_FILE}" > "${tmp}" || true
  printf '%s=%s\n' "${k}" "${v}" >> "${tmp}"
  cat "${tmp}" > "${ENV_FILE}"
  rm -f "${tmp}"
}

# set_quoted KEY VALUE - single-quote the value (for free-text like passwords
# that may contain shell metacharacters). Rejects values containing a single
# quote, which cannot be represented safely in a sourced env file.
set_quoted() {
  local k="$1" v="$2" tmp
  case "${v}" in
    *\'*) echo "  ! ${k} contains a single quote - choose a value without one" >&2; return 1 ;;
  esac
  tmp="$(mktemp)"
  grep -v "^${k}=" "${ENV_FILE}" > "${tmp}" || true
  printf "%s='%s'\n" "${k}" "${v}" >> "${tmp}"
  cat "${tmp}" > "${ENV_FILE}"
  rm -f "${tmp}"
}

ensure_rand()    { local k="$1" b="$2"; [ -n "$(getv "${k}")" ] || { setv "${k}" "$(openssl rand -hex "${b}")"; echo "  generated ${k}"; }; }
ensure_default() { local k="$1" d="$2"; [ -n "$(getv "${k}")" ] || { setv "${k}" "${d}"; echo "  set ${k}=${d}"; }; }

# True if a Postgres cluster already exists on this host's data directory.
# Used to refuse minting a fresh POSTGRES_PASSWORD over a surviving DB (which
# would lock the app out of its own database — see the guard below).
#
# boot-and-config-06: this used to ask DOCKER where pg_data lives —
# `docker volume inspect --format '{{.Mountpoint}}' libriant_pg_data` — and it
# could not answer correctly in either of the two topologies we actually run:
#
#   1. The scenario the guard EXISTS for is a Hetzner "Rebuild": the boot disk
#      is wiped, the attached data volume survives. That wipe takes
#      /var/lib/docker with it, so the named volume's metadata is gone (docker
#      itself is usually not even installed yet). `docker volume inspect` fails,
#      the function returned 1, and the guard did not fire — in precisely the
#      disaster it was written for.
#   2. Every deploy chains infra/compose/docker-compose.volume.yml, which
#      redefines pg_data as a `local` driver bind onto $LIBRIANT_DATA_ROOT/postgres.
#      A local-driver bind volume STILL reports .Mountpoint as
#      /var/lib/docker/volumes/<name>/_data, which holds no PG_VERSION — so even
#      on a healthy box the check looked in the wrong directory.
#
# So look at the filesystem first, with no Docker involved. The docker-volume
# probe is kept only as a fallback for a host running the prod file WITHOUT the
# volume overlay, where the cluster really does live inside /var/lib/docker.
# Where persistent data lives. $LIBRIANT_DATA_ROOT may come from the
# environment, from a .env.prod written by an earlier run, or from this script's
# own default — in that order. One helper so the guard below and the on-volume
# copy at the end can never disagree about which directory they mean.
# (`ensure_default LIBRIANT_DATA_ROOT` runs AFTER the guard, so on a first run
# the getv is empty and the literal default is what answers.)
data_root() {
  local root
  root="${LIBRIANT_DATA_ROOT:-$(getv LIBRIANT_DATA_ROOT)}"
  [ -n "${root}" ] || root=/mnt/libriant
  printf '%s' "${root}"
}

pg_data_initialized() {
  local root vol mp
  root="$(data_root)"
  if [ -f "${root}/postgres/PG_VERSION" ]; then
    echo "  (found an initialized Postgres cluster at ${root}/postgres)" >&2
    return 0
  fi

  command -v docker >/dev/null 2>&1 || return 1
  vol="${COMPOSE_PROJECT_NAME:-$(getv COMPOSE_PROJECT_NAME)}"
  [ -n "${vol}" ] || vol=libriant
  mp="$(docker volume inspect --format '{{.Mountpoint}}' "${vol}_pg_data" 2>/dev/null)" || return 1
  [ -n "${mp}" ] && [ -f "${mp}/PG_VERSION" ]
}

# CRITICAL guard: never regenerate the DB password when the DB already exists
# but the env file lost it (e.g. boot-disk rebuild while the data volume
# survived). Minting a new one here desyncs from the password baked into the
# existing cluster and locks the app out. Fail loud so the operator restores
# the real value from their .env.prod backup first.
if [ -z "$(getv POSTGRES_PASSWORD)" ] && pg_data_initialized; then
  echo "  ! POSTGRES_PASSWORD is missing but an initialized Postgres cluster exists." >&2
  echo "  ! Refusing to mint a new password (it would lock the app out of the surviving DB)." >&2
  echo "  ! Recover it, in this order:" >&2
  echo "  !   1. \${LIBRIANT_DATA_ROOT:-/mnt/libriant}/env/.env.prod  (written by this script," >&2
  echo "  !      on the volume that survives a boot-disk rebuild — see save_env_copy below)" >&2
  echo "  !   2. your own off-host backup of /srv/libriant/.env.prod" >&2
  echo "  !   3. last resort: stop the stack, start postgres alone with" >&2
  echo "  !      POSTGRES_HOST_AUTH_METHOD=trust, and ALTER USER libriant PASSWORD '<new>';" >&2
  echo "  ! Then put the value in ${ENV_FILE} and re-run. Do not delete the data directory." >&2
  exit 3
fi

echo "Ensuring secrets in ${ENV_FILE} ..."
ensure_rand SESSION_SECRET 32
# Peppers the IP hash behind the marketing form's throttle. The privacy notice
# promises a secret key, so there is no safe shared default.
ensure_rand HASH_PEPPER 32
ensure_rand ADMIN_SESSION_SECRET 32
ensure_rand IMPERSONATION_SECRET 32
ensure_rand STORAGE_SIGNING_SECRET 32
ensure_rand MFA_MASTER_KEY 32        # 32 bytes -> 64 hex chars (AES-256)
ensure_rand POSTGRES_PASSWORD 24     # preserved if the DB already has one

echo "Ensuring config defaults ..."
ensure_default BILLING_ENABLED false # free launch: all tenants get every feature; set 'true' to enforce plans
# billing-02: `none` means the API loads NO Stripe driver — every billing
# action refuses with a 503 and POST /webhooks/stripe answers 503 without
# verifying anything. This line used to write `fake`, an in-memory stand-in
# that verified webhook signatures against a secret published in this
# repository; since that endpoint is unauthenticated by design, every host this
# script provisioned could have its libraries' subscriptions rewritten by
# anyone on the internet. `fake` is development/test only now.
#
# Hosts provisioned before that change still carry STRIPE_DRIVER=fake, and
# ensure_default never overwrites an existing value — so rewrite it here.
# Safe: 'fake' on a server always meant "we are not charging anyone", which is
# exactly what 'none' does, minus the remote-write hole. Anyone actually taking
# payments has 'real' and is untouched.
if [ "$(getv STRIPE_DRIVER)" = "fake" ]; then
  setv STRIPE_DRIVER none
  echo "  migrated STRIPE_DRIVER=fake -> none (the stand-in driver is dev/test only)"
fi
ensure_default STRIPE_DRIVER none    # billing off; set 'real' + keys to charge
# boot-and-config-05. docker-compose.prod.yml passes EMAIL_DRIVER through UNSET
# on purpose (`${EMAIL_DRIVER:-}`), so that env.ts's fail-fast makes an operator
# choose. Writing `console` here fills that gap before they ever see it, and the
# original line did so in one quiet `set EMAIL_DRIVER=console` among thirty
# others. The default STAYS — console-only is the deliberate posture for this
# launch, there is no mail provider yet, and refusing to boot would be refusing
# the configuration the owner chose — but it is no longer silent.
if [ -z "$(getv EMAIL_DRIVER)" ]; then
  setv EMAIL_DRIVER console
  echo
  echo "  !! EMAIL_DRIVER=console — NOTHING IS DELIVERED."
  echo "     Password resets, e-mail verification and staff invites compose a"
  echo "     message and send it nowhere. That is recoverable: an owner admin can"
  echo "     issue a reset link from /admin/account-recovery (RUNBOOK §4.3a)."
  echo "     To actually send mail, set EMAIL_DRIVER=resend + RESEND_API_KEY (or"
  echo "     smtp + SMTP_URL) in .env.prod and restart api + worker."
  echo
fi
# PUBLIC_HOST is the APP host; the marketing site owns the apex. Changing this
# default only affects a NEWLY provisioned host — an existing .env.prod keeps
# whatever it already has, which is why the migration needs a manual edit there.
ensure_default PUBLIC_HOST app.libriant.com
ensure_default SITE_HOST libriant.com
ensure_default PUBLIC_APEX_DOMAIN libriant.com
ensure_default ADMIN_HOST admin.libriant.com
ensure_default ACME_EMAIL ops@libriant.com
ensure_default IMAGE_TAG latest
ensure_default COMPOSE_PROJECT_NAME libriant
ensure_default LIBRIANT_DATA_ROOT /mnt/libriant
ensure_default BACKUP_KEEP_DAYS 14
# Which host address caddy's 80/443 are published on. IPv4-only ON PURPOSE:
# a wildcard publish also binds [::], and because no compose network sets
# enable_ipv6 a v6 connection is then relayed by Docker's userland proxy from
# the bridge gateway — which made every v6 client look private to the edge and
# handed them a fresh rate-limit bucket per forged header (authn-authz-01).
# Read the long note above `ports:` in infra/compose/docker-compose.prod.yml
# before changing this; it is one of four changes that must be made together.
ensure_default EDGE_BIND_IPV4 0.0.0.0

# Operator-supplied values with no safe default. In --auto we leave them blank
# (admin creation is then skipped until you set them); interactively we ask.
ask() {  # ask KEY "Prompt" [secret]
  local k="$1" msg="$2" secret="${3:-}" val=""
  [ -n "$(getv "${k}")" ] && return 0
  [ "${AUTO}" = "1" ] && return 0
  if [ "${secret}" = "secret" ]; then
    read -rsp "  ${msg}: " val; echo
  else
    read -rp "  ${msg}: " val
  fi
  [ -n "${val}" ] || return 0
  if [ "${secret}" = "secret" ]; then set_quoted "${k}" "${val}"; else setv "${k}" "${val}"; fi
}

if [ "${AUTO}" = "0" ]; then echo "Operator settings (leave blank to skip):"; fi
ask IMAGE_OWNER "GitHub owner/org, lowercase (e.g. cybersystema)"
ask ADMIN_BOOTSTRAP_EMAIL "First admin email"
ask ADMIN_BOOTSTRAP_PASSWORD "First admin password" secret

# Sync any NEW keys from the .env.prod.example template that the explicit logic
# above doesn't already manage (e.g. DESKTOP_RELEASE_*) — so a .env.prod created
# by an older version of this script, or a fresh host, picks them up on the next
# run. Copies the template's committed line VERBATIM and ONLY when the key is
# entirely absent — it NEVER overwrites an operator-set value (same contract as
# the rest of this script). Runs LAST so secrets keep their generated values
# (they're already present by now) rather than the template's blanks.
#
# Skips IMAGE_OWNER: the template ships it as the placeholder `your-github-owner`,
# which must never be written into a live .env (it's set per host via `ask`).
TEMPLATE="$(cd "$(dirname "$0")" && pwd)/../.env.prod.example"
if [ -f "${TEMPLATE}" ]; then
  echo "Syncing any new keys from .env.prod.example ..."
  while IFS= read -r line || [ -n "${line}" ]; do
    case "${line}" in
      '' | \#*) continue ;; # blank line or comment
    esac
    key="${line%%=*}"
    case "${key}" in
      '' | *[!A-Za-z0-9_]*) continue ;; # not a KEY=value line
      IMAGE_OWNER) continue ;;          # per-host placeholder, handled by `ask`
    esac
    if ! grep -q "^${key}=" "${ENV_FILE}"; then
      printf '%s\n' "${line}" >> "${ENV_FILE}"
      echo "  added ${key} (from template)"
    fi
  done < "${TEMPLATE}"
fi

# Keep a copy where the DATA lives, not only where the OS lives.
#
# boot-and-config-06's second half: the guard above can only tell the operator
# "restore POSTGRES_PASSWORD from your backup" if a backup exists, and the
# failure mode it guards against — a Hetzner Rebuild — is precisely the event
# that destroys /srv/libriant/.env.prod while keeping the Postgres cluster. The
# password and the cluster it belongs to now travel together: whoever still has
# the data volume still has the credentials for it.
#
# This is not a downgrade in exposure. $LIBRIANT_DATA_ROOT already holds every
# byte of every library's database; a 600 file beside it changes nothing about
# who can read what. It is deliberately NOT a substitute for an off-host backup
# (a lost volume loses both) — see docs/RUNBOOK.md §8.
save_env_copy() {
  local root dest
  root="$(data_root)"
  # Only when the data root is actually a mounted directory. On a laptop, in CI,
  # or before the volume is mounted it will not be, and creating it would put a
  # secret on the boot disk under a path the operator believes is the volume.
  [ -d "${root}" ] || { echo "  (no ${root} - skipping the on-volume copy of ${ENV_FILE})"; return 0; }
  dest="${root}/env"
  mkdir -p "${dest}" 2>/dev/null || { echo "  ! could not create ${dest} - no on-volume copy made" >&2; return 0; }
  chmod 700 "${dest}" 2>/dev/null || true
  cp "${ENV_FILE}" "${dest}/.env.prod.new" 2>/dev/null || {
    echo "  ! could not write ${dest}/.env.prod - no on-volume copy made" >&2; return 0; }
  chmod 600 "${dest}/.env.prod.new"
  # Rename last: a reader never sees a half-written file, and a crash mid-copy
  # leaves the previous good copy in place rather than a truncated one.
  mv -f "${dest}/.env.prod.new" "${dest}/.env.prod"
  echo "  copied ${ENV_FILE} -> ${dest}/.env.prod (survives a boot-disk rebuild)"
}
save_env_copy

echo "Done - ${ENV_FILE} is ready."
