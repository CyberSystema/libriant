#!/usr/bin/env bash
# =============================================================================
# Libriant — bare Ubuntu box -> a working Libriant server, in one script.
#
# This is docs/RUNBOOK.md §3 (first deploy, from bare metal), §6.1 (the `dc`
# helper) and §8.2 (the nightly backup, which NOTHING else installs) executed
# rather than copy-pasted, plus the origin firewall (authn-authz-01) that a
# green deploy also leaves undone.
#
# It ORCHESTRATES the scripts that already exist — scripts/ensure-env.sh,
# scripts/deploy-on-host.sh, scripts/prod-bootstrap.sh, scripts/backup.sh — and
# reimplements none of them. Everything it does itself is the glue the runbook
# describes in prose. Where it deviates from the runbook, the deviation is
# commented with the reason.
#
#   ssh root@<the box>
#   # get this file onto the box (scp, or paste it into an editor)
#   sudo bash install-server.sh
#
# ── HAVE THESE IN FRONT OF YOU BEFORE YOU START ─────────────────────────────
#
#   1. A SECOND SSH SESSION, open and working. The `ssh` step turns password
#      authentication off; if the key you rely on stops working after that,
#      only the provider console or a rescue boot gets you back in.
#   2. The Cloudflare Origin certificate — BOTH PEM blocks, with SANs for the
#      apex AND *.<apex>. No backup contains this pair. If it is not in your
#      password manager it exists nowhere else.
#   3. A browser logged in to GitHub with rights to add a read-only Deploy Key
#      to the repository. The `checkout` step generates a key and then STOPS
#      and waits for you.
#   4. The first admin e-mail and password (12 characters minimum —
#      bootstrap-admin.ts exits non-zero below that). Without both you get a
#      green deploy nobody can log into, and for the password nothing warns.
#   5. A password for the `deploy` account, and somewhere to store it. sudo
#      cannot authenticate without one and roughly a third of what follows is
#      sudo.
#   6. A backup encryption decision: an `age` RECIPIENT (public key, age1…,
#      the identity kept OFF this host) or a gpg passphrase file. backup.sh
#      REFUSES to run without one.
#   7. tmux or screen. The image build is 10–20 minutes cold; an SSH drop in
#      the middle of it kills the run.
#
# ── THE TWO WAYS THIS SCRIPT COULD RUIN YOUR DAY, AND WHAT STOPS IT ─────────
#
# 1. LOCKING YOU OUT. Three separate steps here can cost you the machine, and
#    each has its own guard.
#
#    §3.2a turns SSH password authentication off. If no account has a usable
#    authorized_keys that is a permanent lockout. The `ssh` step refuses to
#    write the drop-in until it has COUNTED a real public key for an account
#    that can still log in — parsing authorized_keys the way sshd does (a
#    @revoked line, a lapsed expiry-time and a @cert-authority line are all
#    NON-EMPTY and authenticate nobody holding a bare key), resolving
#    AuthorizedKeysFile out of `sshd -T`, honouring AllowUsers / AllowGroups /
#    DenyUsers, inspecting the account you are ACTUALLY logged in as (not just
#    root and $SUDO_USER), and checking the StrictModes permission bits that
#    make sshd ignore a key file that looks perfect. It checks the EFFECTIVE
#    config — all three of §3.2a's values — before reloading and again after,
#    and rolls its own change back rather than leave a box nobody can reach.
#
#    ufw is the same hazard from the other side. The `ufw` step reads the REAL
#    ssh port from the LISTENING SOCKET (`ss`, then ssh.socket's ListenStream,
#    then sshd's config, then this session) and never assumes 22 — because on a
#    socket-activated box, which Ubuntu has shipped by default since 22.10,
#    sshd_config's Port is IGNORED and `sshd -T` answers a different question
#    from the one being asked. It proves the allow rule is in the ruleset BEFORE
#    `ufw --force enable`, and — on a box with public IPv6 — turns the firewall
#    back off rather than leave it up with no v6 ssh rule.
#
#    The origin firewall (authn-authz-01) DROPs non-Cloudflare traffic to 80/443
#    at INPUT position 1. If sshd is on 443 — a common way through a corporate
#    egress filter — that is a lockout that looks completely green, because the
#    running session survives on conntrack. The `firewall` step reads the ssh
#    port and refuses rather than apply it.
#
# 2. DESTROYING AN EXISTING INSTALL. Assume this WILL be re-run on a box that
#    is already half — or fully — provisioned. So: no secret is ever minted
#    here (ensure-env.sh owns that and never overwrites; a POSTGRES_PASSWORD
#    keyed to a live cluster is unrecoverable). An existing origin certificate
#    is validated, never replaced, unless --replace-origin-cert, which backs
#    the old pair up first. No data directory is ever removed. An existing
#    deploy key is never regenerated. And the `git reset --hard` inside
#    deploy-on-host.sh is announced — with the list of tracked files AND the
#    list of unpushed local commits it would destroy — before anyone confirms
#    anything.
#
#    The sharpest edge of all is that ensure-env.sh's POSTGRES_PASSWORD guard
#    looks for a cluster at $LIBRIANT_DATA_ROOT. After a provider Rebuild the
#    boot disk (and /etc/fstab with it) is gone and the data volume is intact
#    but NOT MOUNTED — so that guard is pointed at an empty directory on the
#    root filesystem, does not fire, and a fresh password is minted over a live
#    database while 250 GiB of library data sits invisibly under the mountpoint.
#    Every step that could start writing there refuses outright when there is an
#    fstab entry or an unmounted formatted volume, and otherwise makes you type
#    BOOTDISK rather than press y.
#
# ── RESUMING ────────────────────────────────────────────────────────────────
#
# Every step decides whether it is needed by inspecting the MACHINE, so
# re-running after a failure is the normal way to use this. Nothing that
# already exists is regenerated.
#
#   sudo bash install-server.sh --status         what is done, what is not
#   sudo bash install-server.sh                  run, or resume
#   sudo bash install-server.sh --only deploy    re-run exactly one step
#   sudo bash install-server.sh --from checkout  resume from a named step
#   sudo bash install-server.sh --dry-run        print the plan, change nothing
#   sudo bash install-server.sh --verify-only    the §3.9 + firewall + backup
#                                                read-only checks, nothing else
#        bash install-server.sh --self-test      exercise this script's own
#                                                parsers and validators
#
# Flags:
#   --dry-run              print what each step would do; change nothing
#   --status               print the step table and exit
#   --verify-only          run only the read-only verification
#   --from <step>          resume at a step (--list-steps for the ids)
#   --only <step[,step…]>  run just these steps, satisfied or not
#   --skip <step[,step…]>  run everything except these
#   --force                run steps even when they report themselves satisfied
#   --list-steps           print the step ids and stop
#   --repo <git-url>       the checkout source (default: §3.6's)
#   --origin-crt <file>    read the origin certificate from files instead of
#   --origin-key <file>    pasting the two PEM blocks
#   --replace-origin-cert  replace an EXISTING origin pair (backs it up first)
#   --self-test            run the internal tests and exit; touches only a
#                          temp directory, needs no root and no network
#
# ── WHAT IT DELIBERATELY DOES NOT DO ────────────────────────────────────────
#
# It does not put the box in DNS and does not do the cutover (§5.4) — a first
# deploy on a box nobody can reach is the correct outcome here, which is why
# the deploy prints "nothing is public" rather than "you are live". It does not
# send mail: EMAIL_DRIVER=console is the deliberate posture for this launch and
# nothing in here depends on delivery. It cannot prove the origin firewall from
# the inside; an external nmap over BOTH address families, from a machine that
# is not this one, is the only check that cannot be fooled, and it prints those
# commands for you. The closing summary lists the rest.
# =============================================================================
set -euo pipefail

# ── Paths. These are the deployed layout that deploy-on-host.sh, backup.sh and
#    the compose volume overlay all assume. Overridable from the environment
#    because the runbook describes ONE box and this script should not hard-code
#    facts about it that a second box would contradict. ──────────────────────
DEPLOY_USER="${LIBRIANT_DEPLOY_USER:-deploy}"
SRV_ROOT="${LIBRIANT_APP_ROOT:-/srv/libriant}"
APP_DIR="${LIBRIANT_APP_DIR:-${SRV_ROOT}/app}"
ENV_FILE="${LIBRIANT_ENV_FILE:-${SRV_ROOT}/.env.prod}"
DATA_ROOT="${LIBRIANT_DATA_ROOT:-/mnt/libriant}"
LOG_DIR="${LIBRIANT_LOG_DIR:-/var/log/libriant}"
STATE_DIR="${LIBRIANT_INSTALL_STATE:-/var/lib/libriant-install}"
INSTALL_LOG="${STATE_DIR}/install.log"
COMPOSE_PROJECT=libriant
CRON_FILE="${LIBRIANT_CRON_FILE:-/etc/cron.d/libriant-backup}"
# The sshd configuration, as variables so the lockout guard can be driven
# against a fixture directory on a machine that is not an Ubuntu server.
# Nothing but the tests ever overrides them.
SSHD_CONFIG="${LIBRIANT_SSHD_CONFIG:-/etc/ssh/sshd_config}"
UFW_DEFAULTS="${LIBRIANT_UFW_DEFAULTS:-/etc/default/ufw}"
SSHD_CONFIG_DIR="${LIBRIANT_SSHD_CONFIG_DIR:-/etc/ssh/sshd_config.d}"
SSHD_DROPIN="${SSHD_CONFIG_DIR}/00-libriant.conf"
# node-exporter's textfile collector reads this. It must match the bind mount in
# infra/monitoring/docker-compose.monitoring.yml AND backup.sh's own default,
# because backup.sh REFUSES to run when neither this directory is writable nor
# BACKUP_HEARTBEAT_URL is set — a backup that stops happening has to be
# noticeable, and `absent()` on this metric is the only alert shape that fires
# for a backup that never ran at all.
TEXTFILE_DIR="${LIBRIANT_TEXTFILE_DIR:-/var/lib/node_exporter/textfile}"
# §3.6 names this repository. --repo overrides it for a fork or a mirror.
REPO_URL="${LIBRIANT_REPO_SSH:-git@github.com:CyberSystema/libriant.git}"
DEPLOY_KEY_NAME=github-deploy
# The uid api and worker run as inside their images (`USER node`). Docker does
# not chown a bind mount, so the uploads tree has to be given to it by hand. A
# NUMBER on purpose: it is the CONTAINER's uid, not necessarily $DEPLOY_USER's.
CONTAINER_UID=1000

DEPLOY_HOME="/home/${DEPLOY_USER}"
DEPLOY_KEY="${DEPLOY_HOME}/.ssh/${DEPLOY_KEY_NAME}"

DRY=0
FORCE=0
VERIFY_ONLY=0
WANT_STATUS=0
VERIFY_RC=0
REPLACE_CERT=0
ORIGIN_CRT_SRC=""
ORIGIN_KEY_SRC=""
FROM_STEP=""
ONLY_STEPS=""
SKIP_STEPS=""

# The order is docs/RUNBOOK.md §3's order. `briefing` and `stock` come first
# because both are cheap and both can stop the run before anything is touched.
#
# ONE DELIBERATE DEPARTURE: `backup` runs BEFORE `firewall`, though the runbook
# puts the origin lockdown earlier in the narrative. The backup depends on the
# checkout and a running stack; it does not depend on the firewall. The firewall
# step, by contrast, DIES on any FATAL finding — and one of those FATALs is
# "ip6tables has no jump from DOCKER-USER", which Docker produces whenever its
# daemon has ip6tables off. That is an entirely plausible box state, it has
# nothing to do with backups, and in the other order it meant the one thing this
# installer exists to add — the nightly backup NOTHING else installs, and
# nothing warns is missing — was never reached. An operator who could not
# resolve an ip6tables question walked away from a production box with zero
# backups, which looks exactly like a box that has them.
STEPS="briefing stock ssh ufw packages docker user dirs checkout env cert dchelper deploy backup firewall verify"

# ── Output. Matches deploy-on-host.sh: bold ▸ banners, a red ✗ for a die. ────
if [ -t 1 ]; then
  C_B=$'\033[1m'; C_R=$'\033[31m'; C_Y=$'\033[33m'; C_G=$'\033[32m'; C_D=$'\033[2m'; C_0=$'\033[0m'
else
  C_B=""; C_R=""; C_Y=""; C_G=""; C_D=""; C_0=""
fi

# Best-effort transcript. $STATE_DIR is created by the driver before the first
# step, so everything from the briefing onward is recorded — including the SSH
# and firewall decisions, which are the ones you most want a record of.
_logline() {
  [ -d "$STATE_DIR" ] || return 0
  printf '%s %s\n' "$(date +'%Y-%m-%dT%H:%M:%S%z')" "$*" >> "$INSTALL_LOG" 2>/dev/null || true
  # 0600 on every append, so the transcript never inherits a loose umask. It
  # carries no secret — this script never prints one — but it does carry a
  # complete record of how this box was hardened.
  chmod 0600 "$INSTALL_LOG" 2>/dev/null || true
}
say()  { printf '\n%s▸ %s%s\n' "$C_B" "$*" "$C_0"; _logline "STEP $*"; }
ok()   { printf '  %sok%s   %s\n' "$C_G" "$C_0" "$*"; _logline "ok   $*"; }
note() { printf '  %s·%s    %s\n' "$C_D" "$C_0" "$*"; _logline "note $*"; }
warn() { printf '  %s!%s    %s\n' "$C_Y" "$C_0" "$*" >&2; _logline "WARN $*"; }
die()  { printf '\n%s✗ %s%s\n' "$C_R" "$*" "$C_0" >&2; _logline "DIE  $*"; exit 1; }
banner() {
  printf '\n%s  ══════════════════════════════════════════════════════════════════%s\n' "$C_Y" "$C_0"
  printf '%s  %s%s\n' "$C_Y" "$*" "$C_0"
  printf '%s  ══════════════════════════════════════════════════════════════════%s\n\n' "$C_Y" "$C_0"
}

# ════════════════════════════════════════════════════════════════════════════
# PURE HELPERS
#
# Everything that parses, validates or decides lives here, callable, with no
# side effects. This installer's first real run is on a production box, so
# `--self-test` below is the only chance any of it gets to be exercised before
# that. If you add a decision, add it HERE and add a case to the tests.
# ════════════════════════════════════════════════════════════════════════════

# The key types sshd will accept in an authorized_keys file. ssh-dss is included
# because sshd may still be configured to take one, and the question here is
# "can this operator still log in", not "is this key a good idea".
SSH_KEY_TYPES="ssh-ed25519 ssh-rsa ecdsa-sha2-nistp256 ecdsa-sha2-nistp384 ecdsa-sha2-nistp521 sk-ssh-ed25519@openssh.com sk-ecdsa-sha2-nistp256@openssh.com ssh-dss"

is_ssh_key_type() {
  local t="$1" k
  for k in $SSH_KEY_TYPES; do [ "$t" = "$k" ] && return 0; done
  return 1
}

# A key blob is base64 and nothing else. 40 characters is well under the
# shortest real ed25519 blob (68) and well over any plausible typo.
is_key_blob() {
  local s="${1:-}"
  [ "${#s}" -ge 40 ] || return 1
  case "$s" in *[!A-Za-z0-9+/=]*) return 1 ;; esac
  return 0
}

# opts_expired OPTIONS NOW — true when an authorized_keys options field carries
# an `expiry-time="…"` that has already passed.
#
# sshd's format is YYYYMMDD[HHMM[SS]], optionally with a trailing Z. A lapsed
# key is a NON-EMPTY, perfectly formed line that authenticates nobody, which is
# exactly the class of file count_usable_pubkeys exists to catch — and the one
# member of that class that looks completely fine to the eye. NOW is passed in
# so this is deterministic and testable.
opts_expired() {
  local opts="${1:-}" now="${2:-}" rest exp
  case "$opts" in *[Ee][Xx][Pp][Ii][Rr][Yy]-[Tt][Ii][Mm][Ee]=*) : ;; *) return 1 ;; esac
  rest="${opts#*[Ee][Xx][Pp][Ii][Rr][Yy]-[Tt][Ii][Mm][Ee]=}"
  rest="${rest#\"}"
  exp="${rest%%[\",]*}"
  exp="${exp%Z}"
  case "$exp" in ''|*[!0-9]*) return 1 ;; esac       # unparseable: do not judge it
  # Compare on the shorter of the two, so 20200101 and 20200101120000 are
  # comparable without inventing digits either way.
  local n="$now"
  if [ "${#exp}" -lt "${#n}" ]; then n="${n:0:${#exp}}"
  elif [ "${#exp}" -gt "${#n}" ]; then exp="${exp:0:${#n}}"; fi
  [ "$exp" -lt "$n" ] 2>/dev/null
}

# count_usable_pubkeys FILE — how many lines sshd would accept as a public key
# AND actually authenticate someone with today.
#
# THE LOCKOUT CHECK. `[ -s authorized_keys ]` is NOT this check: a file holding
# a PRIVATE key, a pasted fingerprint, one comment line, or a key mangled onto
# two lines by a mail client is non-empty and authenticates nobody. Handles an
# options field before the key type (command=…, from=…, restrict), CRLF from a
# Windows paste, and leading whitespace.
#
# Three refusals that were added after this function was driven against real
# files, each of which it used to count as usable:
#   @revoked <key>          a REVOCATION entry. sshd refuses that key outright.
#   expiry-time="20200101"  a lapsed key: valid shape, authenticates nobody.
#   @cert-authority <key>   a CA line. It genuinely authenticates CERTIFICATE
#                           holders, but nobody holding a bare key — so counting
#                           it as "1 usable key" would certify a box where the
#                           operator's own key does not work. Reported
#                           separately by count_ca_lines instead.
# And one acceptance: an options field with a QUOTED SPACE
# (command="/usr/bin/wrap --flag arg") pushed the key type past position 2 and
# produced a spurious refusal. The scan below walks every token looking for the
# first key type whose NEXT token is a blob, which is the shape sshd requires.
count_usable_pubkeys() {
  local f="$1" line n=0 i tok nxt now
  [ -r "$f" ] || { printf '0\n'; return 0; }
  now="$(date +%Y%m%d%H%M%S 2>/dev/null || echo 00000000000000)"
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    line="${line#"${line%%[![:space:]]*}"}"
    case "$line" in ''|'#'*) continue ;; esac
    # Globbing off: an options field may legitimately contain `*`
    # (from="*.example.org"), and splitting it with globs on would expand it
    # against the current directory.
    set -f
    # shellcheck disable=SC2086
    set -- $line
    set +f
    # A marker option is the FIRST token and starts with '@'. @revoked and
    # @cert-authority are both non-authenticating for a bare key.
    case "${1:-}" in '@'*) continue ;; esac
    opts_expired "${1:-}" "$now" && continue
    i=1
    while [ "$i" -le "$#" ]; do
      eval "tok=\${$i}"
      if is_ssh_key_type "$tok"; then
        eval "nxt=\${$((i + 1)):-}"
        if is_key_blob "$nxt"; then n=$((n + 1)); break; fi
      fi
      i=$((i + 1))
    done
  done < "$f"
  printf '%s\n' "$n"
}

# count_ca_lines FILE — @cert-authority entries. Reported, never counted as a
# way back in: a box whose authorized_keys holds ONLY a CA line authenticates
# certificate holders and nobody else, and "1 usable key" would be a lie.
count_ca_lines() {
  local f="$1" line n=0
  [ -r "$f" ] || { printf '0\n'; return 0; }
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    line="${line#"${line%%[![:space:]]*}"}"
    case "$line" in '@cert-authority'*) n=$((n + 1)) ;; esac
  done < "$f"
  printf '%s\n' "$n"
}

# mode_unsafe MODE — true when the group or other WRITE bit is set.
#
# sshd's StrictModes (on by default) silently IGNORES an authorized_keys file, a
# .ssh directory or a home directory that is group- or world-writable. The key
# is right there, `ssh-keygen -lf` prints it happily, and authentication fails
# anyway. Checking this BEFORE disabling passwords is the difference between a
# clean run and a rescue boot.
mode_unsafe() {
  local m="${1:-}" g o
  [ -n "$m" ] || return 1
  # Zero-pad BEFORE slicing. `stat -c '%a'` prints no leading zeros, so mode
  # 0006 arrives as the single character "6"; `${m: -2}` on a one-character
  # string yields the EMPTY string, no case matches, and a world-writable file
  # is reported safe by the one function that decides whether StrictModes will
  # honour a key.
  m="000${m}"
  m="${m: -2}"
  g="${m:0:1}"; o="${m:1:1}"
  case "$g" in 2|3|6|7) return 0 ;; esac
  case "$o" in 2|3|6|7) return 0 ;; esac
  return 1
}

# Two stat dialects, for the same reason deploy-on-host.sh carries two: GNU on
# the Ubuntu host this installs, BSD on the machine the helpers were driven on.
stat_mode() { stat -L -c '%a' "$1" 2>/dev/null || stat -L -f '%Lp' "$1" 2>/dev/null; }
stat_uid()  { stat -L -c '%u' "$1" 2>/dev/null || stat -L -f '%u'  "$1" 2>/dev/null; }
stat_owner(){ stat -L -c '%U:%G' "$1" 2>/dev/null || stat -L -f '%Su:%Sg' "$1" 2>/dev/null; }

# sshd_values NAME — every value `sshd -T` reports for a keyword, one per line.
# Reads the captured output on stdin, so it is testable against a fixture with
# no sshd present. `port` legitimately repeats; so can `listenaddress`.
sshd_values() {
  local want k v
  want="$(printf '%s' "$1" | tr 'A-Z' 'a-z')"
  while read -r k v; do
    [ "$k" = "$want" ] && printf '%s\n' "$v"
  done
  return 0
}

# sshd_ports — every port sshd listens on, from `sshd -T` output on stdin.
# Both forms: a bare `port 2222`, and `listenaddress 10.0.0.1:2222` (and the
# bracketed v6 form), because a box that sets ListenAddress with a port does not
# necessarily also emit a matching `port` line.
sshd_ports() {
  local line k v p
  while read -r k v; do
    case "$k" in
      port) printf '%s\n' "$v" ;;
      listenaddress)
        case "$v" in
          *']:'*) p="${v##*]:}" ;;
          *:*:*) continue ;;          # a bare IPv6 address, no port
          *:*)   p="${v##*:}" ;;
          *) continue ;;
        esac
        case "$p" in ''|*[!0-9]*) : ;; *) printf '%s\n' "$p" ;; esac
        ;;
    esac
  done
  return 0
}

# ── THE PORT sshd IS ACTUALLY LISTENING ON, not the one its config names ────
#
# `sshd -T` is NOT authoritative on a socket-activated box, and Ubuntu has
# shipped `ssh.socket` ENABLED BY DEFAULT since 22.10. Under socket activation
# the listening port comes from ssh.socket's ListenStream= and `Port` in
# sshd_config is IGNORED — so `sshd -T` prints the config's value while the
# world connects somewhere else. Both directions are a lockout:
#
#   socket says 2222, config says 22  ->  ufw allows 22, every NEW connection
#                                         to 2222 is dropped. The current
#                                         session survives on conntrack, so
#                                         nothing looks wrong until the build
#                                         finishes and the terminal is closed.
#   config says 2222, socket says 22  ->  ufw allows 2222 ONLY, and 22 — the
#                                         port actually carrying traffic — is
#                                         denied immediately.
#
# 26.04's behaviour here is UNVERIFIED, which is precisely why the port is read
# from the listening socket rather than assumed either way. Both readers below
# are pure, take their input on stdin, and are driven in --self-test.

# ss_ssh_ports — ports from `ss -Hlntp` output on stdin, restricted to rows
# whose process column names sshd. Column 4 of `ss -ln` is the local address;
# it is `0.0.0.0:22`, `[::]:22`, `*:22` or `10.0.0.1:22`, so the port is
# everything after the last `:` or `]`.
ss_ssh_ports() {
  local line addr p
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in *sshd*) : ;; *) continue ;; esac
    set -f
    # shellcheck disable=SC2086
    set -- $line
    set +f
    addr="${4:-}"
    [ -n "$addr" ] || continue
    case "$addr" in
      *']:'*) p="${addr##*]:}" ;;
      *:*)    p="${addr##*:}" ;;
      *) continue ;;
    esac
    case "$p" in ''|*[!0-9]*) continue ;; esac
    printf '%s\n' "$p"
  done
  return 0
}

# socket_listen_ports — ports from `systemctl show ssh.socket -p Listen --value`
# on stdin. That prints one entry per line in the shape `[::]:22 (Stream)` or
# `0.0.0.0:2222 (Stream)`.
socket_listen_ports() {
  local line addr p
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    set -f
    # shellcheck disable=SC2086
    set -- $line
    set +f
    addr="${1:-}"
    [ -n "$addr" ] || continue
    case "$addr" in
      *']:'*) p="${addr##*]:}" ;;
      *:*)    p="${addr##*:}" ;;
      *) continue ;;
    esac
    case "$p" in ''|*[!0-9]*) continue ;; esac
    printf '%s\n' "$p"
  done
  return 0
}

# sshd_permits_user USER GROUPS ALLOWUSERS ALLOWGROUPS DENYUSERS DENYGROUPS
#
# A key that sshd will refuse to consider is not a way back in. A hardening
# image that ships `AllowGroups sudo` or `DenyUsers root` makes root's perfectly
# valid key worthless, and the lockout guard would otherwise count it and
# certify the change as safe. All four lists are sshd PATTERN lists, so the
# match is a glob, not a string compare.
sshd_permits_user() {
  local user="$1" groups="$2" au="$3" ag="$4" du="$5" dg="$6" pat g
  for pat in $du; do
    # shellcheck disable=SC2254
    case "$user" in ${pat%%@*}) return 1 ;; esac
  done
  for pat in $dg; do
    for g in $groups; do
      # shellcheck disable=SC2254
      case "$g" in $pat) return 1 ;; esac
    done
  done
  if [ -n "$(printf '%s' "$au" | tr -d '[:space:]')" ]; then
    local hit=1
    for pat in $au; do
      # shellcheck disable=SC2254
      case "$user" in ${pat%%@*}) hit=0 ;; esac
    done
    [ "$hit" = 0 ] || return 1
  fi
  if [ -n "$(printf '%s' "$ag" | tr -d '[:space:]')" ]; then
    local hit=1
    for pat in $ag; do
      for g in $groups; do
        # shellcheck disable=SC2254
        case "$g" in $pat) hit=0 ;; esac
      done
    done
    [ "$hit" = 0 ] || return 1
  fi
  return 0
}

# unmounted_filesystems — block devices that hold a filesystem and are mounted
# NOWHERE, from `lsblk -Pno NAME,FSTYPE,MOUNTPOINT,SIZE` on stdin.
#
# -P (key="value") and not -r: in raw mode an EMPTY MOUNTPOINT collapses into
# the run of spaces beside it, awk's default field splitting closes the gap, and
# the SIZE column is read as the mountpoint — so every unmounted volume looks
# mounted and the one question this asks ("did the data volume fail to come
# back?") always answers no. Key="value" pairs cannot collapse.
unmounted_filesystems() {
  local line name fstype mp size
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in *NAME=*) : ;; *) continue ;; esac
    name="$(printf '%s' "$line"   | sed -n 's/.*[^A-Z_]\{0,1\}NAME="\([^"]*\)".*/\1/p')"
    fstype="$(printf '%s' "$line" | sed -n 's/.*FSTYPE="\([^"]*\)".*/\1/p')"
    mp="$(printf '%s' "$line"     | sed -n 's/.*MOUNTPOINT="\([^"]*\)".*/\1/p')"
    size="$(printf '%s' "$line"   | sed -n 's/.*SIZE="\([^"]*\)".*/\1/p')"
    [ -n "$fstype" ] || continue
    [ "$fstype" = swap ] && continue
    [ -n "$mp" ] && continue
    printf '/dev/%s  %s  %s\n' "$name" "$fstype" "$size"
  done
  return 0
}

# ssh_port_from_connection — the SERVER port of the current session, from a
# $SSH_CONNECTION string ("client_ip client_port server_ip server_port") given
# as $1. Sudo's env_reset usually drops SSH_CONNECTION, so this is a bonus
# source rather than the primary one — but when it IS present it is the one
# port we know for certain carries a working session.
ssh_port_from_connection() {
  local s="${1:-}" p
  set -f
  # shellcheck disable=SC2086
  set -- $s
  set +f
  [ "$#" -ge 4 ] || return 1
  p="$4"
  case "$p" in ''|*[!0-9]*) return 1 ;; esac
  printf '%s\n' "$p"
}

# resolve_authorized_keys HOME USER PATTERN... — expand sshd's
# AuthorizedKeysFile patterns into real paths. %h and %u are sshd's tokens; a
# relative pattern is relative to the home directory. Getting this wrong means
# the lockout guard inspects a file sshd never reads.
resolve_authorized_keys() {
  local home="$1" user="$2" p out
  shift 2
  for p in "$@"; do
    out="$p"
    out="${out//%h/$home}"
    out="${out//%u/$user}"
    case "$out" in
      /*) : ;;
      *) out="${home}/${out}" ;;
    esac
    printf '%s\n' "$out"
  done
}

# shadow_state — P (usable password) / L (locked) / NP (none) / unknown, from
# `passwd -S <user>` output on stdin.
#
# `adduser --disabled-password` leaves a `!` in the shadow field, so sudo for
# that account cannot authenticate and every sudo in the runbook fails with an
# unpassable prompt. This is how we decide whether §3.4's `passwd deploy` still
# needs doing — and how a re-run avoids resetting a password the operator has
# already stored in their password manager.
shadow_state() {
  local line f2
  IFS= read -r line || true
  set -f
  # shellcheck disable=SC2086
  set -- $line
  set +f
  f2="${2:-}"
  case "$f2" in
    P|L|NP) printf '%s\n' "$f2" ;;
    *) printf 'unknown\n' ;;
  esac
}

# compose_major — 2 from "Docker Compose version v2.29.7", 1 from the v1 python
# binary's "docker-compose version 1.29.2, build …". §3.3: v2 is REQUIRED. The
# stack uses the non-Swarm mem_limit / cpus / pids_limit keys, which v1 ignores
# ENTIRELY — it would start the stack with no resource caps at all.
compose_major() {
  local line v
  IFS= read -r line || true
  case "$line" in
    *"version v"[0-9]*) v="${line#*version v}" ;;
    *"version "[0-9]*)  v="${line#*version }" ;;
    *) printf '0\n'; return 0 ;;
  esac
  v="${v%%.*}"
  case "$v" in
    ''|*[!0-9]*) printf '0\n' ;;
    *) printf '%s\n' "$v" ;;
  esac
}

# http_status_ok — true when a `curl -I` first line is a 200. §3.3's UNVERIFIED
# check: whether Docker's apt repo has published a suite for this release.
http_status_ok() {
  local line
  IFS= read -r line || true
  line="${line%$'\r'}"
  case "$line" in
    HTTP/*" 200"*) return 0 ;;
    *) return 1 ;;
  esac
}

# env_get FILE KEY — the value the app will actually see.
#
# Shell sourcing means the LAST assignment wins; ensure-env.sh's own getv reads
# the FIRST. They only disagree when a key is duplicated, which env_dupe_keys
# reports — but read it the way the running stack does.
env_get() {
  local f="$1" k="$2" v
  [ -r "$f" ] || return 1
  v="$(sed -n "s/^${k}=//p" "$f" | tail -n1)"
  case "$v" in
    "'"*"'") v="${v#\'}"; v="${v%\'}" ;;
    '"'*'"') v="${v#\"}"; v="${v%\"}" ;;
  esac
  printf '%s\n' "$v"
}

# env_set_stream KEY VALUE  (the env file on stdin) — the file with KEY set.
#
# THE BUG THIS EXISTS FOR: the old writer refused to touch a key that was
# already PRESENT, and `ensure-env.sh` copies every key that is in
# `.env.prod.example` but missing from your file — several of them with an
# EMPTY value. So `BACKUP_AGE_RECIPIENT=` could exist while being unset, the
# backup step's own detection (which reads the VALUE) correctly said "not
# configured" and prompted, and the writer then said "already set — left alone"
# and threw the operator's answer away. The result is a cron the operator
# watched being installed and a backup.sh that aborts before the first byte,
# every night, in a log nobody reads.
#
# So: an EMPTY value is treated as absent and REPLACED in place; a non-empty
# value is never overwritten (same contract as ensure-env.sh); an absent key is
# appended. Pure, so the three cases are driven in --self-test.
# The non-overwrite contract lives HERE, not only in the caller, so it holds
# however this is called: a line that already carries a real value is copied
# through untouched and suppresses the append.
env_set_stream() {
  local k="$1" v="$2" line seen=0 out=""
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      "${k}="*)
        if [ "$seen" = 0 ]; then
          seen=1
          if [ -z "${line#"${k}="}" ]; then
            out="${out}${k}=${v}"$'\n'; continue     # present but EMPTY: fill it in
          fi
        fi
        ;;                                           # already has a value: leave it
    esac
    out="${out}${line}"$'\n'
  done
  [ "$seen" = 1 ] || out="${out}${k}=${v}"$'\n'
  printf '%s' "$out"
}

# env_key_state FILE KEY — set / empty / absent. The three answers the writer
# and the detector must agree on.
env_key_state() {
  local f="$1" k="$2" v
  [ -r "$f" ] || { printf 'absent\n'; return 0; }
  grep -q "^${k}=" "$f" 2>/dev/null || { printf 'absent\n'; return 0; }
  v="$(env_get "$f" "$k" || true)"
  if [ -n "$v" ]; then printf 'set\n'; else printf 'empty\n'; fi
}

# env_dupe_keys FILE — keys assigned more than once, one per line.
env_dupe_keys() {
  local f="$1"
  [ -r "$f" ] || return 0
  sed -n 's/^\([A-Za-z_][A-Za-z0-9_]*\)=.*/\1/p' "$f" | sort | uniq -d
}

# file_has_line FILE LINE — exact whole-line match. No regex, no substring.
file_has_line() {
  local f="$1" want="$2" line
  [ -r "$f" ] || return 1
  while IFS= read -r line || [ -n "$line" ]; do
    [ "$line" = "$want" ] && return 0
  done < "$f"
  return 1
}

# upsert_block FILE BEGIN END  (block body on stdin) — idempotent block-in-file.
#
# Prints created (the file did not exist) / added (appended to a file that did)
# / updated (the block was replaced) / unchanged. Used for the deploy user's
# ~/.ssh/config and the `dc` helper in ~/.bashrc — files a human may have
# edited, neither of which may be clobbered by a re-run. A second copy of the
# block is collapsed into one. An UNTERMINATED block (BEGIN with no END) is
# REFUSED rather than swallowing the rest of the file.
upsert_block() {
  local file="$1" begin="$2" end="$3"
  local block out="" line inblock=0 seen=0 orig=""
  block="$(cat)"
  if [ ! -e "$file" ]; then
    printf '%s\n%s\n%s\n' "$begin" "$block" "$end" > "$file"
    printf 'created\n'; return 0
  fi
  orig="$(cat "$file")"
  while IFS= read -r line || [ -n "$line" ]; do
    if [ "$inblock" = 1 ]; then
      [ "$line" = "$end" ] && inblock=0
      continue
    fi
    if [ "$line" = "$begin" ]; then
      inblock=1; seen=$((seen + 1))
      if [ "$seen" = 1 ]; then
        out="${out}${begin}"$'\n'"${block}"$'\n'"${end}"$'\n'
      fi
      continue
    fi
    out="${out}${line}"$'\n'
  done < "$file"
  if [ "$inblock" = 1 ]; then
    printf 'unterminated\n'; return 1
  fi
  if [ "$seen" = 0 ]; then
    out="${out}${begin}"$'\n'"${block}"$'\n'"${end}"$'\n'
  fi
  if [ "$out" = "${orig}"$'\n' ] || [ "$out" = "$orig" ]; then
    printf 'unchanged\n'; return 0
  fi
  printf '%s' "$out" > "$file"
  if [ "$seen" = 0 ]; then printf 'added\n'; else printf 'updated\n'; fi
}

# block_present FILE BEGIN — is the marked block already there? For --status,
# which must not rewrite anything to find out.
block_present() {
  [ -r "$1" ] && file_has_line "$1" "$2"
}

# looks_like_ip / client_ip_from_who — who is at the other end of this session.
#
# Needed for the fail2ban ignoreip below. $SSH_CONNECTION is the obvious source
# and it is usually ABSENT here: sudo's env_reset drops it. `who am i` still
# knows — but only use what it reports when it is an ADDRESS, because a
# reverse-resolved hostname in ignoreip makes fail2ban do DNS on every check.
looks_like_ip() {
  local s="${1:-}"
  [ -n "$s" ] || return 1
  case "$s" in *[!0-9a-fA-F.:]*) return 1 ;; esac
  case "$s" in
    *.*) : ;;   # dotted quad
    *:*) : ;;   # IPv6
    *) return 1 ;;
  esac
  return 0
}

client_ip_from_who() {
  local line rest
  IFS= read -r line || true
  case "$line" in
    *'('*')'*) rest="${line##*(}"; rest="${rest%%)*}" ;;
    *) return 1 ;;
  esac
  looks_like_ip "$rest" || return 1
  printf '%s\n' "$rest"
}

