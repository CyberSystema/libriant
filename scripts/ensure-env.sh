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

echo "Ensuring secrets in ${ENV_FILE} ..."
ensure_rand SESSION_SECRET 32
ensure_rand ADMIN_SESSION_SECRET 32
ensure_rand IMPERSONATION_SECRET 32
ensure_rand STORAGE_SIGNING_SECRET 32
ensure_rand MFA_MASTER_KEY 32        # 32 bytes -> 64 hex chars (AES-256)
ensure_rand POSTGRES_PASSWORD 24     # preserved if the DB already has one

echo "Ensuring config defaults ..."
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

echo "Done - ${ENV_FILE} is ready."
