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

# True if the Postgres data volume already holds an initialized cluster.
# Used to refuse minting a fresh POSTGRES_PASSWORD over a surviving DB (which
# would lock the app out of its own database — see the guard below).
pg_data_initialized() {
  command -v docker >/dev/null 2>&1 || return 1
  local vol mp
  vol="${COMPOSE_PROJECT_NAME:-libriant}_pg_data"
  mp="$(docker volume inspect --format '{{.Mountpoint}}' "${vol}" 2>/dev/null)" || return 1
  [ -n "${mp}" ] && [ -f "${mp}/PG_VERSION" ]
}

# CRITICAL guard: never regenerate the DB password when the DB already exists
# but the env file lost it (e.g. boot-disk rebuild while the data volume
# survived). Minting a new one here desyncs from the password baked into the
# existing cluster and locks the app out. Fail loud so the operator restores
# the real value from their .env.prod backup first.
if [ -z "$(getv POSTGRES_PASSWORD)" ] && pg_data_initialized; then
  echo "  ! POSTGRES_PASSWORD is missing but an initialized Postgres data volume exists." >&2
  echo "  ! Refusing to mint a new password (it would lock the app out of the surviving DB)." >&2
  echo "  ! Restore POSTGRES_PASSWORD from your .env.prod backup, then re-run." >&2
  exit 3
fi

echo "Ensuring secrets in ${ENV_FILE} ..."
ensure_rand SESSION_SECRET 32
ensure_rand ADMIN_SESSION_SECRET 32
ensure_rand IMPERSONATION_SECRET 32
ensure_rand STORAGE_SIGNING_SECRET 32
ensure_rand MFA_MASTER_KEY 32        # 32 bytes -> 64 hex chars (AES-256)
ensure_rand POSTGRES_PASSWORD 24     # preserved if the DB already has one

echo "Ensuring config defaults ..."
ensure_default BILLING_ENABLED false # free launch: all tenants get every feature; set 'true' to enforce plans
ensure_default STRIPE_DRIVER fake    # trial-safe; set 'real' + keys to charge
ensure_default EMAIL_DRIVER console  # trial-safe; set 'smtp' + SMTP_URL to send
ensure_default PUBLIC_HOST libriant.com
ensure_default ADMIN_HOST admin.libriant.com
ensure_default ACME_EMAIL ops@libriant.com
ensure_default IMAGE_TAG latest
ensure_default COMPOSE_PROJECT_NAME libriant
ensure_default LIBRIANT_DATA_ROOT /mnt/libriant
ensure_default BACKUP_KEEP_DAYS 14

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

echo "Done - ${ENV_FILE} is ready."