# ufw_allows_port PORT — reads `ufw show added` and/or `ufw status` output on
# stdin and answers whether that port is allowed.
#
# This is the gate in front of `ufw --force enable`. Wrong in the permissive
# direction, it enables a default-deny firewall with no rule for the port this
# session is on, and the operator is gone before the next line of output
# arrives. Matched on whole tokens so a rule for 2222 can never be read as a
# rule for 22, or the reverse.
#
# AND ON THE ACTION COLUMN. `ufw status` prints `22/tcp  DENY  Anywhere` in the
# very same shape as the ALLOW row, so matching the port alone reports a
# DENY-ed ssh port as allowed — and that is the answer standing in front of
# `ufw --force enable`. Driven against a `22/tcp DENY` fixture in --self-test.
ufw_allows_port() {
  local port="$1" line act
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    case "$line" in
      *"allow ${port}/tcp"*) return 0 ;;            # `ufw show added`
      "${port}/tcp "*|"${port}/tcp")                # `ufw status`, v4 row
        set -f
        # shellcheck disable=SC2086
        set -- $line
        set +f
        # `22/tcp  ALLOW  Anywhere`, or verbose's `22/tcp  ALLOW IN  Anywhere`.
        act="${2:-}"
        case "$act" in ALLOW*|allow*) return 0 ;; esac
        ;;
    esac
  done
  return 1
}

# ufw_has_v6_rule PORT — reads `ufw status` on stdin. §3.2b's "good looks like"
# is TWO rows per ssh port: `22/tcp` and `22/tcp (v6)`. On a box with a public
# IPv6 address the missing v6 row is a lockout of a different shape, so this is
# a separate question from ufw_allows_port and gets its own answer.
ufw_has_v6_rule() {
  local port="$1" line act
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    case "$line" in
      "${port}/tcp (v6)"*)
        set -f
        # shellcheck disable=SC2086
        set -- $line
        set +f
        # `22/tcp (v6)   ALLOW   Anywhere (v6)` — the action is the third token.
        act="${3:-}"
        case "$act" in ALLOW*|allow*) return 0 ;; esac
        ;;
    esac
  done
  return 1
}

# ufw_is_active — reads `ufw status` output on stdin.
#
# NOT `grep -i active`: "Status: inactive" CONTAINS "active", so the obvious
# test reports an inactive firewall as active — which matters twice here, once
# when deciding whether ufw must be cycled to pick up IPV6=yes, and once in the
# assertion that is meant to prove the firewall came up at all.
ufw_is_active() {
  local line
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    case "$(printf '%s' "$line" | tr 'A-Z' 'a-z')" in
      'status: active') return 0 ;;
      'status: inactive') return 1 ;;
    esac
  done
  return 1
}

# is_age_recipient — an age PUBLIC key: bech32, lowercase, `age1` prefix.
# BACKUP_AGE_RECIPIENT is the preferred mode precisely because the matching
# IDENTITY stays off this host, so a host compromise cannot open yesterday's
# off-site copy. A typo is otherwise only discovered by backup.sh's own
# encryption self-test, at 02:15.
is_age_recipient() {
  local s="${1:-}"
  case "$s" in age1*) : ;; *) return 1 ;; esac
  [ "${#s}" -ge 50 ] || return 1
  [ "${#s}" -le 80 ] || return 1
  case "$s" in *[!a-z0-9]*) return 1 ;; esac
  return 0
}

# is_age_identity — the SECRET half. Refuse it loudly: pasting an
# AGE-SECRET-KEY into .env.prod on the host puts the decryptor next to the
# ciphertext, which is the whole thing age was chosen to avoid.
is_age_identity() {
  case "${1:-}" in AGE-SECRET-KEY-*) return 0 ;; *) return 1 ;; esac
}

# is_https_url — for BACKUP_HEARTBEAT_URL (§7.3). It goes into a cron line
# inside single quotes, so a quote or whitespace in it would break the entire
# nightly backup rather than just the ping.
is_https_url() {
  local s="${1:-}"
  case "$s" in https://*|http://*) : ;; *) return 1 ;; esac
  [ "${#s}" -ge 12 ] || return 1
  case "$s" in *[[:space:]]*|*"'"*|*'"'*|*'$'*|*'`'*) return 1 ;; esac
  return 0
}

# password_ok — §3.4 asks for a strong sudo password for `deploy`. 12 is the
# same floor bootstrap-admin.ts enforces on the admin password; reuse it rather
# than invent a second rule. The single-quote refusal is not cosmetic: values
# like this end up inside single-quoted shell strings elsewhere in the tree.
password_ok() {
  local p="${1:-}"
  [ "${#p}" -ge 12 ] || return 1
  case "$p" in *"'"*) return 1 ;; esac
  return 0
}

# tz_looks_valid NAME — the shape of an IANA zone ("Area/Location"). Cheap
# pre-filter; the step also checks the name against `timedatectl list-timezones`,
# which is the authority. Both, because the shape check is testable here and the
# list check is not.
tz_looks_valid() {
  local s="${1:-}"
  case "$s" in
    */*) : ;;
    UTC) return 0 ;;
    *) return 1 ;;
  esac
  case "$s" in *[!A-Za-z0-9/_+-]*) return 1 ;; esac
  case "$s" in /*|*/) return 1 ;; esac
  return 0
}

# pem_count FILE LABEL — number of PEM blocks of a kind. A pasted certificate
# CHAIN (leaf + intermediate) is legitimate and counts more than one.
pem_count() {
  local f="$1" label="$2" line n=0
  [ -r "$f" ] || { printf '0\n'; return 0; }
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    case "$line" in
      "-----BEGIN "*"${label}"*"-----") n=$((n + 1)) ;;
    esac
  done < "$f"
  printf '%s\n' "$n"
}

# pem_balanced FILE — every BEGIN has a matching END, in order. Catches the
# commonest paste failure by far: a terminal that dropped the last line.
pem_balanced() {
  local f="$1" line depth=0
  [ -r "$f" ] || return 1
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    case "$line" in
      "-----BEGIN "*"-----") depth=$((depth + 1)) ;;
      "-----END "*"-----")   depth=$((depth - 1)); [ "$depth" -lt 0 ] && return 1 ;;
    esac
  done < "$f"
  [ "$depth" = 0 ]
}

# cert_key_match CRT KEY — the pair belongs together. Compares the public keys
# rather than RSA moduli, so it is correct for an EC origin certificate too
# (Cloudflare issues both). A mismatched pair installs fine and then fails TLS
# on every vhost.
cert_key_match() {
  local a b
  a="$(openssl x509 -in "$1" -noout -pubkey 2>/dev/null)" || return 1
  b="$(openssl pkey -in "$2" -pubout 2>/dev/null)" || return 1
  [ -n "$a" ] && [ "$a" = "$b" ]
}

# cert_covers CRT HOST — HOST appears verbatim in subjectAltName. Pass the
# literal `*.libriant.com` to check the wildcard; §3.7b requires BOTH the apex
# and the wildcard, and a certificate missing the wildcard produces a fully
# green deploy and then a Cloudflare 526 on every subdomain.
#
# -F IS LOAD-BEARING. Without it grep reads `DNS:*.libriant.com` as a REGEX —
# `:*` is "zero or more colons", `.` is "any character" — so an APEX-ONLY
# certificate matches the wildcard pattern and this function reports that the
# very thing it exists to catch is fine. Found by driving it against a real
# apex-only certificate; that fixture is in the self-test.
cert_covers() {
  openssl x509 -in "$1" -noout -ext subjectAltName 2>/dev/null \
    | tr ',' '\n' | sed 's/^[[:space:]]*//; s/[[:space:]]*$//' \
    | grep -qxF "DNS:$2"
}

# ── The firewall-status parser (authn-authz-01) ─────────────────────────────
#
# `prod-bootstrap.sh --firewall-status` prints a human report. This turns it
# into facts, so "is the origin locked down?" gets an answer rather than a
# glance. The strings matched here are that script's literal output; if it is
# reworded this parser must be reworded with it, which is why the self-test
# carries fixtures of both the good and the bad shapes.
fw_parse() {
  local line fam="" sect=""
  local v4i=1 v6i=1 v4c=0 v6c=0 v4in=0 v4du=0 v6in=0 v6du=0 listener=unknown
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      "--- iptables: LIBRIANT-ORIGIN ---")   fam=v4; sect=chain; continue ;;
      "--- ip6tables: LIBRIANT-ORIGIN ---")  fam=v6; sect=chain; continue ;;
      "--- iptables: jumps into it ---")     fam=v4; sect=jumps; continue ;;
      "--- ip6tables: jumps into it ---")    fam=v6; sect=jumps; continue ;;
      # NOT the pattern *"iptables: NOT INSTALLED"* — "ip6tables" does not
      # contain "iptables" as a substring (ip-6-tables), so that outer test
      # matches only the v4 line and the v6 case falls through silently. Found
      # by the fixture below, which is the entire reason it exists.
      *"tables: NOT INSTALLED"*)
        case "$line" in
          *"ip6tables: NOT INSTALLED"*) v6i=0 ;;
          *) v4i=0 ;;
        esac
        continue ;;
      *"ok: no [::] listener"*) listener=ok; continue ;;
      *"A [::] listener is present"*) listener=bad; continue ;;
      *"ss not installed"*) listener=unknown; continue ;;
    esac
    case "$sect" in
      chain)
        case "$line" in
          "-N LIBRIANT-ORIGIN"*|"-A LIBRIANT-ORIGIN"*)
            [ "$fam" = v4 ] && v4c=1; [ "$fam" = v6 ] && v6c=1 ;;
        esac ;;
      jumps)
        case "$line" in
          *"-A INPUT"*)
            [ "$fam" = v4 ] && v4in=1; [ "$fam" = v6 ] && v6in=1 ;;
        esac
        case "$line" in
          *"-A DOCKER-USER"*)
            [ "$fam" = v4 ] && v4du=1; [ "$fam" = v6 ] && v6du=1 ;;
        esac ;;
    esac
  done
  printf 'V4_INSTALLED=%s\nV6_INSTALLED=%s\nV4_CHAIN=%s\nV6_CHAIN=%s\nV4_INPUT=%s\nV4_DOCKER=%s\nV6_INPUT=%s\nV6_DOCKER=%s\nLISTENER=%s\n' \
    "$v4i" "$v6i" "$v4c" "$v6c" "$v4in" "$v4du" "$v6in" "$v6du" "$listener"
}

# fw_verdict — reads fw_parse's KEY=VALUE lines and prints one finding per line
# as "FATAL <text>" or "WARN <text>". EMPTY OUTPUT MEANS THE LOCKDOWN HOLDS.
#
# The IPv6 findings are FATAL, not warnings: the box has a public IPv6 address,
# so a v4-only lockdown is not a lockdown — prod-bootstrap.sh says exactly that
# and exits 1 for it. A `[::]` listener is equally fatal: it means the compose
# publish form reverted to the wildcard, every v6 client then reaches Caddy
# through the userland proxy from the bridge gateway, looks private to the edge
# guard, and forged CF-Connecting-IP headers work again. That is not
# hypothetical — it is how the FIRST fix for authn-authz-01 was defeated.
fw_verdict() {
  local k v
  local V4_INSTALLED=1 V6_INSTALLED=1 V4_CHAIN=0 V6_CHAIN=0
  local V4_INPUT=0 V4_DOCKER=0 V6_INPUT=0 V6_DOCKER=0 LISTENER=unknown
  while IFS='=' read -r k v; do
    case "$k" in
      V4_INSTALLED|V6_INSTALLED|V4_CHAIN|V6_CHAIN|V4_INPUT|V4_DOCKER|V6_INPUT|V6_DOCKER|LISTENER)
        eval "$k=\$v" ;;
    esac
  done
  [ "$V4_INSTALLED" = 1 ] || printf 'FATAL iptables is not installed — there is no origin lockdown at all.\n'
  [ "$V6_INSTALLED" = 1 ] || printf 'FATAL ip6tables is not installed, and this box has public IPv6. A v4-only lockdown is not a lockdown (apt-get install -y iptables).\n'
  if [ "$V4_INSTALLED" = 1 ]; then
    [ "$V4_CHAIN" = 1 ]  || printf 'FATAL iptables LIBRIANT-ORIGIN chain is absent — the lockdown was never applied.\n'
    [ "$V4_INPUT" = 1 ]  || printf 'FATAL iptables has no jump from INPUT — the userland-proxy path is unfiltered.\n'
    [ "$V4_DOCKER" = 1 ] || printf 'FATAL iptables has no jump from DOCKER-USER — published ports are unfiltered.\n'
  fi
  if [ "$V6_INSTALLED" = 1 ]; then
    [ "$V6_CHAIN" = 1 ]  || printf 'FATAL ip6tables LIBRIANT-ORIGIN chain is absent — public IPv6 to 80/443 is wide open.\n'
    [ "$V6_INPUT" = 1 ]  || printf 'FATAL ip6tables has no jump from INPUT — public IPv6 to 80/443 is wide open.\n'
    [ "$V6_DOCKER" = 1 ] || printf 'FATAL ip6tables has no jump from DOCKER-USER — public IPv6 to 80/443 is wide open.\n'
  fi
  case "$LISTENER" in
    ok)  : ;;
    bad) printf 'FATAL a [::] listener is present on 80/443: the compose publish form has reverted to the wildcard and layers 1 and 3 do not cover the gap. Fix EDGE_BIND_IPV4 in docker-compose.prod.yml before anything else.\n' ;;
    *)   printf 'WARN  could not read the listeners (ss missing, or caddy is not up) — the [::] check did not run.\n' ;;
  esac
}

# valid_step — a typo in --from/--only/--skip must not read as "nothing to do".
# Without this, `--only orgin_cert` walks the whole list, matches nothing, and
# prints the closing summary as though the box had been provisioned.
valid_step() {
  local x
  for x in $STEPS; do [ "$x" = "$1" ] && return 0; done
  return 1
}

# ── The three generated artefacts, as functions, so the self-test can read
#    them. Each is a string that has to be EXACTLY right on a box nobody will
#    proofread it on. ─────────────────────────────────────────────────────────

# The §6.1 preamble, for the compose commands THIS script runs as deploy.
# IMAGE_TAG is recomputed AFTER sourcing .env.prod: that file ships
# IMAGE_TAG=latest, nothing tags anything `latest`, and any command that CREATES
# a container would then try to pull ghcr.io/libriant/libriant-api:latest and
# fail on a manifest error that names nothing useful. The `\$(` and `\$@`
# escapes matter — expanding them here would bake this moment's commit in.
dc_preamble() {
  cat <<EOF
set -uo pipefail
cd ${APP_DIR}
set -a; . ${ENV_FILE}; set +a
export COMPOSE_PROJECT_NAME=${COMPOSE_PROJECT}
export LIBRIANT_DATA_ROOT=${DATA_ROOT}
export IMAGE_TAG="\$(git -C ${APP_DIR} rev-parse --short=12 HEAD 2>/dev/null)\$(git -C ${APP_DIR} diff --quiet 2>/dev/null || echo -dirty)"
case "\$IMAGE_TAG" in
  ''|-dirty) IMAGE_TAG="\$(docker inspect -f '{{.Config.Image}}' libriant-api-1 2>/dev/null | sed 's/.*://')" ;;
esac
# An EMPTY IMAGE_TAG is worse than a wrong one: compose resolves
# ghcr.io/libriant/libriant-api: — no tag at all — and the error names a
# registry path rather than the reason. Refuse rather than proceed.
case "\$IMAGE_TAG" in
  ''|latest|-dirty)
    echo "IMAGE_TAG could not be determined (git says nothing and no libriant-api-1 container is running)." >&2
    echo "Every compose command that CREATES a container would fail on a manifest pull. See RUNBOOK §6.1." >&2
    exit 90 ;;
esac
export IMAGE_TAG
dc() { docker compose -f infra/compose/docker-compose.prod.yml -f infra/compose/docker-compose.volume.yml "\$@"; }
EOF
}

# §6.1's block for the deploy user's ~/.bashrc, with this installer's paths.
#
# It goes at the END of ~/.bashrc, after Ubuntu's non-interactive early return —
# so it applies to interactive logins and NOT to the `bash -lc` in the backup
# cron, which carries its own env prefix. That is correct and deliberate.
#
# ONE DELIBERATE ADDITION to §6.1's four lines, and it is the `case` below.
# §6.1's tag is a bare command substitution: when `git rev-parse` fails — a
# moved tree, a "dubious ownership" refusal, a checkout that is not there — it
# yields the empty string and the whole expression collapses to exactly
# "-dirty". Anything that CREATES a container then pulls an image tagged
# `-dirty`, which exists nowhere. §6.1's own advice for the moved-checkout case
# is to read the tag off a running container; this does that instead of
# proceeding with a tag we already know is wrong.
dchelper_block() {
  cat <<EOF
export COMPOSE_PROJECT_NAME=${COMPOSE_PROJECT}
export LIBRIANT_DATA_ROOT=${DATA_ROOT}
set -a; . ${ENV_FILE}; set +a
# .env.prod ships IMAGE_TAG=latest and no such image exists on this box.
# Recompute the tag exactly as deploy-on-host.sh does, AFTER sourcing.
export IMAGE_TAG="\$(git -C ${APP_DIR} rev-parse --short=12 HEAD 2>/dev/null)\$(git -C ${APP_DIR} diff --quiet 2>/dev/null || echo -dirty)"
# Installer addition to §6.1: if git could not answer, that expression is the
# bare string "-dirty" and every 'dc up' fails on a manifest pull. Read the tag
# off the running api container instead, which is §6.1's own advice for a
# checkout that has moved.
case "\$IMAGE_TAG" in
  ''|-dirty) IMAGE_TAG="\$(docker inspect -f '{{.Config.Image}}' libriant-api-1 2>/dev/null | sed 's/.*://')" ;;
esac
# If BOTH sources came up empty, say so at login rather than export "" and let
# compose resolve ghcr.io/libriant/libriant-api: with no tag at all. A login
# shell must not exit, so this warns; §3.9's own check fails the run for it.
case "\$IMAGE_TAG" in
  ''|latest)
    printf '%s\\n' "libriant: IMAGE_TAG is empty or 'latest' — 'dc up'/'dc run' will fail on a" >&2
    printf '%s\\n' "         manifest pull. git could not answer and no libriant-api-1 is running." >&2
    printf '%s\\n' "         See docs/RUNBOOK.md §6.1." >&2 ;;
esac
export IMAGE_TAG
dc() { ( cd ${APP_DIR} && docker compose \\
  -f infra/compose/docker-compose.prod.yml \\
  -f infra/compose/docker-compose.volume.yml "\$@" ); }
EOF
}

# §8.2's cron line.
#
# THERE ARE TWO CRON LINES IN THE REPO AND ONE OF THEM IS WRONG: the header
# comment in backup.sh sets no BACKUP_ROOT, so it would write every artefact to
# /srv/libriant/backups on the 80 GiB BOOT DISK. This is §8.2's line, with two
# additions that §8.2 predates:
#
#   BACKUP_TEXTFILE_DIR  backup.sh REFUSES to run when it has neither a
#                        writable textfile directory nor a heartbeat URL, and
#                        its default path is not writable by deploy unless this
#                        installer created it (the `dirs` step does).
#   MAILTO=""            cron mails every line of output to the crontab user by
#                        default. With EMAIL_DRIVER=console and no MTA that mail
#                        goes nowhere, or fills a spool nobody reads.
#
# STORAGE_DIR is stated explicitly, as §8.2 does. backup.sh can usually resolve
# the uploads directory itself (it asks docker for the bind SOURCE, not the
# mountpoint) — but "usually" is doing a lot of work in a line that runs
# unattended at 02:15.
backup_cron_line() {
  cat <<EOF
# Libriant nightly backup — 02:15 HOST time (docs/RUNBOOK.md §8.2).
# Installed by scripts/install-server.sh. BACKUP_ROOT is explicit on purpose:
# it cannot be set from .env.prod (ensure-env.sh never writes it and the compose
# layer never reads it), and backup.sh's own default is the boot disk.
# Host timezone at install time: ${HOST_TZ:-unknown}. If you change the zone
# later, 02:15 moves with it — see RUNBOOK §1 "Timezone decision".
SHELL=/bin/bash
MAILTO=""
15 2 * * * ${DEPLOY_USER} bash -lc 'set -a; . ${ENV_FILE}; set +a; BACKUP_ROOT=${DATA_ROOT}/backups STORAGE_DIR=${DATA_ROOT}/storage COMPOSE_FILE=${APP_DIR}/infra/compose/docker-compose.prod.yml BACKUP_TEXTFILE_DIR=${TEXTFILE_DIR} ${APP_DIR}/scripts/backup.sh >> ${LOG_DIR}/backup.log 2>&1'
EOF
}

# The env prefix every MANUAL backup invocation needs. §8.2: "Carry the full env
# prefix on every manual invocation, every time." One function so the preflight
# run, the real run, --check-cron and the message printed when the operator
# skips the run can never drift apart.
backup_env_prefix() {
  printf 'BACKUP_ROOT=%s/backups STORAGE_DIR=%s/storage COMPOSE_FILE=%s/infra/compose/docker-compose.prod.yml BACKUP_TEXTFILE_DIR=%s' \
    "$DATA_ROOT" "$DATA_ROOT" "$APP_DIR" "$TEXTFILE_DIR"
}

# ════════════════════════════════════════════════════════════════════════════
# SELF-TEST — the only mechanical check available before this runs for real.
#
#   bash install-server.sh --self-test
#
# No root, no network, no Docker. Everything it writes is under one temp dir.
# ════════════════════════════════════════════════════════════════════════════
T_PASS=0; T_FAIL=0
t_eq() {
  if [ "$2" = "$3" ]; then T_PASS=$((T_PASS + 1)); printf '  ok   %s\n' "$1"
  else T_FAIL=$((T_FAIL + 1)); printf '  FAIL %s\n         expected: [%s]\n         actual:   [%s]\n' "$1" "$2" "$3"; fi
}
t_true()  { if "${@:2}"; then T_PASS=$((T_PASS + 1)); printf '  ok   %s\n' "$1"; else T_FAIL=$((T_FAIL + 1)); printf '  FAIL %s (expected success)\n' "$1"; fi; }
t_false() { if "${@:2}"; then T_FAIL=$((T_FAIL + 1)); printf '  FAIL %s (expected failure)\n' "$1"; else T_PASS=$((T_PASS + 1)); printf '  ok   %s\n' "$1"; fi; }

self_test() {
  local d
  d="$(mktemp -d)"
  register_tmp "$d"

  printf '\n== count_usable_pubkeys — THE lockout check ==\n'
  local realkey=""
  if command -v ssh-keygen >/dev/null 2>&1; then
    ssh-keygen -q -t ed25519 -N '' -C 'self-test' -f "$d/id" >/dev/null 2>&1 || true
    [ -f "$d/id.pub" ] && realkey="$(cat "$d/id.pub")"
  fi
  if [ -n "$realkey" ]; then
    printf '%s\n' "$realkey" > "$d/ak1";              t_eq "a real ed25519 key"            1 "$(count_usable_pubkeys "$d/ak1")"
    printf 'restrict,from="*.example.org" %s\n' "$realkey" > "$d/ak2"
    t_eq "options field before the key"  1 "$(count_usable_pubkeys "$d/ak2")"
    printf '%s\r\n' "$realkey" > "$d/ak3";            t_eq "CRLF from a Windows paste"     1 "$(count_usable_pubkeys "$d/ak3")"
    printf '   %s\n' "$realkey" > "$d/ak4";           t_eq "leading whitespace"            1 "$(count_usable_pubkeys "$d/ak4")"
    printf '# a comment\n\n%s\n%s\n' "$realkey" "$realkey" > "$d/ak5"
    t_eq "comments and blanks ignored, two keys" 2 "$(count_usable_pubkeys "$d/ak5")"
    # A key mangled onto two lines by a mail client: neither half is usable.
    printf '%s\n' "${realkey%% *}" > "$d/ak6"
    printf '%s\n' "${realkey#* }" >> "$d/ak6"
    t_eq "a key split across two lines"  0 "$(count_usable_pubkeys "$d/ak6")"
  else
    printf '  ..   ssh-keygen not available; using a synthetic blob\n'
    printf 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAbcdefghijklmnopqrstuvwxyz0123456789AB you@laptop\n' > "$d/ak1"
    t_eq "a synthetic ed25519 key" 1 "$(count_usable_pubkeys "$d/ak1")"
  fi
  # Every one of these is a NON-EMPTY file that authenticates nobody. `-s` says
  # yes to all four.
  printf '256 SHA256:abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG you@laptop (ED25519)\n' > "$d/fp"
  t_eq "a pasted FINGERPRINT is not a key"      0 "$(count_usable_pubkeys "$d/fp")"
  printf -- '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gt\n-----END OPENSSH PRIVATE KEY-----\n' > "$d/priv"
  t_eq "a PRIVATE key in the wrong file"        0 "$(count_usable_pubkeys "$d/priv")"
  printf 'my laptop key is in 1password, ask me\n' > "$d/prose"
  t_eq "prose"                                  0 "$(count_usable_pubkeys "$d/prose")"
  printf 'ssh-ed25519 AAAAC3Nza\n' > "$d/trunc"
  t_eq "a truncated blob"                       0 "$(count_usable_pubkeys "$d/trunc")"
  : > "$d/empty";  t_eq "an empty file"          0 "$(count_usable_pubkeys "$d/empty")"
  t_eq "a file that does not exist"             0 "$(count_usable_pubkeys "$d/nope")"

  # The three shapes that USED to be counted as usable, each a non-empty,
  # perfectly-formed line that authenticates nobody holding a bare key.
  if [ -n "$realkey" ]; then
    printf '@revoked %s\n' "$realkey" > "$d/rev"
    t_eq "@revoked is a REVOCATION, not a key"  0 "$(count_usable_pubkeys "$d/rev")"
    printf 'expiry-time="20200101" %s\n' "$realkey" > "$d/exp"
    t_eq "a LAPSED expiry-time authenticates nobody" 0 "$(count_usable_pubkeys "$d/exp")"
    printf 'expiry-time="20991231" %s\n' "$realkey" > "$d/exp2"
    t_eq "…but a future expiry-time is fine"    1 "$(count_usable_pubkeys "$d/exp2")"
    printf '@cert-authority %s\n' "$realkey" > "$d/ca"
    t_eq "@cert-authority is not a bare-key way in" 0 "$(count_usable_pubkeys "$d/ca")"
    t_eq "…and it IS reported separately"        1 "$(count_ca_lines "$d/ca")"
    t_eq "count_ca_lines on a normal file"       0 "$(count_ca_lines "$d/ak1")"
    # And the one that used to be a SPURIOUS REFUSAL: a quoted space in the
    # options field pushes the key type past position 2.
    printf 'command="/usr/local/bin/wrap --flag arg",no-pty %s\n' "$realkey" > "$d/cmd"
    t_eq "an options field with a quoted space"  1 "$(count_usable_pubkeys "$d/cmd")"
  fi

  printf '\n== opts_expired ==\n'
  t_true  "20200101 is past 20260828…"    opts_expired 'expiry-time="20200101"' 20260828120000
  t_false "20991231 is not"               opts_expired 'expiry-time="20991231"' 20260828120000
  t_true  "with a trailing Z"             opts_expired 'expiry-time="20200101Z"' 20260828120000
  t_true  "…and inside a longer options field" opts_expired 'from="*.x.org",expiry-time="20200101",no-pty' 20260828120000
  t_false "no expiry-time at all"         opts_expired 'restrict,from="*.x.org"' 20260828120000
  t_false "an unparseable date is not judged" opts_expired 'expiry-time="soon"' 20260828120000
  t_false "empty options"                 opts_expired '' 20260828120000

  printf '\n== mode_unsafe — sshd StrictModes ==\n'
  t_false "0700 is safe"          mode_unsafe 700
  t_false "0600 is safe"          mode_unsafe 600
  t_false "0755 is safe"          mode_unsafe 755
  t_true  "0770 is group-writable" mode_unsafe 770
  t_true  "0707 is other-writable" mode_unsafe 707
  t_true  "0666 is both"           mode_unsafe 666
  t_true  "0622"                   mode_unsafe 622
  t_false "0644"                   mode_unsafe 644
  t_true  "4-digit 2775 (setgid, group-writable)" mode_unsafe 2775
  # `stat -c '%a'` prints no leading zeros, so mode 0006 arrives as "6". Before
  # the zero-pad, ${m: -2} on a one-character string was EMPTY and a
  # world-writable file was reported safe.
  t_true  "a one-character mode '6' (0006)"  mode_unsafe 6
  t_true  "a one-character mode '2' (0002)"  mode_unsafe 2
  t_false "a one-character mode '4' (0004)"  mode_unsafe 4
  t_true  "a two-character mode '20' (0020)" mode_unsafe 20

  printf '\n== sshd -T parsing ==\n'
  cat > "$d/sshdT" <<'EOF'
port 22
port 2222
addressfamily any
listenaddress 0.0.0.0:2222
listenaddress [::]:2222
permitrootlogin prohibit-password
passwordauthentication yes
pubkeyauthentication yes
authorizedkeysfile .ssh/authorized_keys .ssh/authorized_keys2
strictmodes yes
EOF
  t_eq "sshd_values port"                 "22 2222" "$(sshd_values port < "$d/sshdT" | tr '\n' ' ' | sed 's/ $//')"
  t_eq "sshd_values passwordauthentication" "yes"   "$(sshd_values passwordauthentication < "$d/sshdT")"
  t_eq "sshd_values on a keyword that is absent" "" "$(sshd_values banner < "$d/sshdT")"
  t_eq "sshd_ports (port + listenaddress)" "22 2222 2222 2222" "$(sshd_ports < "$d/sshdT" | tr '\n' ' ' | sed 's/ $//')"
  t_eq "authorizedkeysfile"               ".ssh/authorized_keys .ssh/authorized_keys2" "$(sshd_values authorizedkeysfile < "$d/sshdT")"
  # shellcheck disable=SC2046
  t_eq "resolve_authorized_keys, relative" "/home/deploy/.ssh/authorized_keys /home/deploy/.ssh/authorized_keys2" \
    "$(resolve_authorized_keys /home/deploy deploy $(sshd_values authorizedkeysfile < "$d/sshdT") | tr '\n' ' ' | sed 's/ $//')"
  t_eq "resolve_authorized_keys, %h/%u"    "/home/deploy/.ssh/ak-deploy" \
    "$(resolve_authorized_keys /home/deploy deploy '%h/.ssh/ak-%u')"
  t_eq "resolve_authorized_keys, absolute" "/etc/ssh/keys/deploy" \
    "$(resolve_authorized_keys /home/deploy deploy '/etc/ssh/keys/%u')"

  printf '\n== the LISTENING port — what sshd -T cannot tell you ==\n'
  # Ubuntu has shipped ssh.socket enabled by default since 22.10. Under socket
  # activation sshd_config's Port is IGNORED, so `sshd -T` and the kernel
  # disagree — and the ufw allow rule has to follow the kernel.
  local SS_OUT SOCK_OUT
  SS_OUT='LISTEN 0  4096  0.0.0.0:2222  0.0.0.0:*  users:(("sshd",pid=812,fd=3))
LISTEN 0  4096  [::]:2222     [::]:*     users:(("sshd",pid=812,fd=4))
LISTEN 0  4096  127.0.0.53:53 0.0.0.0:*  users:(("systemd-resolve",pid=700,fd=14))
LISTEN 0  4096  0.0.0.0:5432  0.0.0.0:*  users:(("docker-proxy",pid=999,fd=4))'
  t_eq "ss: the sshd rows only, both families" "2222" \
    "$(printf '%s\n' "$SS_OUT" | ss_ssh_ports | sort -un | tr '\n' ' ' | sed 's/ $//')"
  t_eq "ss: systemd-resolved and docker-proxy are not sshd" "" \
    "$(printf '%s\n' "$SS_OUT" | ss_ssh_ports | grep -x '53\|5432' || true)"
  t_eq "ss: no sshd row at all" "" "$(printf 'LISTEN 0 4096 0.0.0.0:80 0.0.0.0:*\n' | ss_ssh_ports)"
  t_eq "ss: empty input"        "" "$(printf '' | ss_ssh_ports)"
  SOCK_OUT='[::]:2222 (Stream)
0.0.0.0:2222 (Stream)'
  t_eq "ssh.socket ListenStream, both families" "2222" \
    "$(printf '%s\n' "$SOCK_OUT" | socket_listen_ports | sort -un | tr '\n' ' ' | sed 's/ $//')"
  t_eq "ssh.socket: a bare port with no address" "" "$(printf '22 (Stream)\n' | socket_listen_ports)"
  t_eq "ssh.socket: empty (not socket-activated)" "" "$(printf '' | socket_listen_ports)"

  printf '\n== unmounted_filesystems — "did the data volume fail to come back?" ==\n'
  local LSBLK
  LSBLK='NAME="nvme0n1" FSTYPE="" MOUNTPOINT="" SIZE="476.9G"
NAME="vg0-root" FSTYPE="ext4" MOUNTPOINT="/" SIZE="80G"
NAME="vg0-data" FSTYPE="ext4" MOUNTPOINT="" SIZE="250G"
NAME="vg0-swap" FSTYPE="swap" MOUNTPOINT="[SWAP]" SIZE="8G"'
  t_eq "the unmounted ext4 volume, and only it" "/dev/vg0-data  ext4  250G" \
    "$(printf '%s\n' "$LSBLK" | unmounted_filesystems)"
  t_eq "…a bare disk with no filesystem is not one" "0" \
    "$(printf '%s\n' "$LSBLK" | unmounted_filesystems | grep -c nvme0n1 || true)"
  t_eq "…nor is the mounted root"                   "0" \
    "$(printf '%s\n' "$LSBLK" | unmounted_filesystems | grep -c vg0-root || true)"
  # An UNMOUNTED swap partition would otherwise read as a lost data volume.
  t_eq "…nor an unmounted swap partition" "" \
    "$(printf 'NAME=\"sd1\" FSTYPE=\"swap\" MOUNTPOINT=\"\" SIZE=\"8G\"\n' | unmounted_filesystems)"
  t_eq "everything mounted: nothing to report" "" \
    "$(printf 'NAME=\"a\" FSTYPE=\"ext4\" MOUNTPOINT=\"/\" SIZE=\"80G\"\n' | unmounted_filesystems)"
  t_eq "empty input" "" "$(printf '' | unmounted_filesystems)"

  printf '\n== sshd_permits_user — Allow/Deny lists ==\n'
  t_true  "no lists at all: everyone is permitted" sshd_permits_user root 'root sudo' '' '' '' ''
  t_false "DenyUsers root"                         sshd_permits_user root 'root'      '' '' 'root' ''
  t_true  "…but not deploy"                        sshd_permits_user deploy 'deploy sudo docker' '' '' 'root' ''
  t_false "AllowGroups sudo, and ubuntu is not in it" sshd_permits_user ubuntu 'ubuntu users' '' 'sudo' '' ''
  t_true  "…deploy is"                             sshd_permits_user deploy 'deploy sudo docker' '' 'sudo' '' ''
  t_false "AllowUsers deploy, asked about root"    sshd_permits_user root 'root' 'deploy' '' '' ''
  t_true  "AllowUsers with a glob"                 sshd_permits_user deploy 'deploy' 'dep*' '' '' ''
  t_true  "AllowUsers user@host form"              sshd_permits_user deploy 'deploy' 'deploy@203.0.113.5' '' '' ''
  t_false "DenyGroups wheel"                       sshd_permits_user alice 'alice wheel' '' '' '' 'wheel'

  printf '\n== ssh_port_from_connection ==\n'
  t_eq "a normal SSH_CONNECTION" "22"   "$(ssh_port_from_connection '203.0.113.5 51234 198.51.100.7 22')"
  t_eq "a non-standard port"     "2222" "$(ssh_port_from_connection '203.0.113.5 51234 198.51.100.7 2222')"
  t_false "an empty SSH_CONNECTION" ssh_port_from_connection ''
  t_false "a truncated one"         ssh_port_from_connection '203.0.113.5 51234'

  printf '\n== shadow_state — the sudo password §3.4 forgets ==\n'
  t_eq "P (usable)"  "P"       "$(printf 'deploy P 2026-08-01 0 99999 7 -1\n' | shadow_state)"
  t_eq "L (locked)"  "L"       "$(printf 'deploy L 2026-08-01 0 99999 7 -1\n' | shadow_state)"
  t_eq "NP (none)"   "NP"      "$(printf 'deploy NP 2026-08-01 0 99999 7 -1\n' | shadow_state)"
  t_eq "empty input" "unknown" "$(printf '' | shadow_state)"
  t_eq "garbage"     "unknown" "$(printf 'passwd: user deploy does not exist\n' | shadow_state)"

  printf '\n== compose_major — v2 is required ==\n'
  t_eq "v2"          "2" "$(printf 'Docker Compose version v2.29.7\n' | compose_major)"
  t_eq "v5, later"   "5" "$(printf 'Docker Compose version v5.0.1\n' | compose_major)"
  t_eq "the v1 tool" "1" "$(printf 'docker-compose version 1.29.2, build 5becea4c\n' | compose_major)"
  t_eq "nonsense"    "0" "$(printf 'command not found\n' | compose_major)"
  t_eq "empty"       "0" "$(printf '' | compose_major)"

  printf '\n== http_status_ok — the UNVERIFIED Docker suite probe ==\n'
  t_true  "a 200"          http_status_ok <<< 'HTTP/1.1 200 OK'
  t_true  "HTTP/2 200"     http_status_ok <<< 'HTTP/2 200 '
  t_true  "200 with CR"    http_status_ok <<< "$(printf 'HTTP/1.1 200 OK\r')"
  t_false "a 404"          http_status_ok <<< 'HTTP/1.1 404 Not Found'
  t_false "a 403"          http_status_ok <<< 'HTTP/1.1 403 Forbidden'
  t_false "nothing at all" http_status_ok <<< ''

  printf '\n== env_get / env_dupe_keys ==\n'
  cat > "$d/env" <<'EOF'
SESSION_SECRET=aaaa
ADMIN_BOOTSTRAP_PASSWORD='a pass with spaces'
QUOTED="double"
IMAGE_TAG=latest
IMAGE_TAG=abcdef123456
EOF
  t_eq "a plain value"           "aaaa"                "$(env_get "$d/env" SESSION_SECRET)"
  t_eq "single-quoted"           "a pass with spaces"  "$(env_get "$d/env" ADMIN_BOOTSTRAP_PASSWORD)"
  t_eq "double-quoted"           "double"              "$(env_get "$d/env" QUOTED)"
  t_eq "duplicated: LAST wins, as the shell does" "abcdef123456" "$(env_get "$d/env" IMAGE_TAG)"
  t_eq "a key that is absent"    ""                    "$(env_get "$d/env" NOPE)"
  t_eq "env_dupe_keys"           "IMAGE_TAG"           "$(env_dupe_keys "$d/env")"
  t_eq "env_dupe_keys on a clean file" ""              "$(printf 'A=1\nB=2\n' > "$d/env2"; env_dupe_keys "$d/env2")"

  printf '\n== env_set_stream / env_key_state — the discarded-answer bug ==\n'
  # ensure-env.sh copies every key that is in .env.prod.example but missing
  # from your file, and several of those have NO VALUE. `KEY=` is therefore a
  # state that occurs on a perfectly normal first run — and the old writer read
  # it as "already set" and threw the operator's typed answer away.
  printf 'A=1\nRCLONE_REMOTE=\nB=2\n' > "$d/env3"
  t_eq "an empty value reads as 'empty', not 'set'" "empty" "$(env_key_state "$d/env3" RCLONE_REMOTE)"
  t_eq "a real value reads as 'set'"                "set"   "$(env_key_state "$d/env3" A)"
  t_eq "a missing key reads as 'absent'"            "absent" "$(env_key_state "$d/env3" NOPE)"
  t_eq "an empty line is REPLACED in place, not appended" \
    "A=1
RCLONE_REMOTE=hetzner:libriant
B=2" "$(env_set_stream RCLONE_REMOTE 'hetzner:libriant' < "$d/env3")"
  t_eq "…and the file does not grow a duplicate" "1" \
    "$(env_set_stream RCLONE_REMOTE 'x' < "$d/env3" | grep -c '^RCLONE_REMOTE=')"
  t_eq "an absent key is appended" "A=1
RCLONE_REMOTE=
B=2
BACKUP_ALLOW_LOCAL_ONLY=1" "$(env_set_stream BACKUP_ALLOW_LOCAL_ONLY 1 < "$d/env3")"
  t_eq "a key with a REAL value already is left exactly alone" "A=1
RCLONE_REMOTE=
B=2" "$(env_set_stream A 999 < "$d/env3")"
  t_eq "…and the writer's contract agrees with the detector" "set" \
    "$(printf 'K=v\n' > "$d/env4"; env_key_state "$d/env4" K)"

  printf '\n== upsert_block — ~/.bashrc and ~/.ssh/config must survive a re-run ==\n'
  local B='# --- BEGIN ---' E='# --- END ---'
  rm -f "$d/bl"
  t_eq "creates a missing file" "created"   "$(printf 'body\n' | upsert_block "$d/bl" "$B" "$E")"
  t_eq "unchanged on a re-run"  "unchanged" "$(printf 'body\n' | upsert_block "$d/bl" "$B" "$E")"
  t_eq "updates a changed body" "updated"   "$(printf 'body2\n' | upsert_block "$d/bl" "$B" "$E")"
  t_true "the new body is there"  grep -qx 'body2' "$d/bl"
  t_false "the old body is gone"  grep -qx 'body' "$d/bl"
  printf 'existing user content\n' > "$d/bl2"
  t_eq "appends to an existing file" "added" "$(printf 'body\n' | upsert_block "$d/bl2" "$B" "$E")"
  t_true "the user's own content survives" grep -qx 'existing user content' "$d/bl2"
  printf 'keep\n%s\nold1\n%s\nmid\n%s\nold2\n%s\ntail\n' "$B" "$E" "$B" "$E" > "$d/bl3"
  t_eq "collapses a duplicated block" "updated" "$(printf 'new\n' | upsert_block "$d/bl3" "$B" "$E")"
  t_eq "…to exactly one BEGIN"        "1"       "$(grep -c -- "$B" "$d/bl3")"
  t_true "…keeping every non-block line" grep -qx 'mid' "$d/bl3"
  printf 'keep\n%s\nnever terminated\n' "$B" > "$d/bl4"
  local before4; before4="$(cat "$d/bl4")"
  t_eq "refuses an unterminated block" "unterminated" "$(printf 'x\n' | upsert_block "$d/bl4" "$B" "$E" || true)"
  t_eq "…and leaves the file untouched" "$before4" "$(cat "$d/bl4")"

  printf '\n== ufw parsing — the enable gate ==\n'
  local UFWST UFWADD
  UFWST='Status: active

To                         Action      From
--                         ------      ----
2222/tcp                   ALLOW       Anywhere
2222/tcp (v6)              ALLOW       Anywhere (v6)'
  UFWADD='Added user rules (see ufw status for running firewall):
ufw allow 2222/tcp comment '"'"'ssh'"'"''
  t_true  "2222 is allowed"                 ufw_allows_port 2222 <<< "$UFWST"
  t_false "22 must NOT satisfy a 2222 box"  ufw_allows_port 22   <<< "$UFWST"
  t_true  "…also read from 'ufw show added'" ufw_allows_port 2222 <<< "$UFWADD"
  t_false "…and not the wrong port there"    ufw_allows_port 222  <<< "$UFWADD"
  t_true  "a v6 row for 2222"                ufw_has_v6_rule 2222 <<< "$UFWST"
  t_false "no v6 row for 22"                 ufw_has_v6_rule 22   <<< "$UFWST"
  t_true  "'Status: active' is active"       ufw_is_active <<< "$UFWST"
  # The trap: "Status: inactive" CONTAINS "active".
  t_false "'Status: inactive' is NOT active" ufw_is_active <<< 'Status: inactive'
  t_false "no status line at all"            ufw_is_active <<< 'ERROR: could not find ufw'
  local UFWV4ONLY='Status: active

To                         Action      From
--                         ------      ----
22/tcp                     ALLOW       Anywhere'
  t_true  "v4-only: the port is allowed"    ufw_allows_port 22 <<< "$UFWV4ONLY"
  t_false "v4-only: but there is no v6 row" ufw_has_v6_rule 22 <<< "$UFWV4ONLY"
  # THE ACTION COLUMN. A DENY row has exactly the same shape as an ALLOW row,
  # and reading it as "allowed" is the answer standing in front of
  # `ufw --force enable`.
  local UFWDENY='Status: active

To                         Action      From
--                         ------      ----
22/tcp                     DENY        Anywhere
22/tcp (v6)                DENY        Anywhere (v6)
2222/tcp                   ALLOW IN    Anywhere'
  t_false "a DENY row is NOT an allow rule"        ufw_allows_port 22   <<< "$UFWDENY"
  t_false "…nor is a DENY (v6) row"                ufw_has_v6_rule 22   <<< "$UFWDENY"
  t_true  "…and verbose's 'ALLOW IN' still counts" ufw_allows_port 2222 <<< "$UFWDENY"

  printf '\n== client_ip_from_who / looks_like_ip ==\n'
  t_eq "an IPv4 client" "203.0.113.5" "$(printf 'root     pts/0        2026-08-28 02:00 (203.0.113.5)\n' | client_ip_from_who)"
  t_eq "an IPv6 client" "2001:db8::1" "$(printf 'root     pts/0        2026-08-28 02:00 (2001:db8::1)\n' | client_ip_from_who)"
  t_false "a reverse-resolved hostname is refused" client_ip_from_who <<< 'root pts/0 2026-08-28 02:00 (laptop.example.org)'
  t_false "a local console has no parentheses"     client_ip_from_who <<< 'root tty1 2026-08-28 02:00'
  t_true  "looks_like_ip v4"  looks_like_ip 198.51.100.7
  t_false "looks_like_ip on a name" looks_like_ip 'host.example'
  t_false "looks_like_ip on empty"  looks_like_ip ''

  printf '\n== value validators ==\n'
  t_true  "a plausible age recipient"  is_age_recipient 'age1zvkyg2lqzraa2lnjvqej32nkuu0ues2s82hzrye869xeexvn73equnujwj'
  t_false "…an age IDENTITY is not one" is_age_recipient 'AGE-SECRET-KEY-1QQPQZRFR6WWCUZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQ'
  t_true  "…and is recognised as the identity" is_age_identity 'AGE-SECRET-KEY-1QQPQ'
  t_false "…uppercase is not a recipient" is_age_recipient 'AGE1ZVKYG2LQZRAA2LNJVQEJ32NKUU0UES2S82HZRYE869XEEXVN73EQUNUJWJ'
  t_false "…too short"                    is_age_recipient 'age1short'
  t_false "…empty"                        is_age_recipient ''
  t_true  "an https heartbeat URL"        is_https_url 'https://hc-ping.com/0d4b1f6a-1111-2222-3333-444455556666'
  t_false "…with a space in it"           is_https_url 'https://hc-ping.com/ uuid'
  t_false "…with a single quote (it goes inside a quoted cron line)" is_https_url "https://x.example/'"
  t_false "…with a backtick"              is_https_url 'https://x.example/`id`'
  t_false "…not a URL at all"             is_https_url 'hc-ping.com/uuid'
  t_true  "a 12-character password"       password_ok 'correct-horse'
  t_false "…11 characters"                password_ok 'elevenchars'
  t_false "…containing a single quote"    password_ok "twelve'chars-long"
  t_true  "tz Europe/Athens"              tz_looks_valid 'Europe/Athens'
  t_true  "tz UTC"                        tz_looks_valid 'UTC'
  t_false "tz with no area"               tz_looks_valid 'Athens'
  t_false "tz with a shell metacharacter" tz_looks_valid 'Europe/Athens; rm -rf /'
  t_false "tz empty"                      tz_looks_valid ''

  printf '\n== PEM structure ==\n'
  printf -- '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n' > "$d/one.crt"
  printf -- '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n-----BEGIN CERTIFICATE-----\nBBBB\n-----END CERTIFICATE-----\n' > "$d/chain.crt"
  printf -- '-----BEGIN CERTIFICATE-----\nAAAA\n' > "$d/trunc.crt"
  t_eq "one block"                    1 "$(pem_count "$d/one.crt" CERTIFICATE)"
  t_eq "a leaf+intermediate chain"    2 "$(pem_count "$d/chain.crt" CERTIFICATE)"
  t_eq "no PRIVATE KEY in a cert"     0 "$(pem_count "$d/one.crt" 'PRIVATE KEY')"
  t_true  "balanced"                  pem_balanced "$d/one.crt"
  t_true  "a chain is balanced"       pem_balanced "$d/chain.crt"
  t_false "a dropped END line"        pem_balanced "$d/trunc.crt"

  # Real certificates, generated here, because the SAN check is the one that
  # silently passed the failure it exists to catch.
  if command -v openssl >/dev/null 2>&1; then
    printf '\n== certificates (generated by openssl, on the spot) ==\n'
    openssl req -x509 -newkey rsa:2048 -nodes -keyout "$d/good.key" -out "$d/good.crt" \
      -days 3650 -subj '/CN=libriant.com' \
      -addext 'subjectAltName=DNS:libriant.com,DNS:*.libriant.com' >/dev/null 2>&1
    openssl req -x509 -newkey rsa:2048 -nodes -keyout "$d/apex.key" -out "$d/apex.crt" \
      -days 3650 -subj '/CN=libriant.com' \
      -addext 'subjectAltName=DNS:libriant.com' >/dev/null 2>&1
    openssl req -x509 -newkey rsa:2048 -nodes -keyout "$d/other.key" -out "$d/other.crt" \
      -days 3650 -subj '/CN=other.example' \
      -addext 'subjectAltName=DNS:other.example' >/dev/null 2>&1
    if [ -s "$d/good.crt" ] && [ -s "$d/apex.crt" ]; then
      t_true  "the good pair matches"            cert_key_match "$d/good.crt" "$d/good.key"
      t_false "a mismatched pair is caught"      cert_key_match "$d/good.crt" "$d/other.key"
      t_false "…and so is a key that is a cert"  cert_key_match "$d/good.crt" "$d/good.crt"
      t_true  "SAN covers the apex"              cert_covers "$d/good.crt" 'libriant.com'
      t_true  "SAN covers the wildcard"          cert_covers "$d/good.crt" '*.libriant.com'
      # THE REGRESSION. Without grep -F this passed: `:*` is "zero or more
      # colons" and `.` is "any character", so DNS:libriant.com matched the
      # pattern DNS:*.libriant.com and an apex-only certificate looked complete.
      t_false "an APEX-ONLY cert does NOT satisfy the wildcard" cert_covers "$d/apex.crt" '*.libriant.com'
      t_true  "…it does still satisfy the apex"  cert_covers "$d/apex.crt" 'libriant.com'
      t_false "a different cert covers neither"  cert_covers "$d/other.crt" 'libriant.com'
      t_true  "not expired"                      openssl x509 -in "$d/good.crt" -noout -checkend 0
    else
      printf '  ..   openssl could not generate a test certificate; skipped\n'
    fi
  fi

  printf '\n== --firewall-status parsing (authn-authz-01) ==\n'
  local FW_GOOD FW_NOV6 FW_NOJUMP FW_LISTENER FW_ABSENT
  FW_GOOD='--- iptables: LIBRIANT-ORIGIN ---
-N LIBRIANT-ORIGIN
-A LIBRIANT-ORIGIN -m conntrack --ctstate RELATED,ESTABLISHED -j RETURN
-A LIBRIANT-ORIGIN -j DROP
--- iptables: jumps into it ---
-A INPUT -p tcp -m multiport --dports 80,443 -j LIBRIANT-ORIGIN
-A DOCKER-USER -p tcp -m multiport --dports 80,443 -j LIBRIANT-ORIGIN
--- ip6tables: LIBRIANT-ORIGIN ---
-N LIBRIANT-ORIGIN
-A LIBRIANT-ORIGIN -j DROP
--- ip6tables: jumps into it ---
-A INPUT -p tcp -m multiport --dports 80,443 -j LIBRIANT-ORIGIN
-A DOCKER-USER -p tcp -m multiport --dports 80,443 -j LIBRIANT-ORIGIN

--- published listeners on 80/443 (the compose layer) ---
tcp   LISTEN 0  4096   0.0.0.0:443   0.0.0.0:*
  ok: no [::] listener - IPv6 clients cannot reach the userland proxy.'
  t_eq "a fully applied lockdown yields no findings" "" "$(printf '%s\n' "$FW_GOOD" | fw_parse | fw_verdict)"

  # The v6 half missing entirely. prod-bootstrap.sh prints
  # "[bootstrap] ip6tables: NOT INSTALLED" — and "ip6tables" does NOT contain
  # "iptables" as a substring, which is what made the first parser miss it.
  FW_NOV6='--- iptables: LIBRIANT-ORIGIN ---
-N LIBRIANT-ORIGIN
--- iptables: jumps into it ---
-A INPUT -j LIBRIANT-ORIGIN
-A DOCKER-USER -j LIBRIANT-ORIGIN
[bootstrap] ip6tables: NOT INSTALLED
  ok: no [::] listener - IPv6 clients cannot reach the userland proxy.'
  t_eq "a missing ip6tables is reported as V6_INSTALLED=0" "V6_INSTALLED=0" \
    "$(printf '%s\n' "$FW_NOV6" | fw_parse | grep '^V6_INSTALLED=')"
  t_eq "…and iptables is still seen as installed" "V4_INSTALLED=1" \
    "$(printf '%s\n' "$FW_NOV6" | fw_parse | grep '^V4_INSTALLED=')"
  t_eq "…and it is FATAL, not a warning" "1" \
    "$(printf '%s\n' "$FW_NOV6" | fw_parse | fw_verdict | grep -c '^FATAL ip6tables is not installed')"

  FW_NOJUMP='--- iptables: LIBRIANT-ORIGIN ---
-N LIBRIANT-ORIGIN
--- iptables: jumps into it ---
  (no jump - the chain exists but nothing sends traffic to it)
--- ip6tables: LIBRIANT-ORIGIN ---
-N LIBRIANT-ORIGIN
--- ip6tables: jumps into it ---
  (no jump - the chain exists but nothing sends traffic to it)
  ok: no [::] listener - IPv6 clients cannot reach the userland proxy.'
  t_eq "a chain with no jumps is four FATALs" "4" \
    "$(printf '%s\n' "$FW_NOJUMP" | fw_parse | fw_verdict | grep -c '^FATAL')"

  FW_LISTENER='--- iptables: LIBRIANT-ORIGIN ---
-N LIBRIANT-ORIGIN
--- iptables: jumps into it ---
-A INPUT -j LIBRIANT-ORIGIN
-A DOCKER-USER -j LIBRIANT-ORIGIN
--- ip6tables: LIBRIANT-ORIGIN ---
-N LIBRIANT-ORIGIN
--- ip6tables: jumps into it ---
-A INPUT -j LIBRIANT-ORIGIN
-A DOCKER-USER -j LIBRIANT-ORIGIN
  ! A [::] listener is present on 80/443. The compose layer has REVERTED:'
  t_eq "a [::] listener is FATAL — it is how the first fix was defeated" "1" \
    "$(printf '%s\n' "$FW_LISTENER" | fw_parse | fw_verdict | grep -c '^FATAL a .::. listener')"

  FW_ABSENT='--- iptables: LIBRIANT-ORIGIN ---
  (chain absent - the lockdown is NOT applied)
--- iptables: jumps into it ---
  (no jump - the chain exists but nothing sends traffic to it)
--- ip6tables: LIBRIANT-ORIGIN ---
  (chain absent - the lockdown is NOT applied)
--- ip6tables: jumps into it ---
  (no jump - the chain exists but nothing sends traffic to it)
  (ss not installed - check by hand: no [::]:80 or [::]:443 may be listening)'
  t_eq "nothing applied at all: six FATALs" "6" \
    "$(printf '%s\n' "$FW_ABSENT" | fw_parse | fw_verdict | grep -c '^FATAL')"
  t_eq "…and one WARN for the unreadable listeners" "1" \
    "$(printf '%s\n' "$FW_ABSENT" | fw_parse | fw_verdict | grep -c '^WARN')"

  printf '\n== the generated artefacts ==\n'
  backup_cron_line > "$d/cron"
  dchelper_block   > "$d/bashrc"
  dc_preamble      > "$d/preamble"
  t_eq "the cron line names the deploy user in the 6th field" "1" \
    "$(grep -cE "^15 2 \\* \\* \\* ${DEPLOY_USER} " "$d/cron")"
  t_eq "…and sets BACKUP_ROOT on the DATA volume, not the boot disk" "1" \
    "$(grep -cF "BACKUP_ROOT=${DATA_ROOT}/backups" "$d/cron")"
  t_eq "…and BACKUP_TEXTFILE_DIR (the dead man's switch §8.2 predates)" "1" \
    "$(grep -cF "BACKUP_TEXTFILE_DIR=${TEXTFILE_DIR}" "$d/cron")"
  t_eq "…and STORAGE_DIR, so uploads cannot silently fall out" "1" \
    "$(grep -cF "STORAGE_DIR=${DATA_ROOT}/storage" "$d/cron")"
  t_eq "…and MAILTO=\"\", because nothing on this box delivers mail" "1" \
    "$(grep -c '^MAILTO=\"\"' "$d/cron")"
  t_eq "…and NOT backup.sh's own boot-disk default" "0" \
    "$(grep -cF 'BACKUP_ROOT=/srv/libriant/backups' "$d/cron" || true)"
  t_eq "…and it ends in a newline (cron ignores a file that does not)" "" "$(tail -c1 "$d/cron")"
  t_eq "the bashrc block keeps IMAGE_TAG as a live substitution" "1" \
    "$(grep -cF 'rev-parse --short=12 HEAD' "$d/bashrc")"
  t_eq "…and does not bake in a commit" "0" \
    "$(grep -cE 'IMAGE_TAG=\"[0-9a-f]{12}\"' "$d/bashrc" || true)"
  t_eq "…and passes both -f files, always" "1" \
    "$(grep -cF 'docker-compose.volume.yml' "$d/bashrc")"
  t_eq "…and sources .env.prod BEFORE computing the tag (else latest wins)" "0" \
    "$(awk '/^set -a; \. /{s=NR} /^export IMAGE_TAG=/{t=NR} END{ if (s && t && s<t) print 0; else print 1 }' "$d/bashrc")"
  t_eq "the dc preamble sources .env.prod before exporting IMAGE_TAG too" "0" \
    "$(awk '/^set -a; \. /{s=NR} /^export IMAGE_TAG=/{t=NR} END{ if (s && t && s<t) print 0; else print 1 }' "$d/preamble")"

  printf '\n== step-name validation ==\n'
  t_true  "'deploy' is a step"      valid_step deploy
  t_true  "'ssh' is a step"         valid_step ssh
  t_false "'orgin_cert' is a typo"  valid_step orgin_cert
  t_false "an empty name"           valid_step ''

  printf '\n%s passed, %s failed\n\n' "$T_PASS" "$T_FAIL"
  [ "$T_FAIL" = 0 ]
}

# ════════════════════════════════════════════════════════════════════════════
# RUNTIME HELPERS — these touch the machine, so they cannot be unit-tested.
# ════════════════════════════════════════════════════════════════════════════

# One EXIT trap for every temp directory. A function-scoped RETURN trap would
# not fire on the path that matters most — a `die` inside the certificate step,
# which is holding a private key in /tmp at the time.
CLEANUP_DIRS=""
register_tmp() { CLEANUP_DIRS="$CLEANUP_DIRS $1"; }
cleanup_tmp() {
  local d
  for d in $CLEANUP_DIRS; do rm -rf "$d" 2>/dev/null || true; done
  return 0   # never let cleanup change the script's exit status
}

# on_exit — cleanup, PLUS the resume line.
#
# `die` from inside a step (and `run` now dies) exits directly, so the driver's
# own "step X did not complete" never prints on the most common failure path.
# The operator was left with a precise message about what broke and nothing at
# all about how to pick up where they were. This closes that: the specific
# message stays, and the resume instruction is appended by the trap no matter
# which layer called exit. It only PRINTS — it must never change the status.
CURRENT_STEP=""
RUN_FINISHED=0
on_exit() {
  local rc=$?
  cleanup_tmp
  if [ "$rc" != 0 ] && [ -n "$CURRENT_STEP" ] && [ "$RUN_FINISHED" = 0 ]; then
    printf '\n%s  The run stopped inside step '"'"'%s'"'"' (exit %s). Nothing after it has run.%s\n' \
      "$C_Y" "$CURRENT_STEP" "$rc" "$C_0" >&2
    printf '%s  Every step decides what it needs by inspecting the machine, so resuming is%s\n' "$C_Y" "$C_0" >&2
    printf '%s  the normal way to use this:%s\n' "$C_Y" "$C_0" >&2
    printf '      %s --status\n      %s --from %s\n' "$SELF" "$SELF" "$CURRENT_STEP" >&2
    _logline "STOPPED in step $CURRENT_STEP (exit $rc)"
  fi
  exit "$rc"
}

# run — a mutation that MUST succeed.
#
# It dies rather than returning non-zero, and that is not belt-and-braces: the
# driver invokes each step as a TESTED command (`step_x || die`), and bash
# switches `set -e` OFF inside any function whose return value is being tested.
# `if ! step_x; then` does NOT change that — measured, both forms. So errexit
# does not protect a step body, an unchecked `apt-get install` or
# `usermod -aG docker` would simply be stepped over, and the failure would
# surface later as something that names nothing useful. Every mutation in this
# file goes through run / try / write_file, and `run` is the one that stops.
run() {
  if [ "$DRY" = 1 ]; then printf '  would run: %s\n' "$*"; return 0; fi
  "$@" || die "command failed (exit $?): $*
     Nothing after it in this step has run."
}

# try — a mutation that is allowed to fail, for the handful of places where the
# caller has a fallback or the failure is genuinely not load-bearing. Use it
# ONLY with a comment saying why; the default is `run`.
try() {
  if [ "$DRY" = 1 ]; then printf '  would run (best-effort): %s\n' "$*"; return 0; fi
  "$@"
}

# write_file PATH MODE OWNER  (content on stdin).
# Writes only when the content DIFFERS, so a re-run says "unchanged" instead of
# churning mtimes, and an existing file that does differ is copied aside first.
# This installer must never be the reason someone loses a hand-edited config.
write_file() {
  local path="$1" mode="$2" owner="$3" content tmp
  content="$(cat)"
  if [ "$DRY" = 1 ]; then
    printf '  would write %s (%s bytes, mode %s, owner %s)\n' "$path" "${#content}" "$mode" "$owner"
    return 0
  fi
  if [ -f "$path" ] && [ "$(cat "$path")" = "$content" ]; then
    chmod "$mode" "$path"; chown "$owner" "$path"
    ok "$path unchanged (mode/owner reasserted)"
    return 0
  fi
  if [ -f "$path" ]; then
    cp -p "$path" "${path}.bak-$(date +%Y%m%d%H%M%S)"
    warn "$path differed; the previous copy is beside it as ${path}.bak-*"
  fi
  tmp="$(mktemp "${path}.new.XXXXXX")"
  printf '%s\n' "$content" > "$tmp"
  chmod "$mode" "$tmp"; chown "$owner" "$tmp"
  mv -f "$tmp" "$path"
  ok "wrote $path ($mode $owner)"
}

# ── Prompts. Every one of these asks for something that cannot be derived. ──
#
# All of them read /dev/tty when it is there, so they still work when this
# script's stdin is a pipe — but the driver refuses to start without a terminal
# in the first place, because §3.7a is explicit that the first run must not be
# non-interactive.
# WHERE A PROMPT READS FROM, decided once.
#
# stdin FIRST when it is already a terminal, /dev/tty only as the fallback for
# a piped stdin. The other order looks equivalent and is not: /dev/tty can be
# PRESENT and READABLE by `[ -r ]` while a read from it fails outright (any
# session with no controlling terminal — a CI runner, a wrapper, some
# `nohup`/`setsid` shapes). Every prompt then returns the empty string without
# pausing: `confirm` reads as no, `confirm_typed` refuses, `ask` takes the
# default. Those are all the SAFE direction, which is why it went unnoticed —
# but on a box where stdin is a perfectly good terminal it would make the
# installer un-driveable for no reason.
# `[ -r /dev/tty ]` is not the test: the device node can be present and pass it
# while OPENING it fails ("Device not configured"). Open it and see.
tty_usable() { ( : < /dev/tty ) 2>/dev/null; }

PROMPT_SRC="${LIBRIANT_PROMPT_SRC:-}"
prompt_src() {
  if [ -n "$PROMPT_SRC" ]; then printf '%s\n' "$PROMPT_SRC"; return 0; fi
  if [ -t 0 ]; then PROMPT_SRC=/dev/stdin
  elif tty_usable; then PROMPT_SRC=/dev/tty
  else PROMPT_SRC=/dev/stdin; fi
  printf '%s\n' "$PROMPT_SRC"
}

ask() {
  local __var="$1" __msg="$2" __def="${3:-}" __ans="" __src
  if [ "$DRY" = 1 ]; then printf '  would prompt: %s\n' "$__msg"; eval "$__var=\$__def"; return 0; fi
  if [ -n "$__def" ]; then printf '  %s [%s]: ' "$__msg" "$__def" >&2
  else printf '  %s: ' "$__msg" >&2; fi
  __src="$(prompt_src)"
  IFS= read -r __ans < "$__src" || true
  [ -n "$__ans" ] || __ans="$__def"
  eval "$__var=\$__ans"
}

ask_secret() {
  local __var="$1" __msg="$2" __ans="" __src
  if [ "$DRY" = 1 ]; then printf '  would prompt (hidden): %s\n' "$__msg"; eval "$__var=''"; return 0; fi
  printf '  %s: ' "$__msg" >&2
  __src="$(prompt_src)"
  IFS= read -rs __ans < "$__src" || true
  printf '\n' >&2
  eval "$__var=\$__ans"
}

# confirm PROMPT — a plain y/N.
#
# Under --dry-run it prints the question and assumes YES. Nothing mutates in a
# dry run (every mutation goes through run / write_file / as_deploy*, all of
# which are dry-aware), and answering "no" on the operator's behalf would
# truncate the very preview they asked for.
confirm() {
  local a=""
  if [ "$DRY" = 1 ]; then printf '  would ask: %s [y/N]  (dry run: assuming yes)\n' "$1"; return 0; fi
  printf '  %s [y/N] ' "$1" >&2
  IFS= read -r a < "$(prompt_src)" || true
  case "$a" in y|Y|yes|YES) return 0 ;; *) return 1 ;; esac
}

# confirm_typed PROMPT WORD — for anything irreversible. `y` is too easy to hit
# by reflex at 2am; this makes the operator say the word out loud.
confirm_typed() {
  local a=""
  if [ "$DRY" = 1 ]; then printf '  would require the operator to type %s: %s  (dry run: assuming they do)\n' "$2" "$1"; return 0; fi
  printf '  %s\n  Type %s to continue: ' "$1" "$2" >&2
  IFS= read -r a < "$(prompt_src)" || true
  [ "$a" = "$2" ]
}

pause_for() {
  local a=""
  if [ "$DRY" = 1 ]; then printf '  would pause: %s\n' "$1"; return 0; fi
  printf '\n  %s\n  Press Enter when done. ' "$1" >&2
  IFS= read -r a < "$(prompt_src)" || true
}

# ── Markers, for the handful of facts the machine cannot report: an
#    acknowledgement, an operator decision. Everything else is decided by
#    LOOKING AT THE BOX, because a marker only says what a previous run
#    believed, and the whole point of resuming is that it may have been wrong.
marker()    { printf '%s/%s.done' "$STATE_DIR" "$1"; }
mark_done() {
  [ "$DRY" = 1 ] && return 0
  [ -d "$STATE_DIR" ] || return 0
  printf 'completed %s by %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(id -un)" > "$(marker "$1")" 2>/dev/null || true
}
marked() { [ -f "$(marker "$1")" ]; }

# ── Running things as `deploy`. ─────────────────────────────────────────────
#
# §3.4 says "log out and back in as deploy — group membership is not
# retroactive". That is true of the CURRENT shell; a NEW process gets its
# supplementary groups fresh from /etc/group, so runuser/sudo -u after
# `usermod -aG docker deploy` DOES have the docker group. That claim is proved
# rather than assumed: the `user` step runs `docker ps` through this exact path
# before anything depends on it.
as_deploy() {
  if [ "$DRY" = 1 ]; then printf '  would run as %s: %s\n' "$DEPLOY_USER" "$*"; return 0; fi
  if command -v runuser >/dev/null 2>&1; then
    runuser -u "$DEPLOY_USER" -- env HOME="$DEPLOY_HOME" USER="$DEPLOY_USER" LOGNAME="$DEPLOY_USER" "$@"
  else
    sudo -u "$DEPLOY_USER" -H "$@"
  fi
}

# as_deploy_sh — a shell snippet on stdin, run as deploy. Taking the body on
# stdin rather than in a quoted argument is deliberate: the §3.9 probes contain
# nested quotes, backslashes and a psql statement, and escaping those through
# two shells is a bug waiting for 2am.
#
# BUT IT IS RUN FROM A FILE, WITH STDIN CLOSED, NOT PIPED TO `bash -s`.
#
# Bash reading a script from a PIPE reads it minimally, a chunk at a time, and
# leaves the rest in the pipe. Any child that reads stdin therefore EATS THE
# REST OF THE SCRIPT. `docker compose exec` defaults to --interactive=true and
# `-T` only turns off the TTY, so its stdin pump does exactly that — and the
# §3.9 body's very first probe is a `dc exec -T`. Piped, that body printed
# `dc ps`, ran ONE probe, and exited 0; STORAGE-OK's own result line,
# WEB-TO-API-OK, the /pricing check, the help-centre query, the admin_users
# query and the closing `exit $fails` were all silently consumed, and the
# installer reported "§3.9 verification passed". Reproduced here with a
# faithful stand-in for the pump. A real file has a seekable descriptor of its
# own, and `</dev/null` means a child that reads stdin gets EOF instead.
#
# The file is 600 and owned by the deploy user, not 644: nothing in these
# bodies is a secret (they carry PATHS to .env.prod, never its contents), and
# that is exactly why it costs nothing to keep it that way.
as_deploy_sh() {
  local body tmp rc=0
  body="$(cat)"
  if [ "$DRY" = 1 ]; then
    printf '  would run a %s-line script as %s\n' "$(printf '%s\n' "$body" | wc -l | tr -d ' ')" "$DEPLOY_USER"
    return 0
  fi
  tmp="$(mktemp "${TMPDIR:-/tmp}/libriant-step.XXXXXX")"
  register_tmp "$tmp"
  printf '%s\n' "$body" > "$tmp"
  chmod 600 "$tmp"
  chown "$DEPLOY_USER" "$tmp" 2>/dev/null || chmod 644 "$tmp"
  as_deploy bash "$tmp" < /dev/null || rc=$?
  rm -f "$tmp"
  return "$rc"
}

# as_deploy_dc — the same, with §6.1's `dc` preamble in front of it.
as_deploy_dc() {
  local body
  body="$(cat)"
  { dc_preamble; printf '%s\n' "$body"; } | as_deploy_sh
}

# env_set_if_absent KEY VALUE — set a key in .env.prod unless it already has a
# REAL value, as deploy, preserving 600. Same contract as ensure-env.sh: never
# overwrite an operator-set value.
#
# "Absent" means absent OR present-but-empty. ensure-env.sh copies every key
# that is in .env.prod.example but missing from your file, several of them with
# no value, so `KEY=` is a state that occurs on a perfectly normal first run —
# and treating it as "already set" is how the operator's answer to a prompt
# they just typed gets thrown away with a dim one-line note. See env_set_stream.
env_set_if_absent() {
  local k="$1" v="$2" state tmp
  if [ "$DRY" = 1 ]; then printf '  would set %s in %s (only if it has no value)\n' "$k" "$ENV_FILE"; return 0; fi
  state="$(env_key_state "$ENV_FILE" "$k")"
  if [ "$state" = "set" ]; then
    note "$k already has a value in $ENV_FILE — left alone"
    return 0
  fi
  tmp="$(mktemp "${ENV_FILE}.new.XXXXXX")" || die "could not create a temp file beside $ENV_FILE"
  chmod 600 "$tmp"
  env_set_stream "$k" "$v" < "$ENV_FILE" > "$tmp" \
    || { rm -f "$tmp"; die "could not rewrite $ENV_FILE while setting $k"; }
  chown "$(stat_owner "$ENV_FILE")" "$tmp" 2>/dev/null || true
  mv -f "$tmp" "$ENV_FILE" || { rm -f "$tmp"; die "could not replace $ENV_FILE"; }
  chmod 600 "$ENV_FILE"
  [ "$(env_key_state "$ENV_FILE" "$k")" = "set" ] \
    || die "$k is STILL not set in $ENV_FILE after writing it. Do not walk away from
     this: backup.sh aborts before the first byte without it."
  if [ "$state" = "empty" ]; then ok "set $k in $ENV_FILE (it was present but empty)"
  else ok "added $k to $ENV_FILE"; fi
}

# The host's own addresses, for the external-scan instructions. Detected, never
# hard-coded: this script must not print an IP it has not read off the box.
host_v4() { ip -4 -o addr show scope global 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | head -1; }
# `ip` comes from iproute2, which is Priority: important on Ubuntu and is also
# installed by the packages step — but the ufw step runs BEFORE that step, and
# the decision it makes with this answer is whether a missing v6 rule is a
# lockout. /proc/net/if_inet6 is the kernel's own answer and needs no package:
# field 4 is the scope, and 00 is global.
host_v6() {
  local a
  a="$(ip -6 -o addr show scope global 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | head -1)"
  if [ -z "$a" ] && [ -r /proc/net/if_inet6 ]; then
    a="$(awk '$4 == "00" { print "(a global IPv6 address on " $6 ")"; exit }' /proc/net/if_inet6)"
  fi
  printf '%s' "$a"
}
has_global_v6() { [ -n "$(host_v6)" ]; }

# The address to put in the external-scan instructions. NEVER a made-up one:
# when the box cannot tell us, print a literal placeholder so the operator sees
# a command that is obviously incomplete rather than one that silently scans
# nothing (`nmap -Pn -p 22,80,443` with no target exits immediately and looks
# like it passed).
scan_v4() {
  local a; a="$(host_v4 || true)"
  [ -n "$a" ] && printf '%s' "$a" || printf '%s' "[PLACEHOLDER: this box's public IPv4 — read it with: ip -4 addr]"
}
scan_v6() {
  local a; a="$(host_v6 || true)"
  [ -n "$a" ] && printf '%s' "$a" || printf '%s' "[this box reports no global IPv6 address — skip the v6 scan]"
}

# ── $DATA_ROOT MUST BE ITS OWN FILESYSTEM, and "it isn't" has two very
#    different causes that look identical from the box.
#
# THE ONE THAT MUST NOT BE WAVED THROUGH: a Hetzner Rebuild wipes the boot disk
# — /etc/fstab with it — and leaves the data volume intact but UNMOUNTED. The
# installer is then re-run on a box where /mnt/libriant is an empty directory
# on the root filesystem with 250 GiB of live library data sitting invisibly
# under it. One `y` and: the dirs step creates postgres/ redis/ storage/
# backups/ env/ on the BOOT DISK; ensure-env.sh's CRITICAL POSTGRES_PASSWORD
# guard looks for $DATA_ROOT/postgres/PG_VERSION, finds the empty directory
# just created, does NOT fire, and mints a fresh password; the deploy
# initialises a SECOND, empty cluster; the health gate goes green; §3.9 passes;
# and fourteen days of backups are scheduled onto the boot disk. Every library's
# data is still on the volume, unreachable, and the running app is keyed to a
# password that cannot open it. The moment anyone mounts the volume the whole
# install disappears behind the mount.
#
# THE OTHER ONE: a smaller box that genuinely has no separate volume. Legitimate
# — but it is a decision, so it is typed out, not a keystroke.
DATA_ROOT_ACKED=0
assert_data_root_sane() {
  if mountpoint -q "$DATA_ROOT" 2>/dev/null || findmnt -rno TARGET "$DATA_ROOT" >/dev/null 2>&1; then
    return 0
  fi
  [ "$DATA_ROOT_ACKED" = 1 ] && return 0

  # An fstab entry for this path that is not mounted is not a design choice.
  # It is a mount that did not happen, and it is the exact signature of the
  # boot-disk-rebuild case.
  local fstab=""
  fstab="$(findmnt --fstab -rno SOURCE,TARGET "$DATA_ROOT" 2>/dev/null || true)"
  if [ -n "$fstab" ]; then
    die "$DATA_ROOT has an /etc/fstab entry and is NOT MOUNTED:
       $fstab
     That is a FAILED MOUNT, not a box without a data volume. Continuing would
     build a second, empty Postgres cluster on the boot disk while the real one
     sits under the mountpoint — and ensure-env.sh's POSTGRES_PASSWORD guard
     cannot see a cluster it cannot reach, so it would mint a new password over
     the top. Mount it first:  mount $DATA_ROOT"
  fi

  # No fstab line, but a formatted block device with no mountpoint is the same
  # story with the fstab lost. Name the device rather than ask a vague question.
  local orphans=""
  orphans="$(lsblk -Pno NAME,FSTYPE,MOUNTPOINT,SIZE 2>/dev/null | unmounted_filesystems | sed 's/^/       /' || true)"
  if [ -n "$orphans" ]; then
    warn "$DATA_ROOT is NOT a mount point, and this box has formatted block device(s)"
    warn "that are not mounted anywhere:"
    printf '%s\n' "$orphans"
    warn "If one of those is the data volume, MOUNT IT and re-run. Continuing would put"
    warn "Postgres, Redis, the uploads AND the backups on the boot disk, and mounting"
    warn "the volume later would hide every byte of it behind the mount."
  else
    warn "$DATA_ROOT is NOT a separate mount point."
    warn "Everything the stack persists would go on the boot disk. §1: it should be"
    warn "its own logical volume."
  fi
  confirm_typed "This box deliberately has no separate data volume, and you accept
     Postgres, Redis, uploads and backups all living on the root filesystem." "BOOTDISK" \
    || die "Stopped. Mount the data volume at $DATA_ROOT first, then re-run."
  DATA_ROOT_ACKED=1
  _logline "DECISION $DATA_ROOT accepted on the root filesystem (typed BOOTDISK)"
  return 0
}

# The ssh port(s) this box actually serves. The UNION of FOUR sources, because
# no single one of them is authoritative and being wrong here is a lockout:
#
#   ss -Hlntp                    what the kernel is ACTUALLY listening on. The
#                                only source that is right on a socket-activated
#                                box, where sshd_config's Port is ignored.
#   systemctl show ssh.socket    the socket unit's own ListenStream, which
#                                answers even when `ss` is not installed yet
#                                (the ufw step runs before the packages step).
#   sshd -T                      the config's view. Right on a classic box, and
#                                it also catches a port that is configured but
#                                not yet listening.
#   $SSH_CONNECTION              the one port we KNOW carries a working session
#                                — when sudo's env_reset has not dropped it.
#
# Union, never intersection: allowing a port nothing uses costs nothing;
# missing the one in use costs the machine. Never a bare "22" unless something
# actually said 22.
#
# The trailing `|| true` is load-bearing under `set -o pipefail`: when there is
# NO port to report, grep exits 1, the pipeline exits 1, and `ports="$(...)"`
# in the caller would abort the whole script under `set -e` — silently, before
# the careful refusal below could print. Found by driving step_ufw with an sshd
# that reports no port at all, which is precisely the case that refusal exists
# for. An empty answer is a FACT for the caller to handle, not an error.
ssh_ports_all() {
  { ss -Hlntp 2>/dev/null | ss_ssh_ports
    systemctl show ssh.socket -p Listen --value 2>/dev/null | socket_listen_ports
    systemctl show sshd.socket -p Listen --value 2>/dev/null | socket_listen_ports
    sshd -T 2>/dev/null | sshd_ports
    [ -n "${SSH_CONNECTION:-}" ] && ssh_port_from_connection "$SSH_CONNECTION"
    true
  } | grep -E '^[0-9]+$' | sort -un || true
}

# ssh_ports_listening — ONLY the sockets that are up right now. `ssh_ports_all`
# is the union used for "what must ufw allow"; this narrower answer is what the
# origin-firewall step needs, because the question there is the opposite one:
# "is sshd sitting on a port I am about to DROP?"
ssh_ports_listening() {
  { ss -Hlntp 2>/dev/null | ss_ssh_ports
    systemctl show ssh.socket -p Listen --value 2>/dev/null | socket_listen_ports
    systemctl show sshd.socket -p Listen --value 2>/dev/null | socket_listen_ports
    sshd -T 2>/dev/null | sshd_ports
    true
  } | grep -E '^[0-9]+$' | sort -un || true
}

# ════════════════════════════════════════════════════════════════════════════
# STEPS — docs/RUNBOOK.md §3, in order.
#
# Each step has a `satisfied_<step>` that inspects the MACHINE. The driver uses
# it twice: to skip work on a re-run, and to draw --status. A step that returns
# 1 from `satisfied_` always runs; that is the right answer for anything
# read-only or cheap.
# ════════════════════════════════════════════════════════════════════════════

# ── Briefing: what to have in front of you ──────────────────────────────────
satisfied_briefing() { marked briefing; }

step_briefing() {
  say "Before we start — what you need in front of you"
  cat <<BRIEF

  This script will, in order:

    as root       take stock · SSH password auth OFF · ufw (v4+v6) · baseline
                  packages + fail2ban · Docker · the '${DEPLOY_USER}' user ·
                  directories on ${DATA_ROOT}
    as ${DEPLOY_USER}   a GitHub deploy key (it PAUSES for you) · the checkout ·
                  .env.prod · the Cloudflare origin certificate · the dc helper ·
                  a dry run · the real deploy
    as root       the nightly backup (§8.2) · the origin firewall
                  (authn-authz-01) · the post-deploy checks §3.9 does by hand

  The backup comes BEFORE the firewall on purpose. The firewall step stops the
  run on any fatal finding, and some of those (an ip6tables chain Docker never
  created) have nothing to do with backups — in the other order, an operator who
  could not resolve one walked away from a production box with no backups at
  all, which looks exactly like a box that has them.

  It will NOT put this box in DNS. That is a separate, deliberate decision
  (RUNBOOK §5.4), and the deploy prints "nothing is public" for a reason.

  ${C_B}Have these in front of you now${C_0}

    1. ${C_B}A second SSH session, already open and working.${C_0}
       The 'ssh' step disables password authentication. If the key you rely on
       does not work after that, only the provider console gets you back in.

    2. ${C_B}The Cloudflare Origin certificate — both PEM blocks.${C_0}
       Dashboard -> SSL/TLS -> Origin Server -> Create Certificate, hostnames
       BOTH the apex AND *.<apex>. No backup contains this pair; if it is not
       in your password manager it exists nowhere else.

    3. ${C_B}A browser logged in to GitHub${C_0} with rights to add a READ-ONLY
       Deploy Key to ${REPO_URL}.

    4. ${C_B}The first admin e-mail and password${C_0} (12 characters minimum).
       Without the email no admin is created and the deploy prints a warning;
       without the password no admin is created and NOTHING warns at all.

    5. ${C_B}A password for the '${DEPLOY_USER}' account${C_0}, and somewhere to store it.
       sudo cannot authenticate without one and a third of the runbook is sudo.

    6. ${C_B}A backup encryption decision${C_0}: an age RECIPIENT (public key, 'age1…',
       identity kept OFF this host) or a gpg passphrase file. backup.sh
       refuses to run without one, so this is not something to defer.

    7. ${C_B}tmux or screen.${C_0} The image build is 10-20 minutes cold and an SSH
       drop in the middle of it kills the run.

  ${C_B}Two things this script guards, and why${C_0}

    · ${C_B}Lockout.${C_0} Before password auth goes off it counts the USABLE keys in
      the authorized_keys of every account you could log in as — parsing them
      the way sshd does, and checking the StrictModes bits that make sshd
      ignore a key that looks perfect — and refuses if there are none. Before
      ufw is enabled it reads the port sshd is ACTUALLY listening on and proves
      the allow rule exists, rather than assuming 22.
    · ${C_B}Your existing install.${C_0} It never regenerates a secret that exists,
      never overwrites an origin certificate, never touches a data directory,
      and tells you before anything discards uncommitted work.

BRIEF
  if [ -z "${TMUX:-}" ] && [ -z "${STY:-}" ]; then
    warn "You are not inside tmux or screen. A dropped connection during the"
    warn "10-20 minute build ends the install mid-flight. Consider: tmux new -s libriant"
  else
    ok "running inside tmux/screen — an SSH drop will not kill the build"
  fi
  confirm_typed "All seven are in front of you?" "READY" \
    || die "Stopped, with nothing changed. Come back when they are — every step
     checks the machine rather than a marker, so re-running resumes."
  mark_done briefing
}

# ── §3.1 Get on the box and take stock ──────────────────────────────────────
# Read-only apart from the timezone question, and its findings change over
# time, so it always runs.
satisfied_stock() { return 1; }

step_stock() {
  say "§3.1 Taking stock"
  printf '\n'
  uptime || true
  free -h 2>/dev/null || true
  df -h / "$DATA_ROOT" 2>/dev/null || df -h / || true
  lsblk 2>/dev/null || true

  # §1 records both arrays as [UU]. A degraded array before a first deploy is a
  # reason to stop and think, not a line to scroll past.
  if [ -r /proc/mdstat ]; then
    cat /proc/mdstat
    if grep -q '\[[U_]*_[U_]*\]' /proc/mdstat; then
      warn "a RAID array is DEGRADED (/proc/mdstat does not show all [U])."
      confirm "Install onto a degraded array anyway?" || die "Stopped. Fix the array first."
    else
      ok "RAID arrays look healthy"
    fi
  fi

  # $DATA_ROOT must be its own filesystem. If it is only a directory on the
  # boot disk then every byte of Postgres, Redis, the uploads AND the backups
  # lands on the 80 GiB root — and the day someone mounts the real volume over
  # it, all of it disappears behind the mount.
  if mountpoint -q "$DATA_ROOT" 2>/dev/null || findmnt -rno TARGET "$DATA_ROOT" >/dev/null 2>&1; then
    ok "$DATA_ROOT is a mounted filesystem"
  else
    assert_data_root_sane
  fi

  # §3.8 step 6: budget ~15-20 GB in /var/lib/docker for a cold build. The
  # runbook marks that figure UNVERIFIED ON THIS BOX (it was measured on the
  # dead machine), so this stays a check with the caveat attached, not a fact.
  local root_free_gb
  root_free_gb="$(df -Pk / 2>/dev/null | awk 'NR==2 {printf "%d", $4/1024/1024}' || true)"
  if [ -z "$root_free_gb" ]; then
    # An empty answer must not print as "only  GiB free", which reads like a
    # number that happens to be missing rather than a check that did not run.
    warn "could not read the free space on / (df produced nothing)."
    warn "The cold build wants ~15-20 GiB in /var/lib/docker — a figure the runbook"
    warn "marks UNVERIFIED on this box. Check it yourself:  df -h /"
    confirm "Continue without knowing how much space is free?" || die "Stopped. Check df -h / first."
  elif [ "${root_free_gb:-0}" -lt 25 ]; then
    warn "only ${root_free_gb} GiB free on / — the cold build wants ~15-20 GiB in /var/lib/docker (a figure the runbook marks UNVERIFIED on this box)."
    confirm "Continue anyway?" || die "Stopped. Free space on / first."
  else
    ok "${root_free_gb} GiB free on / (cold build wants ~15-20 GiB; UNVERIFIED figure)"
  fi

  # ── §1 "Timezone decision". Neither the deploy nor any other script asks
  #    this, and it has to be settled BEFORE the first deploy because the whole
  #    document — cron times, log timestamps, the backup window — is written in
  #    host time. "A backup at 02:15 Berlin runs at 03:15 for a Greek library.
  #    That is fine and deliberate." Changing it afterwards silently moves the
  #    backup window and every timestamp anyone correlates against.
  HOST_TZ="$(timedatectl show -p Timezone --value 2>/dev/null || cat /etc/timezone 2>/dev/null || echo unknown)"
  printf '\n'
  note "host timezone: ${HOST_TZ}"
  note "§1: the customers are in Greece; this box's clock is what every cron line"
  note "     in the runbook means. The backup this installer schedules runs at"
  note "     02:15 HOST time. Change the zone ONCE, before the first deploy, or"
  note "     not at all."
  if [ "$DRY" = 0 ] && confirm "Change the host timezone before continuing?"; then
    local tz=""
    ask tz "IANA timezone (e.g. Europe/Athens; blank to keep ${HOST_TZ})"
    if [ -n "$tz" ]; then
      tz_looks_valid "$tz" || die "'$tz' is not the shape of an IANA zone (Area/Location). Nothing was changed."
      if command -v timedatectl >/dev/null 2>&1; then
        timedatectl list-timezones 2>/dev/null | grep -qxF "$tz" \
          || die "'$tz' is not in timedatectl's list of zones. Nothing was changed."
      fi
      if [ -f "$CRON_FILE" ]; then
        warn "A backup cron already exists. Changing the zone MOVES its 02:15 window."
        confirm_typed "Change the zone anyway, knowing the backup window moves?" "MOVE" \
          || die "Stopped. Nothing was changed."
      fi
      run timedatectl set-timezone "$tz"
      HOST_TZ="$tz"
      ok "host timezone is now ${HOST_TZ} — update RUNBOOK §1 to match"
      _logline "DECISION timezone set to ${HOST_TZ}"
    fi
  fi

  printf '\n'
  ufw status verbose 2>/dev/null || note "ufw is not installed yet"
  sshd -T 2>/dev/null | grep -E '^(permitrootlogin|passwordauthentication|pubkeyauthentication) ' || true
  note "On a fresh box, good looks like: ufw inactive and passwordauthentication yes."
  note "Both are what the next two steps fix."
}

# ── §3.2a SSH: turn off password authentication ─────────────────────────────
#
# The one step in this document that can cost you the machine.
satisfied_ssh() {
  local t
  [ -f "$SSHD_DROPIN" ] || return 1
  t="$(sshd -T 2>/dev/null || true)"
  [ -n "$t" ] || return 1
  printf '%s\n' "$t" | sshd_values passwordauthentication      | grep -qx 'no'  || return 1
  # All three of §3.2a's values. A box where kbdinteractive is still `yes` has
  # password-equivalent PAM auth reachable and is NOT done.
  printf '%s\n' "$t" | sshd_values kbdinteractiveauthentication | grep -qx 'no'  || return 1
  printf '%s\n' "$t" | sshd_values pubkeyauthentication         | grep -qx 'yes' || return 1
  return 0
}

# Put the SSH configuration back exactly as it was found, and reload. Called
# only from the post-reload re-check — the one moment where continuing would
# leave a box nobody can log into.
ROLLBACK_PAIRS=""
DROPIN_EXISTED=0
ssh_rollback() {
  local pair bak f lost=0
  warn "ROLLING BACK the SSH change."
  for pair in $ROLLBACK_PAIRS; do
    bak="${pair%%=*}"; f="${pair#*=}"
    if [ ! -f "$bak" ]; then
      # A recorded backup that is not there means the rollback is INCOMPLETE,
      # and the caller is about to tell the operator "the change has been undone"
      # — at the exact moment they most need that to be true. Say the opposite,
      # loudly, and name the file.
      lost=1
      warn "MISSING BACKUP $bak — $f was NOT restored and still carries this script's edit."
      continue
    fi
    cp -p "$bak" "$f" && warn "restored $f"
  done
  [ "$lost" = 1 ] && warn "THE ROLLBACK IS INCOMPLETE. Do not close this session; check the files above by hand."
  if [ "$DROPIN_EXISTED" = 0 ] && [ -f "$SSHD_DROPIN" ]; then
    rm -f "$SSHD_DROPIN"
    warn "removed $SSHD_DROPIN"
  fi
  if sshd -t 2>/dev/null; then
    systemctl reload ssh 2>/dev/null || systemctl reload sshd 2>/dev/null || true
    warn "sshd reloaded with the original configuration"
  else
    warn "sshd -t rejects even the restored configuration — DO NOT CLOSE THIS SESSION."
  fi
}

step_ssh() {
  say "§3.2a SSH — disabling password authentication"

  local sshd_t
  sshd_t="$(sshd -T 2>/dev/null || true)"
  [ -n "$sshd_t" ] || die "\`sshd -T\` produced nothing. Refusing to touch the SSH configuration
     of a host whose current configuration I cannot read."

  # ─────────────────────────────────────────────────────────────────────────
  # THE LOCKOUT GUARD. Nothing below this point runs until an account that can
  # still log in AFTER the change has been proven to exist.
  # ─────────────────────────────────────────────────────────────────────────
  local pubkey_auth
  pubkey_auth="$(printf '%s\n' "$sshd_t" | sshd_values pubkeyauthentication)"
  if [ "$pubkey_auth" != "yes" ]; then
    die "sshd reports pubkeyauthentication=$pubkey_auth.
     Turning password authentication off while public keys are ALSO disabled is
     an immediate and total lockout. Fix PubkeyAuthentication first."
  fi
  ok "pubkeyauthentication is yes"

  # Ask sshd which file it reads, and expand its %h/%u tokens, rather than
  # guessing ~/.ssh/authorized_keys — a guard that inspects a file sshd never
  # opens is not a guard.
  local akf_patterns
  akf_patterns="$(printf '%s\n' "$sshd_t" | sshd_values authorizedkeysfile)"
  [ -n "$akf_patterns" ] || akf_patterns=".ssh/authorized_keys"
  note "sshd reads: $akf_patterns"

  local permitroot
  permitroot="$(printf '%s\n' "$sshd_t" | sshd_values permitrootlogin)"

  # WHO COULD ACTUALLY LOG IN. root / $SUDO_USER / deploy is not the list: an
  # operator who ssh'd in as `ubuntu` with a password and used `su -` rather
  # than sudo leaves SUDO_USER unset, so `ubuntu` is never inspected — and if
  # root happens to carry a provider-injected key the guard is satisfied, the
  # change goes through, and the ONE account whose private key the operator
  # actually holds can no longer log in. `who am i` and `logname` both know the
  # login name; ask them.
  local candidates="root" cand_extra=""
  [ -n "${SUDO_USER:-}" ] && [ "${SUDO_USER}" != "root" ] && candidates="$candidates $SUDO_USER"
  cand_extra="$(who am i 2>/dev/null | awk '{print $1}' || true)"
  [ -n "$cand_extra" ] && candidates="$candidates $cand_extra"
  cand_extra="$(logname 2>/dev/null || true)"
  [ -n "$cand_extra" ] && candidates="$candidates $cand_extra"
  id "$DEPLOY_USER" >/dev/null 2>&1 && candidates="$candidates $DEPLOY_USER"
  # De-duplicate: the same name from three sources would print three times.
  candidates="$(printf '%s\n' $candidates | grep -vx '' | sort -u | tr '\n' ' ')"

  # AllowUsers / AllowGroups / DenyUsers / DenyGroups. A hardening image that
  # ships `AllowGroups sudo` or `DenyUsers root` makes an otherwise-perfect key
  # worthless: sshd refuses the connection before it ever looks at the file.
  # Counting such a key as a way back in is the same lie as counting a
  # fingerprint.
  local sshd_au sshd_ag sshd_du sshd_dg
  sshd_au="$(printf '%s\n' "$sshd_t" | sshd_values allowusers  | tr '\n' ' ')"
  sshd_ag="$(printf '%s\n' "$sshd_t" | sshd_values allowgroups | tr '\n' ' ')"
  sshd_du="$(printf '%s\n' "$sshd_t" | sshd_values denyusers   | tr '\n' ' ')"
  sshd_dg="$(printf '%s\n' "$sshd_t" | sshd_values denygroups  | tr '\n' ' ')"
  if [ -n "$(printf '%s%s%s%s' "$sshd_au" "$sshd_ag" "$sshd_du" "$sshd_dg" | tr -d '[:space:]')" ]; then
    note "sshd restricts who may connect:"
    [ -n "$(printf '%s' "$sshd_au" | tr -d ' ')" ] && note "  AllowUsers  $sshd_au"
    [ -n "$(printf '%s' "$sshd_ag" | tr -d ' ')" ] && note "  AllowGroups $sshd_ag"
    [ -n "$(printf '%s' "$sshd_du" | tr -d ' ')" ] && note "  DenyUsers   $sshd_du"
    [ -n "$(printf '%s' "$sshd_dg" | tr -d ' ')" ] && note "  DenyGroups  $sshd_dg"
  fi

  local usable_total=0 u home akfile n m key_users="" ugroups nca
  printf '\n  Keys that will still work after this change:\n'
  for u in $candidates; do
    home="$(getent passwd "$u" | cut -d: -f6)"
    [ -n "$home" ] || continue
    ugroups="$(id -nG "$u" 2>/dev/null || true)"
    if ! sshd_permits_user "$u" "$ugroups" "$sshd_au" "$sshd_ag" "$sshd_du" "$sshd_dg"; then
      warn "$u: sshd's Allow/Deny lists REFUSE this account — its keys are not a way back in."
      continue
    fi
    # StrictModes: sshd IGNORES keys under a group- or world-writable home,
    # .ssh, or authorized_keys. The key is right there and authentication fails
    # anyway, which is the most confusing possible way to be locked out.
    m="$(stat_mode "$home" || true)"
    if [ -n "$m" ] && mode_unsafe "$m"; then
      warn "$u: home $home is mode $m — sshd's StrictModes will IGNORE its keys."
      continue
    fi
    # shellcheck disable=SC2086
    for akfile in $(resolve_authorized_keys "$home" "$u" $akf_patterns); do
      [ -f "$akfile" ] || continue
      m="$(stat_mode "$akfile" || true)"
      if [ -n "$m" ] && mode_unsafe "$m"; then
        warn "$u: $akfile is mode $m — group/world writable, StrictModes will ignore it."
        continue
      fi
      m="$(stat_mode "$(dirname "$akfile")" || true)"
      if [ -n "$m" ] && mode_unsafe "$m"; then
        warn "$u: $(dirname "$akfile") is mode $m — StrictModes will ignore what is inside it."
        continue
      fi
      n="$(count_usable_pubkeys "$akfile")"
      nca="$(count_ca_lines "$akfile")"
      if [ "${nca:-0}" -gt 0 ]; then
        note "$u: $akfile also has ${nca} @cert-authority line(s) — those authenticate"
        note "     CERTIFICATE holders only, so they are NOT counted as a bare-key way in."
      fi
      if [ "$n" -gt 0 ]; then
        # root counts as a way back in because the drop-in below sets
        # PermitRootLogin prohibit-password, which permits KEY auth for root
        # even where it is currently 'no'. That is a promise this step makes
        # about its own output, so it is re-checked against the EFFECTIVE
        # configuration after the reload and rolled back if it did not hold.
        [ "$u" = "root" ] && [ "$permitroot" = "no" ] && \
          note "root's key(s) count only because this step sets PermitRootLogin prohibit-password"
        ok "$u: $n usable public key(s) in $akfile"
        ssh-keygen -l -f "$akfile" 2>/dev/null | sed 's/^/         /' || true
        key_users="$key_users $u"
        usable_total=$((usable_total + n))
      else
        warn "$u: $akfile exists but holds NO usable public key (a fingerprint? a private key? a mangled paste?)"
      fi
    done
  done

  if [ "$usable_total" -eq 0 ]; then
    banner "NO ACCOUNT ON THIS BOX HAS A USABLE SSH KEY"
    printf '  Turning password authentication off now would lock you out permanently:\n'
    printf '  recovery needs the provider console or a rescue boot.\n\n'
    printf '  Checked: %s\n\n' "$candidates"
    if [ "$DRY" = 1 ]; then
      warn "(dry run) this is where the installer REFUSES, or offers to install a pasted key."
      warn "(dry run) On a real run it will not disable password auth from this state."
      return 0
    fi
    if confirm "Paste a public key for root now instead?"; then
      local pasted="" tmpkey
      ask pasted "Paste ONE public key line (ssh-ed25519 AAAA… or ssh-rsa AAAA…)"
      tmpkey="$(mktemp)"
      printf '%s\n' "$pasted" > "$tmpkey"
      if [ "$(count_usable_pubkeys "$tmpkey")" -lt 1 ]; then
        rm -f "$tmpkey"
        die "That is not a usable public key line. Nothing was changed."
      fi
      install -d -m 700 -o root -g root /root/.ssh || { rm -f "$tmpkey"; die "could not create /root/.ssh"; }
      cat "$tmpkey" >> /root/.ssh/authorized_keys  || { rm -f "$tmpkey"; die "could not write /root/.ssh/authorized_keys"; }
      chmod 600 /root/.ssh/authorized_keys         || die "could not chmod /root/.ssh/authorized_keys"
      chown root:root /root/.ssh/authorized_keys   || die "could not chown /root/.ssh/authorized_keys"
      rm -f "$tmpkey"
      # Re-read it the way sshd will. Writing the file is not the same as the
      # file now holding a key sshd would accept.
      [ "$(count_usable_pubkeys /root/.ssh/authorized_keys)" -gt 0 ] \
        || die "/root/.ssh/authorized_keys still holds no usable key after the write.
     Password authentication has NOT been touched."
      ok "installed a key into /root/.ssh/authorized_keys"
      banner "VERIFY IT BEFORE CONTINUING"
      printf '  Open a SECOND session now and confirm you can log in with that key.\n'
      confirm_typed "This session is your only way in until you have." "VERIFIED" \
        || die "Stopped, deliberately. Password authentication is still ON."
    else
      die "Refusing to disable password authentication with no usable key on the box.
     Add your public key to /root/.ssh/authorized_keys (mode 600, .ssh mode 700)
     and re-run. Nothing was changed."
    fi
  else
    printf '\n'
    warn "Keep THIS session open. Open a SECOND session now, log in with one of the"
    warn "keys above, and leave it connected. If you are logged in with a PASSWORD,"
    warn "that session is the last one you will get."
  fi

  # ─────────────────────────────────────────────────────────────────────────
  # OpenSSH uses the FIRST value it obtains and reads drop-ins in lexical
  # order, so a 99- file cannot override a 50-cloud-init.conf. Find every place
  # it is set, comment those out, and put the authoritative value in a 00- file.
  #
  # Everything modified from here on is recorded, so that if the effective
  # configuration turns out not to permit a key login this step can put the box
  # back the way it found it, rather than leave the operator locked out of a
  # machine that was fine ten seconds ago.
  # ─────────────────────────────────────────────────────────────────────────
  # BOTH keywords. §3.2a's "good looks like" is THREE values, and
  # KbdInteractiveAuthentication is password-equivalent PAM auth: a lexically
  # earlier 50-cloud-init.conf setting it to `yes` wins by exactly the mechanism
  # this whole step exists to defeat. Hunting only PasswordAuthentication leaves
  # the step able to report green with that door still open.
  #
  # `--include='*.conf'`, and backups written OUTSIDE the include directory:
  # sshd_config.d is an Include glob, and a `.bak-*` file left in it was matched
  # by the recursive grep on the NEXT run, re-edited, backed up again, and
  # counted as a change — so `--only ssh` reloaded sshd and demanded a typed
  # VERIFIED for a run in which nothing real happened. The one prompt that must
  # never become reflex is that one.
  local hits changed=0 bakdir
  ROLLBACK_PAIRS=""
  DROPIN_EXISTED=0
  [ -f "$SSHD_DROPIN" ] && DROPIN_EXISTED=1
  bakdir="${STATE_DIR}/sshd-backups"
  [ "$DRY" = 1 ] || install -d -m 700 -o root -g root "$bakdir" \
    || die "could not create $bakdir, and this step will not edit sshd's configuration
     without somewhere to put the originals."
  hits="$(grep -rn -i -E '^[[:space:]]*(passwordauthentication|kbdinteractiveauthentication)' \
            --include='*.conf' "$SSHD_CONFIG" "$SSHD_CONFIG_DIR"/ 2>/dev/null \
            | grep -v "^${SSHD_DROPIN}:" || true)"
  if [ -n "$hits" ]; then
    note "existing PasswordAuthentication / KbdInteractiveAuthentication settings:"
    printf '%s\n' "$hits" | sed 's/^/         /'
    local f bak
    for f in $(printf '%s\n' "$hits" | cut -d: -f1 | sort -u); do
      [ "$f" = "$SSHD_DROPIN" ] && continue
      if [ "$DRY" = 1 ]; then
        printf '  would comment out PasswordAuthentication / KbdInteractiveAuthentication in %s\n' "$f"
      else
        bak="${bakdir}/$(printf '%s' "${f#/}" | tr '/' '_').bak-$(date +%Y%m%d%H%M%S)"
        # `|| die` and not a bare cp: an unchecked copy that failed (read-only
        # /etc, a full disk) would leave ROLLBACK_PAIRS naming a file that does
        # not exist, the sed below would still edit the original away, and
        # ssh_rollback would then silently restore NOTHING while the caller told
        # the operator "the change has been undone".
        cp -p "$f" "$bak" || die "could not back up $f to $bak. Nothing has been edited or reloaded."
        [ -f "$bak" ] || die "the backup of $f was not created. Nothing has been edited or reloaded."
        sed -i -E 's/^([[:space:]]*([Pp][Aa][Ss][Ss][Ww][Oo][Rr][Dd]|[Kk][Bb][Dd][Ii][Nn][Tt][Ee][Rr][Aa][Cc][Tt][Ii][Vv][Ee])[Aa][Uu][Tt][Hh][Ee][Nn][Tt][Ii][Cc][Aa][Tt][Ii][Oo][Nn])/# libriant-installer disabled: \1/' "$f" \
          || die "could not edit $f. Nothing has been reloaded and $bak holds the original."
        ok "commented out PasswordAuthentication / KbdInteractiveAuthentication in $f"
        note "     original: $bak"
        ROLLBACK_PAIRS="$ROLLBACK_PAIRS ${bak}=${f}"
        changed=1
      fi
    done
  else
    ok "no competing PasswordAuthentication / KbdInteractiveAuthentication line to comment out"
  fi

  run install -d -m 755 -o root -g root "$SSHD_CONFIG_DIR"
  local before="" after=""
  [ -f "$SSHD_DROPIN" ] && before="$(cat "$SSHD_DROPIN")"
  write_file "$SSHD_DROPIN" 0644 root:root <<'EOF'
# Libriant — docs/RUNBOOK.md §3.2a.
# 00- so it wins: OpenSSH takes the FIRST value it obtains and reads drop-ins in
# lexical order, so a 99- file cannot override a 50-cloud-init.conf.
# Giving the deploy user a password (§3.4) does NOT re-open password login; that
# password is usable only at a sudo prompt inside an authenticated key session.
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
PubkeyAuthentication yes
EOF
  [ -f "$SSHD_DROPIN" ] && after="$(cat "$SSHD_DROPIN")"
  [ "$before" = "$after" ] || changed=1

  if [ "$DRY" = 1 ]; then note "(dry run) would validate with sshd -t, check sshd -T, then reload"; return 0; fi

  # Validate BEFORE reloading. A configuration sshd refuses to parse, plus a
  # reload, is a dead sshd — and a dead sshd on a box you are logged into once
  # is a rescue boot.
  if ! sshd -t 2>/dev/null; then
    sshd -t || true
    # ROLL BACK HERE TOO. This path is strictly more dangerous than the
    # sshd -T mismatch below — it means the on-disk configuration is one sshd
    # will NOT PARSE — and leaving the drop-in and the commented-out originals
    # in place looks harmless only because nothing has been reloaded yet. The
    # next `systemctl reload ssh` from the ssh package's own postinst under
    # unattended-upgrades, or the next reboot, starts sshd against a config it
    # rejects. That is the rescue-console outcome §3.2a exists to prevent,
    # arriving hours later with no visible cause.
    ssh_rollback
    die "sshd -t rejects the resulting configuration, and its objection is printed
     above. NOTHING was reloaded and the configuration has been PUT BACK.
     Fix what sshd named, then re-run:  $SELF --only ssh"
  fi
  ok "sshd -t accepts the configuration"

  # Then check what the configuration WOULD be, still before the reload: sshd -T
  # re-reads the files, so if something else still wins we find out while the
  # RUNNING sshd is the old, working one, and we can simply undo.
  local pre pa pk pr kb
  pre="$(sshd -T 2>/dev/null || true)"
  pa="$(printf '%s\n' "$pre" | sshd_values passwordauthentication)"
  pk="$(printf '%s\n' "$pre" | sshd_values pubkeyauthentication)"
  pr="$(printf '%s\n' "$pre" | sshd_values permitrootlogin)"
  # §3.2a names THREE values, so gate on three. KbdInteractiveAuthentication is
  # password-equivalent PAM auth and it is won by a lexically earlier drop-in in
  # exactly the way PasswordAuthentication is.
  kb="$(printf '%s\n' "$pre" | sshd_values kbdinteractiveauthentication)"
  if [ "$pa" != "no" ] || [ "$pk" != "yes" ] || [ "$kb" != "no" ]; then
    ssh_rollback
    die "With the drop-in in place, sshd would still report
       passwordauthentication=$pa  kbdinteractiveauthentication=$kb  pubkeyauthentication=$pk
     Something is read before $(basename "$SSHD_DROPIN"). NOTHING was reloaded and the
     change has been undone. Find it with:
       grep -rn -i -E '^\\s*(password|kbdinteractive)authentication' $SSHD_CONFIG $SSHD_CONFIG_DIR/"
  fi
  # If root's key was the ONLY way in, PermitRootLogin must not have come out
  # 'no' — that would be a lockout with a perfectly valid key on the box.
  case " $key_users " in
    *" root "*)
      if [ "$(printf '%s' "$key_users" | tr ' ' '\n' | grep -vx '' | grep -vx root | head -1)" = "" ] && [ "$pr" = "no" ]; then
        ssh_rollback
        die "root's key is the only way in, and the resulting config sets PermitRootLogin no.
     The change has been undone and nothing was reloaded. Give another account a
     key, or find the drop-in that sets PermitRootLogin no."
      fi ;;
  esac

  if [ "$changed" = 1 ]; then
    # reload, NOT restart: your current session survives a reload.
    systemctl reload ssh 2>/dev/null || systemctl reload sshd 2>/dev/null \
      || warn "could not reload the ssh service. New connections still read the config
     (sshd re-reads it per connection), but check: systemctl status ssh"
    ok "reloaded sshd (reload, not restart — this session survives)"
  else
    ok "configuration already correct; nothing to reload"
  fi

  # §3.2a's "good looks like".
  sshd -T 2>/dev/null | grep -E '^(passwordauthentication|kbdinteractiveauthentication|permitrootlogin|pubkeyauthentication) ' | sed 's/^/         /'
  local post post_kb post_pk
  post="$(sshd -T 2>/dev/null | sshd_values passwordauthentication || true)"
  post_kb="$(sshd -T 2>/dev/null | sshd_values kbdinteractiveauthentication || true)"
  post_pk="$(sshd -T 2>/dev/null | sshd_values pubkeyauthentication || true)"
  [ "$post" = "no" ] || die "passwordauthentication is still '$post' after the reload. Investigate before going further."
  # ASSERTED, not printed. All three of §3.2a's values, or this step has not
  # done what it says on the tin.
  [ "$post_kb" = "no" ] || die "kbdinteractiveauthentication is '$post_kb' after the reload — that is
     password-equivalent PAM authentication, still reachable. §3.2a lists it as one
     of the three values that must be right. Find what sets it:
       grep -rn -i '^\\s*kbdinteractiveauthentication' $SSHD_CONFIG $SSHD_CONFIG_DIR/"
  [ "$post_pk" = "yes" ] || die "pubkeyauthentication is '$post_pk' after the reload, and passwords are now off.
     Undo immediately from THIS session:  rm $SSHD_DROPIN && systemctl reload ssh"
  ok "passwordauthentication no, kbdinteractiveauthentication no, pubkeyauthentication yes, permitrootlogin $pr"

  if [ "$changed" = 1 ]; then
    banner "KEEP THIS SESSION OPEN UNTIL YOU HAVE PROVED A SECOND ONE WORKS"
    printf '  If you cannot open a second session now, this one is the only thing\n'
    printf '  standing between you and a rescue boot.\n'
    confirm_typed "A second session is open and working?" "VERIFIED" \
      || die "Stopped at your request. SSH is ALREADY hardened — fix your access from
     THIS session before you close it. To undo:  rm $SSHD_DROPIN && systemctl reload ssh"
  fi
}

# ── §3.2b ufw, with IPv6, allowing the REAL ssh port ────────────────────────
satisfied_ufw() {
  local p ports st
  st="$(ufw status 2>/dev/null || true)"
  printf '%s\n' "$st" | ufw_is_active || return 1
  grep -qi '^IPV6=yes' "$UFW_DEFAULTS" 2>/dev/null || return 1
  ports="$(ssh_ports_all)"
  # No ports means the check could not be PERFORMED, which is not the same as
  # passing it. Reporting "satisfied" here would skip the one step standing
  # between the operator and a firewall with no ssh rule.
  [ -n "$ports" ] || return 1
  for p in $ports; do
    printf '%s\n' "$st" | ufw_allows_port "$p" || return 1
  done
  return 0
}

step_ufw() {
  say "§3.2b ufw — default deny, with IPv6"

  # iproute2 comes with `ss`, which is how the REAL listening port is read.
  # It is Priority: important on Ubuntu so it is normally already there — but
  # this step runs BEFORE the packages step and the decision it makes with that
  # answer is whether the operator keeps their session, so make sure rather than
  # assume. `ufw` likewise, if it is not installed yet.
  local need=""
  command -v ufw >/dev/null 2>&1 || need="$need ufw"
  command -v ss  >/dev/null 2>&1 || need="$need iproute2"
  if [ -n "$need" ]; then
    note "installing before the packages step (needed to read the real ssh port):$need"
    # try, not run: `apt-get update` exits non-zero if ANY configured source
    # fails — one stale third-party PPA is enough — while still refreshing
    # everything else. The install below is the real gate, and it dies.
    try apt-get update -qq || warn "apt-get update reported an error; continuing, the install below is the gate"
    # shellcheck disable=SC2086
    run env DEBIAN_FRONTEND=noninteractive apt-get install -y $need
  fi

  # THE REAL PORT. Read from the LISTENING SOCKET first, then the socket unit,
  # then sshd's config, then this session — never assumed. A box moved to 2222
  # and a firewall that allows 22 is the same outage as no rule at all; it just
  # looks more responsible in the transcript. And on a socket-activated box —
  # Ubuntu's default since 22.10 — `sshd -T` prints the CONFIG's port while the
  # world connects to ssh.socket's, so config alone is not an answer.
  local ports p listening sockports
  ports="$(ssh_ports_all | tr '\n' ' ')"
  # BOTH live sources. Under socket activation the listening socket belongs to
  # systemd (pid 1), so `ss` shows `users:(("systemd"…))` and NOT sshd — there
  # is nothing in that row to identify it by. The socket unit is the source that
  # can answer on such a box, and `ss` is the source that can answer on a
  # classic one. Warning on either being empty on its own would fire on every
  # normal Ubuntu box and teach the operator to skip past it.
  sockports="$( { systemctl show ssh.socket -p Listen --value 2>/dev/null
                  systemctl show sshd.socket -p Listen --value 2>/dev/null
                  true; } | socket_listen_ports | sort -un | tr '\n' ' ' || true)"
  listening="$(ss -Hlntp 2>/dev/null | ss_ssh_ports | sort -un | tr '\n' ' ' || true)"
  if [ -z "$(printf '%s' "$ports" | tr -d ' ')" ]; then
    die "REFUSING to enable a default-deny firewall: I cannot determine which port
     sshd listens on. Nothing answered — not 'ss', not ssh.socket, not 'sshd -T',
     and SSH_CONNECTION is unset (sudo drops it). Enabling ufw now would drop you
     mid-run. Find the port, allow it by hand, and re-run this step:
       ss -lntp | grep sshd
       ufw allow <port>/tcp comment 'ssh'
       $SELF --only ufw"
  fi
  ok "ssh port(s) to allow: $ports"
  [ -n "$(printf '%s' "$listening" | tr -d ' ')" ] && note "sshd is listening on: $listening   (from ss)"
  [ -n "$(printf '%s' "$sockports" | tr -d ' ')" ] && note "ssh.socket ListenStream: $sockports   (socket-activated: sshd_config's Port is IGNORED)"
  if [ -z "$(printf '%s%s' "$listening" "$sockports" | tr -d ' ')" ]; then
    warn "Neither 'ss' nor ssh.socket could tell me where ssh is actually listening."
    warn "The port(s) above come from sshd's config and this session only — and on a"
    warn "socket-activated box the config's Port is IGNORED, so those can be wrong."
    warn "Check by hand before you continue:  ss -lntp | grep -iE 'ssh|:22'"
    confirm "Continue and allow the port(s) listed above?" \
      || die "Stopped, with ufw untouched. Allow the right port by hand, then: $SELF --only ufw"
  fi

  # ufw only reads IPV6= at ENABLE time. The box has public IPv6 (§1), so a
  # v4-only ruleset leaves v6 open.
  local ipv6_changed=0 was_active=0
  ufw status 2>/dev/null | ufw_is_active && was_active=1
  if grep -qi '^IPV6=yes' "$UFW_DEFAULTS" 2>/dev/null; then
    ok "$UFW_DEFAULTS has IPV6=yes"
  else
    if [ "$DRY" = 1 ]; then
      printf '  would set IPV6=yes in %s\n' "$UFW_DEFAULTS"
    else
      cp -p "$UFW_DEFAULTS" "${UFW_DEFAULTS}.bak-$(date +%Y%m%d%H%M%S)"
      if grep -qi '^IPV6=' "$UFW_DEFAULTS"; then
        sed -i 's/^IPV6=.*/IPV6=yes/' "$UFW_DEFAULTS"
      else
        printf 'IPV6=yes\n' >> "$UFW_DEFAULTS"
      fi
      grep -qi '^IPV6=yes' "$UFW_DEFAULTS" || die "could not set IPV6=yes in $UFW_DEFAULTS."
      ipv6_changed=1
      ok "set IPV6=yes in $UFW_DEFAULTS"
    fi
  fi

  run ufw default deny incoming
  run ufw default allow outgoing
  for p in $ports; do
    run ufw allow "${p}/tcp" comment 'ssh'
  done

  # PROVE the rule is in the ruleset BEFORE enabling. `ufw allow` on an inactive
  # firewall still records the rule; `ufw show added` is how you read it back.
  # Enabling default-deny without this check is exactly how an operator gets cut
  # off mid-run, and it is entirely avoidable.
  if [ "$DRY" = 0 ]; then
    local added
    added="$(ufw show added 2>/dev/null || true)
$(ufw status 2>/dev/null || true)"
    for p in $ports; do
      printf '%s\n' "$added" | ufw_allows_port "$p" \
        || die "ufw has no allow rule for ${p}/tcp, and I will not enable a default-deny
     firewall without one — that would drop this SSH session and every future one.
     Add it by hand and re-run:  ufw allow ${p}/tcp comment 'ssh'"
      ok "ufw has an allow rule for ${p}/tcp"
    done
  fi

  if [ "$was_active" = 1 ] && [ "$ipv6_changed" = 1 ]; then
    warn "ufw was active with IPV6=no. It only reads that at ENABLE time, so it must"
    warn "be cycled. The ssh allow rules are already in the ruleset and nothing is"
    warn "blocked while it is down, so this cannot lock you out — but say yes knowingly."
    confirm "Cycle ufw now?" || die "Stopped. IPV6=yes is written; cycle it yourself when ready:
       ufw disable && ufw --force enable"
    run ufw --force disable
    run ufw --force enable
  else
    run ufw --force enable
  fi

  if [ "$DRY" = 0 ]; then
    local st; st="$(ufw status verbose 2>/dev/null || true)"
    printf '%s\n' "$st" | sed 's/^/         /'
    printf '%s\n' "$st" | ufw_is_active || die "ufw is not active after --force enable."

    # §3.2b's "good looks like": TWO rules per ssh port — 22/tcp and 22/tcp (v6).
    # A missing v6 rule on a box with a public IPv6 address is a lockout of a
    # different shape: every NEW v6 connection is denied. Existing connections
    # survive (ufw permits ESTABLISHED), so turning the firewall back off is a
    # real recovery and the right thing to do rather than leave it up.
    local missing_v6=""
    for p in $ports; do
      if printf '%s\n' "$st" | ufw_has_v6_rule "$p"; then
        ok "port ${p}/tcp is allowed on BOTH address families"
      else
        missing_v6="$missing_v6 $p"
      fi
    done
    if [ -n "$missing_v6" ]; then
      if has_global_v6; then
        # try, not run: this is the RECOVERY path. If the disable itself fails,
        # the die below is still the message the operator needs, and replacing
        # it with "command failed: ufw --force disable" would bury the reason.
        try ufw --force disable || warn "ufw --force disable FAILED — the firewall is still UP with no v6 ssh rule."
        die "ufw came up with NO IPv6 rule for port(s):${missing_v6}, and this box has a
     public IPv6 address ($(host_v6)) — every new v6 ssh connection would be denied.
     I have turned ufw back OFF so you are not cut off. Check that
     $UFW_DEFAULTS really says IPV6=yes, then re-run:  $SELF --only ufw"
      else
        warn "no (v6) rule for port(s):${missing_v6}, but this box has no global IPv6"
        warn "address, so nothing is being denied that could have connected. If you add"
        warn "IPv6 later, re-run this step."
      fi
    fi
    ok "ufw active, default deny incoming"
  fi

  # §3.2c — say this out loud, because a green ufw is the single most misleading
  # thing on this box after the first deploy.
  banner "ufw DOES NOT FILTER 80/443 ONCE DOCKER IS UP"
  printf '  The caddy container publishes 80/443 through the DOCKER-USER chain, AHEAD of\n'
  printf '  ufw INPUT. `ufw deny 80` will not close port 80. The `firewall` step is what\n'
  printf '  closes it, and the only check that cannot be fooled is an external scan from\n'
  printf '  a machine that is not this one:\n\n'
  printf '      nmap -Pn -p 22,80,443,5432,6379,3300,9090 %s\n' "$(scan_v4)"
  printf '      nmap -6 -Pn -p 22,80,443 %s\n\n' "$(scan_v6)"
  printf '  Today: only 22 open. After the first deploy: 22, 80, 443 — and NOTHING else.\n'
  printf '  5432 and 6379 must never appear (the data network is internal: true).\n\n'
}

# ── §3.2d Baseline packages ─────────────────────────────────────────────────
#
# git, curl and openssl are not optional: deploy-on-host.sh checks only for
# docker, so a missing one fails mid-run with a bare "command not found"
# instead of a named precondition.
#
# Three additions to §3.2d's list, each with a reason:
#   iptables   prod-bootstrap.sh --firewall-only exits FATAL without ip6tables
#              and its own message says `apt-get install -y iptables`.
#   iproute2   --firewall-status uses `ss` to prove there is no [::] listener.
#              Without it that check degrades to "(ss not installed)", which is
#              the one answer nobody can act on.
#   cron       /etc/cron.d/libriant-backup is an inert text file without a cron
#              daemon, and a minimal cloud image may not ship one. A backup that
#              was never scheduled looks exactly like a backup that was.
BASE_PACKAGES="ca-certificates curl git openssl fail2ban unattended-upgrades ufw cron iproute2 iptables"

satisfied_packages() {
  local p
  for p in $BASE_PACKAGES; do
    dpkg-query -W -f='${Status}' "$p" 2>/dev/null | grep -q '^install ok installed$' || return 1
  done
  systemctl is-active --quiet fail2ban 2>/dev/null || return 1
  [ -f /etc/apt/apt.conf.d/20auto-upgrades ] || return 1
  return 0
}

step_packages() {
  say "§3.2d Baseline packages, fail2ban, unattended-upgrades"

  # try: one broken source in sources.list.d makes `apt-get update` exit
  # non-zero while every other source still refreshes. The install is the gate.
  try apt-get update || warn "apt-get update reported an error — check sources.list.d. Continuing; the install below is the gate."
  # shellcheck disable=SC2086
  run env DEBIAN_FRONTEND=noninteractive apt-get install -y $BASE_PACKAGES

  # try: fail2ban is real defence in depth, not load-bearing here — password
  # authentication is already off by this point. A jail that will not start must
  # not take down a step that also installs git, curl, openssl and iptables. The
  # post-check below says plainly whether it came up.
  try systemctl enable --now fail2ban || warn "systemctl enable --now fail2ban failed; see the jail check below"

  # Not in the runbook, and worth it: fail2ban's default sshd jail can ban the
  # operator's own address during a long provisioning session, and that looks
  # exactly like a network fault. Whitelisting the address THIS session came
  # from costs nothing.
  #
  # $SSH_CONNECTION is the obvious source and is usually absent — sudo's
  # env_reset drops it, and this script is run with sudo. `who am i` still
  # knows.
  local client_ip=""
  if [ -n "${SSH_CONNECTION:-}" ]; then
    client_ip="$(printf '%s' "$SSH_CONNECTION" | awk '{print $1}' || true)"
  fi
  if [ -z "$client_ip" ] && command -v who >/dev/null 2>&1; then
    client_ip="$(who am i 2>/dev/null | client_ip_from_who || true)"
  fi
  if [ -n "$client_ip" ] && looks_like_ip "$client_ip"; then
    run install -d -m 755 /etc/fail2ban/jail.d
    write_file /etc/fail2ban/jail.d/libriant.local 0644 root:root <<EOF
# Libriant installer: do not ban the address this box was provisioned from.
# fail2ban's sshd jail is on by default, and a long session of failed sudo or
# scp attempts is enough to trip it. Remove this file once you are confident.
[DEFAULT]
ignoreip = 127.0.0.1/8 ::1 ${client_ip}
EOF
    # try, not run: reload fails on some fail2ban builds and restart is the
    # documented fallback. `run` would die here and never reach the fallback.
    try systemctl reload fail2ban 2>/dev/null || try systemctl restart fail2ban || \
      warn "could not reload or restart fail2ban; the ignoreip file is written but not live"
    ok "fail2ban will not ban ${client_ip}"
  else
    note "could not determine this session's client address — no fail2ban ignoreip added."
    note "If fail2ban locks you out mid-install, that is why: /etc/fail2ban/jail.d/."
  fi

  # `systemctl is-active unattended-upgrades` can be green while nothing is
  # scheduled; this periodic config is what actually turns it on.
  write_file /etc/apt/apt.conf.d/20auto-upgrades 0644 root:root <<'EOF'
// Libriant installer — unattended-upgrades installed AND scheduled.
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF
  # try: some images ship it masked or socket-less; the post-check below reports
  # the real answer and this must not take the whole step down.
  try systemctl enable --now unattended-upgrades 2>/dev/null || true

  if [ "$DRY" = 0 ]; then
    systemctl is-active fail2ban >/dev/null 2>&1 && ok "fail2ban is active" || warn "fail2ban is NOT active"
    # fail2ban's sshd jail reads the journal on recent Ubuntu rather than
    # /var/log/auth.log, and a jail that silently did not start is
    # indistinguishable from one that did. UNVERIFIED on 26.04, so ask it.
    if fail2ban-client status sshd >/dev/null 2>&1; then
      ok "the fail2ban sshd jail is running"
    else
      warn "fail2ban is up but has no active 'sshd' jail. Password auth is off, so this"
      warn "is not load-bearing — but it does mean fail2ban is protecting nothing."
    fi
    systemctl is-enabled unattended-upgrades >/dev/null 2>&1 \
      && ok "unattended-upgrades is enabled" \
      || warn "unattended-upgrades is installed but not enabled: systemctl enable --now unattended-upgrades"
    # An /etc/cron.d file is a text file until something reads it.
    systemctl is-active --quiet cron 2>/dev/null \
      && ok "cron is running (the §8.2 nightly needs it)" \
      || warn "cron is NOT running — the nightly backup would never fire: systemctl enable --now cron"
  fi
}

# ── §3.3 Docker ─────────────────────────────────────────────────────────────
satisfied_docker() {
  command -v docker >/dev/null 2>&1 || return 1
  local maj
  maj="$(docker compose version 2>/dev/null | compose_major)"
  [ "${maj:-0}" -ge 2 ] 2>/dev/null || return 1
  systemctl is-active --quiet docker 2>/dev/null || return 1
  return 0
}

step_docker() {
  say "§3.3 Docker, from Docker's own apt repository"

  local codename=""
  # shellcheck disable=SC1091
  [ -r /etc/os-release ] && . /etc/os-release
  codename="${VERSION_CODENAME:-}"
  [ -n "$codename" ] || die "/etc/os-release has no VERSION_CODENAME; refusing to guess an apt suite."
  note "this release's codename is: $codename"

  # §3.3, marked UNVERIFIED in the runbook: whether Docker's apt repo has
  # published a suite for this Ubuntu release. CHECK, do not trust. And on a
  # 404 do NOT silently fall back — the runbook says pin to the previous LTS
  # codename DELIBERATELY and write down that you did, so ask, re-probe the
  # answer, and record the decision.
  local suite="$codename"
  if [ "$DRY" = 0 ]; then
    if curl -fsSI "https://download.docker.com/linux/ubuntu/dists/${codename}/Release" 2>/dev/null | http_status_ok; then
      ok "Docker publishes an apt suite for '$codename'"
    else
      warn "Docker has NO apt suite for '$codename' (the Release file did not return 200)."
      warn "§3.3: pin to the previous LTS codename DELIBERATELY, and write down that you did."
      local pin=""
      ask pin "Codename to pin to instead (no default — you are choosing this)"
      [ -n "$pin" ] || die "No codename given. Nothing was changed."
      curl -fsSI "https://download.docker.com/linux/ubuntu/dists/${pin}/Release" 2>/dev/null | http_status_ok \
        || die "Docker has no suite for '$pin' either. Nothing was changed."
      suite="$pin"
      ok "pinned to '$suite'"
      _logline "DECISION docker apt suite pinned to '$suite' because '$codename' is not published"
    fi
  fi

  run install -m 0755 -d /etc/apt/keyrings
  # `gpg --dearmor -o` FAILS on a file that already exists, so this is not just
  # an optimisation — re-running without the guard would abort the step.
  if [ -s /etc/apt/keyrings/docker.gpg ]; then
    ok "/etc/apt/keyrings/docker.gpg is already present"
  elif [ "$DRY" = 1 ]; then
    printf "  would fetch and dearmor Docker's apt signing key\n"
  else
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg \
      || die "could not fetch or dearmor Docker's apt signing key."
    ok "installed Docker's apt signing key"
  fi
  # OUTSIDE the branch above, and asserted. §3.3 makes `chmod a+r` a separate
  # line for a reason: apt verifies signatures as the `_apt` user, and a keyring
  # left at 600 root:root — an operator who followed §3.3 by hand and stopped
  # after the dearmor, or a copy made with `install -m 600` — makes the very next
  # `apt-get update` fail with a missing-public-key error that names the
  # REPOSITORY, not the permissions. Re-asserting it costs nothing and the
  # skip-when-present guard above would otherwise never reach it.
  if [ "$DRY" = 0 ] && [ -f /etc/apt/keyrings/docker.gpg ]; then
    run chmod a+r /etc/apt/keyrings/docker.gpg
    case "$(stat_mode /etc/apt/keyrings/docker.gpg)" in
      *[4567]) ok "/etc/apt/keyrings/docker.gpg is world-readable (apt reads it as _apt)" ;;
      *) die "/etc/apt/keyrings/docker.gpg is mode $(stat_mode /etc/apt/keyrings/docker.gpg) — apt runs
     as _apt and would fail the next update with a missing-public-key error that
     names the repository rather than the permissions." ;;
    esac
  fi

  write_file /etc/apt/sources.list.d/docker.list 0644 root:root <<EOF
# Libriant installer — docs/RUNBOOK.md §3.3.
# Suite '${suite}' was verified to exist at download.docker.com before this line
# was written. If it differs from this host's VERSION_CODENAME, that pin was a
# deliberate choice and it is recorded in ${INSTALL_LOG}.
deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu ${suite} stable
EOF

  # try on update, run on install: if the DOCKER repo is the unreachable one,
  # the install below fails and dies with a message that names docker-ce, which
  # is the useful error. A different broken source must not stop us here.
  try apt-get update || warn "apt-get update reported an error; the docker install below is the real gate"
  run env DEBIAN_FRONTEND=noninteractive apt-get install -y \
    docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  run systemctl enable --now docker

  if [ "$DRY" = 0 ]; then
    docker --version | sed 's/^/         /'
    docker compose version | sed 's/^/         /'
    local maj
    maj="$(docker compose version | compose_major || true)"
    # Compose v2 is REQUIRED. The stack uses the non-Swarm mem_limit / cpus /
    # pids_limit keys; v1 ignores them entirely and would start every container
    # with no resource cap at all.
    [ "${maj:-0}" -ge 2 ] 2>/dev/null || die "docker compose reports major version '$maj'. The stack needs Compose v2:
     it uses mem_limit / cpus / pids_limit, which only v2 honours."
    ok "docker and compose v${maj} are installed"
  fi
}

# ── §3.4 The deploy user ────────────────────────────────────────────────────
satisfied_user() {
  id "$DEPLOY_USER" >/dev/null 2>&1 || return 1
  id -nG "$DEPLOY_USER" 2>/dev/null | tr ' ' '\n' | grep -qx sudo   || return 1
  id -nG "$DEPLOY_USER" 2>/dev/null | tr ' ' '\n' | grep -qx docker || return 1
  [ "$(passwd -S "$DEPLOY_USER" 2>/dev/null | shadow_state)" = "P" ] || return 1
  [ "$(count_usable_pubkeys "${DEPLOY_HOME}/.ssh/authorized_keys")" -gt 0 ] || return 1
  return 0
}

step_user() {
  say "§3.4 The deploy user"

  if id "$DEPLOY_USER" >/dev/null 2>&1; then
    ok "user '$DEPLOY_USER' already exists"
  else
    if command -v adduser >/dev/null 2>&1; then
      run adduser --disabled-password --gecos "" "$DEPLOY_USER"
    else
      run useradd -m -s /bin/bash "$DEPLOY_USER"
    fi
    ok "created '$DEPLOY_USER'"
  fi

  # `usermod -aG docker` fails outright when the group does not exist, which is
  # what a skipped or failed `docker` step looks like from here. Name that
  # rather than let usermod's message be the whole explanation.
  if [ "$DRY" = 0 ] && ! getent group docker >/dev/null 2>&1; then
    die "there is no 'docker' group — Docker is not installed. Run the 'docker'
     step first (or the whole installer without --only/--skip)."
  fi
  run usermod -aG docker "$DEPLOY_USER"
  run usermod -aG sudo "$DEPLOY_USER"

  local grp; grp="$(id -gn "$DEPLOY_USER" 2>/dev/null || echo "$DEPLOY_USER")"
  run install -d -m 700 -o "$DEPLOY_USER" -g "$grp" "${DEPLOY_HOME}/.ssh"

  # Copy keys in ONLY if deploy has none. Never clobber an existing
  # authorized_keys — on a re-run that file may hold keys root's does not.
  local dep_ak="${DEPLOY_HOME}/.ssh/authorized_keys" have=0
  [ -f "$dep_ak" ] && have="$(count_usable_pubkeys "$dep_ak")"
  if [ "${have:-0}" -gt 0 ]; then
    ok "$dep_ak already holds ${have} usable key(s) — left untouched"
  else
    local src=""
    if [ -f /root/.ssh/authorized_keys ] && [ "$(count_usable_pubkeys /root/.ssh/authorized_keys)" -gt 0 ]; then
      src=/root/.ssh/authorized_keys
    elif [ -n "${SUDO_USER:-}" ] && [ "${SUDO_USER}" != root ]; then
      local sh_home; sh_home="$(getent passwd "$SUDO_USER" | cut -d: -f6 || true)"
      if [ -n "$sh_home" ] && [ -f "${sh_home}/.ssh/authorized_keys" ] \
         && [ "$(count_usable_pubkeys "${sh_home}/.ssh/authorized_keys")" -gt 0 ]; then
        src="${sh_home}/.ssh/authorized_keys"
      fi
    fi
    if [ -n "$src" ]; then
      run cp "$src" "$dep_ak"
      run chown "${DEPLOY_USER}:${grp}" "$dep_ak"
      run chmod 600 "$dep_ak"
      ok "copied $src -> $dep_ak"
    else
      warn "no source of public keys found for '$DEPLOY_USER'."
      warn "Everything from §3.5 on runs as this user, and you will want to log in as it."
      local pasted="" tmpkey
      ask pasted "Paste a public key for $DEPLOY_USER (blank to skip)"
      if [ -n "$pasted" ]; then
        tmpkey="$(mktemp)"; printf '%s\n' "$pasted" > "$tmpkey"
        if [ "$(count_usable_pubkeys "$tmpkey")" -lt 1 ]; then
          rm -f "$tmpkey"; die "That is not a usable public key line. Nothing was changed."
        fi
        run cp "$tmpkey" "$dep_ak"; rm -f "$tmpkey"
        run chown "${DEPLOY_USER}:${grp}" "$dep_ak"; run chmod 600 "$dep_ak"
        ok "installed a key for $DEPLOY_USER"
      fi
    fi
  fi

  # THE STEP THAT IS EASY TO SKIP AND BREAKS EVERYTHING AFTER IT.
  # `adduser --disabled-password` leaves a `!` in the shadow field, so even
  # after `usermod -aG sudo` every sudo fails with an unpassable prompt — and
  # roughly a third of the commands from here on are sudo.
  local state="unknown"
  [ "$DRY" = 0 ] && state="$(passwd -S "$DEPLOY_USER" 2>/dev/null | shadow_state || true)"
  if [ "$state" = "P" ]; then
    ok "'$DEPLOY_USER' already has a usable password for sudo — NOT touching it"
  elif [ "$DRY" = 1 ]; then
    note "would set a sudo password for '$DEPLOY_USER'"
  else
    banner "SET A PASSWORD FOR '$DEPLOY_USER' — sudo CANNOT AUTHENTICATE WITHOUT ONE"
    printf '  This does NOT re-open SSH password login: §3.2a turned that off, so the\n'
    printf '  password is usable only at a sudo prompt inside an already-authenticated\n'
    printf '  key session. Store it in the password manager now.\n\n'
    local p1="" p2="" tries=0
    while :; do
      tries=$((tries + 1))
      [ "$tries" -gt 3 ] && die "Three failed attempts at the password. Nothing was changed."
      ask_secret p1 "New password for $DEPLOY_USER (12+ characters)"
      ask_secret p2 "Again"
      if [ "$p1" != "$p2" ]; then warn "they do not match"; continue; fi
      if ! password_ok "$p1"; then warn "at least 12 characters, and no single quote"; continue; fi
      break
    done
    printf '%s:%s\n' "$DEPLOY_USER" "$p1" | chpasswd \
      || { p1=""; p2=""; die "chpasswd failed; '$DEPLOY_USER' still has no usable password and sudo will not work."; }
    state="$(passwd -S "$DEPLOY_USER" 2>/dev/null | shadow_state || true)"
    [ "$state" = "P" ] || { p1=""; p2=""; die "passwd -S still reports '$state' for $DEPLOY_USER; sudo will not work."; }
    ok "password set (shadow state: P)"

    # §3.4's THIRD verification, which the two proxies above do not perform:
    # `sudo -v` — "expect: it accepts the password you just set". A box whose
    # sudoers ships %sudo under a name a later drop-in overrides passes both
    # proxies and still fails the first real sudo, and this is the only moment
    # the password is in hand to test it with. The password goes down a PIPE,
    # never onto a command line, so it is not in the process table and not in
    # this script's transcript.
    #
    # A WARNING, deliberately, not a die: everything the installer itself runs
    # is root, so a broken sudo does not stop the install — it stops a third of
    # the RUNBOOK, later, and the operator needs to know now rather than be
    # blocked now.
    if printf '%s\n' "$p1" | as_deploy sudo -S -p '' -v >/dev/null 2>&1; then
      ok "'sudo -v' as $DEPLOY_USER accepts that password (§3.4's third check)"
    else
      warn "'sudo -v' as $DEPLOY_USER did NOT succeed with the password just set."
      warn "The install continues (everything here runs as root), but roughly a third of"
      warn "the runbook is sudo and it will fail for you. Check, as root:"
      warn "  grep -rn '^%sudo' /etc/sudoers /etc/sudoers.d/   and then, as $DEPLOY_USER:  sudo -v"
    fi
    p1=""; p2=""
  fi

  if [ "$DRY" = 0 ]; then
    id "$DEPLOY_USER" | sed 's/^/         /'
    id -nG "$DEPLOY_USER" | tr ' ' '\n' | grep -qx sudo   || die "'$DEPLOY_USER' is not in the sudo group."
    id -nG "$DEPLOY_USER" | tr ' ' '\n' | grep -qx docker || die "'$DEPLOY_USER' is not in the docker group."
    # /etc/sudoers.d/ too: distributions increasingly ship the %sudo rule as a
    # drop-in rather than in the main file, and looking only at the main file
    # produces a scary warning on a perfectly correct box.
    grep -rqE '^[[:space:]]*%sudo[[:space:]]' /etc/sudoers /etc/sudoers.d/ 2>/dev/null \
      || warn "no %sudo rule found in /etc/sudoers or /etc/sudoers.d/ — sudo will still refuse."
    ok "'$DEPLOY_USER' is in both sudo and docker"

    # deploy-on-host.sh checks only `command -v docker`. If deploy is not
    # EFFECTIVELY in the docker group, its preflight passes, the two prune calls
    # swallow the permission error with `|| true`, and the failure surfaces much
    # later at `dc build` as "permission denied while trying to connect to the
    # Docker daemon socket" — 15 minutes into a build, pointing nowhere near the
    # cause. Prove it now, through the same fresh-process path every later step
    # uses. (This is also the proof that runuser makes the new group effective
    # without the logout §3.4 asks a human for.)
    if as_deploy docker ps >/dev/null 2>&1; then
      ok "'docker ps' works as $DEPLOY_USER — the docker group is effective"
    else
      as_deploy docker ps 2>&1 | sed 's/^/         /' || true
      die "'docker ps' fails as $DEPLOY_USER. Every build later would fail with a socket
     permission error that points nowhere near this cause. Check the docker group
     and that dockerd is running."
    fi
  fi
}

# ── §3.5 Directories ────────────────────────────────────────────────────────
satisfied_dirs() {
  local d
  for d in "$SRV_ROOT" "$LOG_DIR" "$DATA_ROOT/postgres" "$DATA_ROOT/redis" \
           "$DATA_ROOT/storage" "$DATA_ROOT/caddy/origin" "$DATA_ROOT/backups" \
           "$DATA_ROOT/env" "$TEXTFILE_DIR"; do
    [ -d "$d" ] || return 1
  done
  [ "$(stat_uid "$DATA_ROOT/storage")" = "$CONTAINER_UID" ] || return 1
  [ "$(stat_mode "$DATA_ROOT/env")" = "700" ] || return 1
  return 0
}

step_dirs() {
  say "§3.5 Directories"

  # Re-asked here and not only in `stock`, because --only dirs / --from dirs
  # skip that step entirely and THIS is where the boot disk starts receiving
  # directories that a later mount would hide.
  assert_data_root_sane

  local grp; grp="$(id -gn "$DEPLOY_USER" 2>/dev/null || echo "$DEPLOY_USER")"
  run install -d -m 755 -o "$DEPLOY_USER" -g "$grp" "$SRV_ROOT"
  run install -d -m 755 -o "$DEPLOY_USER" -g "$grp" "$LOG_DIR"

  local d
  for d in postgres redis storage caddy caddy/origin backups; do
    run mkdir -p "${DATA_ROOT}/${d}"
  done
  run chown "${DEPLOY_USER}:${grp}" "${DATA_ROOT}/backups"

  # ─────────────────────────────────────────────────────────────────────────
  # THE STEP THAT GETS FORGOTTEN.
  #
  # api and worker run as USER node = uid 1000, and Docker does NOT chown a
  # bind mount. Skip this and you get a FULLY HEALTHY STACK that throws EACCES
  # on the first cover upload — because /readyz checks Postgres and Redis and
  # never touches storage. 1000 is the CONTAINER's uid; it is not necessarily
  # deploy's, which is why this is a number. Postgres and Redis do NOT need it:
  # their images start as root and chown their own data directories.
  # ─────────────────────────────────────────────────────────────────────────
  if [ "$DRY" = 1 ]; then
    printf '  would chown -R %s:%s %s/storage\n' "$CONTAINER_UID" "$CONTAINER_UID" "$DATA_ROOT"
  else
    local top_uid stray=""
    top_uid="$(stat_uid "${DATA_ROOT}/storage" || echo "")"
    # -R only when something is actually wrong: on a re-run over a populated
    # uploads tree a recursive chown is minutes of pointless IO.
    [ "$top_uid" = "$CONTAINER_UID" ] && stray="$(find "${DATA_ROOT}/storage" -maxdepth 3 ! -uid "$CONTAINER_UID" -print -quit 2>/dev/null || true)"
    if [ "$top_uid" = "$CONTAINER_UID" ] && [ -z "$stray" ]; then
      ok "${DATA_ROOT}/storage is already uid ${CONTAINER_UID} — no recursive chown needed"
    else
      chown -R "${CONTAINER_UID}:${CONTAINER_UID}" "${DATA_ROOT}/storage"
      ok "chown -R ${CONTAINER_UID}:${CONTAINER_UID} ${DATA_ROOT}/storage (the container user; enforced by nothing else)"
    fi
    [ "$(stat_uid "${DATA_ROOT}/storage")" = "$CONTAINER_UID" ] \
      || die "${DATA_ROOT}/storage is not owned by uid ${CONTAINER_UID}. Uploads would fail with
     EACCES against a stack that reports itself perfectly healthy."
  fi

  # $DATA_ROOT/env holds the on-volume copy of .env.prod that ensure-env.sh
  # writes, and it is the FIRST recovery source that script names when
  # POSTGRES_PASSWORD is lost but the cluster survives — the boot-disk-rebuild
  # case. It was missing from §3.5's list once and, because $DATA_ROOT is
  # root-owned, ensure-env.sh (which runs as deploy) could not create it: it
  # printed one line about it and still finished "Done". Owned by deploy
  # because that script writes it unprivileged; 700 because it holds every
  # secret the stack has.
  run install -d -m 700 -o "$DEPLOY_USER" -g "$grp" "${DATA_ROOT}/env"

  # Beyond §3.5, and named: node-exporter's textfile collector reads this, and
  # backup.sh REFUSES to run when neither it nor BACKUP_HEARTBEAT_URL is
  # usable. It must exist, owned by deploy, BEFORE the deploy — otherwise the
  # monitoring compose file's bind mount makes Docker create it as root, and
  # then the nightly backup cannot write its metric and exits 1 every night in
  # a log nobody reads.
  run install -d -m 755 -o "$DEPLOY_USER" -g "$grp" "$TEXTFILE_DIR"

  if [ "$DRY" = 0 ]; then
    ls -la "$DATA_ROOT" | sed 's/^/         /'
    # deploy-on-host.sh enforces postgres, redis, storage, caddy. It does NOT
    # check backups, and nothing in the deploy path touches backups at all.
    for d in postgres redis storage caddy backups env; do
      [ -d "${DATA_ROOT}/${d}" ] || die "${DATA_ROOT}/${d} is missing after this step."
    done
    ok "all six data directories exist; storage is uid ${CONTAINER_UID}; env is 700 ${DEPLOY_USER}"
    if [ "$(id -u "$DEPLOY_USER")" != "$CONTAINER_UID" ]; then
      note "$DEPLOY_USER is uid $(id -u "$DEPLOY_USER"), the containers run as ${CONTAINER_UID}."
      note "That is fine — the storage chown is deliberately numeric."
    fi
  fi
}

# ── §3.6 The checkout ───────────────────────────────────────────────────────
satisfied_checkout() {
  [ -d "${APP_DIR}/.git" ] || return 1
  [ -f "$DEPLOY_KEY" ] || return 1
  block_present "${DEPLOY_HOME}/.ssh/config" '# --- Libriant deploy key BEGIN ---' || return 1
  return 0
}

step_checkout() {
  say "§3.6 The checkout — a read-only GitHub deploy key"

  local grp; grp="$(id -gn "$DEPLOY_USER" 2>/dev/null || echo "$DEPLOY_USER")"
  run install -d -m 755 -o "$DEPLOY_USER" -g "$grp" "$SRV_ROOT"
  run install -d -m 700 -o "$DEPLOY_USER" -g "$grp" "${DEPLOY_HOME}/.ssh"

  # The repo is private, so an HTTPS clone will not work — and deploy-on-host.sh
  # runs `git fetch origin` as deploy on EVERY deploy, so a one-off credential
  # is not enough either.
  #
  # NEVER regenerate an existing deploy key: the public half is registered in
  # GitHub, and a new key silently breaks every future fetch.
  if [ -f "$DEPLOY_KEY" ]; then
    ok "deploy key already exists at $DEPLOY_KEY — NOT regenerating it"
  else
    local host_label
    host_label="$(hostname -f 2>/dev/null || hostname)"
    if [ "$DRY" = 1 ]; then
      printf '  would generate an ed25519 deploy key at %s\n' "$DEPLOY_KEY"
    else
      as_deploy ssh-keygen -t ed25519 -f "$DEPLOY_KEY" -N '' -C "libriant deploy@${host_label}" \
        || die "ssh-keygen failed; there is no deploy key and the clone cannot work."
      [ -f "${DEPLOY_KEY}.pub" ] || die "ssh-keygen reported success but ${DEPLOY_KEY}.pub does not exist."
      ok "generated $DEPLOY_KEY"
    fi
  fi

  # ~/.ssh/config as a MARKED block, so a re-run neither duplicates it nor
  # destroys anything else the operator put in that file.
  if [ "$DRY" = 1 ]; then
    printf '  would ensure the github.com block in %s/.ssh/config\n' "$DEPLOY_HOME"
  else
    local r
    r="$(printf 'Host github.com\n  IdentityFile %s\n  IdentitiesOnly yes\n' "$DEPLOY_KEY" \
      | upsert_block "${DEPLOY_HOME}/.ssh/config" '# --- Libriant deploy key BEGIN ---' '# --- Libriant deploy key END ---')" \
      || die "${DEPLOY_HOME}/.ssh/config has an unterminated Libriant block; fix it by hand."
    chown "${DEPLOY_USER}:${grp}" "${DEPLOY_HOME}/.ssh/config"
    chmod 600 "${DEPLOY_HOME}/.ssh/config"
    ok "${DEPLOY_HOME}/.ssh/config github.com block: $r"
  fi

  # known_hosts. §3.6 warns that the first connection prompts, and offers
  # ssh-keyscan — with the fingerprints compared against GitHub's PUBLISHED list
  # FIRST. This script will not assert what those fingerprints are: it shows you
  # what the box just fetched and names the source.
  if [ "$DRY" = 0 ] && ! as_deploy ssh-keygen -F github.com -f "${DEPLOY_HOME}/.ssh/known_hosts" >/dev/null 2>&1; then
    local kh; kh="$(mktemp)"
    ssh-keyscan -t rsa,ecdsa,ed25519 github.com > "$kh" 2>/dev/null || true
    if [ -s "$kh" ]; then
      printf '\n  Fingerprints just fetched from github.com:\n'
      ssh-keygen -lf "$kh" | sed 's/^/         /'
      printf '\n  Compare these against GitHub'"'"'s own published SSH key fingerprints\n'
      printf '  (GitHub Docs -> Authentication -> GitHub'"'"'s SSH key fingerprints).\n'
      if confirm "Do they match the published list?"; then
        cat "$kh" >> "${DEPLOY_HOME}/.ssh/known_hosts"
        chown "${DEPLOY_USER}:${grp}" "${DEPLOY_HOME}/.ssh/known_hosts"
        chmod 600 "${DEPLOY_HOME}/.ssh/known_hosts"
        ok "seeded known_hosts for github.com"
      else
        rm -f "$kh"
        die "Fingerprint mismatch. Stopping: something is intercepting this box's
     traffic to github.com."
      fi
    fi
    rm -f "$kh"
  fi

  # The operator's turn — but only when it is still needed.
  #
  # Access is proved with `git ls-remote`, NOT with `ssh -T`: on SUCCESS
  # `ssh -T git@github.com` prints "Hi …! You've successfully authenticated"
  # AND EXITS 1. A non-zero exit there is the correct outcome and people chase
  # it for half an hour. §3.6's own "good looks like" is
  # `git ls-remote --exit-code origin HEAD` exiting 0.
  local repo_path="${REPO_URL#*:}"
  if [ "$DRY" = 1 ]; then
    printf '  would show the deploy public key and pause for you to register it in GitHub\n'
  elif as_deploy git ls-remote --exit-code "$REPO_URL" HEAD >/dev/null 2>&1; then
    ok "git ls-remote against $REPO_URL already succeeds — the deploy key is registered"
  else
    printf "\n  This box's deploy PUBLIC key:\n\n"
    sed 's/^/      /' "${DEPLOY_KEY}.pub"
    printf '\n'
    pause_for "Add that key to GitHub -> ${repo_path%.git} -> Settings -> Deploy keys, as READ-ONLY."
    local tries=0
    while :; do
      if as_deploy git ls-remote --exit-code "$REPO_URL" HEAD >/dev/null 2>&1; then
        ok "git ls-remote against $REPO_URL succeeds"
        break
      fi
      tries=$((tries + 1))
      as_deploy git ls-remote --exit-code "$REPO_URL" HEAD 2>&1 | tail -5 | sed 's/^/         /' || true
      [ "$tries" -ge 5 ] && die "Still cannot reach $REPO_URL after $tries attempts."
      confirm "Not yet. Try again?" || die "Stopped. The checkout needs a working read-only deploy key."
    done
  fi

  if [ -d "${APP_DIR}/.git" ]; then
    ok "$APP_DIR is already a checkout — NOT re-cloning"
    [ "$DRY" = 0 ] && as_deploy git -C "$APP_DIR" log -1 --format='         %h %ad %s' --date=iso || true
  else
    if [ "$DRY" = 1 ]; then
      printf '  would clone %s -> %s as %s\n' "$REPO_URL" "$APP_DIR" "$DEPLOY_USER"
    else
      as_deploy git clone "$REPO_URL" "$APP_DIR" || die "git clone of $REPO_URL failed. Nothing after this can run."
      [ -d "${APP_DIR}/.git" ] || die "git clone reported success but ${APP_DIR}/.git does not exist."
      as_deploy git -C "$APP_DIR" log -1 --format='         %h %ad %s' --date=iso || true
      ok "cloned into $APP_DIR"
    fi
  fi
}

# ── §3.7a .env.prod ─────────────────────────────────────────────────────────
#
# Always runs: ensure-env.sh preserves every existing value and its prompts
# return immediately for keys that are already set, so a re-run is cheap — and
# the assertions after it are worth repeating.
satisfied_env() { return 1; }

step_env() {
  say "§3.7a Secrets — ensure-env.sh, interactively"

  [ -d "${APP_DIR}/.git" ] || die "$APP_DIR is not a checkout yet. Run the 'checkout' step first."

  # ensure-env.sh's CRITICAL POSTGRES_PASSWORD guard looks for
  # $DATA_ROOT/postgres/PG_VERSION. If $DATA_ROOT is not the real volume, that
  # guard is looking at the wrong filesystem and cannot see the cluster it is
  # guarding — so it mints a fresh password over a live database. Ask the
  # question again here, right in front of the script whose safety depends on
  # the answer.
  assert_data_root_sane

  banner "THIS RUN MUST NOT BE --auto"
  printf '  --auto never prompts, and the two values a human must supply are the\n'
  printf '  difference between a green deploy and one nobody can log into:\n\n'
  printf '    ADMIN_BOOTSTRAP_EMAIL     without it no admin is created; the deploy\n'
  printf '                              prints a yellow warning.\n'
  printf '    ADMIN_BOOTSTRAP_PASSWORD  without it no admin is created and NOTHING\n'
  printf '                              warns at all. Minimum 12 characters —\n'
  printf '                              bootstrap-admin.ts exits non-zero below that.\n\n'
  printf '  It asks for IMAGE_OWNER FIRST. LEAVE IT BLANK: it is only an image-name\n'
  printf '  namespace for a GHCR path this box does not use.\n\n'
  printf '  Secrets that already exist are never regenerated. That guard is what stops\n'
  printf '  a re-run minting a POSTGRES_PASSWORD over a live cluster.\n\n'

  if [ "$DRY" = 1 ]; then
    printf '  would run, as %s, on the real terminal: bash %s/scripts/ensure-env.sh %s\n' \
      "$DEPLOY_USER" "$APP_DIR" "$ENV_FILE"
    return 0
  fi

  # Interactive, with the real terminal — deliberately NOT as_deploy_sh, which
  # feeds stdin and would swallow every prompt.
  #
  # AND EXPLICITLY FROM /dev/tty. Every prompt this installer owns reads
  # /dev/tty when it is readable, and the driver's own gate permits a non-tty
  # stdin as long as /dev/tty is there — so `sudo bash install-server.sh
  # </dev/null`, or any wrapper that redirects stdin, is a supported way to run
  # this. ensure-env.sh's prompts are bare `read -rp` on STDIN, so in that
  # configuration IMAGE_OWNER, ADMIN_BOOTSTRAP_EMAIL and
  # ADMIN_BOOTSTRAP_PASSWORD would all return empty without pausing — and §3.7a
  # is the one step the runbook is explicit must not be non-interactive.
  local envrc=0 envsrc
  envsrc="$(prompt_src)"
  as_deploy bash "${APP_DIR}/scripts/ensure-env.sh" "$ENV_FILE" < "$envsrc" || envrc=$?
  [ "$envrc" = 0 ] \
    || die "ensure-env.sh exited $envrc. If it refused because POSTGRES_PASSWORD is
     missing while an initialized Postgres cluster exists, DO NOT DELETE THE DATA
     DIRECTORY. Recover the password from ${DATA_ROOT}/env/.env.prod or your own
     off-host backup first, put it in ${ENV_FILE}, and re-run this step."

  # §3.7a's own verification.
  local owner mode
  mode="$(stat_mode "$ENV_FILE" || true)"
  owner="$(stat_owner "$ENV_FILE" || true)"
  printf '         %s %s\n' "$mode" "$owner"
  [ "$mode" = "600" ] || die "$ENV_FILE is mode $mode; it must be 600."
  [ "$owner" = "${DEPLOY_USER}:$(id -gn "$DEPLOY_USER" 2>/dev/null)" ] \
    || warn "$ENV_FILE is owned by $owner, expected ${DEPLOY_USER}"

  # The on-volume copy: the FIRST recovery source ensure-env.sh names for a lost
  # POSTGRES_PASSWORD. It prints a warning and STILL says "Done" when it could
  # not write it, so check for the file rather than trust the exit code.
  if [ -f "${DATA_ROOT}/env/.env.prod" ]; then
    ok "on-volume copy exists at ${DATA_ROOT}/env/.env.prod (survives a boot-disk rebuild)"
  else
    warn "NO on-volume copy at ${DATA_ROOT}/env/.env.prod."
    warn "That is the first recovery source for a lost POSTGRES_PASSWORD. Fix the"
    warn "directory (700, owned by ${DEPLOY_USER}) and re-run this step."
  fi

  local dupes; dupes="$(env_dupe_keys "$ENV_FILE" | tr '\n' ' ')"
  [ -n "$(printf '%s' "$dupes" | tr -d ' ')" ] \
    && warn "duplicate keys in $ENV_FILE: ${dupes}(the LAST value is what the stack sees)"

  # §4.2 hard requirements, checked here because the failure mode is a container
  # that refuses to boot rather than a warning anyone reads.
  local mfa ses sto
  mfa="$(env_get "$ENV_FILE" MFA_MASTER_KEY || true)"
  case "$mfa" in
    *[!0-9a-fA-F]*|'') die "MFA_MASTER_KEY is missing or not hex in $ENV_FILE." ;;
    *) [ "${#mfa}" = 64 ] || die "MFA_MASTER_KEY is ${#mfa} characters; the API requires exactly 64 hex (AES-256)." ;;
  esac
  ses="$(env_get "$ENV_FILE" SESSION_SECRET || true)"
  sto="$(env_get "$ENV_FILE" STORAGE_SIGNING_SECRET || true)"
  if [ -n "$ses" ] && [ "$ses" = "$sto" ]; then
    die "STORAGE_SIGNING_SECRET equals SESSION_SECRET. One key covering both session
     forgery and anonymous cross-tenant file reads is exactly the oracle that
     separating them prevents. Generate a distinct value (openssl rand -hex 32)."
  fi
  ok "MFA_MASTER_KEY is 64 hex; STORAGE_SIGNING_SECRET differs from SESSION_SECRET"

  local abe abp
  abe="$(env_get "$ENV_FILE" ADMIN_BOOTSTRAP_EMAIL || true)"
  abp="$(env_get "$ENV_FILE" ADMIN_BOOTSTRAP_PASSWORD || true)"
  if [ -z "$abe" ] || [ -z "$abp" ]; then
    banner "NO ADMIN WILL BE CREATED"
    printf '  ADMIN_BOOTSTRAP_EMAIL=%s\n' "${abe:-<empty>}"
    printf '  ADMIN_BOOTSTRAP_PASSWORD=%s\n\n' "$( [ -n "$abp" ] && echo '<set>' || echo '<empty>')"
    printf '  prod-bootstrap.sh creates the admin only when BOTH are non-empty. A green\n'
    printf '  deploy nobody can log into is the outcome, and only the email case warns.\n\n'
    confirm "Continue without an admin?" || die "Stopped. Re-run this step and answer both prompts."
  else
    ok "ADMIN_BOOTSTRAP_EMAIL and ADMIN_BOOTSTRAP_PASSWORD are both set"
    [ "${#abp}" -ge 12 ] \
      || warn "ADMIN_BOOTSTRAP_PASSWORD is only ${#abp} characters; bootstrap-admin.ts exits non-zero below 12."
  fi

  # §4.1 / boot-and-config-05: this is the deliberate posture for this launch,
  # but it must not be a surprise on the day someone needs a password reset.
  local mail; mail="$(env_get "$ENV_FILE" EMAIL_DRIVER || true)"
  [ "$mail" = "console" ] && note "EMAIL_DRIVER=console — nothing is delivered. Account recovery is done by an owner admin from /admin/account-recovery (§4.3a), not by email."

  banner "COPY ${ENV_FILE} INTO THE PASSWORD MANAGER NOW"
  printf '  From this moment the host holds the ONLY copy. backup.sh deliberately does\n'
  printf '  not capture .env.prod — a stolen backup would otherwise be total compromise.\n\n'
  printf '  Three values are IRRECOVERABLE if lost:\n'
  printf '    MFA_MASTER_KEY      the only decryptor of stored admin TOTP secrets, and\n'
  printf '                        MFA is mandatory in production with no recovery codes\n'
  printf '    POSTGRES_PASSWORD   the live cluster is keyed to it\n'
  printf '    the origin cert     in no backup; it blocks every deploy if lost\n\n'
  pause_for "Copy it now (as ${DEPLOY_USER}: cat ${ENV_FILE})."
}

# ── §3.7b The Cloudflare origin certificate ─────────────────────────────────
#
# Always runs: when a pair is already installed the step VERIFIES it rather
# than replacing it, and that verification is the thing nothing else does.
satisfied_cert() { return 1; }

# read_pem_block LABEL OUTFILE — collect one pasted PEM block.
#
# Reads from PEM_SRC (the terminal in real use) on a PERSISTENT fd, so two
# consecutive calls read two consecutive blocks rather than restarting the
# source. Anything before the BEGIN line is discarded — a terminal echoes
# prompts, people paste a blank line first, and a certificate with a shell
# prompt on line 1 is a mystifying openssl error. CR is stripped, because a
# Windows or web-console paste otherwise produces a PEM openssl rejects for
# reasons nobody can see.
PEM_FD_OPEN=""
read_pem_block() {
  local label="$1" out="$2" line="" started=0
  printf '  Paste the %s block now, including the BEGIN and END lines.\n' "$label"
  printf '  (It ends when the -----END %s----- line arrives.)\n\n' "$label"
  : > "$out"; chmod 600 "$out"
  if [ -z "$PEM_FD_OPEN" ]; then
    exec 3< "${PEM_SRC:-$(prompt_src)}"
    PEM_FD_OPEN=1
  fi
  while IFS= read -r line <&3; do
    line="${line%$'\r'}"
    if [ "$started" = 0 ]; then
      case "$line" in
        "-----BEGIN "*"${label}"*"-----") started=1 ;;
        *) continue ;;
      esac
    fi
    printf '%s\n' "$line" >> "$out"
    case "$line" in "-----END "*"${label}"*"-----") break ;; esac
  done
  printf '\n'
}

verify_cert() {
  local crt="$1" key="$2" site="$3" apex="$4"
  # `sudo` on this openssl call is not decoration in the runbook: the file is
  # 640 root:root and reading it unprivileged fails with a BIO_new_file
  # permission error that reads like a corrupt certificate and is not. This
  # script is already root, so it simply works here.
  openssl x509 -in "$crt" -noout -subject -issuer -dates -ext subjectAltName 2>/dev/null | sed 's/^/         /'
  local issuer
  issuer="$(openssl x509 -in "$crt" -noout -issuer 2>/dev/null || true)"
  case "$issuer" in
    *"loudFlare Origin SSL Certificate Authority"*|*"loudflare Origin SSL Certificate Authority"*)
      ok "issued by the Cloudflare Origin CA" ;;
    *) warn "issuer is not the Cloudflare Origin CA: $issuer" ;;
  esac
  local san_ok=1
  cert_covers "$crt" "$site" \
    || { warn "subjectAltName does NOT include DNS:${site} — that host would fail TLS."; san_ok=0; }
  cert_covers "$crt" "*.${apex}" \
    || { warn "subjectAltName does NOT include DNS:*.${apex} — app. and admin. would 526 behind a fully green deploy."; san_ok=0; }
  [ "$san_ok" = 1 ] && ok "SANs cover ${site} and *.${apex}"
  # The deploy checks only that the two FILES EXIST. An expired certificate, or
  # one whose SANs omit the wildcard, produces a fully green deploy and then a
  # Cloudflare 526 on every host. Nothing monitors this.
  if openssl x509 -in "$crt" -noout -checkend 0 >/dev/null 2>&1; then
    if openssl x509 -in "$crt" -noout -checkend 2592000 >/dev/null 2>&1; then
      ok "not expired, and more than 30 days left"
    else
      warn "this certificate expires within 30 DAYS. Nothing monitors that."
    fi
  else
    die "this certificate is ALREADY EXPIRED. The deploy would go green and every
     host would answer Cloudflare 526."
  fi
  note "Nothing monitors the expiry. Put the notAfter date above in your calendar"
  note "now, and add the check to the monthly rhythm (§6.7)."
}

step_cert() {
  say "§3.7b The Cloudflare origin certificate"

  local dir="${DATA_ROOT}/caddy/origin"
  local crt="${dir}/origin.crt" key="${dir}/origin.key"
  run install -d -m 755 -o root -g root "$dir"

  local site apex
  site="$(env_get "$ENV_FILE" SITE_HOST 2>/dev/null || true)"
  apex="$(env_get "$ENV_FILE" PUBLIC_APEX_DOMAIN 2>/dev/null || true)"
  if [ -z "$site" ] || [ -z "$apex" ]; then
    die "SITE_HOST / PUBLIC_APEX_DOMAIN are not set in $ENV_FILE, so I do not know
     which hostnames this certificate must cover. Run the 'env' step first."
  fi

  if [ -f "$crt" ] && [ -f "$key" ] && [ "$REPLACE_CERT" = 0 ]; then
    ok "an origin certificate is already installed — NOT replacing it"
    note "pass --replace-origin-cert if you really mean to (the old pair is backed up first)."
    note "Note that ${DATA_ROOT}/caddy is also caddy_data: 'cleaning it out' deletes a"
    note "certificate that exists in no backup."
    [ "$DRY" = 0 ] && verify_cert "$crt" "$key" "$site" "$apex"
    return 0
  fi

  if [ "$DRY" = 1 ]; then
    printf '  would install an origin certificate into %s (640/600 root:root)\n' "$dir"
    return 0
  fi

  local tmpdir; tmpdir="$(mktemp -d)"; chmod 700 "$tmpdir"
  register_tmp "$tmpdir"
  local tcrt="${tmpdir}/origin.crt" tkey="${tmpdir}/origin.key"

  if [ -n "$ORIGIN_CRT_SRC" ] && [ -n "$ORIGIN_KEY_SRC" ]; then
    [ -r "$ORIGIN_CRT_SRC" ] || die "cannot read $ORIGIN_CRT_SRC"
    [ -r "$ORIGIN_KEY_SRC" ] || die "cannot read $ORIGIN_KEY_SRC"
    cp "$ORIGIN_CRT_SRC" "$tcrt"; cp "$ORIGIN_KEY_SRC" "$tkey"
    ok "read the pair from the files you named"
  else
    printf '\n  Cloudflare dashboard -> SSL/TLS -> Origin Server -> Create Certificate.\n'
    printf '  Hostnames must be BOTH %s AND *.%s.\n' "$site" "$apex"
    printf '  Save both PEM blocks to the password manager FIRST — they are in no backup.\n\n'
    read_pem_block "CERTIFICATE" "$tcrt"
    read_pem_block "PRIVATE KEY" "$tkey"
  fi

  # Validate BEFORE installing.
  pem_balanced "$tcrt" || die "the certificate PEM is unbalanced — a BEGIN with no END. Re-paste it."
  pem_balanced "$tkey" || die "the key PEM is unbalanced — a BEGIN with no END. Re-paste it."
  [ "$(pem_count "$tcrt" CERTIFICATE)" -ge 1 ] || die "no CERTIFICATE block in what you supplied."
  [ "$(pem_count "$tkey" 'PRIVATE KEY')" -ge 1 ] || die "no PRIVATE KEY block in what you supplied."
  openssl x509 -in "$tcrt" -noout >/dev/null 2>&1 || die "openssl cannot parse that certificate."
  openssl pkey -in "$tkey" -noout >/dev/null 2>&1 || die "openssl cannot parse that private key."
  cert_key_match "$tcrt" "$tkey" || die "the certificate and the key are NOT a pair. Caddy would fail to load the
     certificate on every HTTPS vhost and the edge would be down. Nothing was
     installed."
  ok "PEM structure valid, and the certificate and key are a matching pair"

  local ts; ts="$(date +%Y%m%d%H%M%S)"
  [ -f "$crt" ] && { cp -p "$crt" "${crt}.bak-${ts}"; warn "previous certificate saved as ${crt}.bak-${ts}"; }
  [ -f "$key" ] && { cp -p "$key" "${key}.bak-${ts}"; warn "previous key saved as ${key}.bak-${ts}"; }

  # `|| die` on BOTH, and not because it is tidy. errexit is not in force
  # inside a step (see run()), so an unchecked `install` that failed here would
  # be stepped over — and the crt half failing is the dangerous one: the OLD
  # certificate stays on disk, verify_cert below validates IT and prints green
  # SANs, and the box is left with a cert and a key that are not a pair. Caddy
  # then fails to load a certificate on every HTTPS vhost and the edge is down.
  install -o root -g root -m 640 "$tcrt" "$crt" || die "could not install $crt. The previous pair (if any) is untouched."
  install -o root -g root -m 600 "$tkey" "$key" || die "could not install $key. $crt HAS been replaced — restore it from
     ${crt}.bak-* before deploying, or the pair will not match."
  ok "installed $crt (640 root:root) and $key (600 root:root)"

  # Re-check the pair on the INSTALLED files, not only on the temp ones. A
  # half-applied replacement is exactly the state that passes its own
  # verification and takes the edge down.
  cert_key_match "$crt" "$key" \
    || die "the INSTALLED $crt and $key are not a pair, even though the files supplied
     were. Something went wrong between validation and installation — restore from
     the .bak-* copies beside them and do NOT deploy."
  ok "the installed certificate and key are still a matching pair"

  # root:root is LOAD-BEARING, not tidiness. Caddy runs as uid 0 inside its
  # container and, since supply-chain-07, holds no capability but
  # NET_BIND_SERVICE — CAP_DAC_OVERRIDE is gone, so a key owned by `deploy` at
  # 600 would be unreadable, every HTTPS vhost would fail to load its
  # certificate and the edge would be down. deploy-on-host.sh refuses to deploy
  # unless the key is uid 0 and mode 600 or 400.
  [ "$(stat_uid "$key")" = "0" ] || die "$key is not owned by uid 0; deploy-on-host.sh will refuse to deploy."
  [ "$(stat_uid "$crt")" = "0" ] || die "$crt is not owned by uid 0; Caddy holds no CAP_DAC_OVERRIDE and could not read it."
  case "$(stat_mode "$key")" in
    600|400) : ;;
    *) die "$key is mode $(stat_mode "$key"); deploy-on-host.sh requires 600 or 400." ;;
  esac
  verify_cert "$crt" "$key" "$site" "$apex"
}

# ── §6.1 The `dc` helper ────────────────────────────────────────────────────
DC_BEGIN='# --- Libriant BEGIN (installer; docs/RUNBOOK.md §6.1) ---'
DC_END='# --- Libriant END ---'
satisfied_dchelper() { block_present "${DEPLOY_HOME}/.bashrc" "$DC_BEGIN"; }

step_dchelper() {
  say "§6.1 The 'dc' helper in ${DEPLOY_USER}'s shell"

  # §3.8: set this up BEFORE the deploy. Everything from §3.9 onward is written
  # in terms of `dc`, and the deploy itself does not create it.
  #
  # The block sources .env.prod on every interactive login, exactly as §6.1
  # does. That is fine in the normal order (env runs before this step) but it
  # would print an error on every login if the file is not there yet — worth
  # saying out loud rather than letting the operator discover it at the prompt.
  [ -f "$ENV_FILE" ] || warn "$ENV_FILE does not exist yet. The §6.1 block sources it on every
     interactive login, so ${DEPLOY_USER}'s shell will complain until the 'env' step has run."

  if [ "$DRY" = 1 ]; then
    printf '  would add the Libriant block to %s/.bashrc\n' "$DEPLOY_HOME"
    return 0
  fi

  local r
  r="$(dchelper_block | upsert_block "${DEPLOY_HOME}/.bashrc" "$DC_BEGIN" "$DC_END")" \
    || die "${DEPLOY_HOME}/.bashrc has an unterminated Libriant block; fix it by hand."
  chown "${DEPLOY_USER}:$(id -gn "$DEPLOY_USER" 2>/dev/null || echo "$DEPLOY_USER")" "${DEPLOY_HOME}/.bashrc"
  ok "${DEPLOY_HOME}/.bashrc: $r"

  if [ -f "$ENV_FILE" ] && [ -d "${APP_DIR}/.git" ]; then
    local out
    out="$(as_deploy bash -ic 'dc config >/dev/null 2>&1 && echo DC-OK' 2>/dev/null | tr -d '\r' || true)"
    case "$out" in
      *DC-OK*) ok "DC-OK — an interactive shell as ${DEPLOY_USER} has a working dc()" ;;
      *) warn "could not confirm DC-OK from a non-interactive check (best-effort)."
         warn "Log in as ${DEPLOY_USER} and run:  dc config >/dev/null && echo DC-OK" ;;
    esac
  fi
}

# ── §3.8 Deploy ─────────────────────────────────────────────────────────────

# The same lookup deploy-on-host.sh's health gate uses.
svc_health() {
  local id
  id="$(docker ps -q --filter "label=com.docker.compose.project=${COMPOSE_PROJECT}" \
                     --filter "label=com.docker.compose.service=$1" 2>/dev/null | head -n1)"
  [ -n "$id" ] || { printf 'missing'; return 0; }
  docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$id" 2>/dev/null || printf 'missing'
}

# A stack that is already up and healthy does not need a 10-20 minute rebuild
# just because the installer was re-run. `--only deploy` and `--force` are how
# you ask for one anyway.
# THE SAME SIX SIGNALS deploy-on-host.sh's own health gate requires, not three
# of them. A resume — which is the normal way this installer is used — must not
# print "already satisfied, skipping" for a deploy that DIED at its own gate.
#
# The one that used to be missing is the one boot-and-config-15 added: the
# `pgbouncer-probe` sidecar runs `psql -c 'select 1'` THROUGH the pooler, which
# is the only probe that can tell "the pooler answers" from "the pooler can
# reach Postgres" — `pg_isready`, the probe it replaced, stayed green with the
# backend gone. Every control-plane query goes through that pooler. Skipping the
# deploy on a subset of its own gate reintroduces exactly that shape, one level
# up.
satisfied_deploy() {
  command -v docker >/dev/null 2>&1 || return 1
  [ "$(svc_health api)" = healthy ] || return 1
  [ "$(svc_health web)" = healthy ] || return 1
  [ "$(svc_health worker)" = healthy ] || return 1
  [ "$(svc_health pgbouncer-probe)" = healthy ] || return 1
  # The edge. deploy-on-host.sh requires http://localhost/healthz == 200 before
  # it will call a deploy healthy; a Caddy that is not answering is not a
  # finished deploy no matter how healthy the containers look.
  [ "$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 http://localhost/healthz 2>/dev/null || echo 000)" = "200" ] || return 1
  return 0
}

step_deploy() {
  say "§3.8 Deploy"

  [ -d "${APP_DIR}/.git" ] || die "$APP_DIR is not a checkout. Run the 'checkout' step first."
  [ -f "$ENV_FILE" ] || die "$ENV_FILE is missing — run the 'env' step first."

  # deploy-on-host.sh step 2 is `git fetch origin` + `git reset --hard`.
  # HOST-LOCAL EDITS TO TRACKED FILES ARE DESTROYED. Say so, with the list,
  # before anyone confirms anything.
  local fetch_flag="" dirty="" untracked="" ahead="" branch=""
  if [ "$DRY" = 0 ]; then
    # --untracked-files=no on purpose: `git reset --hard` does NOT remove
    # untracked files, so listing them would demand a DISCARD confirmation for
    # something that is not at risk — and the fastest way to make a
    # confirmation useless is to ask for it when nothing is wrong.
    dirty="$(as_deploy git -C "$APP_DIR" status --porcelain --untracked-files=no 2>/dev/null || true)"
    untracked="$(as_deploy git -C "$APP_DIR" ls-files --others --exclude-standard 2>/dev/null | head -5 || true)"
    branch="$(as_deploy git -C "$APP_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
    # UNPUSHED LOCAL COMMITS ARE ALSO DESTROYED, and `git status --porcelain`
    # says nothing about them. Someone hotfixing a file on the box during an
    # incident and committing it — the natural thing to do, and the runbook
    # itself sends operators to the box to run things by hand — leaves a clean
    # working tree and a commit that `git reset --hard origin/main` throws away
    # with no confirmation at all. Reflog keeps it for 90 days; the operator
    # gets no signal, which contradicts this script's own promise that it tells
    # you before anything discards uncommitted work.
    #
    # A read-only fetch first, so the comparison is against what the deploy will
    # actually reset to rather than a stale remote-tracking ref. Best-effort:
    # deploy-on-host.sh does its own fetch, and a network failure here must not
    # take the step down before it has said anything useful.
    as_deploy git -C "$APP_DIR" fetch origin --quiet 2>/dev/null \
      || warn "could not 'git fetch origin' to compare — the list below may be out of date."
    ahead="$(as_deploy git -C "$APP_DIR" log --oneline origin/main..HEAD 2>/dev/null | head -20 || true)"
  fi
  if [ -n "$untracked" ]; then
    note "untracked files present (these SURVIVE git reset --hard):"
    printf '%s\n' "$untracked" | sed 's/^/         /'
  fi
  if [ -n "$branch" ] && [ "$branch" != "main" ] && [ "$branch" != "HEAD" ]; then
    warn "the checkout is on branch '$branch', and the deploy resets to origin/main."
    warn "The content of every tracked file will change to main's, silently."
  fi
  if [ -n "$dirty" ] || [ -n "$ahead" ]; then
    banner "THE CHECKOUT HAS LOCAL WORK, AND THE DEPLOY RUNS git reset --hard origin/main"
    if [ -n "$dirty" ]; then
      printf '  Uncommitted edits to tracked files:\n'
      printf '%s\n' "$dirty" | sed 's/^/         /'
    fi
    if [ -n "$ahead" ]; then
      printf '\n  Commits on this checkout that are NOT on origin/main:\n'
      printf '%s\n' "$ahead" | sed 's/^/         /'
      printf '  (recoverable from `git reflog` for 90 days, but only by someone who looks)\n'
    fi
    printf '\n  All of the above will be DESTROYED by the deploy.\n'
    printf '  (%s is untracked and is not affected.)\n\n' "$ENV_FILE"
    if confirm "Deploy the working tree AS-IS instead (--no-fetch), keeping all of it?"; then
      fetch_flag="--no-fetch"
      warn "deploying with --no-fetch: the image tag carries a -dirty suffix and matches no commit"
    else
      confirm_typed "Discard everything listed above and deploy origin/main?" "DISCARD" \
        || die "Stopped. Nothing was changed."
    fi
  fi

  # Dry run first: every precondition check, the commit and the tag, nothing
  # touched. Cheap — and the place a missing origin cert or a wrong key mode
  # surfaces with a NAMED error instead of a mysterious Caddyfile failure.
  say "§3.8 deploy-on-host.sh --dry-run"
  if [ "$DRY" = 1 ]; then
    printf '  would run: bash %s/scripts/deploy-on-host.sh --dry-run %s\n' "$APP_DIR" "$fetch_flag"
    printf '  would then run the real deploy (NEVER with --skip-build on a first deploy)\n'
    return 0
  fi
  # shellcheck disable=SC2086
  as_deploy bash -c "cd '$APP_DIR' && bash scripts/deploy-on-host.sh --dry-run $fetch_flag" \
    || die "the dry run failed its preconditions. Fix what it named; nothing was deployed."

  printf '\n'
  confirm "Preconditions pass. Run the real deploy now? (a cold build takes 10-20 minutes)" \
    || { warn "skipping the deploy at your request. Resume with: $SELF --from deploy"; return 0; }

  # NEVER --skip-build on a first deploy: with no locally built images Compose
  # falls back to pulling ghcr.io/libriant/libriant-*:<sha>, which does not
  # exist — nothing publishes to GHCR while deploys are manual. And never
  # `dc pull`, for the same reason; every old document that says so is wrong.
  say "§3.8 deploy-on-host.sh (building on this box)"
  # shellcheck disable=SC2086
  if as_deploy bash -c "cd '$APP_DIR' && bash scripts/deploy-on-host.sh $fetch_flag"; then
    ok "the deploy script reported success"
  else
    die "the deploy FAILED. Its own output above names the step, and nothing was
     rolled back. Read the migrate log before re-running:
       sudo -u $DEPLOY_USER bash -lc 'dc logs migrate | tail -40'"
  fi

  note "The run has only succeeded when you have seen the script's own '▸ Healthy: …'"
  note "line and its 'Deployed <tag>. This box is not in DNS yet' line. A"
  note "'waiting… edge=200 site=000 …' line is the PENDING form, not the success form."
  note "Do NOT over-read web=healthy: that healthcheck is a constant, and it passes"
  note "green with a wrong API_INTERNAL_URL while every page renders an error."
  note "api=healthy, worker=healthy and the pgbouncer probe are real."
}

# ── authn-authz-01: the origin lockdown ─────────────────────────────────────
#
# A green deploy does not install this, and it is one of three layers that all
# have to hold: every rate limit, the /apply throttle and the brute-force login
# lockout are keyed on X-Real-IP, which Caddy sets from CF-Connecting-IP.
# Anyone who can reach this origin directly and forge that header reshapes all
# of them.
satisfied_firewall() {
  local pb="${APP_DIR}/scripts/prod-bootstrap.sh" findings
  [ -f "$pb" ] || return 1
  command -v iptables >/dev/null 2>&1 || return 1
  [ "$(id -u)" = 0 ] || return 1
  findings="$(bash "$pb" --firewall-status 2>&1 | fw_parse | fw_verdict || true)"
  if printf '%s\n' "$findings" | grep -q '^FATAL'; then return 1; fi
  systemctl is-enabled libriant-origin-firewall >/dev/null 2>&1 || return 1
  return 0
}

step_firewall() {
  say "authn-authz-01 — the origin lockdown (Cloudflare-only 80/443, v4 AND v6)"

  local pb="${APP_DIR}/scripts/prod-bootstrap.sh"
  [ -f "$pb" ] || die "$pb is missing — run the 'checkout' step first."

  # A v4-only lockdown is not a lockdown: this box has a public IPv6 address.
  # prod-bootstrap.sh exits FATAL on a missing ip6tables and says exactly this.
  if ! command -v ip6tables >/dev/null 2>&1; then
    warn "ip6tables is missing; installing iptables (prod-bootstrap.sh treats this as FATAL, not a warning)"
    run env DEBIAN_FRONTEND=noninteractive apt-get install -y iptables
  fi

  # ─────────────────────────────────────────────────────────────────────────
  # BEFORE claiming this cannot touch your ssh session, FIND OUT WHERE SSH IS.
  #
  # prod-bootstrap.sh does `-I INPUT 1 -p tcp -m multiport --dports 80,443
  # -j LIBRIANT-ORIGIN`, and that chain ends `-j DROP` for everything outside
  # the Cloudflare and RFC1918 ranges. Position 1 of INPUT puts it ahead of
  # ufw's own jumps. An operator running sshd on 443 to get through a corporate
  # egress filter — a common and documented hardening move — has their ssh port
  # DROPped for every non-Cloudflare source the moment this runs. The current
  # session survives on the RELATED,ESTABLISHED RETURN at the top of the chain,
  # so the step prints green, the verdict parser reports nothing, and the run
  # completes clean. The lockout is discovered at the next login attempt, by
  # which time --firewall-install-unit has made it survive a reboot.
  #
  # The ufw step is careful never to assume port 22. This one used to say it in
  # a banner. Read it instead.
  # ─────────────────────────────────────────────────────────────────────────
  local sshports p
  sshports="$(ssh_ports_listening | tr '\n' ' ')"
  for p in $sshports; do
    case "$p" in
      80|443)
        die "sshd listens on port ${p}, and the origin lockdown inserts a DROP for
     non-Cloudflare traffic to 80/443 at INPUT position 1. Applying it would lock
     you out of this box — your current session would survive on conntrack and
     nothing would look wrong until you tried to reconnect.
     Move sshd off ${p} first, then re-run:  $SELF --only firewall" ;;
    esac
  done

  if [ -n "$(printf '%s' "$sshports" | tr -d ' ')" ]; then
    banner "THIS APPLIES DROP RULES TO 80/443 — AND NOT TO PORT(S) ${sshports}"
    printf '  The LIBRIANT-ORIGIN chain is only jumped into for tcp 80,443 and udp 443.\n'
    printf '  sshd was read as listening on: %s — none of which is 80 or 443, so your\n' "$sshports"
    printf '  session is untouched. Keep a second session open anyway.\n\n'
  else
    banner "COULD NOT READ WHICH PORT sshd IS ON"
    warn "The lockdown DROPs non-Cloudflare traffic to 80/443 at INPUT position 1."
    warn "If sshd is on 80 or 443 this WILL lock you out. Check by hand:  ss -lntp | grep -i ssh"
    confirm "sshd is NOT on port 80 or 443. Apply the origin lockdown?" \
      || die "Stopped, with the firewall untouched."
  fi
  printf '  Public IPv6 to 80/443 is DROPPED OUTRIGHT by default — deliberately, and\n'
  printf '  correct while the origin has no proxied AAAA records. Add --allow-ipv6 only\n'
  printf '  once AAAA records exist; until then it would collapse every v6-carried\n'
  printf '  visitor into one rate-limit bucket through the userland proxy.\n\n'

  bash "$pb" --firewall-only \
    || die "prod-bootstrap.sh --firewall-only exited non-zero. Its own message above names
     the reason — a missing ip6tables is FATAL to it, not a warning, because this
     box has a public IPv6 address. The lockdown is NOT applied."

  # These rules do not survive a reboot, and a `docker network` change can
  # recreate DOCKER-USER. The unit re-runs --firewall-only after docker.service.
  bash "$pb" --firewall-install-unit \
    || die "prod-bootstrap.sh --firewall-install-unit failed. The rules are applied NOW
     but would not come back after a reboot, and nothing would say so."

  # prod-bootstrap.sh's own closing instruction: TEST the unit now. A unit that
  # is enabled but fails on boot is indistinguishable from a working one until
  # the next reboot, which will be during an incident.
  if [ "$DRY" = 0 ]; then
    if systemctl start libriant-origin-firewall 2>/dev/null \
       && [ "$(systemctl is-active libriant-origin-firewall 2>/dev/null || true)" = "active" ]; then
      ok "libriant-origin-firewall.service runs cleanly — the lockdown survives a reboot"
    else
      systemctl status libriant-origin-firewall --no-pager 2>&1 | tail -15 | sed 's/^/         /' || true
      warn "the boot-time unit did not start cleanly. The rules are applied NOW, but a"
      warn "reboot would come back without them and nothing would say so."
    fi
    note "the unit does NOT pass --allow-ipv6. If you ever admit the Cloudflare v6"
    note "ranges by hand, edit its ExecStart to match or the next reboot silently"
    note "reverts to dropping public IPv6 and Cloudflare starts seeing 522s over v6."
  fi

  if [ "$DRY" = 1 ]; then
    printf '  would then read --firewall-status and treat a missing ip6tables rule as FATAL\n'
    return 0
  fi

  say "authn-authz-01 — verifying, not assuming"
  local status findings
  status="$(bash "$pb" --firewall-status 2>&1 || true)"
  printf '%s\n' "$status" | sed 's/^/         /'
  findings="$(printf '%s\n' "$status" | fw_parse | fw_verdict || true)"
  if [ -n "$findings" ]; then
    printf '\n'
    printf '%s\n' "$findings" | sed 's/^/         /'
    if printf '%s\n' "$findings" | grep -q '^FATAL'; then
      die "The origin lockdown is NOT in force. Fix the findings above before going
     further. If the DOCKER-USER jumps are what is missing, the usual cause is
     that the stack is not up: dockerd builds that chain, and there is nothing
     to hook into before it does. Run the 'deploy' step, then this one again.
     If the missing chain is the ip6tables one, dockerd may simply have IPv6
     disabled — that is a docker daemon.json question, not a Libriant one.
     The nightly backup runs BEFORE this step, so it is already installed; the
     only thing after this is the read-only §3.9 verification, which you can run
     on its own:
       $SELF --verify-only
     and this step can be left out of a resume entirely:
       $SELF --from firewall --skip firewall"
    fi
  else
    ok "a LIBRIANT-ORIGIN chain with jumps from BOTH INPUT and DOCKER-USER, on BOTH families, and no [::] listener"
  fi

  banner "ON-BOX OUTPUT PROVES NOTHING ABOUT THE INTERNET"
  printf '  From a machine that is NOT this one, and not a Cloudflare address:\n\n'
  # §3.2c's FULL port list, including 3300 and 9090. Those two only become
  # checkable AFTER the deploy — infra/monitoring publishes Grafana on
  # 127.0.0.1:3300 and deploy-on-host.sh starts that stack on every deploy — so
  # this, the post-deploy scan, is the one moment the loopback bind can be
  # proved to have held. Dropping them from the list removed the check at the
  # only point it can fail.
  printf '      nmap -Pn -p 22,80,443,5432,6379,3300,9090 %s\n' "$(scan_v4)"
  printf '      nmap -6 -Pn -p 22,80,443 %s\n\n' "$(scan_v6)"
  printf '  Expect: ssh (port %s) open, 80/443 FILTERED from a non-Cloudflare address.\n' \
    "$(printf '%s' "${sshports}" | sed 's/[[:space:]]*$//; s/^$/unknown — check by hand/')"
  printf '  5432 and 6379 must never appear: the data network is internal: true.\n'
  printf '  3300 (Grafana) and 9090 (Prometheus) must never appear either: they are\n'
  printf '  published on 127.0.0.1 only, and this scan is what proves that held.\n\n'
}

# ── §8.2 The nightly backup — a green deploy has none ───────────────────────
#
# The cron file alone is not the whole job: backup.sh has moved on from §8.2 and
# will refuse to run without an encryption decision and a dead man's switch. The
# marker records that the operator settled both.
satisfied_backup() { [ -f "$CRON_FILE" ] && marked backup; }

step_backup() {
  say "§8.2 The nightly backup — nothing else installs this"

  local bs="${APP_DIR}/scripts/backup.sh"
  [ -f "$bs" ] || die "$bs is missing — run the 'checkout' step first."
  [ -f "$ENV_FILE" ] || die "$ENV_FILE is missing."

  banner "NOTHING INSTALLS THE NIGHTLY BACKUP, AND NOTHING WARNS IT IS MISSING"
  printf '  Not the deploy, not any script, not CI. "Daily backups and an off-server\n'
  printf '  copy" is a written term of the founding offer. This is the step people skip,\n'
  printf '  in the same sitting they meant to do it in.\n\n'
  printf '  backup.sh has two gates §8.2 predates, and it stops dead on either:\n'
  printf '    encryption          age recipient, gpg passphrase file, or an explicit\n'
  printf '                        plaintext acknowledgement. A pg_dumpall is the\n'
  printf '                        complete member registry of every library on this\n'
  printf '                        host — names, dates of birth, addresses, and the loan\n'
  printf '                        history of named children.\n'
  printf '    a dead man'"'"'s switch  a heartbeat URL, or a writable %s\n\n' "$TEXTFILE_DIR"

  # ── Encryption (privacy-legal-02). ──────────────────────────────────────
  local have_crypt=""
  [ -n "$(env_get "$ENV_FILE" BACKUP_AGE_RECIPIENT 2>/dev/null || true)" ] && have_crypt="age"
  [ -z "$have_crypt" ] && [ -n "$(env_get "$ENV_FILE" BACKUP_AGE_RECIPIENTS_FILE 2>/dev/null || true)" ] && have_crypt="age"
  [ -z "$have_crypt" ] && [ -n "$(env_get "$ENV_FILE" BACKUP_GPG_PASSPHRASE_FILE 2>/dev/null || true)" ] && have_crypt="gpg"
  [ -z "$have_crypt" ] && [ "$(env_get "$ENV_FILE" BACKUP_ALLOW_PLAINTEXT 2>/dev/null || true)" = "1" ] && have_crypt="plaintext"

  if [ -n "$have_crypt" ]; then
    ok "backup encryption is already configured in $ENV_FILE ($have_crypt)"
  elif [ "$DRY" = 1 ]; then
    note "would ask how backups are to be encrypted"
  else
    printf '  How should backups be encrypted?\n\n'
    printf '    1. age  (preferred)  you hold the age RECIPIENT (public key) here and keep\n'
    printf '                         the IDENTITY off this host, so a host compromise\n'
    printf '                         cannot open yesterday'"'"'s off-site copy.\n'
    printf '    2. gpg               a passphrase file on this host. Defends the off-site\n'
    printf '                         leg only, which is the exposure that matters most.\n'
    printf '    3. plaintext         allowed ONLY for a local-only host, and never with an\n'
    printf '                         off-site remote. The Art. 28 DPA a municipality signs\n'
    printf '                         says "encrypted backups"; this makes that untrue.\n\n'
    local choice=""
    ask choice "Choose 1, 2 or 3"
    case "$choice" in
      1)
        local rcpt=""
        ask rcpt "BACKUP_AGE_RECIPIENT (age1…)"
        is_age_identity "$rcpt" && die "That is an age IDENTITY (the SECRET half). Putting it on this host defeats
     the point: the decryptor would sit next to the ciphertext. Paste the
     RECIPIENT (age1…) instead."
        is_age_recipient "$rcpt" || die "That is not an age recipient (age1…, lowercase). Nothing was written."
        if ! command -v age >/dev/null 2>&1; then
          note "installing age"
          run env DEBIAN_FRONTEND=noninteractive apt-get install -y age
        fi
        command -v age >/dev/null 2>&1 || die "age is still not installed, and backup.sh aborts on every run when
     BACKUP_AGE_RECIPIENT is set without it. Install it, or choose gpg."
        env_set_if_absent BACKUP_AGE_RECIPIENT "$rcpt"
        ;;
      2)
        local pf=""
        ask pf "Path to the gpg passphrase file (must exist, be non-empty and readable by $DEPLOY_USER)"
        [ -s "$pf" ] || die "$pf is missing or empty. An empty passphrase file encrypts to something
     everybody can guess. Nothing was written."
        # READABLE BY THE ACCOUNT THAT WILL RUN THE BACKUP, not by root. The cron
        # line runs as $DEPLOY_USER, and backup-crypt.sh's own `[ -r ]` check
        # would otherwise fail at 02:15, in a log nobody reads. Root can read
        # anything, so testing it here as root proves nothing at all.
        as_deploy test -r "$pf" \
          || die "$pf is not readable by $DEPLOY_USER, which is the account the nightly cron
     runs as. Every backup would abort before the first byte. Fix the ownership
     or mode and re-run this step."
        command -v gpg >/dev/null 2>&1 || run env DEBIAN_FRONTEND=noninteractive apt-get install -y gnupg
        env_set_if_absent BACKUP_GPG_PASSPHRASE_FILE "$pf"
        ;;
      3)
        confirm_typed "Plaintext backups make the signed DPA untrue. This is your decision." "PLAINTEXT" \
          || die "Stopped. Configure age or gpg and re-run this step."
        env_set_if_absent BACKUP_ALLOW_PLAINTEXT 1
        warn "backups will be UNENCRYPTED, and backup.sh marks every run degraded for it."
        ;;
      *) die "No choice made, and backup.sh aborts on every run without one." ;;
    esac
  fi

  # ── The dead man's switch. ──────────────────────────────────────────────
  if [ -d "$TEXTFILE_DIR" ]; then
    ok "$TEXTFILE_DIR exists (node-exporter's textfile collector; the absent() alert reads it)"
  else
    run install -d -m 755 -o "$DEPLOY_USER" -g "$(id -gn "$DEPLOY_USER" 2>/dev/null || echo "$DEPLOY_USER")" "$TEXTFILE_DIR"
  fi
  local hb
  hb="$(env_get "$ENV_FILE" BACKUP_HEARTBEAT_URL 2>/dev/null || true)"
  if [ -n "$hb" ]; then
    ok "BACKUP_HEARTBEAT_URL is set"
  elif [ "$DRY" = 0 ]; then
    printf '\n  §7.3: an external dead-man switch (period 1 day, grace 6 hours) is the\n'
    printf '  cheapest real alert you can have, and it SURVIVES losing this host — which\n'
    printf '  the textfile metric does not.\n'
    local url=""
    ask url "BACKUP_HEARTBEAT_URL (blank to skip)"
    if [ -n "$url" ]; then
      is_https_url "$url" || die "That URL has whitespace or a quote in it. It goes into a cron line inside
     single quotes and would break the whole nightly, not just the ping."
      env_set_if_absent BACKUP_HEARTBEAT_URL "$url"
    else
      warn "no heartbeat URL: the only dead-man switch is the textfile metric, which dies with this host."
    fi
  fi

  # ── Off-site (launch-readiness-05). ─────────────────────────────────────
  local remote
  remote="$(env_get "$ENV_FILE" RCLONE_REMOTE 2>/dev/null || true)"
  if [ -n "$remote" ]; then
    ok "RCLONE_REMOTE is set ($remote)"
    command -v rclone >/dev/null 2>&1 \
      || warn "…but rclone is NOT installed, and backup.sh ABORTS on that. Install it or clear RCLONE_REMOTE."
  elif [ "$(env_get "$ENV_FILE" BACKUP_ALLOW_LOCAL_ONLY 2>/dev/null || true)" = "1" ]; then
    ok "BACKUP_ALLOW_LOCAL_ONLY=1 — a deliberately local-only host, already acknowledged"
  elif [ "$DRY" = 0 ]; then
    warn "There is no off-site copy. A lost box loses the backups with it, and"
    warn "backup.sh exits NON-ZERO every night to say so — on purpose."
    if confirm "Acknowledge this as a deliberately LOCAL-ONLY host for now (BACKUP_ALLOW_LOCAL_ONLY=1)?"; then
      env_set_if_absent BACKUP_ALLOW_LOCAL_ONLY 1
      warn "This is a promise you still owe. It is in the closing summary for a reason."
    else
      note "leaving it unset: every nightly run will exit non-zero and report degraded"
      note "until an off-site remote exists. That is the intended signal, not a fault."
    fi
  fi

  # ── The cron file. ──────────────────────────────────────────────────────
  backup_cron_line | write_file "$CRON_FILE" 0644 root:root

  if [ "$DRY" = 0 ]; then
    # cron silently ignores a /etc/cron.d file whose last line has no newline,
    # and ignores one whose user field names an account that does not exist.
    [ "$(tail -c1 "$CRON_FILE" | wc -l | tr -d ' ')" = "1" ] \
      || warn "$CRON_FILE does not end in a newline; cron ignores such files."
    id "$DEPLOY_USER" >/dev/null 2>&1 || die "$CRON_FILE names user '$DEPLOY_USER', which does not exist."
    ok "$CRON_FILE installed, root:root, mode 644"
    note "backup.sh --print-cron renders a DIFFERENT line to this one (it carries no"
    note "STORAGE_DIR and takes BACKUP_ROOT from its own environment, which unprefixed"
    note "is the boot disk). If you ever regenerate it, carry the full env prefix:"
    note "  sudo env $(backup_env_prefix) bash ${APP_DIR}/scripts/backup.sh --install-cron"
  fi

  # ── Run it once by hand, immediately, and READ the output. §8.2. ────────
  if [ "$DRY" = 1 ]; then
    printf '  would run backup.sh --preflight, then the real backup once, and read both\n'
    return 0
  fi

  # --preflight is everything that can be wrong about the CONFIG, before the
  # first byte is dumped: the encryption self-test (an archive nobody can
  # decrypt is not a backup), the storage directory, the remote, and whether a
  # dead man's switch exists at all. Seconds, against minutes for the real run.
  printf '\n'
  say "§8.2 backup.sh --preflight (config only; touches no data)"
  if as_deploy_sh <<EOS
set -a; . ${ENV_FILE}; set +a
$(backup_env_prefix) bash ${APP_DIR}/scripts/backup.sh --preflight
EOS
  then
    ok "preflight passed"
  else
    warn "preflight FAILED — read its message above. The nightly would fail the same way."
    confirm "Continue to the real run anyway?" || return 0
  fi

  printf '\n'
  if ! confirm "Run the backup once now (it dumps the whole cluster; minutes on a fresh box)?"; then
    warn "skipped. Run it before you walk away — an untested backup is not a backup:"
    printf '         sudo -u %s bash -lc '"'"'set -a; . %s; set +a; %s %s/scripts/backup.sh'"'"'\n' \
      "$DEPLOY_USER" "$ENV_FILE" "$(backup_env_prefix)" "$APP_DIR"
    mark_done backup
    return 0
  fi

  local rc=0
  as_deploy_sh <<EOS || rc=$?
set -a; . ${ENV_FILE}; set +a
$(backup_env_prefix) bash ${APP_DIR}/scripts/backup.sh
EOS

  local day dest
  day="$(date +%Y%m%d)"
  dest="${DATA_ROOT}/backups/${day}"
  printf '\n'
  ls -lh "$dest" 2>/dev/null | sed 's/^/         /' || warn "no ${dest} directory was produced"

  # §8.2's "good looks like": four files, postgres.sql.gz comfortably over 1 KiB.
  # The artefact name carries an .age/.gpg suffix when encryption is on, so glob
  # rather than match the plaintext name.
  local pg n_files sz
  pg="$(ls -1 "$dest" 2>/dev/null | grep '^postgres\.sql\.gz' | head -1 || true)"
  n_files="$(ls -1 "$dest" 2>/dev/null | wc -l | tr -d ' ' || echo 0)"
  if [ -n "$pg" ]; then
    sz="$(wc -c < "${dest}/${pg}" | tr -d ' ')"
    if [ "${sz:-0}" -gt 1024 ]; then
      ok "${pg} is ${sz} bytes (backup.sh's own gate calls anything under 1024 a failed dump)"
    else
      die "${pg} is only ${sz} bytes. That is a failed dump by backup.sh's own gate."
    fi
  fi
  [ "${n_files:-0}" -ge 4 ] \
    && ok "${n_files} artefacts written (expect four: postgres, storage, caddy-logs, manifest)" \
    || warn "${n_files:-0} artefacts — expected four"

  if [ "$rc" = 0 ]; then
    ok "the backup exited 0"
  elif [ -n "$pg" ]; then
    # It writes its artefacts BEFORE it judges the run, so this shape is
    # "degraded", not "failed": the data is captured and a promise is unmet.
    warn "backup.sh exited ${rc}, but a database dump WAS written. That is the DEGRADED"
    warn "shape, and it is by design:"
    warn "  * no RCLONE_REMOTE and no BACKUP_ALLOW_LOCAL_ONLY=1 exits non-zero because"
    warn "    an off-server copy is a written term of the offer;"
    warn "  * BACKUP_ALLOW_PLAINTEXT=1 marks every run degraded for the same reason."
    warn "Read the log above and decide which it is."
  else
    die "backup.sh exited ${rc} and wrote NO database dump under ${dest}.
     That is one of its hard aborts — the control-DB tenant query, a tenant living
     off this host, a dump under 1024 bytes, a failed gzip -t, a missing storage
     directory, or the encryption / dead-man's-switch gates above them.
     Read the output above, then re-run:  $SELF --only backup"
  fi

  # backup.sh's own consumer-facing check, LAST, so the "is there a backup newer
  # than 48h" half of it has something to find.
  printf '\n'
  as_deploy_sh <<EOS || warn "--check-cron is not satisfied yet; read its message above"
set -a; . ${ENV_FILE}; set +a
BACKUP_ROOT=${DATA_ROOT}/backups COMPOSE_FILE=${APP_DIR}/infra/compose/docker-compose.prod.yml bash ${APP_DIR}/scripts/backup.sh --check-cron
EOS

  note "Local retention is BACKUP_KEEP_DAYS (14). There is NO WAL archiving and no"
  note "point-in-time recovery: the RPO is the cron interval — up to 24 hours of loss."
  note "The quarterly restore drill (§8.5) has never been done. Book it."
  mark_done backup
}

# ── §3.9 Post-deploy checks the deploy script does not do ───────────────────
#
# Read-only, so it always runs.
satisfied_verify() { return 1; }

step_verify() {
  say "§3.9 Post-deploy checks — the things nothing else proves"

  # Not a die: --verify-only wants the firewall and backup answers even when the
  # checkout is missing, so this reports and returns rather than taking the
  # whole run down.
  if [ ! -d "${APP_DIR}/.git" ]; then
    warn "$APP_DIR is not a checkout — the §3.9 probes cannot run"
    VERIFY_RC=1
    return 0
  fi
  if [ "$DRY" = 1 ]; then printf '  would run the §3.9 probes as %s\n' "$DEPLOY_USER"; return 0; fi

  local apex
  apex="$(env_get "$ENV_FILE" SITE_HOST 2>/dev/null || true)"
  [ -n "$apex" ] || apex="$(env_get "$ENV_FILE" PUBLIC_APEX_DOMAIN 2>/dev/null || true)"
  [ -n "$apex" ] || { warn "SITE_HOST is not set in $ENV_FILE — skipping the page check"; apex=""; }

  # A hostname and nothing else: this value is interpolated into a shell script
  # that runs as another user, so anything but [A-Za-z0-9.-] is refused rather
  # than quoted around.
  case "$apex" in *[!A-Za-z0-9.-]*) warn "SITE_HOST ('$apex') is not a bare hostname — skipping the page check"; apex="" ;; esac

  local rc=0
  # APEX is prepended to the body rather than exported, because runuser does not
  # promise to carry an ad-hoc variable across the user switch.
  { printf 'APEX=%s\n' "$apex"; cat <<'EOS'
fails=0
mark() { if [ "$1" = 0 ]; then printf '  ok   %s\n' "$2"; else printf '  FAIL %s\n' "$2"; fails=$((fails+1)); fi; }

printf '\n--- dc ps ---\n'
dc ps

# Captured ONCE and reused below, so the log the operator reads and the log the
# checks are run against cannot be two different reads of a moving target.
migrate_log="$(dc logs --no-color migrate 2>/dev/null || true)"
printf '\n--- migrate log (last 40) ---\n'
printf '%s\n' "$migrate_log" | tail -40

# WHAT THE MIGRATE LOG ACTUALLY SAYS TODAY.
#
# §3.9's table — ingest:help / tenant:migrate / admin:bootstrap are
# "best-effort and still exit 0", look for "skipped (non-fatal)" — IS STALE.
# launch-readiness-15 and boot-and-config-04 made all three FATAL: prod-bootstrap.sh
# now prints "[bootstrap] FATAL: …" and exits 1 for each, and the string
# "skipped (non-fatal)" appears nowhere in the repo any more. Grepping for it
# printed a reassuring "none" on every run, forever, about a class of failure
# that had moved.
#
# What HAS survived, and is the one line that still means "a green deploy
# nobody can log into", is prod-bootstrap.sh's own:
#     [bootstrap] ADMIN_BOOTSTRAP_* not set - skipping admin creation
# That path exits 0. Nothing else in the deploy notices it.
printf '\n--- migrate log: things that are a job for you ---\n'
if printf '%s\n' "$migrate_log" | grep -q 'ADMIN_BOOTSTRAP_\* not set - skipping'; then
  printf '  FAIL no admin was created — ADMIN_BOOTSTRAP_EMAIL / _PASSWORD were empty when\n'
  printf '       migrate ran. This is a fully green deploy that NOBODY CAN LOG INTO, and\n'
  printf '       only the email half warns anywhere else. Repair: set both in .env.prod\n'
  printf '       and re-run the deploy (RUNBOOK §4.5).\n'
  fails=$((fails+1))
fi
if printf '%s\n' "$migrate_log" | grep -q '\[bootstrap\] FATAL'; then
  printf '%s\n' "$migrate_log" | grep '\[bootstrap\] FATAL' | sed 's/^/  FAIL /'
  fails=$((fails+1))
fi
# Belt and braces: if a future prod-bootstrap.sh reintroduces the swallow-and-
# continue shape, catch it rather than silently pass.
if printf '%s\n' "$migrate_log" | grep -i -q 'skipped (non-fatal)\|(non-fatal)'; then
  printf '%s\n' "$migrate_log" | grep -i '(non-fatal)' | sed 's/^/  FAIL /'
  printf '       ^ a best-effort step failed and the deploy still went green.\n'
  fails=$((fails+1))
fi
printf '  (checked: no admin created, [bootstrap] FATAL, and any (non-fatal) swallow)\n'

printf '\n--- the probes ---\n'

# Uploads are writable by the CONTAINER user (uid 1000). /readyz checks Postgres
# and Redis and never touches storage, so a fully healthy stack can still EACCES
# on the first cover upload.
# </dev/null on every `dc exec`: `docker compose exec` defaults to
# --interactive=true and -T only turns off the TTY, so its stdin pump will
# happily read whatever is on this script's stdin. as_deploy_sh already runs
# this body from a FILE with stdin closed, which is the real fix; this is the
# second lock on the same door, so that a future caller who pipes the body in
# cannot silently truncate §3.9 again.
dc exec -T api sh -c 'touch /srv/libriant/storage/.probe && rm /srv/libriant/storage/.probe' >/dev/null 2>&1 </dev/null
mark $? "STORAGE-OK — the uploads directory is writable by uid 1000"

# The web -> api hop, which NO healthcheck crosses. web's own healthcheck is a
# constant: it passes green with a wrong API_INTERNAL_URL while every page
# renders an error.
dc exec -T web sh -c 'wget -qO- http://api:3001/healthz' >/dev/null 2>&1 </dev/null
mark $? "WEB-TO-API-OK — web can reach api over the app network"

# A real page, not a static probe. --resolve, not -H: curl takes SNI from the
# URL host, and the origin certificate does not cover 'localhost' — a healthy
# stack would read as down.
if [ -n "${APEX:-}" ]; then
  code="$(curl -sk --resolve "$APEX:443:127.0.0.1" -o /dev/null -w '%{http_code}' --max-time 10 "https://$APEX/pricing" 2>/dev/null || true)"
  [ "$code" = "200" ]
  mark $? "GET https://$APEX/pricing returned ${code:-000} (expect 200)"
fi

# The help centre. ingest:help is one of the best-effort steps above, and an
# empty help centre is indistinguishable from a working one until a librarian
# goes looking — the app renders "no articles" rather than an error, and the
# site sells in-app help as one of four support mechanisms.
#
# The count(*) FILTER form is not decoration: the obvious GROUP BY version
# returns NO ROWS on an empty table, so it prints nothing and exits 0 on exactly
# the failure it exists to catch.
dc exec -T postgres psql -U libriant -d libriant_control -tAc \
  "SELECT count(*) FILTER (WHERE locale = 'el'), count(*) FILTER (WHERE locale = 'en')
     FROM help_articles WHERE \"archivedAt\" IS NULL" </dev/null \
  | awk -F'|' '{ if ($1 >= 4 && $2 >= 4) print "  HELP-OK el=" $1 " en=" $2;
                 else { print "  HELP-MISSING el=" $1 " en=" $2; exit 1 } }
               END { if (NR == 0) { print "  HELP-QUERY-FAILED — psql produced no output at all"; exit 1 } }'
help_rc=$?
mark $help_rc "help centre populated (four articles per language is the whole corpus)"
if [ "$help_rc" != 0 ]; then
  printf '       repair — it upserts, so re-running is free:\n'
  printf '         dc run --rm --no-deps migrate sh -lc "cd /app && pnpm ingest:help"\n'
fi

# The admin actually exists. MFA enrolment needs a browser and the box is not in
# DNS, so this is what CAN be confirmed from here.
printf '\n--- the first admin ---\n'
printf '%s\n' "$migrate_log" | grep -i admin | tail -5 || printf '  (no admin line in the migrate log)\n'
dc exec -T postgres psql -U libriant -d libriant_control -tAc \
  "select email, role, status from admin_users;" 2>/dev/null </dev/null | sed 's/^/  /' \
  || printf '  (could not query admin_users)\n'

# §6.1's OTHER two "good looks like" conditions, which nothing has checked
# until now. DC-OK alone is checked in the dchelper step, which runs BEFORE the
# deploy — at that moment no image can exist, so `dc config` passing proves only
# that the YAML parses. §6.1 is explicit that an IMAGE_TAG of `latest` (or of
# nothing at all) breaks every command that CREATES a container: `dc up -d
# caddy` in §9.1, the reboot procedure in §6.8, `dc run … migrate` in §6.4.
# This is the first moment the assertion can mean anything, because the image
# now exists.
printf '\n--- §6.1: the dc helper resolves a real, LOCAL image ---\n'
printf '  IMAGE_TAG=%s\n' "$IMAGE_TAG"
case "$IMAGE_TAG" in
  latest|''|-dirty)
    printf '  FAIL IMAGE_TAG is "%s". Every `dc up`/`dc run` would try to pull\n' "$IMAGE_TAG"
    printf '       ghcr.io/libriant/libriant-api:%s, which exists nowhere. Fix the block in\n' "$IMAGE_TAG"
    printf '       ~/.bashrc (RUNBOOK §6.1) before you rely on any dc command.\n'
    fails=$((fails+1)) ;;
  *) printf '  ok   IMAGE_TAG is not "latest"\n' ;;
esac
if docker images --format '{{.Repository}}:{{.Tag}}' 2>/dev/null | grep -q "libriant-api:$IMAGE_TAG"; then
  printf '  ok   a LOCAL libriant-api:%s image exists\n' "$IMAGE_TAG"
else
  printf '  FAIL no local image tagged libriant-api:%s. §6.1: `dc up -d` resolves the\n' "$IMAGE_TAG"
  printf '       GHCR path instead and fails on a manifest error. Nothing publishes to\n'
  printf '       GHCR while deploys are manual.\n'
  fails=$((fails+1))
fi
dc config >/dev/null 2>&1 </dev/null
mark $? "DC-OK — both compose files parse with this environment"

printf '\n'
if [ "$fails" = 0 ]; then
  printf '  All §3.9 checks passed.\n'
else
  printf '  %s §3.9 check(s) need attention.\n' "$fails"
fi
exit "$fails"
EOS
  } | as_deploy_dc || rc=$?

  # 90 is the §6.1 preamble's own refusal, not a count of failed checks.
  if [ "$rc" = 0 ]; then
    ok "§3.9 verification passed"
  elif [ "$rc" = 90 ]; then
    warn "§3.9 could not run: IMAGE_TAG could not be determined (see the message above)."
    warn "That is RUNBOOK §6.1's failure — git could not answer in ${APP_DIR} and no"
    warn "libriant-api-1 container is running. Deploy first, then:  $SELF --verify-only"
    rc=1
  else
    warn "§3.9: ${rc} check(s) failed — see above"
  fi
  VERIFY_RC="$rc"

  banner "A GREEN STORAGE PROBE IS NOT A WORKING UPLOAD"
  printf '  STORAGE-OK proves the DIRECTORY is writable by uid 1000. It does not prove\n'
  printf '  uploads work. BLOCKER data-integrity-01: every file upload returns HTTP 500\n'
  printf '  in the launch configuration — the unlimited-plan MAX_SAFE_INTEGER sentinel\n'
  printf '  overflows a Postgres bigint (§9.9). Do not conclude from this probe that a\n'
  printf '  librarian can attach a cover image.\n\n'

  cat <<EOF
  ${C_B}Logging into the admin panel before cutover is harder than it sounds.${C_0}
  The box is not in DNS and a browser cannot be given --resolve. A hosts entry
  walks into two walls: Caddy serves the Cloudflare Origin CA, which no browser
  trusts, and the apex asserts includeSubDomains HSTS — an HSTS certificate
  error has no "proceed anyway" button. The normal choice is to defer it and
  log in over real DNS after the cutover (§5.4). Either way MFA enrolment needs
  a browser: it is mandatory in production and cannot be turned off from
  .env.prod.

EOF
}

# ════════════════════════════════════════════════════════════════════════════
# READ-ONLY STATUS SURFACES
# ════════════════════════════════════════════════════════════════════════════

step_title() {
  case "$1" in
    briefing) printf 'What to have in front of you' ;;
    stock)    printf '§3.1   Take stock (and the §1 timezone decision)' ;;
    ssh)      printf '§3.2a  SSH password authentication OFF (lockout guard)' ;;
    ufw)      printf '§3.2b  ufw, with IPv6, allowing the real ssh port' ;;
    packages) printf '§3.2d  Baseline packages, fail2ban, unattended-upgrades' ;;
    docker)   printf '§3.3   Docker from its own apt repository' ;;
    user)     printf '§3.4   The deploy user: docker, sudo, a password, keys' ;;
    dirs)     printf '§3.5   Directories on the data volume' ;;
    checkout) printf '§3.6   Deploy key + checkout (pauses for GitHub)' ;;
    env)      printf '§3.7a  ensure-env.sh, interactively — never --auto' ;;
    cert)     printf '§3.7b  The Cloudflare origin certificate' ;;
    dchelper) printf '§6.1   The dc helper in the deploy shell' ;;
    deploy)   printf '§3.8   The deploy (builds images — 10-20 min cold)' ;;
    firewall) printf 'authn-authz-01  Origin lockdown, v4 AND v6' ;;
    backup)   printf '§8.2   The nightly backup — nothing else installs it' ;;
    verify)   printf '§3.9   The checks the deploy script does not do' ;;
  esac
}

satisfied() {
  local fn="satisfied_$1"
  if type "$fn" >/dev/null 2>&1; then "$fn"; else marked "$1"; fi
}

show_status() {
  local s n=0 total mark
  total="$(printf '%s\n' $STEPS | wc -w | tr -d ' ')"
  printf '\n%sLibriant install status%s   state: %s\n\n' "$C_B" "$C_0" "$STATE_DIR"
  for s in $STEPS; do
    n=$((n + 1))
    if satisfied "$s" 2>/dev/null; then
      mark="${C_G}done   ${C_0}"
    elif marked "$s"; then
      mark="${C_Y}ran*   ${C_0}"
    else
      mark="${C_D}pending${C_0}"
    fi
    printf '  %2d/%s [%s] %-9s %s\n' "$n" "$total" "$mark" "$s" "$(step_title "$s")"
  done
  printf '\n  %s* ran before, but the machine no longer satisfies the check.%s\n' "$C_D" "$C_0"
  printf '  %sSteps with no machine-visible end state — stock, env, cert, verify —%s\n' "$C_D" "$C_0"
  printf '  %salways report pending: they are cheap, and they re-check rather than redo.%s\n' "$C_D" "$C_0"
  if [ "$(id -u)" != "0" ]; then
    printf '  %sRun as root for an accurate reading: ufw, sshd and passwd all refuse%s\n' "$C_D" "$C_0"
    printf '  %sto answer an unprivileged caller.%s\n' "$C_D" "$C_0"
  fi
  printf '\n'
}

# The firewall's real state and whether a nightly backup exists at all. Both are
# read-only, and both run even when an earlier one has findings — the whole
# value of a status pass is the complete picture.
firewall_status_only() {
  say "authn-authz-01 — firewall status"
  local pb="${APP_DIR}/scripts/prod-bootstrap.sh" status findings
  [ -f "$pb" ] || { warn "$pb is missing (no checkout?) — cannot read the firewall state"; return 0; }
  [ "$(id -u)" = 0 ] || { warn "--firewall-status needs root; skipping"; return 0; }
  status="$(bash "$pb" --firewall-status 2>&1 || true)"
  printf '%s\n' "$status" | sed 's/^/         /'
  findings="$(printf '%s\n' "$status" | fw_parse | fw_verdict || true)"
  if [ -n "$findings" ]; then
    printf '%s\n' "$findings" | sed 's/^/         /'
    printf '%s\n' "$findings" | grep -q '^FATAL' && VERIFY_RC=$((VERIFY_RC + 1))
  else
    ok "the origin lockdown holds on both address families"
  fi
  return 0
}

backup_status_only() {
  say "§8.2 The nightly backup"
  if [ -f "$CRON_FILE" ]; then
    ok "$CRON_FILE is installed"
    local newest
    newest="$(find "${DATA_ROOT}/backups" -mindepth 1 -maxdepth 1 -type d -mtime -2 2>/dev/null | head -1 || true)"
    if [ -n "$newest" ]; then
      ok "newest backup: $newest"
    else
      warn "the cron exists but there is no backup under ${DATA_ROOT}/backups newer than 48h"
      VERIFY_RC=$((VERIFY_RC + 1))
    fi
  else
    warn "NO NIGHTLY BACKUP IS INSTALLED ($CRON_FILE is missing). The offer terms promise daily backups."
    VERIFY_RC=$((VERIFY_RC + 1))
  fi
  return 0
}

# ════════════════════════════════════════════════════════════════════════════
# THE CLOSING SUMMARY — what this installer deliberately did NOT do.
# ════════════════════════════════════════════════════════════════════════════
closing_summary() {
  say "Done — and here is what this installer deliberately did NOT do"
  cat <<EOF

  THE BOX IS NOT IN DNS, AND THAT IS CORRECT.
    A first deploy on a private box is legitimate; the cutover is a separate,
    deliberate act (§5.4), and the runbook's standing verdict is "do not put
    this box in DNS" while the launch blockers below still stand.

  RUN THE EXTERNAL SCAN, FROM YOUR LAPTOP, OVER BOTH ADDRESS FAMILIES.
    On-box output proves nothing about the internet. Expect 22, 80 and 443 and
    nothing else; 5432 and 6379 must never appear.
      nmap -Pn -p 22,80,443,5432,6379,3300,9090 $(scan_v4)
      nmap -6 -Pn -p 22,80,443 $(scan_v6)

  COPY ${ENV_FILE} AND THE ORIGIN PAIR INTO THE PASSWORD MANAGER.
    They are in no backup. MFA_MASTER_KEY, POSTGRES_PASSWORD and the origin
    certificate pair are irrecoverable if lost.

  ALERTING IS PROBABLY NOT DELIVERING.
    The deploy starts Prometheus and evaluates every rule, but Alertmanager
    sits behind a profile that only switches on once
    infra/monitoring/alertmanager.yml has real receivers instead of
    [PLACEHOLDER]s. Until then nothing wakes anybody up — including the backup
    dead-man switch and the disk-full alerts. §7.3.

  PUT THE ORIGIN CERTIFICATE EXPIRY IN YOUR CALENDAR.
    Nothing monitors it. An expired origin certificate is a fully green deploy
    and a Cloudflare 526 on every host.

  THE ADMIN PANEL NEEDS A BROWSER, AND MFA IS MANDATORY.
    You cannot enrol MFA from this shell. §3.9 explains why the /etc/hosts
    workaround walks into an untrusted Origin CA and a non-bypassable HSTS pin.

  THE QUARTERLY RESTORE DRILL (§8.5) HAS NEVER BEEN DONE.
    An untested restore is a hypothesis. Book it.

  KNOWN, AND NOT FIXED BY ANY OF THIS:
    * every file upload returns HTTP 500 in the launch configuration
      (data-integrity-01)
    * due-soon, overdue and hold-ready notifications have never been sent, and
      the worker reports ok:true while it happens (reliability-01)
    * EMAIL_DRIVER=console — nothing is delivered. Account recovery is done by
      an owner admin from /admin/account-recovery (§4.3a), not by email.

  Transcript of this run: ${INSTALL_LOG}
  Re-run any step:        $SELF --status   then   $SELF --only <step>

EOF

  # ── THE PROMISES THIS RUN LEFT OUTSTANDING ────────────────────────────────
  # step_backup tells the operator that an acknowledged local-only host "is in
  # the closing summary for a reason". It has to actually BE here, and it has
  # to be read off the machine rather than remembered, because the operator may
  # have answered these prompts on a previous run.
  local _lo _rc _pt
  _lo="$(env_get "$ENV_FILE" BACKUP_ALLOW_LOCAL_ONLY 2>/dev/null || true)"
  _rc="$(env_get "$ENV_FILE" RCLONE_REMOTE 2>/dev/null || true)"
  _pt="$(env_get "$ENV_FILE" BACKUP_ALLOW_PLAINTEXT 2>/dev/null || true)"
  if [ ! -f "$CRON_FILE" ]; then
    banner "THERE IS NO NIGHTLY BACKUP ON THIS BOX"
    printf '  %s does not exist. "Daily backups and an off-server copy" is a\n' "$CRON_FILE"
    printf '  written term of the founding offer, and nothing else installs this.\n'
    printf '  Run it before you walk away:  %s --only backup\n\n' "$SELF"
  else
    if [ -z "$_rc" ] && [ "$_lo" = "1" ]; then
      banner "YOU STILL OWE AN OFF-SITE COPY"
      printf '  BACKUP_ALLOW_LOCAL_ONLY=1 is set, so the nightly no longer complains — but\n'
      printf '  every backup on this box dies with this box. Set RCLONE_REMOTE and clear\n'
      printf '  that acknowledgement once the remote exists.\n\n'
    elif [ -z "$_rc" ]; then
      warn "RCLONE_REMOTE is unset and BACKUP_ALLOW_LOCAL_ONLY is not set either: every"
      warn "nightly run will exit non-zero and report degraded. That is the intended"
      warn "signal until an off-site remote exists, not a fault."
    fi
    if [ "$_pt" = "1" ]; then
      banner "BACKUPS ARE UNENCRYPTED, AND THE DPA SAYS THEY ARE NOT"
      printf '  BACKUP_ALLOW_PLAINTEXT=1. A pg_dumpall here is the complete member registry\n'
      printf '  of every library on this host, and the Art. 28 DPA a municipality signs\n'
      printf '  promises "encrypted backups". Fix it before a real library'"'"'s data lands:\n'
      printf '  set BACKUP_AGE_RECIPIENT (identity kept OFF this host) and re-run:\n'
      printf '    %s --only backup\n\n' "$SELF"
    fi
  fi
  if ! systemctl is-enabled libriant-origin-firewall >/dev/null 2>&1; then
    banner "THE ORIGIN LOCKDOWN IS NOT INSTALLED AS A BOOT UNIT"
    printf '  authn-authz-01: every rate limit, the /apply throttle and the brute-force\n'
    printf '  login lockout are keyed on a header anyone who can reach this origin can\n'
    printf '  forge. Run:  %s --only firewall\n\n' "$SELF"
  fi
}

# ════════════════════════════════════════════════════════════════════════════
# ARGUMENT PARSING AND DRIVER
# ════════════════════════════════════════════════════════════════════════════

# The whole leading comment block, however long it grows. A fixed line range
# silently truncates the help the day someone adds a paragraph.
usage() { awk 'NR==1{next} /^#/{sub(/^# ?/,""); print; next} {exit}' "$SELF"; }

# ${BASH_SOURCE[0]:-$0}, not the bare form: `set -u` makes that an error when
# this file is sourced by a test harness rather than executed.
SELF="${BASH_SOURCE[0]:-$0}"
case "$SELF" in /*) ;; *) SELF="$PWD/$SELF" ;; esac
HOST_TZ=""

main() {
  local want_self_test=0

  while [ $# -gt 0 ]; do
    case "$1" in
      # `[ $# -ge 2 ] ||` on each of these: without it a trailing `--only` dies
      # with "$2: unbound variable" under set -u, which tells the operator
      # nothing about what they mistyped.
      --dry-run) DRY=1; shift ;;
      --force) FORCE=1; shift ;;
      --status) WANT_STATUS=1; shift ;;
      --verify-only) VERIFY_ONLY=1; shift ;;
      --from) [ $# -ge 2 ] || die "--from needs a step name (see --list-steps)"
        FROM_STEP="$2"; shift 2 ;;
      --only) [ $# -ge 2 ] || die "--only needs a step name (see --list-steps)"
        ONLY_STEPS="$(printf '%s' "$2" | tr ',' ' ')"; shift 2 ;;
      --skip) [ $# -ge 2 ] || die "--skip needs a step name (see --list-steps)"
        SKIP_STEPS="$(printf '%s' "$2" | tr ',' ' ')"; shift 2 ;;
      --repo) [ $# -ge 2 ] || die "--repo needs a git URL"
        REPO_URL="$2"; shift 2 ;;
      --origin-crt) [ $# -ge 2 ] || die "--origin-crt needs a file"
        ORIGIN_CRT_SRC="$2"; shift 2 ;;
      --origin-key) [ $# -ge 2 ] || die "--origin-key needs a file"
        ORIGIN_KEY_SRC="$2"; shift 2 ;;
      --replace-origin-cert) REPLACE_CERT=1; shift ;;
      --self-test) want_self_test=1; shift ;;
      --list-steps) printf '%s\n' $STEPS; exit 0 ;;
      -h|--help) usage; exit 0 ;;
      *) die "unknown option: $1   (--help for the list)" ;;
    esac
  done

  # --self-test comes before every gate: it needs no root, no network and no
  # terminal, and it writes only into one temp directory.
  if [ "$want_self_test" = 1 ]; then
    trap cleanup_tmp EXIT
    self_test || die "SELF-TEST FAILURES — do not run this script against a server."
    exit 0
  fi

  # A typo in --from/--only/--skip must not read as "nothing to do".
  local s
  for s in $FROM_STEP $ONLY_STEPS $SKIP_STEPS; do
    valid_step "$s" || die "unknown step '$s'.
     Valid steps: $STEPS"
  done

  # --status before the root gate: it is entirely read-only, and "what is the
  # state of this box" is a question worth being able to ask without sudo. It
  # says so itself when it cannot see the privileged answers.
  if [ "$WANT_STATUS" = 1 ] && [ "$(id -u)" != "0" ]; then show_status; exit 0; fi

  [ "$(id -u)" = "0" ] || die "run this as root:  sudo bash $SELF
     It installs packages, edits the sshd configuration and creates a user.
     Every step that belongs to the deploy user is dropped to that user
     explicitly, so nothing here runs as root that should not.

     Two things you CAN do without root:
       bash $SELF --status      what is done and what is not (the privileged
                                answers — ufw, sshd, passwd — read as unknown)
       bash $SELF --self-test   exercise this script's own parsers and guards"

  # If the account already exists, believe passwd about where its home is
  # rather than the constant at the top of this file. A box provisioned by hand,
  # or from a provider image, may not put it under /home.
  if id "$DEPLOY_USER" >/dev/null 2>&1; then
    local h
    h="$(getent passwd "$DEPLOY_USER" | cut -d: -f6 || true)"
    if [ -n "${h:-}" ] && [ "$h" != "$DEPLOY_HOME" ]; then
      DEPLOY_HOME="$h"
      DEPLOY_KEY="${DEPLOY_HOME}/.ssh/${DEPLOY_KEY_NAME}"
    fi
  fi

  if [ "$WANT_STATUS" = 1 ]; then show_status; exit 0; fi

  # --verify-only asks no questions, so it is deliberately exempt: it is the one
  # mode you want usable from a checklist script or a cron job.
  if [ "$DRY" = 0 ] && [ "$VERIFY_ONLY" = 0 ] && [ ! -t 0 ] && ! tty_usable; then
    # Same two sources, same order, same test as prompt_src().
    die "no terminal. This installer PROMPTS for the things only a human can supply
     — the deploy user's sudo password, the GitHub deploy-key pause, the two
     ADMIN_BOOTSTRAP_* values, the origin certificate, the backup encryption
     decision. §3.7a is explicit that the first run must not be non-interactive.
     Run it from an interactive session, or use --dry-run."
  fi

  trap on_exit EXIT
  # 0700: this directory holds the install transcript (every SSH, firewall and
  # data-volume decision this run made) and, under sshd-backups/, verbatim
  # copies of the sshd configuration as it was found. Neither belongs to
  # anybody but root. --status run unprivileged then reads every step as
  # pending, which it already says it does.
  [ "$DRY" = 1 ] || install -d -m 0700 -o root -g root "$STATE_DIR" 2>/dev/null || true
  _logline "=== install-server.sh started by $(id -un) on $(hostname) (args: ${ONLY_STEPS:-}${FROM_STEP:-}${SKIP_STEPS:-}) ==="

  HOST_TZ="$(timedatectl show -p Timezone --value 2>/dev/null || cat /etc/timezone 2>/dev/null || echo unknown)"

  # ── The state of this box, before anything is touched. Re-running this
  #    installer is expected; knowing what is already true is how you read the
  #    rest of the transcript.
  printf '\n%sLibriant installer%s — docs/RUNBOOK.md §3, §6.1, §8.2, on %s as %s\n' \
    "$C_B" "$C_0" "$(hostname)" "$(id -un)"
  [ "$DRY" = 1 ] && printf '%sDRY RUN — nothing will be changed.%s\n' "$C_Y" "$C_0"
  printf '\n  This box, right now:\n'
  printf '    ubuntu           %s\n' "$( . /etc/os-release 2>/dev/null; echo "${VERSION_ID:-?} ${VERSION_CODENAME:-?}")"
  printf '    timezone         %s\n' "$HOST_TZ"
  printf '    ufw              %s\n' "$(ufw status 2>/dev/null | head -1 || echo 'not installed')"
  printf '    sshd passwords   %s\n' "$(sshd -T 2>/dev/null | sshd_values passwordauthentication || echo '?')"
  printf '    docker           %s\n' "$(docker --version 2>/dev/null || echo 'not installed')"
  printf '    deploy user      %s\n' "$(id "$DEPLOY_USER" >/dev/null 2>&1 && echo present || echo absent)"
  printf '    checkout         %s\n' "$([ -d "${APP_DIR}/.git" ] && echo "$APP_DIR" || echo absent)"
  printf '    .env.prod        %s\n' "$([ -f "$ENV_FILE" ] && echo present || echo absent)"
  printf '    origin cert      %s\n' "$([ -f "${DATA_ROOT}/caddy/origin/origin.crt" ] && echo present || echo absent)"
  printf '    backup cron      %s\n' "$([ -f "$CRON_FILE" ] && echo present || echo absent)"
  printf '\n'

  # --verify-only: the read-only picture, nothing else. Every part runs even if
  # an earlier one has findings, because the value of a status pass is the
  # complete picture — dying on the first problem is how you learn about one
  # problem and ship the other two.
  if [ "$VERIFY_ONLY" = 1 ]; then
    step_verify || true
    firewall_status_only
    backup_status_only
    printf '\n'
    if [ "$VERIFY_RC" = 0 ]; then ok "verification clean"; exit 0; fi
    warn "${VERIFY_RC} problem(s) — see above"
    exit 1
  fi

  local reached=0
  [ -n "$FROM_STEP" ] || reached=1
  local n=0 total
  total="$(printf '%s\n' $STEPS | wc -w | tr -d ' ')"

  for s in $STEPS; do
    n=$((n + 1))
    [ "$s" = "$FROM_STEP" ] && reached=1
    [ "$reached" = 1 ] || continue

    if [ -n "$ONLY_STEPS" ]; then
      local want=0 x
      for x in $ONLY_STEPS; do [ "$x" = "$s" ] && want=1; done
      [ "$want" = 1 ] || continue
    else
      local skip=0
      for x in $SKIP_STEPS; do [ "$x" = "$s" ] && skip=1; done
      if [ "$skip" = 1 ]; then note "skipping step '$s' (--skip)"; continue; fi
    fi

    # `satisfied` inspects the MACHINE, not a marker — a marker only records
    # what a previous run BELIEVED, and the whole point of resuming is that it
    # may have been wrong. --only and --force both override it, because
    # "re-run this even though it looks done" is a thing you sometimes need.
    if [ "$FORCE" = 0 ] && [ -z "$ONLY_STEPS" ] && satisfied "$s" 2>/dev/null; then
      printf '\n%s▸ [%s/%s] %s%s\n' "$C_B" "$n" "$total" "$(step_title "$s")" "$C_0"
      ok "already satisfied — skipping (--force to run it anyway)"
      continue
    fi

    if [ "$DRY" = 1 ]; then
      printf '\n%s▸ [%s/%s] %s%s\n' "$C_B" "$n" "$total" "$(step_title "$s")" "$C_0"
    fi

    # A step that returns non-zero stops the run with its name attached. Steps
    # that merely REPORT a problem say so and return 0 on purpose; a non-zero
    # return here means the step could not do its job.
    # CURRENT_STEP so the EXIT trap can name it. That matters because `die`
    # (and `run`, which now dies) exits DIRECTLY, so the `|| die` below never
    # runs on the commonest failure path.
    CURRENT_STEP="$s"
    "step_${s}" || die "step '$s' did not complete. Nothing after it has run."
    CURRENT_STEP=""
  done

  RUN_FINISHED=1
  closing_summary
  [ "$VERIFY_RC" = 0 ] || exit 1
  exit 0
}

# Sourced by a test harness? Define everything, run nothing. This is how the
# helpers above get driven on a machine that is not an Ubuntu server.
if [ "${LIBRIANT_INSTALL_SOURCE_ONLY:-0}" != "1" ]; then
  main "$@"
fi
