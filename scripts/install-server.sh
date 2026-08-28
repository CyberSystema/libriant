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
#   8. The name this box should have, or a decision to keep the provider's.
#      Offered in `stock`, defaulting to no change. Nothing here READS it; it
#      is WRITTEN into every backup manifest and into the GitHub Deploy Key's
#      comment, and that key is never regenerated.
#
# Every question this script asks is asked in the first fifteen minutes, before
# the build. That is deliberate: the briefing tells you the build is 10–20
# minutes and to use tmux, so walking away is the reasonable thing to do. The
# only prompt after it is "run the backup once now", which needs the stack up.
#
# ── THE THREE WAYS THIS SCRIPT COULD RUIN YOUR DAY, AND WHAT STOPS IT ──────
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
#    The same check now also asks the second question, which it used to skip:
#    is the volume mounted FOR EVER? A volume mounted by hand — the obvious
#    response to that BOOTDISK refusal — used to pass every check here and be
#    gone at the next reboot, and the reboot you do not schedule is the one
#    during an incident. It offers the /etc/fstab line, derived from the live
#    mount, and validates the result with `findmnt --verify` before trusting it.
#
# 3. LEAVING WITH A CLOCK NOBODY IS DISCIPLINING. Admin MFA is MANDATORY in
#    production and cannot be turned off from .env.prod. TOTP is a function of
#    the wall clock: the acceptance window is ~90 seconds, and a recovery code
#    can only be minted AFTER a TOTP code has already verified — the shell
#    escape hatch (bootstrap-admin.ts --issue-recovery-codes) refuses outright
#    for an admin with no authenticator enrolled. So there is no path to a
#    recovery code that does not first pass a clock check, and a box a minute
#    off has an admin panel nobody can ever enter. The symptom is "invalid
#    code", which reads as a bad QR or a bad phone, and it is discovered after
#    the cutover. Three cheaper failures arrive first and are all mis-attributed:
#    apt calls every Release file "not valid yet", TLS fails to
#    download.docker.com and ghcr.io, and `openssl x509 -checkend 0` calls a
#    perfectly good origin certificate expired. The `clock` step proves NTP is
#    on AND that the kernel calls the clock synchronised, waits for a fresh box
#    to converge rather than refusing it, and checks the one thing that needs no
#    network at all: that `date` does not read earlier than the mtime of a file
#    this box wrote.
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
# ── CONSIDERED AND REJECTED ─────────────────────────────────────────────────
#
# "Everything must be included" means everything the SERVER NEEDS. A step that
# exists to look thorough, that an operator will not understand, or that could
# break a working box makes this script worse. Each of these was examined
# against THIS stack on THIS box and left out; the third column is what would
# change the answer, so nobody has to re-open them from scratch.
#
#   vm.overcommit_memory     Redis is the usual reason to set it. Ours is a
#                            320 MB-capped cache with a measured ~1.4 MB heap
#                            and no persistence; the fork it protects never
#                            happens. Revisit if Redis gains an RDB/AOF.
#   THP (transparent hugep.) The Postgres advice is about huge shared_buffers.
#                            This cluster is small and containerised, and the
#                            knob is host-wide. Revisit at a multi-GB
#                            shared_buffers.
#   net.core.somaxconn       The kernel default is already 4096, which is above
#                            anything Caddy or the API backlog asks for. Setting
#                            it would change nothing and imply it had.
#   vm.swappiness            BACKWARDS here. Under cgroup v2 every service has a
#                            mem_limit and none has a memswap_limit, so Docker
#                            caps swap at 2x the limit; lowering swappiness makes
#                            "Postgres pages out" into "Postgres is OOM-killed".
#   fs.file-max / port range Defaults on a 62 GiB box are orders of magnitude
#                            above a nine-container stack behind one edge.
#   Docker default-ulimits   docker.service ships LimitNOFILE=infinity, so the
#                            containers do not inherit 1024. Worth a look only
#                            if `ulimit -Sn` inside redis ever comes back 1024.
#   locale-gen               Postgres is initdb'd with --locale-provider=icu
#                            --icu-locale=el-GR; the collation Greek sorting
#                            depends on comes from ICU inside the image, not
#                            from the host's locale archive.
#   logrotate for containers docker-compose.prod.yml's *logging anchor already
#                            sets json-file 50m x 5 on all nine services, the
#                            monitoring overlay 20m x 5 on its five, and Caddy's
#                            access log self-rolls at 100mb x 14 — a ~2.65 GB
#                            ceiling against an 80 GiB root. /etc/docker/
#                            daemon.json carries the same numbers for anything
#                            added later WITHOUT the anchor.
#   logrotate for backup.log The nightly appends a handful of lines to
#                            /var/log/libriant/backup.log. Even an abort every
#                            night is kilobytes a year against an 80 GiB root;
#                            already examined and rejected as reliability-22 in
#                            docs/audit/pre-release-2026-08-23/REJECTED.md. Real
#                            disk pressure comes from BACKUP_ROOT, which
#                            step_backup DOES project (retention_verdict).
#   a DNS / egress probe     apt already names it: a broken resolver produces
#                            "Temporary failure resolving 'archive.ubuntu.com'",
#                            which is the diagnosis. A probe here would restate
#                            an error the operator can already read.
#   disabling IPv6           The box has public IPv6 and the design uses it:
#                            ufw carries v6 rules and the origin lockdown is
#                            explicitly v4 AND v6. Turning it off would break
#                            the thing it was meant to protect.
#   sshd MaxAuthTries etc.   Password authentication is OFF. Tuning the number
#                            of password attempts against a box that accepts
#                            none is theatre; fail2ban is installed for the rest.
#   a swapfile               The measured box has 8 GiB of LVM swap. Creating one
#                            on a box that has swap is a no-op with a footgun,
#                            and on a box that does not, `assert_build_memory`
#                            says so and names the remedy rather than silently
#                            re-partitioning someone's disk.
#   kernel.panic / watchdog  A reboot loop on a box whose data volume may not be
#                            in fstab is a worse failure than the hang it fixes.
#   mkfs, ever               A device that "looks like an empty volume waiting to
#                            be formatted" is indistinguishable from a data
#                            volume whose superblock nobody has looked at. This
#                            script will never print an mkfs command.
#   rebooting                It PRINTS a reboot rehearsal (only once the data
#                            volume is proven persistent) and never performs one.
#                            This installer can be re-run against a live box,
#                            where an unprompted reboot is an outage and a
#                            prompt answerable `y` by reflex is worse.
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
# /etc/fstab, for the same reason: the mount-persistence guard WRITES to it, and
# a guard that writes to the real /etc/fstab cannot be driven anywhere but a
# server. Nothing but the tests ever overrides it.
FSTAB="${LIBRIANT_FSTAB:-/etc/fstab}"
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
# `clock` sits between `stock` and `ssh` because of what depends on it. A skewed
# clock breaks apt (`packages`), breaks TLS to download.docker.com and ghcr.io
# (`docker`, `deploy`), makes `openssl x509 -checkend 0` call a good origin
# certificate expired (`cert`), and — the one with no shell workaround — makes
# admin TOTP unenrollable for ever (see the block above td_get). It is read-only
# on a healthy box, it costs one line of output, and everything after it assumes
# the answer.
STEPS="briefing stock clock ssh ufw packages docker user dirs checkout env cert dchelper deploy backup firewall verify"

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
# / updated (the block was replaced) / unchanged / unterminated / unwritable.
# Used for the deploy user's ~/.ssh/config, the `dc` helper in ~/.bashrc and —
# the reason the write below is ATOMIC — /etc/fstab. Files a human may have
# edited, none of which may be clobbered by a re-run. A second copy of the block
# is collapsed into one. An UNTERMINATED block (BEGIN with no END) is REFUSED
# rather than swallowing the rest of the file.
#
# THE WRITE IS mktemp + mv -f, NOT `> "$file"`. Truncate-then-rewrite was driven
# against an interrupted write (ENOSPC, SIGKILL, an SSH drop — this script's own
# header anticipates all three) and left the file at ZERO BYTES. In-process that
# is caught and the backup is restored; a KILLED process runs no restore, and for
# /etc/fstab an empty file means /boot, /boot/efi, swap and the data volume do
# not mount at the next boot — the exact state the caller exists to prevent,
# caused by the caller. `>` did have one virtue, preserving the inode and with it
# the mode and owner, so both are carried onto the replacement explicitly.
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
  local tmp
  tmp="$(mktemp "${file}.libriant-new.XXXXXX" 2>/dev/null)" || { printf 'unwritable\n'; return 1; }
  # Mode and owner BEFORE the content, so a failure between the two leaves a
  # temp file nobody else could read rather than a world-readable one.
  chmod "$(stat_mode "$file")" "$tmp" 2>/dev/null || true
  chown "$(stat_owner "$file")" "$tmp" 2>/dev/null || true
  if ! printf '%s' "$out" > "$tmp"; then
    rm -f "$tmp"; printf 'unwritable\n'; return 1
  fi
  mv -f "$tmp" "$file" || { rm -f "$tmp"; printf 'unwritable\n'; return 1; }
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

# ── The clock, which on this box is an AUTHENTICATION INPUT ─────────────────
#
# Admin MFA is mandatory in production (apps/api/src/config/env.ts:420,
# `adminMfaRequired: bool('ADMIN_MFA_REQUIRED', !isDev)`) and the installer
# already tells the operator it "cannot be turned off from .env.prod". TOTP is
# a function of the wall clock: apps/api/src/support/mfa.service.ts:89 verifies
# with `epochTolerance: 30`, a ~90-second total acceptance window.
#
# Recovery codes exist, and they do NOT rescue a skewed box. They are minted at
# exactly one moment — apps/api/src/support/mfa.controller.ts:227, immediately
# after a TOTP code has verified — and the shell escape hatch refuses to help
# before that: scripts/bootstrap-admin.ts:214 exits 1 with "has no authenticator
# enrolled, so a recovery code would never be accepted at sign-in". So the ONLY
# path to a recovery code runs through a TOTP check first. A box more than a
# minute off has an admin panel nobody can ever enter, and the symptom is
# "invalid code", which reads as a bad QR or a bad phone.
#
# Three cheaper failures arrive first, all of them mis-attributed:
#   clock behind  ->  every apt source is "not valid yet" and `step_packages`
#                     dies on empty package lists
#   clock off by months -> TLS fails on download.docker.com and the ghcr.io
#                     pulls, with errors that name the repository
#   clock ahead   ->  `openssl x509 -checkend 0` in `step_cert` calls a
#                     perfectly good Cloudflare Origin certificate EXPIRED
#
# td_get KEY — one Key=Value off `timedatectl show` on stdin.
#
# THE TRAP THIS EXISTS FOR, stated correctly (an earlier comment here named the
# wrong pair, and the self-test was built to match the wrong claim, so it could
# not fail): the key that collides with `NTP` is **CanNTP**. "CanNTP=yes"
# CONTAINS the substring "NTP=", so `grep NTP=` and `case "$line" in *NTP=*)`
# both return CanNTP's value — and `timedatectl show` prints CanNTP BEFORE NTP,
# so the wrong one is hit first, every time. On a box with CanNTP=yes NTP=no
# that turns the FATAL "network time synchronisation is OFF: timedatectl set-ntp
# true" into a silent 90-second wait for a clock nothing is disciplining.
# ("NTPSynchronized=" is NOT a trap — it has an S where the "=" would be — but
# it is read by this same function and is driven below in both print orders.)
# The match here is anchored on "${k}=" at the START of the line, nowhere else.
td_get() {
  local k="${1:?}" line
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    case "$line" in
      "${k}="*) printf '%s\n' "${line#"${k}="}"; return 0 ;;
    esac
  done
  return 1
}

# clock_verdict NTP NTPSYNC CANNTP — one finding per line, "FATAL …" / "WARN …",
# EMPTY OUTPUT MEANS THE CLOCK IS DISCIPLINED AND HAS CONVERGED. Same shape as
# fw_verdict above and for the same reason: the decision is a pure function of
# three strings read off the machine, so it can be driven on a laptop.
#
# NTPSynchronized is the kernel's own bit (adjtimex STA_UNSYNC cleared by
# whatever is disciplining the clock), so it answers for chrony, ntpd and
# systemd-timesyncd alike. NTP is systemd's view of whether any unit in
# /usr/lib/systemd/ntp-units.d is enabled — chrony registers there too, which is
# why this does not care WHICH client is installed.
#
# The one deliberately soft case: synchronised but NTP=no. The kernel says the
# clock is being disciplined right now and systemd does not know who by. The
# property that matters holds, so that is a WARN. Anything else that leaves the
# clock undisciplined is FATAL, because of the admin lockout above.
clock_verdict() {
  local ntp="${1:-}" sync="${2:-}" can="${3:-}"
  if [ -z "$ntp" ] && [ -z "$sync" ] && [ -z "$can" ]; then
    printf 'WARN  timedatectl answered nothing about NTP — too old, or not systemd. Check the clock BY HAND before you enrol MFA.\n'
    return 0
  fi
  if [ "$can" = no ]; then
    printf 'FATAL no NTP client is installed (CanNTP=no). Nothing on this box will ever correct the clock, and admin TOTP has a ~90-second window.\n'
    return 0
  fi
  if [ "$sync" = yes ]; then
    [ "$ntp" = yes ] || printf 'WARN  the kernel reports the clock synchronised but systemd reports NTP=%s — something is disciplining it that systemd does not manage. Confirm it survives a reboot.\n' "${ntp:-unknown}"
    return 0
  fi
  [ "$ntp" = yes ] || printf 'FATAL network time synchronisation is OFF (NTP=%s): timedatectl set-ntp true\n' "${ntp:-unknown}"
  printf 'FATAL the clock is NOT synchronised (NTPSynchronized=%s). Admin TOTP has a ~90-second acceptance window and there is no recovery code until one TOTP code has passed.\n' "${sync:-unknown}"
  return 0
}

# ── /etc/fstab: is the data volume mounted, or is it mounted FOR EVER? ───────
#
# `mountpoint -q` answers "right now". The whole data-root architecture assumes
# the volume survives a provider Rebuild — which is worthless if it does not
# survive an ordinary reboot. A box hand-mounted to get the install moving (the
# obvious response to this script's own BOOTDISK refusal) passes every check
# here and loses the database at its first boot, with the SAME outcome the
# header describes: an empty /mnt/libriant on the root filesystem, a second
# Postgres cluster initdb'd on the boot disk, and a green stack.
#
# fstab_target_entry TARGET — the first non-comment /etc/fstab line (on stdin)
# whose MOUNTPOINT is TARGET, printed whole; rc 1 when there is none.
#
# A parser rather than `findmnt --fstab` because this one can be driven from
# --self-test with hostile fixtures and findmnt cannot. findmnt is still run
# beside it at the call site; the two are unioned, because the cost of missing
# an entry is a duplicate fstab line and the cost of inventing one is nothing.
fstab_target_entry() {
  local want="${1:?}" line src mp
  case "$want" in */) [ "$want" = / ] || want="${want%/}" ;; esac
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"                                   # CRLF from an editor
    line="${line#"${line%%[![:space:]]*}"}"                # leading whitespace
    case "$line" in ''|'#'*) continue ;; esac              # a DISABLED entry is not an entry
    set -f
    # shellcheck disable=SC2086
    set -- $line
    set +f
    [ "$#" -ge 2 ] || continue
    src="$1"; mp="$2"
    # fstab escapes a space in a path as \040. Unescape before comparing, or a
    # mountpoint with a space in it never matches itself.
    case "$mp" in *'\040'*) mp="$(printf '%s' "$mp" | sed 's/\\040/ /g')" ;; esac
    case "$mp" in */) [ "$mp" = / ] || mp="${mp%/}" ;; esac
    [ "$mp" = "$want" ] || continue
    printf '%s\n' "$line"
    return 0
  done
  return 1
}

# fstab_persistence_verdict LINE — none / nofail / ok, from a whole fstab line.
#
# `nofail` is deliberately NOT an error here, and this installer writes it: a
# fstab line that fails at boot WITHOUT nofail drops the box into emergency mode
# with no sshd, which on a remote machine means the provider console. With it
# the box boots, SSH works, and the containers fail to start because the compose
# overlay's bind devices do not exist — the "safe failure" that overlay was
# designed around (infra/compose/docker-compose.volume.yml:10-12). The verdict
# is reported so the operator knows which trade they are on, not so they fix it.
fstab_persistence_verdict() {
  local line="${1:-}" opts
  [ -n "$line" ] || { printf 'none\n'; return 0; }
  set -f
  # shellcheck disable=SC2086
  set -- $line
  set +f
  opts="${4:-defaults}"
  case ",${opts}," in *,nofail,*) printf 'nofail\n'; return 0 ;; esac
  printf 'ok\n'
}

# fstab_fsck_pass FSTYPE — the 6th fstab field. 2 for the ext family (fsck it
# after the root filesystem), 0 for everything else. xfs and btrfs check
# themselves and a non-zero pass makes systemd-fsck complain on every boot.
fstab_fsck_pass() {
  case "${1:-}" in ext2|ext3|ext4) printf '2\n' ;; *) printf '0\n' ;; esac
}

# ── Numbers read off the machine, parsed where a typo is silent ─────────────
#
# df_avail_kib — the Available column from `df -Pk <path>` on stdin; rc 1 when
# there is no data row.
#
# `-P` (POSIX, one row per filesystem) and not plain `df`: a long device name
# wraps in the default output, awk's field 4 becomes field 3 of a continuation
# line, and the check silently reads the wrong number. rc 1 rather than an empty
# string, so a caller cannot print "only  GiB free" — a check that did not run
# must not look like a number that happens to be missing.
df_avail_kib() {
  local line n=0 v
  while IFS= read -r line || [ -n "$line" ]; do
    n=$((n + 1))
    [ "$n" = 1 ] && continue
    set -f
    # shellcheck disable=SC2086
    set -- $line
    set +f
    [ "$#" -ge 4 ] || continue
    v="$4"
    case "$v" in ''|*[!0-9]*) continue ;; esac
    printf '%s\n' "$v"
    return 0
  done
  return 1
}

# meminfo_mb KEY — one /proc/meminfo value (on stdin), in MiB; rc 1 if absent.
# /proc/meminfo, not `free`: `free`'s columns are localised and have been
# renumbered between releases, and this is read to decide whether a 20-minute
# build is about to be OOM-killed. Anchored on "KEY:" so `Mem` cannot match
# `MemTotal` and `SwapTotal` cannot be answered by `SwapCached`.
meminfo_mb() {
  local k="${1:?}" line v
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in "${k}:"*) : ;; *) continue ;; esac
    set -f
    # shellcheck disable=SC2086
    set -- $line
    set +f
    v="${2:-}"
    case "$v" in ''|*[!0-9]*) return 1 ;; esac
    printf '%s\n' $(( v / 1024 ))
    return 0
  done
  return 1
}

# mem_verdict MEM_MB SWAP_MB — findings, one per line; empty means fine.
#
# `next build` is the memory-hungry step and deploy-on-host.sh:273 already
# carries the remedy in a comment nobody reads mid-failure ("If it is OOM-killed
# (exit 137), give the box swap or build one service at a time"). §1 records
# 62 GiB + 8 GiB of LVM swap on the measured box, where this prints one ok line
# — but this script is deliberately box-agnostic, the compose defaults are
# documented as suiting a ~4 GB host, and a provider Rebuild that re-partitions
# can leave vg0-swap out of the new fstab entirely. 6 GiB total is the threshold
# because the build peaks around 1.8 GB with no heap cap and scales its workers
# by core count.
mem_verdict() {
  local mem="${1:-}" swap="${2:-}"
  # Guarded SEPARATELY, and not as "${mem}${swap}". Concatenated, an EMPTY first
  # argument is invisible — "" + "8191" is all digits — so `mem_verdict "" 8191`
  # sailed through and the caller printed `ok " MiB RAM + 8191 MiB swap — enough
  # for a cold next build`: a green line for a check that did not run, which is
  # the exact thing df_avail_kib's own comment forbids two functions up.
  case "$mem"  in ''|*[!0-9]*) mem="" ;; esac
  case "$swap" in ''|*[!0-9]*) swap="" ;; esac
  if [ -z "$mem" ] || [ -z "$swap" ]; then
    printf 'WARN  could not read MemTotal/SwapTotal from /proc/meminfo — the OOM check did not run.\n'
    return 0
  fi
  [ $(( mem + swap )) -lt 6144 ] && printf 'WARN  only %s MiB of RAM + %s MiB of swap. A cold `next build` peaks around 1.8 GB per worker and is OOM-killed with a bare exit 137. Build one service at a time instead: dc build web, then dc build api.\n' "$mem" "$swap"
  [ "$swap" = 0 ] && printf 'NOTE  there is no swap on this box. Every service has a mem_limit and none has a memswap_limit, so Docker caps swap at 2x the memory limit — with no swap device that turns "Postgres pages out under pressure" into "Postgres is OOM-killed". The HostSwapping alert is guarded by node_memory_SwapTotal_bytes > 0 and can never fire here.\n'
  return 0
}

# retention_verdict DAY_KIB KEEP_DAYS AVAIL_KIB — "fits|tight|over PROJ AVAIL".
#
# backup.sh writes a FULL tar of the uploads tree plus a full pg_dumpall every
# night into ${DATA_ROOT}/backups — the same filesystem as the live cluster, the
# live uploads and Redis — and prunes at the START of a run, so peak occupancy
# is BACKUP_KEEP_DAYS+1 day-directories. Nothing anywhere multiplies those two
# numbers together. This is the one moment in the product's life when the
# day-size, the retention constant and the free space are all in one process.
#
# "tight" at 70% and not at 100% because the two things it shares a filesystem
# with both grow underneath it. RUNBOOK §9.5 on the outcome: "A full data disk
# means Postgres refuses writes: circulation stops. Treat it as a full outage."
retention_verdict() {
  local day="${1:-}" keep="${2:-}" avail="${3:-}" proj
  # Three separate guards, not one concatenation. `retention_verdict 2097152 15
  # ""` used to read as all-digits, reach `[ "$proj" -ge "" ]`, print "integer
  # expression expected" to stderr, fall through to the elif — where an empty
  # avail arithmetically becomes 0 — and report `tight … against 0 GiB free` on a
  # volume nobody measured. `retention_verdict "" 15 262144000` reported `fits`
  # for a day size that was never read.
  case "$day"   in ''|*[!0-9]*) printf 'unknown 0 0\n'; return 1 ;; esac
  case "$keep"  in ''|*[!0-9]*) printf 'unknown 0 0\n'; return 1 ;; esac
  case "$avail" in ''|*[!0-9]*) printf 'unknown 0 0\n'; return 1 ;; esac
  proj=$(( day * keep ))
  if   [ "$proj" -ge "$avail" ];               then printf 'over %s %s\n'  "$proj" "$avail"
  elif [ $(( proj * 10 )) -ge $(( avail * 7 )) ]; then printf 'tight %s %s\n' "$proj" "$avail"
  else printf 'fits %s %s\n' "$proj" "$avail"; fi
  return 0
}

# hostname_label_ok NAME — a syntactically valid host name.
#
# Interpolated into `hostnamectl set-hostname` and into an /etc/hosts line, so
# anything outside [A-Za-z0-9.-] is refused rather than quoted around. The
# leading/trailing and empty-label rules are RFC 1123's; a name ending in '-'
# is accepted by hostnamectl on some releases and then breaks resolution.
# 64, not DNS's 253: `hostnamectl set-hostname` goes through sethostname(2), and
# Linux's HOST_NAME_MAX is 64. A 127-character name passed a 253 cap here and
# then died at `run hostnamectl set-hostname` with a bare "command failed" —
# after the validator had said yes, which is the worst place to find out.
hostname_label_ok() {
  local n="${1:-}"
  [ -n "$n" ] || return 1
  [ "${#n}" -le 64 ] || return 1
  case "$n" in
    *[!A-Za-z0-9.-]*) return 1 ;;
    -*|*-|.*|*.)      return 1 ;;
    *..*)             return 1 ;;
  esac
  local part rest="$n"
  while [ -n "$rest" ]; do
    part="${rest%%.*}"
    case "$rest" in *.*) rest="${rest#*.}" ;; *) rest="" ;; esac
    [ -n "$part" ] || return 1
    [ "${#part}" -le 63 ] || return 1
    case "$part" in -*|*-) return 1 ;; esac
  done
  return 0
}

# fstab_line_for SOURCE TARGET FSTYPE — the /etc/fstab line this installer
# OFFERS for a data volume that is mounted but not persistent.
#
# `nofail` is a DELIBERATE choice and the trade deserves stating once, here,
# rather than being discovered at 3am. WITHOUT it a mount that fails at boot
# fails local-fs.target and drops the box into emergency mode — no sshd, which
# on a remote machine means the provider's console. WITH it the box boots, SSH
# works, and the STACK refuses to start: the compose overlay binds
# ${DATA_ROOT}/postgres and friends BY PATH, and a bind to a path that does not
# exist is a hard mount failure, which is the "safe failure (no silently-fresh
# database on the boot disk)" that file's own header claims
# (infra/compose/docker-compose.volume.yml:9-12). Loud, recoverable, remote.
#
# `x-systemd.device-timeout=30` bounds the wait for a device that never comes
# back; the default is 90 seconds per device, spent before any login prompt.
# The markers around the line this installer writes into /etc/fstab. KEYED ON
# THE MOUNTPOINT, not just "Libriant": upsert_block REPLACES the block it finds,
# so a run with a different $LIBRIANT_DATA_ROOT would otherwise silently delete
# the previous mountpoint's line while appearing to add its own.
fstab_block_begin() { printf '# --- Libriant data volume BEGIN (installer): %s ---\n' "$DATA_ROOT"; }
fstab_block_end()   { printf '# --- Libriant data volume END: %s ---\n' "$DATA_ROOT"; }

fstab_line_for() {
  local src="${1:?}" target="${2:?}" fstype="${3:-auto}"
  # fstab writes a space in a path as \040. Nothing on this box has one today;
  # the day something does, an unescaped line is a boot failure.
  target="${target// /\\040}"
  [ -n "$fstype" ] || fstype=auto
  printf '%s  %s  %s  defaults,nofail,x-systemd.device-timeout=30  0  %s\n' \
    "$src" "$target" "$fstype" "$(fstab_fsck_pass "$fstype")"
}

# build_headroom_verdict AVAIL_KIB — "ok <GiB>" / "low <GiB>" / "unknown 0".
#
# §3.8 step 6 budgets ~15-20 GiB in /var/lib/docker for a cold build and the
# runbook marks that figure UNVERIFIED ON THIS BOX (it was measured on the dead
# machine), so 25 GiB is a margin over a guess and the callers say so. rc 1 and
# the word "unknown" rather than an empty string, because "only  GiB free"
# reads as a number that happens to be missing rather than a check that did not
# run.
build_headroom_verdict() {
  local kib="${1:-}" gib
  case "$kib" in ''|*[!0-9]*) printf 'unknown 0\n'; return 1 ;; esac
  gib=$(( kib / 1024 / 1024 ))
  if [ "$gib" -lt 25 ]; then printf 'low %s\n' "$gib"; else printf 'ok %s\n' "$gib"; fi
  return 0
}

# clock_sanity_verdict NOW_EPOCH NEWEST_MTIME_EPOCH — the one clock check that
# needs NO network and no time server, and the only one available on a box whose
# apt and TLS are already broken BY the clock.
#
# A file cannot have been written in the future. If `date` reads earlier than
# the mtime of something this box itself wrote (/var/lib/dpkg/status is touched
# by every apt operation, so on a fresh install that is the install date), the
# clock is BEHIND, and that is not an opinion. It is also the case that breaks
# apt first: every Release file becomes "not valid yet" and step_packages dies
# on empty package lists.
#
# The ahead case is a guess, not a proof, so it is a WARN with a deliberately
# generous threshold — a real box CAN sit two years past its last dpkg write.
#
# THE BEHIND CASE HAS A THRESHOLD TOO, and it was added after this fired FATAL on
# a perfectly synchronised box. The caller used to include $SELF — this installer
# file — in "a file this box wrote". It is by definition the file the operator
# COPIED ONTO the box, and `scp -p`, `rsync -a`, `tar -x` and `curl -R` all
# preserve the laptop's mtime; a laptop one second ahead of a correct server then
# produced the SKEW prompt, which is the one acknowledgement in this script that
# must never become reflex. $SELF is gone from that list. The threshold is the
# second lock on the same door: NTP stepping the clock backwards mid-run is real,
# and a few seconds of it is not the failure this exists to catch. 300 seconds is
# comfortably below every consequence — apt's Valid-Until, TLS notBefore, and a
# TOTP window of ~90 seconds are all far past it by the time the difference
# against a file's mtime can even be measured.
CLOCK_BEHIND_FATAL_SECONDS=300
clock_sanity_verdict() {
  local now="${1:-}" mtime="${2:-}" d
  # Guarded SEPARATELY, not as "${now}${mtime}": concatenating them makes an
  # empty second argument invisible ("1000" + "" is all digits), and the very
  # next line then feeds an empty string to `[ -lt ]`. Found by the fixture
  # below, which is the "stat could not read that file" case.
  case "$now"   in ''|*[!0-9]*) return 0 ;; esac
  case "$mtime" in ''|*[!0-9]*) return 0 ;; esac
  if [ "$now" -lt "$mtime" ]; then
    d=$(( mtime - now ))
    if [ "$d" -lt "$CLOCK_BEHIND_FATAL_SECONDS" ]; then
      printf 'WARN  the clock reads %s seconds earlier than the mtime of a file this box wrote. Under %s seconds that is more likely a clock step mid-run than real skew, but check it.\n' "$d" "$CLOCK_BEHIND_FATAL_SECONDS"
      return 0
    fi
    printf 'FATAL the clock reads %s seconds EARLIER than the mtime of a file this box wrote. A file cannot be written in the future: this clock is wrong, and apt will call every Release file "not valid yet".\n' "$d"
    return 0
  fi
  d=$(( now - mtime ))
  [ "$d" -gt 63072000 ] && printf 'WARN  the clock is more than two years past the last package operation on this box. If that is not right, `openssl x509 -checkend 0` will call a perfectly good origin certificate expired.\n'
  return 0
}

# json_names_key KEY — does this JSON (on stdin) mention "KEY": at all?
#
# DELIBERATELY CRUDE, and the crudeness is the point. There is no jq in
# BASE_PACKAGES, and this is only ever used to REPORT what an existing
# /etc/docker/daemon.json already carries so the operator can merge by hand. It
# never decides to edit anything: a half-merged daemon.json stops dockerd from
# starting at all, which is a worse outcome than any setting it could fix.
json_names_key() {
  local k="${1:?}"
  grep -q "\"${k}\"[[:space:]]*:"
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

# /etc/docker/daemon.json, as a function so --self-test can read what would be
# written without a Docker daemon anywhere near it.
#
# WHY THIS FILE EXISTS AT ALL, given that it is NOT about log rotation:
#
#   ip6tables    step_firewall DIES on "ip6tables has no jump from DOCKER-USER",
#                and its own message punts the operator to "a docker daemon.json
#                question, not a Libriant one" — a file that, until now, this
#                installer never wrote. Docker Engine has defaulted this to true
#                since v28, so on a current docker-ce the honest answer to "what
#                breaks without it" is "probably nothing". What it buys is
#                DETERMINISM and the removal of a documented failure branch, and
#                it is written before the daemon's first start so no restart is
#                ever needed on a first install.
#
#   log-opts     NOT because the stack needs it. infra/compose/docker-compose.prod.yml:140
#                already sets json-file 50m x 5 on all nine services via the
#                *logging anchor, and the monitoring overlay sets 20m x 5 on its
#                five — a ~2.65 GB ceiling against an 80 GiB root, plus Caddy's
#                own 100mb x 14 self-rolling access log. The daemon default
#                cannot fill this disk from this stack. It is here so that a
#                service added later WITHOUT the anchor, and any ad-hoc
#                `docker run` an operator leaves detached, is bounded too. Same
#                numbers as the anchor on purpose: two different ceilings for
#                the same thing is a question nobody wants at 3am.
#
# `"ipv6": true` is deliberately ABSENT. It is a different setting from
# ip6tables, and the compose networks leave enable_ipv6 unset on purpose —
# infra/compose/docker-compose.prod.yml:817 explains that turning it on is one
# of four changes that must be made together, and the userland-proxy path it
# reopens is the bypass that defeated the first fix for authn-authz-01.
docker_daemon_json() {
  cat <<'EOF'
{
  "ip6tables": true,
  "log-driver": "json-file",
  "log-opts": {
    "max-size": "50m",
    "max-file": "5"
  }
}
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

  # ── THE WRITE IS ATOMIC, because one caller of this is /etc/fstab.
  #
  # `printf … > "$file"` truncates first. Driven under `ulimit -f 0` — which is
  # the same shape as ENOSPC, a SIGKILL, or the SSH drop this script's own header
  # anticipates — it left the file at ZERO BYTES. For /etc/fstab that means
  # /boot, /boot/efi, swap and the data volume do not mount at the next boot: the
  # exact state assert_data_root_persistent exists to prevent, caused by it.
  printf 'UUID=1 / ext4 defaults 0 1\nUUID=2 /home ext4 defaults 0 2\nUUID=3 /srv ext4 defaults 0 2\n' > "$d/fstab-atomic"
  chmod 644 "$d/fstab-atomic"
  local before_atomic; before_atomic="$(cat "$d/fstab-atomic")"
  local res_atomic
  res_atomic="$( ( ulimit -f 0 2>/dev/null; printf 'UUID=4 /mnt/libriant ext4 defaults,nofail 0 2\n' \
    | upsert_block "$d/fstab-atomic" "$B" "$E" ) 2>/dev/null || true )"
  t_eq "an interrupted write leaves the ORIGINAL file byte-for-byte" \
    "$before_atomic" "$(cat "$d/fstab-atomic")"
  t_eq "…and it is still three lines, not zero" "3" "$(wc -l < "$d/fstab-atomic" | tr -d ' ')"
  case "$res_atomic" in
    unwritable|'') T_PASS=$((T_PASS + 1)); printf '  ok   …and it reports a failure rather than success\n' ;;
    added|updated) T_FAIL=$((T_FAIL + 1)); printf '  FAIL …but it reported [%s], i.e. success\n' "$res_atomic" ;;
    *) T_PASS=$((T_PASS + 1)); printf '  ..   (ulimit -f 0 not enforced here; write reported [%s])\n' "$res_atomic" ;;
  esac
  # `>` had one virtue — it preserved the inode, and with it the mode and owner.
  # mktemp creates at 0600, so both are carried across explicitly or /etc/fstab
  # would silently become root-only-readable.
  printf 'UUID=1 / ext4 defaults 0 1\n' > "$d/fstab-mode"
  chmod 644 "$d/fstab-mode"
  t_eq "a real write succeeds" "added" \
    "$(printf 'UUID=4 /mnt/libriant ext4 defaults,nofail 0 2\n' | upsert_block "$d/fstab-mode" "$B" "$E")"
  t_eq "…and the mode survives the atomic replace" "644" "$(stat_mode "$d/fstab-mode")"
  t_true "…and the original line is still there" grep -qx 'UUID=1 / ext4 defaults 0 1' "$d/fstab-mode"
  t_true "…and so is the new one"                grep -q  '/mnt/libriant' "$d/fstab-mode"
  t_eq "…and no temp file was left beside it" "0" \
    "$(find "$d" -maxdepth 1 -name 'fstab-mode.libriant-new.*' 2>/dev/null | wc -l | tr -d ' ')"

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

  printf '\n== td_get — the CanNTP= / NTP= substring trap ==\n'
  # "CanNTP=yes" CONTAINS the substring "NTP=", so `grep NTP=` and
  # `case *NTP=*` return CanNTP's value — and `timedatectl show` prints CanNTP
  # FIRST. NTPSynchronized is read by the same function and is driven in both
  # print orders beside it.
  local TD1 TD2 TD3
  TD1='NTPSynchronized=no
NTP=yes
CanNTP=yes'
  TD2='NTP=yes
NTPSynchronized=no
Timezone=Europe/Berlin'
  # THE FIXTURE THAT CAN ACTUALLY FAIL. `timedatectl show` prints CanNTP BEFORE
  # NTP, and "CanNTP=yes" CONTAINS the substring "NTP=" — so an unanchored reader
  # returns CanNTP's value for NTP. The two fixtures above were built around a
  # misremembered claim (that NTPSynchronized was the collision) and are arranged
  # so they cannot catch it: TD1 puts CanNTP last, TD2 omits it. Replacing
  # td_get's anchored match with a naive one left all of them green.
  #
  # This is the box the trap costs something on: CanNTP=yes, NTP=no. Read
  # wrongly, the FATAL "network time synchronisation is OFF: timedatectl set-ntp
  # true" disappears and step_clock waits 90 seconds instead.
  TD3='Timezone=Europe/Athens
LocalRTC=no
CanNTP=yes
NTP=no
NTPSynchronized=no'
  t_eq "NTPSynchronized printed FIRST: NTP is still yes" "yes" "$(printf '%s\n' "$TD1" | td_get NTP)"
  t_eq "…and NTPSynchronized is still no"                "no"  "$(printf '%s\n' "$TD1" | td_get NTPSynchronized)"
  t_eq "NTP printed FIRST: NTP is yes"                   "yes" "$(printf '%s\n' "$TD2" | td_get NTP)"
  t_eq "…and NTPSynchronized is no"                      "no"  "$(printf '%s\n' "$TD2" | td_get NTPSynchronized)"
  t_eq "a key that is absent yields NOTHING, not 'no'"   ""    "$(printf '%s\n' "$TD2" | td_get CanNTP || true)"
  t_false "…and says so with rc 1"                       eval "printf '%s\n' \"\$TD2\" | td_get CanNTP"
  t_eq "a value containing ="  "a=b" "$(printf 'X=a=b\n' | td_get X)"
  t_eq "CRLF from a captured log" "yes" "$(printf 'NTP=yes\r\n' | td_get NTP)"
  t_eq "empty input" "" "$(printf '' | td_get NTP || true)"
  # In systemd's own print order, with the value that matters.
  t_eq "CanNTP printed BEFORE NTP: NTP is 'no', NOT CanNTP's 'yes'" "no" \
    "$(printf '%s\n' "$TD3" | td_get NTP)"
  t_eq "…and CanNTP is still readable as itself"        "yes" "$(printf '%s\n' "$TD3" | td_get CanNTP)"
  # And the consequence, through the verdict, so the assertion is about an
  # outcome rather than a string: this box must be told to run set-ntp true.
  t_eq "…so the box gets the set-ntp remediation line" "1" \
    "$(clock_verdict "$(printf '%s\n' "$TD3" | td_get NTP)" \
                     "$(printf '%s\n' "$TD3" | td_get NTPSynchronized)" \
                     "$(printf '%s\n' "$TD3" | td_get CanNTP)" | grep -c 'timedatectl set-ntp true')"

  printf '\n== clock_verdict — admin TOTP has a ~90-second window ==\n'
  t_eq "on and converged: NOTHING to report"     "" "$(clock_verdict yes yes yes)"
  t_eq "NTP off and not synced: two FATALs"      "2" "$(clock_verdict no no yes | grep -c '^FATAL')"
  t_eq "NTP on but not converged: one FATAL"     "1" "$(clock_verdict yes no yes | grep -c '^FATAL')"
  t_eq "no NTP client at all (CanNTP=no)"        "1" "$(clock_verdict no no no | grep -c '^FATAL')"
  t_eq "…and it names CanNTP, not the sync bit"  "1" "$(clock_verdict no no no | grep -c 'CanNTP=no')"
  # The one deliberately SOFT case: the kernel says the clock is disciplined and
  # systemd does not know who by. The property that matters holds.
  t_eq "synced by something systemd does not manage: WARN, not FATAL" "0" \
    "$(clock_verdict no yes yes | grep -c '^FATAL')"
  t_eq "…and it does warn"                       "1" "$(clock_verdict no yes yes | grep -c '^WARN')"
  # A systemd too old to answer must not produce an unactionable FATAL.
  t_eq "timedatectl said nothing: WARN"          "1" "$(clock_verdict '' '' '' | grep -c '^WARN')"
  t_eq "…and no FATAL"                           "0" "$(clock_verdict '' '' '' | grep -c '^FATAL')"

  printf '\n== clock_sanity_verdict — no network, no time server ==\n'
  # A file cannot be written in the future. This is the ONLY clock check still
  # available on a box whose apt and TLS the clock has already broken.
  t_eq "clock BEHIND a file this box wrote: FATAL" "1" "$(clock_sanity_verdict 1000 2000 | grep -c '^FATAL')"
  t_eq "…and it says how far"                      "1" "$(clock_sanity_verdict 1000 2000 | grep -c '1000 seconds')"
  # THE THRESHOLD. This used to FATAL at one second behind, and the caller fed it
  # $SELF's mtime — the installer file the operator scp'd onto the box, whose
  # mtime `scp -p` and `rsync -a` copy from the laptop. A laptop one second ahead
  # of a CORRECT server therefore produced the SKEW prompt, which is the one
  # acknowledgement in this script that must never become reflex. $SELF is gone
  # from the caller's list; this is the second lock on the same door.
  t_eq "1 second behind is a WARN, not a FATAL"    "0" "$(clock_sanity_verdict 1000 1001 | grep -c '^FATAL')"
  t_eq "…and it does say something"                "1" "$(clock_sanity_verdict 1000 1001 | grep -c '^WARN')"
  t_eq "299 seconds behind is still a WARN"        "0" "$(clock_sanity_verdict 1000 1299 | grep -c '^FATAL')"
  t_eq "300 seconds behind IS a FATAL"             "1" "$(clock_sanity_verdict 1000 1300 | grep -c '^FATAL')"
  t_eq "…and a year behind, emphatically"          "1" "$(clock_sanity_verdict 1000 31537000 | grep -c '^FATAL')"
  t_eq "clock a day ahead of it: nothing"          "" "$(clock_sanity_verdict 1086400 1000000)"
  t_eq "clock three years ahead: a WARN, not a FATAL" "1" "$(clock_sanity_verdict 100000000 1000 | grep -c '^WARN')"
  t_eq "…and never a FATAL for the ahead case"     "0" "$(clock_sanity_verdict 100000000 1000 | grep -c '^FATAL')"
  t_eq "unreadable mtime: no finding at all"       "" "$(clock_sanity_verdict 1000 '')"

  printf '\n== fstab_target_entry — mounted is not the same as mounted FOR EVER ==\n'
  cat > "$d/fstab" <<'EOF'
# /etc/fstab
UUID=11111111-1111-1111-1111-111111111111 /               ext4  errors=remount-ro 0 1
# UUID=deadbeef-0000-0000-0000-000000000000 /mnt/libriant ext4 defaults 0 2
#UUID=cafef00d-0000-0000-0000-000000000000 /mnt/libriant ext4 defaults 0 2
/dev/mapper/vg0-old  /mnt/libriant-old   ext4  defaults        0  2
UUID=abcd-1234       /mnt/libriant/      ext4  defaults,nofail 0  2
/dev/mapper/vg0-swap none                swap  sw              0  0
EOF
  t_eq "the entry for the data root, trailing slash and all" \
    "UUID=abcd-1234       /mnt/libriant/      ext4  defaults,nofail 0  2" \
    "$(fstab_target_entry /mnt/libriant < "$d/fstab")"
  t_eq "a COMMENTED-OUT entry is not an entry" "0" \
    "$(fstab_target_entry /mnt/libriant < "$d/fstab" | grep -c 'deadbeef' || true)"
  # …and the NO-SPACE form, which is what people actually type. With a space,
  # `# UUID=…` shifts every field by one and the mountpoint match misses anyway,
  # so the fixture above passes even with the comment-skip line DELETED. This one
  # does not: `#UUID=… /mnt/libriant …` puts the target in field 2 exactly where
  # a live entry would be.
  t_eq "…including the no-space '#UUID=' form"  "0" \
    "$(fstab_target_entry /mnt/libriant < "$d/fstab" | grep -c 'cafef00d' || true)"
  t_eq "…and /mnt/libriant-old must not match /mnt/libriant" "0" \
    "$(fstab_target_entry /mnt/libriant < "$d/fstab" | grep -c 'vg0-old' || true)"
  t_false "a target with no entry at all" eval "fstab_target_entry /mnt/nothing < '$d/fstab'"
  # fstab escapes a space as \040. Unescaped, a mountpoint with a space in it
  # never matches itself and the persistence check silently says "not there".
  printf 'UUID=x /mnt/my\\040data ext4 defaults 0 2\n' > "$d/fstab2"
  t_eq "a \\040-escaped space in the mountpoint" "1" \
    "$(fstab_target_entry '/mnt/my data' < "$d/fstab2" | grep -c 'UUID=x' || true)"
  printf 'UUID=y /mnt/libriant ext4 defaults 0 2\r\n' > "$d/fstab3"
  t_eq "CRLF from an editor"                    "1" "$(fstab_target_entry /mnt/libriant < "$d/fstab3" | grep -c 'UUID=y' || true)"
  printf '   UUID=z /mnt/libriant ext4 defaults 0 2\n' > "$d/fstab4"
  t_eq "leading whitespace"                     "1" "$(fstab_target_entry /mnt/libriant < "$d/fstab4" | grep -c 'UUID=z' || true)"
  printf '/dev/sda1 /mnt/libriant\n' > "$d/fstab5"
  t_eq "a two-field line still identifies the target" "1" \
    "$(fstab_target_entry /mnt/libriant < "$d/fstab5" | grep -c 'sda1' || true)"
  printf 'garbage\n\n\n' > "$d/fstab6"
  t_false "a one-field line is not an entry"    eval "fstab_target_entry /mnt/libriant < '$d/fstab6'"
  t_false "an empty file"                       eval "fstab_target_entry /mnt/libriant < /dev/null"

  printf '\n== fstab_persistence_verdict / fstab_fsck_pass / fstab_line_for ==\n'
  t_eq "no entry at all"    "none"   "$(fstab_persistence_verdict '')"
  t_eq "a plain entry"      "ok"     "$(fstab_persistence_verdict 'UUID=x /mnt/libriant ext4 defaults 0 2')"
  t_eq "nofail is reported, not condemned" "nofail" \
    "$(fstab_persistence_verdict 'UUID=x /mnt/libriant ext4 defaults,nofail 0 2')"
  t_eq "…and nofail in the middle of the list" "nofail" \
    "$(fstab_persistence_verdict 'UUID=x /mnt/libriant ext4 rw,nofail,noatime 0 2')"
  # "nofailsafe" must not read as "nofail".
  t_eq "an option that merely STARTS with nofail" "ok" \
    "$(fstab_persistence_verdict 'UUID=x /mnt/libriant ext4 nofailsafe 0 2')"
  t_eq "ext4 gets fsck pass 2" "2" "$(fstab_fsck_pass ext4)"
  t_eq "ext2 too"              "2" "$(fstab_fsck_pass ext2)"
  # xfs and btrfs check themselves; a non-zero pass makes systemd-fsck complain
  # on every boot about a filesystem it cannot check.
  t_eq "xfs gets 0"            "0" "$(fstab_fsck_pass xfs)"
  t_eq "an unknown fstype gets 0" "0" "$(fstab_fsck_pass '')"
  t_eq "the offered line is UUID-first and carries nofail" "1" \
    "$(fstab_line_for UUID=abc /mnt/libriant ext4 | grep -c 'UUID=abc  /mnt/libriant  ext4  defaults,nofail,x-systemd.device-timeout=30  0  2')"
  t_eq "…and a space in the target is escaped as \\040" "1" \
    "$(fstab_line_for UUID=abc '/mnt/my data' ext4 | grep -c '/mnt/my\\040data')"
  t_eq "…and an unknown fstype becomes 'auto' with pass 0" "1" \
    "$(fstab_line_for /dev/sdb1 /mnt/libriant '' | grep -c 'auto  defaults,nofail,x-systemd.device-timeout=30  0  0')"

  printf '\n== fstab_source_is_plain — sources that must NEVER reach /etc/fstab ==\n'
  # `findmnt -no SOURCE` does not always print a block device. On a btrfs
  # subvolume it prints /dev/sda2[/@sub], on a bind /dev/mapper/vg0-root[/srv/…],
  # on NFS host:/export. blkid fails on all three, and the "name the device
  # instead" branch then wrote that literal string into /etc/fstab, where it
  # cannot mount. Offering nothing beats offering a line that is wrong.
  t_true  "a plain device"            fstab_source_is_plain /dev/mapper/vg0-data
  t_true  "a UUID tag"                fstab_source_is_plain UUID=abcd-1234
  t_true  "a PARTUUID tag"            fstab_source_is_plain PARTUUID=0001-02
  t_true  "a LABEL tag"               fstab_source_is_plain LABEL=libriant
  t_false "a btrfs subvolume"         fstab_source_is_plain '/dev/sda2[/@sub]'
  t_false "a bind mount"              fstab_source_is_plain '/dev/mapper/vg0-root[/srv/libriant-data]'
  t_false "an NFS export"             fstab_source_is_plain 'nas.example:/export/libriant'
  t_false "a source with a space"     fstab_source_is_plain '/dev/my disk'
  t_false "something that is not a device at all" fstab_source_is_plain tmpfs
  t_false "empty"                     fstab_source_is_plain ''
  # fstab_source_device resolves a source field to the device it names, and
  # answers NOTHING when it cannot — because silence at the call site means
  # "could not compare", never "matches". /dev/null and /dev/zero exist
  # everywhere this is driven.
  t_eq "a plain device resolves to itself"  "/dev/null" "$(fstab_source_device /dev/null)"
  t_false "a device that does not exist"     fstab_source_device /dev/definitely-not-here
  t_false "a UUID with no by-uuid link"      fstab_source_device UUID=0000-not-a-real-uuid
  t_false "a source form we do not parse"    fstab_source_device 'nas.example:/export'
  t_false "empty"                            fstab_source_device ''
  # The whole point: two different devices must not compare equal.
  t_false "…/dev/null and /dev/zero are not the same device" \
    eval "[ \"\$(fstab_source_device /dev/null)\" = \"\$(fstab_source_device /dev/zero)\" ]"

  printf '\n== fstab_verify_available — the baseline and the check must agree ==\n'
  # A baseline taken under different conditions from the check it is compared
  # against is not a baseline. One predicate gates both.
  ( FSTAB=/etc/fstab; LIBRIANT_FSTAB_VERIFY=""
    command -v findmnt >/dev/null 2>&1 && fstab_verify_available ) \
    && t_eq "on a real box with findmnt: available" 1 1 \
    || t_eq "no findmnt here, so the real-box path is not driveable" 1 1
  t_false "an overridden FSTAB with no stub: NOT available (it would read /etc/fstab)" \
    eval "FSTAB=/tmp/somewhere-else LIBRIANT_FSTAB_VERIFY= fstab_verify_available"
  t_true  "…but an injected verifier makes it available, which is what makes the
         restore-and-die branch driveable at all" \
    eval "FSTAB=/tmp/somewhere-else LIBRIANT_FSTAB_VERIFY=true fstab_verify_available"

  printf '\n== the fstab block markers are keyed on the MOUNTPOINT ==\n'
  # upsert_block REPLACES the block it finds. Keyed on "Libriant" alone, a run
  # with a different $LIBRIANT_DATA_ROOT would silently delete the previous
  # mountpoint's line while appearing to add its own.
  t_eq "BEGIN names the data root"   "1" "$(fstab_block_begin | grep -c -F "$DATA_ROOT")"
  t_eq "END names it too"            "1" "$(fstab_block_end   | grep -c -F "$DATA_ROOT")"
  t_false "…and the two are not the same line" eval "[ \"\$(fstab_block_begin)\" = \"\$(fstab_block_end)\" ]"

  printf '\n== df_avail_kib / build_headroom_verdict — the ENOSPC gate ==\n'
  # `df -Pk` (POSIX) and not plain `df`: a long device name WRAPS in the default
  # output and field 4 becomes field 3 of a continuation line, which is the
  # classic way this check silently reads the wrong number.
  t_eq "a POSIX df row" "51424540" "$(printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/mapper/vg0-root 82043824 26374132 51424540 34%% /\n' | df_avail_kib)"
  t_eq "…and the header alone is not an answer" "" "$(printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\n' | df_avail_kib || true)"
  t_false "…with rc 1, so a caller cannot print 'only  GiB free'" \
    eval "printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\n' | df_avail_kib"
  t_false "empty input" eval "printf '' | df_avail_kib"
  t_eq "a wrapped (non-POSIX) row is REFUSED rather than misread" "" \
    "$(printf 'Filesystem 1K-blocks Used Available Use%% Mounted on\n/dev/mapper/a-very-long-device-name\n 82043824 26374132 51424540 34%% /\n' | df_avail_kib || true)"
  t_eq "25 GiB exactly is enough"  "ok 25"  "$(build_headroom_verdict 26214400)"
  t_eq "24 GiB is not"             "low 24" "$(build_headroom_verdict 25165824)"
  t_eq "nothing readable"          "unknown 0" "$(build_headroom_verdict '' || true)"
  t_false "…and says so with rc 1" eval "build_headroom_verdict '' >/dev/null"

  printf '\n== meminfo_mb / mem_verdict — exit 137 is a bare number ==\n'
  local MEMINFO
  MEMINFO='MemTotal:       65798060 kB
MemFree:         1234567 kB
MemAvailable:   60000000 kB
SwapCached:            0 kB
SwapTotal:       8388604 kB
SwapFree:        8388604 kB'
  t_eq "MemTotal in MiB (integer division, so 64255 not 64256)" "64255" "$(printf '%s\n' "$MEMINFO" | meminfo_mb MemTotal)"
  # `Mem` must not answer for `MemTotal`, and `SwapCached` must not answer for
  # `SwapTotal` — both are real prefixes/neighbours in this exact file.
  t_eq "SwapTotal, NOT SwapCached" "8191" "$(printf '%s\n' "$MEMINFO" | meminfo_mb SwapTotal)"
  t_false "a key that is absent"   eval "printf '%s\n' \"\$MEMINFO\" | meminfo_mb Nope"
  t_false "empty input"            eval "printf '' | meminfo_mb MemTotal"
  t_eq "62 GiB + 8 GiB of swap: nothing to say" "" "$(mem_verdict 64256 8192)"
  t_eq "a 4 GB box with no swap: a WARN"        "1" "$(mem_verdict 3900 0 | grep -c '^WARN')"
  t_eq "…and it names the one-service-at-a-time remedy" "1" "$(mem_verdict 3900 0 | grep -c 'dc build web')"
  # Losing swap silently converts "Postgres pages out" into "Postgres is
  # OOM-killed", and the HostSwapping alert is guarded by SwapTotal > 0.
  t_eq "no swap on a BIG box: still a NOTE"     "1" "$(mem_verdict 64256 0 | grep -c '^NOTE')"
  t_eq "…and no WARN, because 62 GiB is plenty" "0" "$(mem_verdict 64256 0 | grep -c '^WARN')"
  t_eq "unreadable /proc/meminfo: a WARN, not a crash" "1" "$(mem_verdict '' '' | grep -c '^WARN')"
  # ONE argument missing is the case the concatenated guard could not see: "" and
  # "8191" concatenate to "8191", which is all digits, so mem_verdict said
  # nothing and the caller printed `ok " MiB RAM + 8191 MiB swap — enough for a
  # cold next build`. A green line for a check that did not run.
  t_eq "MemTotal unreadable but swap fine: still a WARN" "1" "$(mem_verdict '' 8191 | grep -c '^WARN')"
  t_eq "…and the reverse"                                "1" "$(mem_verdict 64256 '' | grep -c '^WARN')"
  t_eq "…and non-numeric input"                          "1" "$(mem_verdict x 8191 | grep -c '^WARN')"
  # The anchor's real job is the PREFIX case: without it, `meminfo_mb Mem` would
  # be answered by MemTotal. (Asserting SwapTotal != SwapCached does not test the
  # anchor at all — no other line in that file contains the string "SwapTotal".)
  t_false "'Mem' must NOT be answered by 'MemTotal'" eval "printf '%s\n' \"\$MEMINFO\" | meminfo_mb Mem"
  t_false "…nor 'Swap' by 'SwapTotal'"               eval "printf '%s\n' \"\$MEMINFO\" | meminfo_mb Swap"

  printf '\n== retention_verdict — 15 full copies on the same filesystem ==\n'
  # 250 GiB volume, in KiB.
  local VOL=262144000
  t_eq "15 x 2 GiB fits"          "1" "$(retention_verdict 2097152 15 "$VOL" | grep -c '^fits')"
  t_eq "15 x 14 GiB is TIGHT"     "1" "$(retention_verdict 14680064 15 "$VOL" | grep -c '^tight')"
  t_eq "15 x 20 GiB is OVER"      "1" "$(retention_verdict 20971520 15 "$VOL" | grep -c '^over')"
  t_eq "a day-one, zero-size backup still answers" "1" "$(retention_verdict 0 15 "$VOL" | grep -c '^fits')"
  # Non-numeric input must be REFUSED, not fed to an arithmetic expansion that
  # aborts the whole script under set -e.
  t_eq "non-numeric input is refused"  "unknown 0 0" "$(retention_verdict x 15 "$VOL" || true)"
  t_false "…and says so with rc 1"     eval "retention_verdict x 15 $VOL >/dev/null"
  # EACH ARGUMENT SEPARATELY. Concatenated, `2097152` + `15` + `""` is all
  # digits: the guard passed, `[ "$proj" -ge "" ]` printed "integer expression
  # expected" to stderr, the elif then read the empty avail as 0, and the caller
  # warned `RETENTION PROJECTION IS tight … against 0 GiB free` about a volume
  # nobody had measured. The mirror case reported `fits` for an unread day size.
  t_eq "df produced nothing: refused, not 'tight against 0 GiB'" "unknown 0 0" \
    "$(retention_verdict 2097152 15 '' || true)"
  t_eq "du produced nothing: refused, not 'fits'"                "unknown 0 0" \
    "$(retention_verdict '' 15 "$VOL" || true)"
  t_eq "an unreadable BACKUP_KEEP_DAYS is refused"               "unknown 0 0" \
    "$(retention_verdict 2097152 '' "$VOL" || true)"

  printf '\n== hostname_label_ok — interpolated into /etc/hosts and hostnamectl ==\n'
  t_true  "a plain label"            hostname_label_ok libriant-1
  t_true  "a dotted FQDN"            hostname_label_ok box.libriant.example
  t_false "an empty name"            hostname_label_ok ''
  t_false "a space"                  hostname_label_ok 'my box'
  t_false "a shell metacharacter"    hostname_label_ok 'box;rm -rf /'
  t_false "an underscore"            hostname_label_ok box_1
  t_false "a trailing hyphen"        hostname_label_ok 'box-'
  t_false "a leading hyphen"         hostname_label_ok '-box'
  t_false "a leading dot"            hostname_label_ok '.box'
  t_false "an empty label"           hostname_label_ok 'a..b'
  t_false "a label over 63 chars"    hostname_label_ok "$(printf 'a%.0s' $(seq 1 64))"
  t_true  "…63 is fine"              hostname_label_ok "$(printf 'a%.0s' $(seq 1 63))"
  # HOST_NAME_MAX is 64 on Linux, not DNS's 253. A 127-character dotted name
  # passed the old 253 cap and then died at `hostnamectl set-hostname` with a
  # bare "command failed" — after the validator had said yes.
  t_false "a dotted name over 64 characters"  hostname_label_ok "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.ccccccc"
  t_true  "…and one of exactly 64 is fine"    hostname_label_ok "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

  printf '\n== /etc/docker/daemon.json ==\n'
  docker_daemon_json > "$d/daemon.json"
  t_eq "it sets ip6tables true — step_firewall dies without the chains" "1" \
    "$(grep -c '"ip6tables": true' "$d/daemon.json")"
  # "ipv6" is a DIFFERENT setting. Turning it on is one of four changes that
  # must be made together, and it reopens the userland-proxy path that defeated
  # the first fix for authn-authz-01.
  t_eq "…and does NOT set ipv6"  "0" "$(grep -c '"ipv6"' "$d/daemon.json" || true)"
  t_eq "…and bounds ad-hoc container logs at the same 50m x 5 as the compose anchor" "1" \
    "$(grep -c '"max-size": "50m"' "$d/daemon.json")"
  t_true  "json_names_key finds ip6tables"  eval "json_names_key ip6tables < '$d/daemon.json'"
  t_false "…and does not invent ipv6"       eval "json_names_key ipv6 < '$d/daemon.json'"
  t_false "…nor a key in an empty file"     eval "json_names_key ip6tables < /dev/null"
  t_true  "…and tolerates a space before the colon" \
    eval "printf '{ \"ip6tables\" : true }\n' | json_names_key ip6tables"

  printf '\n== step-name validation ==\n'
  t_true  "'deploy' is a step"      valid_step deploy
  t_true  "'ssh' is a step"         valid_step ssh
  t_true  "'clock' is a step"       valid_step clock
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
DATA_ROOT_FSTAB_ACKED=0

# data_root_mounted — "is it a filesystem RIGHT NOW". Two sources because
# `mountpoint` is not installed on every minimal image and findmnt is.
data_root_mounted() {
  mountpoint -q "$DATA_ROOT" 2>/dev/null || findmnt -rno TARGET "$DATA_ROOT" >/dev/null 2>&1
}

# data_root_fstab_entry — the /etc/fstab line that makes $DATA_ROOT survive a
# reboot, or nothing. The UNION of a hand parser and findmnt, and the union is
# deliberate: missing an entry that exists costs a duplicate line an operator has
# to notice, while inventing one that does not exist costs nothing at all. The
# hand parser is here because it can be driven from --self-test with hostile
# fixtures (a commented-out entry, a /mnt/libriant-old prefix, a \040-escaped
# space, CRLF from an editor) and findmnt cannot.
data_root_fstab_entry() {
  local line=""
  if [ -r "$FSTAB" ]; then
    line="$(fstab_target_entry "$DATA_ROOT" < "$FSTAB" 2>/dev/null || true)"
  fi
  # ONLY when $FSTAB is the real one. `findmnt --fstab` reads /etc/fstab
  # unconditionally and takes no file argument, so on a fixture-driven run it
  # would silently consult the HOST's fstab and answer a question nobody asked.
  # The same care is taken around `findmnt --verify` below; it was missed here.
  if [ -z "$line" ] && [ "$FSTAB" = /etc/fstab ] && command -v findmnt >/dev/null 2>&1; then
    line="$(findmnt --fstab -rno SOURCE,TARGET,FSTYPE,OPTIONS "$DATA_ROOT" 2>/dev/null | head -1 || true)"
  fi
  printf '%s' "$line"
}

# fstab_source_device SOURCEFIELD — the block device an fstab source field names,
# resolved through its symlinks; empty when it cannot be resolved.
#
# Used to answer the question the mountpoint match cannot: is the entry that
# claims to bring $DATA_ROOT back pointing at the RIGHT VOLUME? The BOOTDISK
# refusal prints a line for the operator to hand-write with a UUID they copy by
# eye, and a typo there produces a green "it comes back after a reboot" from the
# one check written to catch exactly that — then an empty directory on the root
# disk at the next boot, because `nofail` lets the box come up regardless.
fstab_source_device() {
  local s="${1:-}" dev=""
  case "$s" in
    UUID=*)        dev="/dev/disk/by-uuid/${s#UUID=}" ;;
    PARTUUID=*)    dev="/dev/disk/by-partuuid/${s#PARTUUID=}" ;;
    LABEL=*)       dev="/dev/disk/by-label/${s#LABEL=}" ;;
    PARTLABEL=*)   dev="/dev/disk/by-partlabel/${s#PARTLABEL=}" ;;
    /dev/*)        dev="$s" ;;
    *)             return 1 ;;
  esac
  [ -e "$dev" ] || return 1
  readlink -f "$dev" 2>/dev/null || printf '%s\n' "$dev"
}

# fstab_source_is_plain SOURCE — refuse anything that is not a plain block
# device or a tag naming one.
#
# `findmnt -no SOURCE` prints `/dev/sda2[/@subvol]` for a btrfs subvolume and
# `/dev/mapper/vg0-root[/srv/…]` for a bind, and `host:/export` for NFS. blkid
# fails on all three, the "name the device instead" branch then writes that
# literal string into /etc/fstab, and the line cannot mount. Offering nothing is
# strictly better than offering a line that is wrong.
# Can `findmnt --verify` (or the injected stand-in) be run at all, and against
# the file this run is actually editing? One predicate, used for BOTH the
# baseline and the post-write check, because a baseline taken under different
# conditions from the check it is compared against is not a baseline.
#
# LIBRIANT_FSTAB_VERIFY is a test hook, and it is the reason the restore-and-die
# path below — the most dangerous branch in this file — can be driven off-box at
# all. Without it that branch was gated on `FSTAB = /etc/fstab`, i.e. excluded
# from the only override that makes any of this testable.
fstab_verify_available() {
  [ -n "${LIBRIANT_FSTAB_VERIFY:-}" ] && return 0
  [ "$FSTAB" = /etc/fstab ] || return 1
  command -v findmnt >/dev/null 2>&1
}

fstab_source_is_plain() {
  local s="${1:-}"
  [ -n "$s" ] || return 1
  case "$s" in
    *'['*|*']'*|*:*|*' '*) return 1 ;;
  esac
  case "$s" in
    /dev/*|UUID=*|PARTUUID=*|LABEL=*|PARTLABEL=*) return 0 ;;
    *) return 1 ;;
  esac
}

# A systemd .mount unit is the other legitimate way to make a mount persistent,
# and a box provisioned by configuration management may well use one. Not
# finding an fstab line is not the same as not being persistent.
data_root_mount_unit_enabled() {
  local unit
  command -v systemd-escape >/dev/null 2>&1 || return 1
  unit="$(systemd-escape -p --suffix=mount "$DATA_ROOT" 2>/dev/null || true)"
  [ -n "$unit" ] || return 1
  systemctl is-enabled "$unit" >/dev/null 2>&1
}

# ── MOUNTED IS NOT THE SAME AS MOUNTED FOR EVER, and until now nothing here
#    asked the second question.
#
# `mountpoint -q` answers "right now". The fstab probe below used to live inside
# the NOT-mounted branch, so a volume mounted BY HAND — which is the obvious
# response to this script's own BOOTDISK refusal, and also what an operator does
# after a Rebuild to get the install moving — short-circuited to
# "ok, a mounted filesystem" and was never examined again.
#
# What that costs, precisely, on the next reboot: /mnt/libriant is an empty
# directory on the 80 GiB root. The compose overlay binds
# ${DATA_ROOT}/postgres, /redis, /storage and /caddy BY PATH, and a bind to a
# path that does not exist is a hard mount failure, so the whole cell refuses to
# start. That much is the "safe failure" the overlay's header claims and it is
# survivable. The catastrophe is one command later, and it is the command that
# file itself tells you to run: `mkdir -p ${LIBRIANT_DATA_ROOT}/{postgres,redis,
# storage,caddy}` (docker-compose.volume.yml:14). Do that on an unmounted box
# and Postgres finds no PG_VERSION, initdbs a SECOND empty cluster on the boot
# disk, every container reports healthy, §3.9 passes, and fourteen days of
# backups of an empty database accumulate — while every library's data sits on
# vg0-data, unreachable, and mounting the volume makes the running install
# vanish behind the mount.
#
# REPORT_ONLY as $1 for --verify-only, which must never prompt.
assert_data_root_persistent() {
  local mode="${1:-fix}" entry="" verdict src fstype uuid line rc=0

  entry="$(data_root_fstab_entry)"
  if [ -n "$entry" ]; then
    verdict="$(fstab_persistence_verdict "$entry")"
    ok "$DATA_ROOT is mounted AND in /etc/fstab — it comes back after a reboot"
    printf '         %s\n' "$entry"
    # ── AND IT NAMES THE RIGHT VOLUME. The match above is on the MOUNTPOINT
    #    alone, which is the whole entry an fstab line needs to be found by and
    #    not nearly enough to be trusted by. The BOOTDISK refusal below prints a
    #    line for the operator to hand-write with a UUID copied by eye; one wrong
    #    character produces a green "it comes back after a reboot" from the one
    #    check written to catch exactly this, and `nofail` then lets the box boot
    #    happily with an empty directory where the database used to be.
    #
    #    Only ever a WARNING, and only when BOTH sides resolve: a device that is
    #    simply not present right now, an LVM name that resolves differently on
    #    this kernel, or an fstab source form this does not parse must not turn a
    #    correct box red. Silence here means "could not compare", not "matches".
    local _ent_src _ent_dev _live_src _live_dev
    set -f
    # shellcheck disable=SC2086
    set -- $entry
    set +f
    _ent_src="${1:-}"
    _ent_dev="$(fstab_source_device "$_ent_src" 2>/dev/null || true)"
    _live_src=""
    command -v findmnt >/dev/null 2>&1 && _live_src="$(findmnt -no SOURCE "$DATA_ROOT" 2>/dev/null | head -1 || true)"
    _live_dev=""
    [ -n "$_live_src" ] && _live_dev="$(readlink -f "$_live_src" 2>/dev/null || printf '%s' "$_live_src")"
    if [ -n "$_ent_dev" ] && [ -n "$_live_dev" ] && [ "$_ent_dev" != "$_live_dev" ]; then
      warn "…BUT THAT ENTRY NAMES A DIFFERENT DEVICE FROM THE ONE MOUNTED THERE NOW:"
      warn "     fstab says  ${_ent_src}  ->  ${_ent_dev}"
      warn "     mounted is  ${_live_src}  ->  ${_live_dev}"
      warn "At the next reboot this mountpoint gets the fstab one, not the one carrying"
      warn "your data. Check it by hand before you reboot:  blkid ${_live_src}"
      _logline "WARN fstab entry for $DATA_ROOT names ${_ent_dev}, live mount is ${_live_dev}"
    fi
    if [ "$verdict" = nofail ]; then
      note "that entry carries \`nofail\`, which is what this installer would have written:"
      note "     a failed mount then boots the box (SSH works) and the STACK refuses to"
      note "     start, instead of dropping to emergency mode with no sshd. If the stack"
      note "     ever comes up on an empty $DATA_ROOT, that is the case to suspect."
    fi
    return 0
  fi
  if data_root_mount_unit_enabled; then
    ok "$DATA_ROOT is mounted by an ENABLED systemd .mount unit — it comes back after a reboot"
    return 0
  fi

  # ── Mounted, and nothing brings it back.
  warn "$DATA_ROOT IS MOUNTED BUT NOT PERSISTENT: no /etc/fstab entry, no enabled"
  warn ".mount unit. It does not survive a reboot, and a reboot is not something you"
  warn "get to schedule — the first one will be unplanned and during an incident."
  if [ "$mode" = report ]; then
    VERIFY_RC=$((VERIFY_RC + 1))
    return 0
  fi
  [ "$DATA_ROOT_FSTAB_ACKED" = 1 ] && return 0

  # The line can be DERIVED from the live mount, so it cannot be wrong about
  # what to mount. Offer it rather than only refusing.
  src=""; fstype=""; uuid=""
  if command -v findmnt >/dev/null 2>&1; then
    src="$(findmnt -no SOURCE "$DATA_ROOT" 2>/dev/null | head -1 || true)"
    fstype="$(findmnt -no FSTYPE "$DATA_ROOT" 2>/dev/null | head -1 || true)"
  fi
  # UUID, never /dev/sdX: a cloud volume's device name is not stable across
  # reboots, which is the very event this line exists to survive.
  if [ -n "$src" ] && command -v blkid >/dev/null 2>&1; then
    uuid="$(blkid -s UUID -o value "$src" 2>/dev/null || true)"
  fi
  # A source this installer will not put in an fstab line. `findmnt -no SOURCE`
  # prints `/dev/sda2[/@subvol]` for a btrfs subvolume, `/dev/mapper/vg0-root[/…]`
  # for a bind and `host:/export` for NFS; blkid fails on all three and the old
  # "name the device instead" branch wrote that literal string into /etc/fstab,
  # where it cannot mount. Offering nothing beats offering a line that is wrong.
  if [ -n "$src" ] && ! fstab_source_is_plain "$src"; then
    warn "the live mount's source is '${src}', which is not a plain block device — a"
    warn "btrfs subvolume, a bind mount or a network filesystem. This installer will"
    warn "not compose an fstab line for it, because the one it could compose would be"
    warn "wrong in a way that only shows up at the next boot."
    src=""
  fi
  if [ -z "$src" ]; then
    warn "no source device to offer a line for $DATA_ROOT."
    warn "Do it by hand, then re-run this installer:"
    printf '         findmnt -no SOURCE,FSTYPE %s\n' "$DATA_ROOT"
    printf '         blkid -s UUID -o value <that device>\n'
    printf '         # then add to /etc/fstab:\n'
    printf '         UUID=[PLACEHOLDER: the UUID above]  %s  [PLACEHOLDER: the fstype]  defaults,nofail,x-systemd.device-timeout=30  0  2\n' "$DATA_ROOT"
    DATA_ROOT_FSTAB_ACKED=1
    return 0
  fi
  # A UUID that does not resolve is a line that will not mount. blkid can answer
  # from a cache; /dev/disk/by-uuid is udev's live view, which is what the boot
  # actually consults.
  if [ -n "$uuid" ] && [ ! -e "/dev/disk/by-uuid/${uuid}" ]; then
    warn "blkid reported UUID=${uuid} but /dev/disk/by-uuid/${uuid} does not exist"
    warn "(a stale blkid cache?). Falling back to the device path rather than offering"
    warn "a UUID the boot would not resolve."
    uuid=""
  fi
  if [ -n "$uuid" ]; then
    line="$(fstab_line_for "UUID=${uuid}" "$DATA_ROOT" "${fstype:-auto}")"
  else
    warn "no usable UUID for $src, so the offered line names the DEVICE."
    warn "A device path is not stable across reboots on a cloud volume — check it."
    line="$(fstab_line_for "$src" "$DATA_ROOT" "${fstype:-auto}")"
  fi
  printf '\n  The line that would be appended to %s, derived from the live mount:\n\n' "$FSTAB"
  printf '    %s\n\n' "$line"
  if [ "$DRY" = 1 ]; then
    note "would offer to append that line to ${FSTAB}"
    DATA_ROOT_FSTAB_ACKED=1
    return 0
  fi
  if ! confirm_typed "Append that line to ${FSTAB} so the data volume comes back after a reboot." "FSTAB"; then
    warn "declined. $DATA_ROOT will NOT come back after a reboot — write the line above"
    warn "yourself before this box carries a library's data."
    DATA_ROOT_FSTAB_ACKED=1
    return 0
  fi

  # /etc/fstab is the one file here where a bad line costs the machine: without
  # `nofail` a failed mount drops the box into emergency mode with no sshd, and
  # on a remote box that means the provider console. So: back it up, write it,
  # PROVE it with findmnt --verify, and put the original back on any doubt.
  local backup="${STATE_DIR}/fstab.bak-$(date +%Y%m%d%H%M%S)"
  install -d -m 0700 "$STATE_DIR" 2>/dev/null || true
  cp -p "$FSTAB" "$backup" 2>/dev/null || die "could not back up ${FSTAB}; refusing to touch it."
  ok "copied ${FSTAB} to $backup before touching it"

  # ── THE BASELINE, TAKEN BEFORE THE WRITE. `findmnt --verify` reports on the
  #    WHOLE FILE, so treating its exit status as a verdict on OUR line makes any
  #    pre-existing complaint elsewhere in /etc/fstab — a stale /mnt/old whose
  #    target directory is gone, a removed swapfile entry, an fstype this kernel
  #    does not have — read as "the line this installer just wrote is bad". The
  #    installer would then restore the backup and `die` at step 2 of 17, telling
  #    the operator that a correct line is the one thing that could cost them the
  #    box, and the only way past on the re-run would be to DECLINE the fix.
  #    Comparing against a baseline needs no knowledge of which conditions
  #    findmnt counts as errors versus warnings, which is exactly the knowledge
  #    nobody here has.
  #
  #    Taken with the SAME command and under the SAME conditions as the check
  #    after the write, or the comparison is between two different questions.
  local base_rc=0
  if fstab_verify_available; then
    ${LIBRIANT_FSTAB_VERIFY:-findmnt --verify} >/dev/null 2>&1 || base_rc=$?
    [ "$base_rc" = 0 ] || warn "findmnt --verify was ALREADY unhappy with ${FSTAB} before this line (rc ${base_rc})"
  fi

  local res
  res="$(printf '%s\n' "$line" | upsert_block "$FSTAB" \
    "$(fstab_block_begin)" "$(fstab_block_end)")" || rc=$?
  if [ "$rc" != 0 ] || [ "$res" = unterminated ] || [ "$res" = unwritable ]; then
    cp -p "$backup" "$FSTAB"
    # Report what actually happened. This branch used to say "unterminated"
    # whatever the cause, and an I/O failure mid-write (rc 153 when driven under
    # `ulimit -f 0`) was reported as a malformed marker block.
    die "could not update ${FSTAB} (upsert_block said '${res:-nothing}', exit ${rc}).
     It has been RESTORED from $backup and nothing was changed.
       unterminated  ${FSTAB} holds a Libriant BEGIN marker with no END — fix by hand
       unwritable    the write failed (full disk? read-only /etc?) — check and re-run"
  fi
  note "${FSTAB}: $res"

  # `findmnt --verify` with NO file argument, deliberately: that is the one
  # documented, definitely-supported form, and this is not the place to find out
  # that a flag combination is rejected — a usage error would be reported to the
  # operator as "your fstab is broken". It reads /etc/fstab, so when FSTAB has
  # been overridden (only the tests do that) it is skipped rather than pointed
  # at the wrong file. FSTAB_VERIFY exists so the restore-and-die path — the
  # single most dangerous branch in this whole change — can be DRIVEN off-box
  # with a stub, instead of being the one thing no test can reach.
  local verify_out verify_rc=0
  if [ "$FSTAB" != /etc/fstab ] && [ -z "${LIBRIANT_FSTAB_VERIFY:-}" ]; then
    note "FSTAB is overridden (${FSTAB}); findmnt --verify reads /etc/fstab, so it was not run"
  elif fstab_verify_available; then
    verify_out="$(${LIBRIANT_FSTAB_VERIFY:-findmnt --verify} 2>&1)" || verify_rc=$?
    if [ "$verify_rc" = 0 ]; then
      ok "findmnt --verify accepts the new ${FSTAB}"
    elif [ "$base_rc" != 0 ]; then
      # It was unhappy BEFORE this line too, so the new line is not what it is
      # objecting to. Leaving a correct line in place and naming the real problem
      # beats restoring it and blaming ourselves.
      printf '%s\n' "$verify_out" | sed 's/^/         /'
      warn "findmnt --verify is still unhappy with ${FSTAB} (rc ${verify_rc}) — and it was"
      warn "ALREADY unhappy before this line was added (rc ${base_rc}), so the objection is"
      warn "to something that was there first. The Libriant line is LEFT IN PLACE. Read the"
      warn "output above and fix the pre-existing entry — do NOT reboot until you have."
    else
      printf '%s\n' "$verify_out" | sed 's/^/         /'
      cp -p "$backup" "$FSTAB"
      die "findmnt --verify accepted ${FSTAB} before this line and rejects it after, so
     the line this installer wrote is the problem. ${FSTAB} has been RESTORED from
     $backup and nothing was changed. A bad fstab line is the one way this step
     could cost you the box, and it will not be left in place."
    fi
  else
    warn "findmnt is not installed, so the new ${FSTAB} could not be validated."
    warn "Check it by hand BEFORE the next reboot:  findmnt --verify"
  fi

  # systemd caches its view of /etc/fstab (generated .mount units) and does not
  # notice an edit until it is told to look. Without this the new entry is inert
  # until the next boot — which is fine for the purpose, but it also means
  # `systemctl status <escaped>.mount` says nothing and the operator cannot check
  # their own work today. Best-effort: a systemd-less container has no daemon.
  try systemctl daemon-reload 2>/dev/null || true

  # Re-read through the same probe that decided the step was needed. Anything
  # else is trusting the write rather than checking it.
  if [ -n "$(data_root_fstab_entry)" ]; then
    ok "$DATA_ROOT now has an /etc/fstab entry and survives a reboot"
    _logline "DECISION appended fstab entry for $DATA_ROOT: $line"
  else
    warn "the line was written but $DATA_ROOT still does not resolve in ${FSTAB}."
    warn "Read it yourself before rebooting:  cat ${FSTAB}"
  fi
  DATA_ROOT_FSTAB_ACKED=1
  return 0
}

assert_data_root_sane() {
  if data_root_mounted; then
    assert_data_root_persistent
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
    # The commands, LITERALLY, in your other session — because the two things an
    # operator does instead are the two worst outcomes: typing BOOTDISK because
    # it is the only key this prompt offers, or hand-mounting with no fstab line
    # and hitting the reboot case above. (That second one is now caught on the
    # re-run by assert_data_root_persistent, which offers the fstab line.)
    #
    # There is deliberately NO mkfs here and this script will never print one. A
    # device that "looks like an empty volume waiting to be formatted" is
    # indistinguishable from a data volume whose superblock nobody has looked at.
    printf '\n'
    printf '  In your OTHER session:\n\n'
    printf '    lsblk -o NAME,FSTYPE,LABEL,UUID,SIZE,MOUNTPOINT\n'
    printf '    mount /dev/[PLACEHOLDER: the device above] %s && ls -la %s\n' "$DATA_ROOT" "$DATA_ROOT"
    printf '    # a data volume has %s/postgres/PG_VERSION on it. If that file is\n' "$DATA_ROOT"
    printf '    # there, this is a LIVE CLUSTER: stop and read RUNBOOK §3.5 before anything.\n'
    printf '    blkid -s UUID -o value /dev/[PLACEHOLDER: the device above]\n'
    printf '    # then make it permanent, or the next reboot loses it again:\n'
    printf '    UUID=[PLACEHOLDER: the UUID]  %s  ext4  defaults,nofail,x-systemd.device-timeout=30  0  2\n' "$DATA_ROOT"
    printf '\n  Then re-run this installer. Do NOT mkfs anything.\n\n'
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

    as root       take stock (host name, RAM, disk, the data volume, the
                  timezone) · prove the clock is synchronised · SSH password
                  auth OFF · ufw (v4+v6) · baseline packages + fail2ban ·
                  Docker · the '${DEPLOY_USER}' user · directories on ${DATA_ROOT}
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

    8. ${C_B}The name this box should have${C_0} (or a decision to keep the provider's).
       Offered in the next step, defaulting to no change. Nothing on this stack
       READS it — but it is written into every backup manifest and into the
       GitHub Deploy Key's comment, and the key is never regenerated, so
       declining is permanent in the one label you read during a DR restore or
       when deciding which key to revoke.

  ${C_B}Three things this script guards, and why${C_0}

    · ${C_B}Lockout.${C_0} Before password auth goes off it counts the USABLE keys in
      the authorized_keys of every account you could log in as — parsing them
      the way sshd does, and checking the StrictModes bits that make sshd
      ignore a key that looks perfect — and refuses if there are none. Before
      ufw is enabled it reads the port sshd is ACTUALLY listening on and proves
      the allow rule exists, rather than assuming 22.
    · ${C_B}Your existing install.${C_0} It never regenerates a secret that exists,
      never overwrites an origin certificate, never touches a data directory,
      and tells you before anything discards uncommitted work.
    · ${C_B}The clock.${C_0} Admin MFA is mandatory in production and TOTP has a
      ~90-second window, and a recovery code can only be minted AFTER a TOTP
      code has verified — so a box whose clock drifts has an admin panel
      nobody can ever enter, and the symptom is "invalid code". The 'clock'
      step refuses to continue on a clock nothing is disciplining.

BRIEF
  if [ -z "${TMUX:-}" ] && [ -z "${STY:-}" ]; then
    warn "You are not inside tmux or screen. A dropped connection during the"
    warn "10-20 minute build ends the install mid-flight. Consider: tmux new -s libriant"
  else
    ok "running inside tmux/screen — an SSH drop will not kill the build"
  fi
  confirm_typed "All eight are in front of you?" "READY" \
    || die "Stopped, with nothing changed. Come back when they are — every step
     checks the machine rather than a marker, so re-running resumes."
  mark_done briefing
}

# ── offer_hostname — the box's own name, which nothing here ever set.
#
# Functionally NOTHING on this stack reads it: no service, no cron, no
# certificate, no alert, no log path. Prometheus labels come from the compose
# service names, and EMAIL_DRIVER=console means no MX-adjacent dependency
# exists. Three things do WRITE it into something a human later reads, and all
# three are read during an incident:
#
#   backup.sh:415        host=$(hostname) in every backup manifest — the
#                        identifier you reach for during a DR restore when you
#                        have dumps from two boxes and need to know which is
#                        which
#   this script          the GitHub Deploy Key's comment, "libriant deploy@<host>",
#                        which is what you read when deciding which key to revoke
#   this script          the install transcript's own header
#
# So: OFFERED, never imposed, and asked beside the timezone because they are the
# same class of decision and `stock` already stops for that one.
#
# THE PART THAT MUST NOT BE SKIPPED is /etc/hosts. `hostnamectl set-hostname`
# alone leaves it stale, and every subsequent `sudo` then prints "unable to
# resolve host <name>" — noise on a box where the deploy user runs sudo
# constantly, and noise nobody will connect to this script.
offer_hostname() {
  command -v hostnamectl >/dev/null 2>&1 || return 0
  local cur fqdn n=""
  cur="$(hostnamectl --static 2>/dev/null || true)"
  fqdn="$(hostname -f 2>/dev/null || hostname 2>/dev/null || true)"
  printf '\n'
  note "host name: static='${cur:-none}'  fqdn='${fqdn:-unknown}'"
  [ "$DRY" = 0 ] || return 0
  confirm "Change the host name before continuing?" || return 0
  ask n "New host name (blank to keep '${cur:-none}')"
  [ -n "$n" ] || return 0
  # Interpolated into hostnamectl AND into an /etc/hosts line, so anything
  # outside RFC 1123's alphabet is refused rather than quoted around.
  hostname_label_ok "$n" || die "'$n' is not a valid host name (letters, digits, '-' and '.', no leading
     or trailing '-' or '.', no empty label, each label 63 characters or fewer).
     Nothing was changed."
  run hostnamectl set-hostname "$n"
  # 127.0.1.1 is Debian/Ubuntu's convention for the box's own name — deliberately
  # NOT 127.0.0.1, which already carries localhost.
  #
  # REPLACED, not appended. The old guard was an exact-line match, so renaming
  # A -> B appended `127.0.1.1 B` and left `127.0.1.1 A` above it: one extra line
  # per rename, and a reverse lookup of 127.0.1.1 that keeps answering with the
  # OLD name — which is the name that then turns up in a backup manifest during a
  # DR restore, the one moment the label has to be right.
  if [ -f /etc/hosts ] && ! file_has_line /etc/hosts "127.0.1.1 ${n}"; then
    cp -p /etc/hosts "${STATE_DIR}/hosts.bak-$(date +%Y%m%d%H%M%S)" 2>/dev/null || true
    if grep -qE '^[[:space:]]*127\.0\.1\.1([[:space:]]|$)' /etc/hosts; then
      sed -i -E "s/^[[:space:]]*127\\.0\\.1\\.1([[:space:]].*)?$/127.0.1.1 ${n}/" /etc/hosts \
        || die "could not rewrite the 127.0.1.1 line in /etc/hosts. The host name IS
     already changed; fix that line by hand or every sudo will warn."
      ok "replaced the 127.0.1.1 line in /etc/hosts with '127.0.1.1 ${n}'"
    else
      printf '127.0.1.1 %s\n' "$n" >> /etc/hosts
      ok "added '127.0.1.1 ${n}' to /etc/hosts (without it every sudo warns it cannot resolve the host)"
    fi
  fi
  ok "host name is now: $(hostname -f 2>/dev/null || hostname)"
  _logline "DECISION hostname set to ${n}"
  if [ -f "$DEPLOY_KEY" ]; then
    note "the GitHub Deploy Key already exists and is NEVER regenerated, so its comment"
    note "     on GitHub still carries the OLD name. That is a stale label, not a broken"
    note "     key — but it is the label you read when deciding which key to revoke."
  fi
  return 0
}

# ── assert_build_headroom — the disk the COLD BUILD needs, measured where the
#    build actually writes, and asserted TWICE.
#
# It used to live inline in `stock`, which is step 2 of 17. Everything between
# `stock` and `deploy` eats the number it printed: apt, the Docker packages, the
# whole checkout, then a cold `next build`. And `--only deploy` / `--from deploy`
# — the resume path an operator takes after a build that failed — skipped it
# entirely. deploy-on-host.sh:265 records that ENOSPC has already broken a deploy
# on this project once, and its two prunes run BEFORE the build, so they cannot
# reclaim anything the build is about to need.
#
# Measured on the filesystem that HOLDS /var/lib/docker rather than on `/`.
# They are the same filesystem today; an operator who moves the image store makes
# the old check answer a question nobody asked. `df -Pk` (POSIX, one row per
# filesystem) and not plain `df`: a long device name wraps in the default output,
# field 4 becomes field 3 of a continuation line, and the check silently reads
# the wrong number.
assert_build_headroom() {
  local where=/var/lib/docker kib state gib
  [ -d "$where" ] || where=/
  kib="$(df -Pk "$where" 2>/dev/null | df_avail_kib || true)"
  set -- $(build_headroom_verdict "$kib" || true)
  state="${1:-unknown}"; gib="${2:-0}"
  case "$state" in
    unknown)
      # An empty answer must not print as "only  GiB free", which reads like a
      # number that happens to be missing rather than a check that did not run.
      warn "could not read the free space on $where (df produced nothing usable)."
      warn "The cold build wants ~15-20 GiB in /var/lib/docker — a figure the runbook"
      warn "marks UNVERIFIED on this box. Check it yourself:  df -h $where"
      confirm "Continue without knowing how much space is free?" || die "Stopped. Check df -h $where first." ;;
    low)
      warn "only ${gib} GiB free on the filesystem holding $where — the cold build wants"
      warn "~15-20 GiB in /var/lib/docker (a figure the runbook marks UNVERIFIED on this box)."
      warn "deploy-on-host.sh prunes BEFORE it builds, so it cannot reclaim what the build needs."
      confirm "Continue anyway?" || die "Stopped. Free space on $where first." ;;
    *)
      ok "${gib} GiB free on the filesystem holding $where (cold build wants ~15-20 GiB; UNVERIFIED figure)" ;;
  esac
}

# ── assert_build_memory — nothing on this box ever read MemTotal before
#    committing to a 10-20 minute build that is known to be OOM-killable.
#
# `stock` runs `free -h` and asserts nothing about it. On the measured box (62
# GiB + 8 GiB of LVM swap) this prints one ok line and that is the correct
# outcome. It is here for the two cases that are live on this project rather
# than hypothetical: a REPLACEMENT box (this script is deliberately box-agnostic
# and the compose defaults are documented as suiting a ~4 GB host), and a
# provider Rebuild that re-partitions and leaves vg0-swap out of the new fstab —
# where `free -h` scrolling past inside a wall of lsblk output is not a check.
#
# /proc/meminfo and not `free`: free's columns are localised and have been
# renumbered between releases, and this decides whether a 20-minute build is
# about to die with a bare exit 137.
assert_build_memory() {
  local mem swap findings
  mem="$(meminfo_mb MemTotal  < /proc/meminfo 2>/dev/null || true)"
  swap="$(meminfo_mb SwapTotal < /proc/meminfo 2>/dev/null || true)"
  findings="$(mem_verdict "${mem:-}" "${swap:-}" || true)"
  if [ -z "$findings" ]; then
    ok "${mem} MiB RAM + ${swap} MiB swap — enough for a cold \`next build\`"
    return 0
  fi
  printf '%s\n' "$findings" | sed 's/^/         /'
  if printf '%s\n' "$findings" | grep -q '^WARN'; then
    confirm "Continue anyway?" || die "Stopped. Give the box swap, or build one service at a time."
  fi
  return 0
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
  # Unconditional now, and that is the fix. The old shape was
  #   if mountpoint -q; then ok "mounted"; else assert_data_root_sane; fi
  # which meant a volume mounted BY HAND — no fstab entry, gone at the next
  # reboot — took the `ok` branch and was never looked at again.
  # assert_data_root_sane prints its own ok on the healthy path.
  assert_data_root_sane

  assert_build_headroom
  assert_build_memory
  offer_hostname

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

# ── The clock ───────────────────────────────────────────────────────────────
#
# The reasoning is in the block above `td_get`. In one line: admin MFA is
# mandatory in production, TOTP has a ~90-second acceptance window, and the only
# path to a recovery code runs through a TOTP check that has already passed — so
# a box whose clock drifts has an admin panel nobody can ever enter, and the
# symptom is "invalid code", which reads as a bad QR or a bad phone.
#
# Read-only on a healthy box: it reads the kernel's own NTPSynchronized bit and
# writes nothing. The single write — installing an NTP client — happens only
# when timedatectl says the box has none at all.
satisfied_clock() {
  local td ntp sync
  command -v timedatectl >/dev/null 2>&1 || return 1
  td="$(timedatectl show 2>/dev/null || true)"
  [ -n "$td" ] || return 1
  ntp="$(printf '%s\n' "$td" | td_get NTP || true)"
  sync="$(printf '%s\n' "$td" | td_get NTPSynchronized || true)"
  [ "$ntp" = yes ] && [ "$sync" = yes ]
}

step_clock() {
  say "The clock — on this box it is an authentication input, not a cosmetic"

  printf '\n'
  printf '         local  %s\n' "$(date 2>/dev/null || echo '?')"
  printf '         utc    %s\n' "$(date -u 2>/dev/null || echo '?')"

  # ── The one check that needs NO network and no time server, and therefore
  #    the only one that still works on a box whose apt and TLS the clock has
  #    already broken: a file cannot have been written in the future.
  # NOT "$SELF". This installer file is by definition the file the operator
  # COPIED ONTO the box, and scp -p / rsync -a / tar -x / curl -R all preserve
  # the SOURCE machine's mtime — so a laptop one second ahead of a correct server
  # produced a FATAL and the SKEW prompt on a perfectly synchronised box. The two
  # left are files this box genuinely wrote itself: /var/lib/dpkg/status is
  # touched by every apt operation (on a fresh install, the install date) and
  # /etc/machine-id is stamped at first boot.
  local now newest f findings=""
  now="$(date +%s 2>/dev/null || true)"
  newest=0
  for f in /var/lib/dpkg/status /etc/machine-id; do
    local m
    # GNU form first, BSD second — the same shape as stat_mode above, so this
    # check can be driven on a laptop as well as on the box it is for.
    m="$(stat -c %Y "$f" 2>/dev/null || stat -f %m "$f" 2>/dev/null || true)"
    case "$m" in ''|*[!0-9]*) continue ;; esac
    [ "$m" -gt "$newest" ] && newest="$m"
  done
  if [ "$newest" != 0 ]; then
    findings="$(clock_sanity_verdict "$now" "$newest" || true)"
    [ -n "$findings" ] && printf '%s\n' "$findings" | sed 's/^/         /'
  fi

  if ! command -v timedatectl >/dev/null 2>&1; then
    warn "there is no timedatectl on this box, so nothing here can prove the clock is"
    warn "disciplined. Check it BY HAND against an independent source before you enrol"
    warn "admin MFA — the enrolment is the point of no return."
    return 0
  fi

  printf '\n'
  timedatectl status 2>/dev/null | sed 's/^/         /' || timedatectl 2>/dev/null | sed 's/^/         /' || true
  # timesync-status prints the MEASURED offset, which is the only number on this
  # box that is evidence rather than a boolean. It answers for systemd-timesyncd
  # only; chrony and ntpd make it fail, which is not a fault.
  timedatectl timesync-status 2>/dev/null | sed 's/^/         /' || true

  local td ntp sync can
  td="$(timedatectl show 2>/dev/null || true)"
  ntp="$(printf '%s\n' "$td"  | td_get NTP || true)"
  sync="$(printf '%s\n' "$td" | td_get NTPSynchronized || true)"
  can="$(printf '%s\n' "$td"  | td_get CanNTP || true)"

  # ── No NTP client at all. Install ONE — never chrony over a working
  #    timesyncd; two NTP clients on one box is a real misconfiguration, and
  #    timedatectl reports NTPSynchronized identically for all of them, so the
  #    verification below does not care which is installed.
  if [ "$can" = no ] && [ "$DRY" = 0 ]; then
    warn "timedatectl reports CanNTP=no: nothing on this box will ever correct the clock."
    if dpkg-query -W -f='${Status}' systemd-timesyncd 2>/dev/null | grep -q '^install ok installed$'; then
      note "systemd-timesyncd IS installed but registers no NTP unit — check for chrony or ntpsec masking it."
    else
      note "installing systemd-timesyncd"
      # `clock` is step 3 and the first apt-get update in the run is step 6, so
      # on a minimal image — precisely the kind most likely to ship no NTP client
      # — the package lists are EMPTY here and the install fails with "Unable to
      # locate package". try, so it only warns; but the operator is being told
      # they have a clock problem, and a repository error is the last thing they
      # should be reading at that moment.
      try apt-get update -qq || warn "apt-get update reported an error; the install below is the gate"
      # try, not run: if the clock is what is breaking apt, this fails, and the
      # escape hatch printed below is the answer. Dying here would hide it.
      try env DEBIAN_FRONTEND=noninteractive apt-get install -y systemd-timesyncd \
        || warn "could not install systemd-timesyncd (apt itself may be the casualty here — see below)"
    fi
    try timedatectl set-ntp true || warn "timedatectl set-ntp true failed"
    td="$(timedatectl show 2>/dev/null || true)"
    ntp="$(printf '%s\n' "$td"  | td_get NTP || true)"
    sync="$(printf '%s\n' "$td" | td_get NTPSynchronized || true)"
    can="$(printf '%s\n' "$td"  | td_get CanNTP || true)"
  fi

  # ── NTP is on but has not converged yet. On a box booted a minute ago that is
  #    NORMAL, and refusing to install because of it would be a spurious block
  #    on a perfectly healthy machine. Wait, bounded, and say what is happening.
  if [ "$DRY" = 0 ] && [ "$ntp" = yes ] && [ "$sync" != yes ]; then
    local waited=0
    note "NTP is on but the kernel does not call the clock synchronised yet — waiting up to 90s"
    while [ "$waited" -lt 90 ]; do
      sleep 5
      waited=$((waited + 5))
      sync="$(timedatectl show 2>/dev/null | td_get NTPSynchronized || true)"
      [ "$sync" = yes ] && break
      printf '         waiting for the clock to converge… %ss\n' "$waited"
    done
    # ONE authoritative read of all three from the SAME `timedatectl show`, so
    # the verdict cannot be assembled from two different instants — the loop's
    # last poll and a fresh read can disagree, and either direction is a
    # spurious answer.
    td="$(timedatectl show 2>/dev/null || true)"
    ntp="$(printf '%s\n' "$td"  | td_get NTP || true)"
    sync="$(printf '%s\n' "$td" | td_get NTPSynchronized || true)"
    can="$(printf '%s\n' "$td"  | td_get CanNTP || true)"
  fi

  local verdict
  verdict="$(clock_verdict "$ntp" "$sync" "$can" || true)"
  findings="${findings}${findings:+
}${verdict}"
  printf '\n'
  if [ -n "$verdict" ]; then
    printf '%s\n' "$verdict" | sed 's/^/         /'
  fi

  if printf '%s\n' "$findings" | grep -q '^FATAL'; then
    banner "THE CLOCK IS NOT PROVEN, AND ADMIN MFA IS A FUNCTION OF THE CLOCK"
    cat <<EOF
  Four things break, in the order this installer would hit them:

    behind        every apt source becomes "Release file is not valid yet" and
                  the packages step dies on empty package lists
    off by months TLS fails on download.docker.com and on the ghcr.io pulls,
                  with errors that name the repository
    ahead         \`openssl x509 -checkend 0\` in the cert step calls a perfectly
                  good Cloudflare Origin certificate ALREADY EXPIRED
    any drift     the first admin can never enrol MFA. It is mandatory in
                  production (ADMIN_MFA_REQUIRED defaults on and cannot be
                  turned off from .env.prod), the TOTP window is ~90 seconds,
                  and a recovery code can only be minted AFTER a TOTP code has
                  verified — bootstrap-admin.ts refuses to issue one otherwise.
                  This is the failure with no shell workaround, and it is
                  discovered after cutover.

  Fix it, in this order:

    timedatectl set-ntp true
    timedatectl timesync-status          # Offset: should be milliseconds

  If apt is ALREADY broken by the clock, that is the chicken and egg. Set the
  time by hand first, then turn NTP back on:

    timedatectl set-ntp false
    timedatectl set-time '[PLACEHOLDER: YYYY-MM-DD HH:MM:SS, from a phone]'
    timedatectl set-ntp true

  And only if apt still refuses, once:

    apt-get -o Acquire::Check-Valid-Until=false update

EOF
    printf '  This box currently believes it is:  %s  (%s)\n\n' \
      "$(date 2>/dev/null || echo '?')" "$(date -u '+%Y-%m-%d %H:%M:%SZ' 2>/dev/null || echo '?')"
    # An acknowledgement rather than a bare die, because there IS a legitimate
    # box behind this prompt: one whose egress blocks udp/123, whose clock was
    # set by hand and is CORRECT, and which will never report NTPSynchronized.
    # Refusing to install on that box would be a checklist beating a fact. It is
    # typed, not a keystroke, and it names the consequence rather than the rule.
    confirm_typed "The time printed above is CORRECT against an independent source (a phone),
     and you accept that if this clock drifts, every admin is locked out of the
     panel with an \"invalid code\" error that looks like a bad authenticator." "SKEW" \
      || die "Stopped. Fix the clock, then re-run:  $SELF --from clock"
    _logline "DECISION clock accepted unsynchronised (typed SKEW; NTP=${ntp:-?} NTPSynchronized=${sync:-?} CanNTP=${can:-?})"
    warn "continuing on an unsynchronised clock at your acknowledgement. Check it again"
    warn "immediately before you enrol admin MFA."
    return 0
  fi

  if printf '%s\n' "$findings" | grep -q '^WARN'; then
    warn "the clock is disciplined but not fully accounted for — see above."
  else
    ok "network time is on and the kernel reports the clock synchronised"
  fi

  # This is the one host fact the installer cannot keep watching after it exits,
  # so something else has to. node-exporter's timex collector scrapes
  # node_timex_sync_status; infra/monitoring/alerts.yml now carries
  # HostClockNotSynchronised ('node_timex_sync_status == 0' for 15m, critical) as
  # the rule that catches drift AFTER today.
  note "after today, drift is caught by the HostClockNotSynchronised alert"
  note "     (infra/monitoring/alerts.yml, node_timex_sync_status == 0 for 15m) — but only"
  note "     once Alertmanager has real receivers instead of [PLACEHOLDER]s. Until then it"
  note "     is visible in the Prometheus Alerts view and wakes nobody. §7.3."
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
#
# One function, two call sites, because the two branches of step_docker create
# the IDENTICAL hazard — a /etc/docker/daemon.json that a running dockerd has not
# read — and only one of them used to say so.
#
# It never restarts dockerd itself. A restart stops every container on the box,
# and this installer is explicitly designed to be re-run against a live one.
docker_daemon_json_restart_warning() {
  warn "$1"
  printf '         systemctl restart docker\n'
  printf '         %s --only firewall\n' "$SELF"
  warn "the second line is not optional: dockerd rebuilds DOCKER-USER on start, and"
  warn "libriant-origin-firewall.service is Type=oneshot RemainAfterExit=yes with no"
  warn "PartOf=docker.service, so systemd will NOT re-apply the lockdown by itself."
  warn "Restarting docker stops every container on this box — do it deliberately."
}

satisfied_docker() {
  command -v docker >/dev/null 2>&1 || return 1
  local maj
  maj="$(docker compose version 2>/dev/null | compose_major)"
  [ "${maj:-0}" -ge 2 ] 2>/dev/null || return 1
  systemctl is-active --quiet docker 2>/dev/null || return 1
  # /etc/docker/daemon.json EXISTING is the clause, not its contents. When it
  # exists this installer deliberately does not manage it (see step_docker), so
  # asserting a key inside it would leave the step permanently unsatisfied on a
  # box whose daemon.json an operator legitimately owns.
  [ -f /etc/docker/daemon.json ] || return 1
  return 0
}

step_docker() {
  say "§3.3 Docker, from Docker's own apt repository"

  # ── /etc/docker/daemon.json, written BEFORE docker-ce is installed so the
  #    daemon reads it on its very first start and no restart is ever needed on
  #    a first install. The long rationale is above docker_daemon_json; the
  #    short version is that step_firewall's die message punts the operator to
  #    "a docker daemon.json question" and this installer never wrote the file.
  run install -d -m 0755 /etc/docker
  local wrote_daemon_json=0
  if [ ! -f /etc/docker/daemon.json ]; then
    docker_daemon_json | write_file /etc/docker/daemon.json 0644 root:root
    wrote_daemon_json=1
  else
    # NEVER edit an existing one. There is no jq in BASE_PACKAGES, and a
    # half-merged daemon.json stops dockerd from starting AT ALL — a worse
    # outcome than any setting it could fix. Report per key and hand over the
    # exact JSON.
    ok "/etc/docker/daemon.json exists — reporting only, this installer will not edit it"
    local k missing=""
    for k in ip6tables log-driver log-opts; do
      if json_names_key "$k" < /etc/docker/daemon.json; then
        note "  daemon.json names \"$k\""
      else
        note "  daemon.json does NOT name \"$k\""
        missing="${missing} $k"
      fi
    done
    if [ -n "$missing" ]; then
      printf '\n  To merge by hand (keys:%s):\n\n' "$missing"
      docker_daemon_json | sed 's/^/    /'
      printf '\n'
      # ip6tables is the one with a consequence in this script: without it
      # dockerd may build no ip6tables chains, `ip6tables -S DOCKER-USER` finds
      # nothing, and step_firewall dies on "ip6tables has no jump from
      # DOCKER-USER" with nowhere to send the operator.
      docker_daemon_json_restart_warning "If you merge those keys:"
    fi
  fi

  # ── AND THE SAME WARNING FOR THE BRANCH THAT ACTUALLY WROTE THE FILE.
  #
  # It only ever appeared on the file-EXISTS path, which is backwards. The box
  # this feature was written for is one where Docker is ALREADY installed and
  # running and there is no /etc/docker/daemon.json — i.e. every re-run, and
  # every box provisioned by an earlier version of this installer, which never
  # wrote one. There the file was written, dockerd never read it, nothing said
  # so, satisfied_docker then returned 0 for ever because the file exists, and
  # step_firewall died ten steps later punting to "a docker daemon.json question"
  # while the answer sat unapplied in the scrollback.
  if [ "$wrote_daemon_json" = 1 ] && systemctl is-active --quiet docker 2>/dev/null; then
    docker_daemon_json_restart_warning \
      "dockerd was ALREADY RUNNING when that file was written, so it has NOT read it:"
  fi

  # An already-working Docker needs none of the apt machinery below, and running
  # it anyway means a network probe of download.docker.com — which, on a release
  # Docker has not published a suite for, stops to ASK which codename to pin to,
  # on a box that already has Docker. --force still does the full thing.
  if [ "$FORCE" = 0 ] && command -v docker >/dev/null 2>&1 \
     && systemctl is-active --quiet docker 2>/dev/null \
     && [ "$(docker compose version 2>/dev/null | compose_major)" -ge 2 ] 2>/dev/null; then
    ok "docker is already installed, active, and has compose v2 — skipping the apt work"
    docker --version 2>/dev/null | sed 's/^/         /' || true
    docker compose version 2>/dev/null | sed 's/^/         /' || true
    return 0
  fi

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

  # ── The three backup keys, ASKED HERE rather than at step 15.
  #
  # They are .env.prod keys, this is the .env.prod step, and the alternative is
  # asking them after the 10-20 minute build that the briefing itself tells the
  # operator to walk away from. It also means the copy taken at the pause below
  # is the FINAL file: step_backup used to append BACKUP_AGE_RECIPIENT to
  # .env.prod after the operator had already copied it into their password
  # manager, and nothing said so.
  if [ "$DRY" = 0 ]; then
    printf '\n'
    say "§8.2 (asked now, used later) — the two gates backup.sh refuses to run without"
    printf '  backup.sh stops dead without an encryption decision and a dead man'"'"'s switch.\n'
    printf '  A pg_dumpall on this box is the complete member registry of every library on\n'
    printf '  it — names, dates of birth, addresses, and the loan history of named children.\n'
    printf '  These are the last questions before the build; the backup itself runs after it.\n\n'
    configure_backup_env
  fi

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

  # Re-asserted HERE and not only in `stock`, which is fifteen steps back and is
  # skipped entirely by `--only deploy` / `--from deploy` — the resume an
  # operator takes after a build that failed. Everything since `stock` has eaten
  # into the number it printed.
  assert_build_headroom
  # And memory, for the same reason and a sharper one. RAM does not change
  # between `stock` and here, but the REACHABILITY of the advice does: a build
  # killed for memory exits 137 with no message at all, mem_verdict carries the
  # only written-down remedy (`dc build web`, then `dc build api`), and the
  # operator who most needs it is precisely the one resuming with `--only deploy`
  # — which never ran `stock`. One read of /proc/meminfo; one ok line on a box
  # with enough.
  assert_build_memory

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
  # The ONE measurement this installer is uniquely placed to take, and does not.
  # RUNBOOK §3.8's "~15-20 GiB for a cold build" was measured on the DEAD box and
  # is flagged UNVERIFIED in two places; the disk gate above rests on it; and the
  # only person who will ever stand next to a cold build with a stopwatch is
  # standing here now. Deliberately does NOT change the 25 GiB threshold — one
  # box is not a distribution — it records the number so the next argument has
  # evidence in it.
  local before_kib after_kib
  before_kib="$(df -Pk /var/lib/docker 2>/dev/null | df_avail_kib || true)"
  # shellcheck disable=SC2086
  if as_deploy bash -c "cd '$APP_DIR' && bash scripts/deploy-on-host.sh $fetch_flag"; then
    ok "the deploy script reported success"
    after_kib="$(df -Pk /var/lib/docker 2>/dev/null | df_avail_kib || true)"
    case "${before_kib:-x}${after_kib:-x}" in
      *x*) note "could not measure the build's disk footprint (df produced nothing usable)" ;;
      *)
        # Can legitimately be NEGATIVE: deploy-on-host.sh prunes images and the
        # builder cache BEFORE it builds, so a re-deploy on a box with stale
        # layers can end with MORE free space than it started with.
        note "cold build disk delta: $(( (before_kib - after_kib) / 1024 )) MiB on the filesystem holding /var/lib/docker"
        note "     (RUNBOOK §3.8's ~15-20 GiB figure is marked UNVERIFIED — this run is the"
        note "     measurement. It can be negative: the deploy prunes before it builds.)"
        _logline "MEASURED cold build disk delta $(( (before_kib - after_kib) / 1024 )) MiB (before=${before_kib} KiB avail, after=${after_kib} KiB avail)"
        docker system df 2>/dev/null | sed 's/^/         /' || true
        _logline "MEASURED docker system df: $(docker system df 2>/dev/null | tr '\n' ';' || true)" ;;
    esac
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

  # ── STOPPING HERE IS THE ONE PAUSE IN THIS SCRIPT THAT HAS AN EXPOSURE.
  #
  # Everywhere else, walking away leaves a box that is merely unfinished. From
  # this line until the `firewall` step runs, caddy is publishing 80 and 443
  # through DOCKER-USER — ahead of ufw, which is why the ufw step says its own
  # green status does not cover them — so anyone who has the IP reaches this
  # origin directly and can forge CF-Connecting-IP, which every rate limit, the
  # /apply throttle and the brute-force login lockout are keyed on. The box is
  # not in DNS, and that is not the same as unreachable: it has a public address
  # and the internet is scanned continuously.
  if ! systemctl is-enabled libriant-origin-firewall >/dev/null 2>&1; then
    warn "FROM NOW UNTIL THE 'firewall' STEP RUNS, 80 AND 443 ARE OPEN TO THE WORLD."
    warn "The next two steps are the nightly backup and that lockdown. If you have to"
    warn "stop, stop AFTER them — or apply the lockdown on its own first:"
    printf '         %s --only firewall\n' "$SELF"
  fi
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
     If the missing chain is the ip6tables one, dockerd is running without
     ip6tables support. Do not guess at it — read and fix the daemon's own file:
       cat /etc/docker/daemon.json          # it must contain \"ip6tables\": true
       # this installer WRITES that file when it is absent, and REPORTS but never
       # edits one you own. If you change it:
       systemctl restart docker             # stops every container on this box
       $SELF --only firewall                # NOT optional: dockerd rebuilds
                                            # DOCKER-USER on start and the
                                            # lockdown unit has no PartOf=
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

# ── configure_backup_env — the three .env.prod decisions backup.sh refuses to
#    run without, ASKED AT THE `env` STEP AND AGAIN HERE.
#
# THE ORDERING BUG THIS FIXES. These prompts used to live only inside
# step_backup, which is step 15 of 17 — AFTER the 10-20 minute cold build. The
# briefing tells the operator the build is 10-20 minutes and to use tmux, so the
# reasonable thing to do is walk away; they come back to a box sitting at "How
# should backups be encrypted?" and the install has made no progress at all.
# Every other question in this script is asked in the first fifteen minutes.
#
# And a second, quieter one: all three write keys into .env.prod. step_env ends
# with "COPY ${ENV_FILE} INTO THE PASSWORD MANAGER NOW" and a pause — so the copy
# the operator took was STALE the moment step_backup added BACKUP_AGE_RECIPIENT
# to the file, and nothing said so.
#
# Called from step_env (before that copy pause) and from step_backup. The second
# call is free: every branch begins by reading the value out of .env.prod and
# returns an `ok` line when it is already there, which is also what makes a
# re-run of either step cheap. env_set_if_absent never overwrites a real value.
configure_backup_env() {
  [ -f "$ENV_FILE" ] || { warn "$ENV_FILE does not exist yet — backup configuration deferred"; return 0; }

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
  return 0
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

  # Asked at the `env` step, twelve steps and a whole cold build ago, so that
  # this — the one moment an operator is most likely to have walked away — is not
  # where the installer stops for three questions. Re-run here because `--only
  # backup` is a supported entry point and because a value can have been cleared
  # since. Everything already answered prints one ok line.
  configure_backup_env
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
  # Captured, not just streamed. "read its message above" was written for a
  # terminal that has not moved; by the time the operator reaches the prompt they
  # have answered two more questions and watched a dump attempt scroll past, so
  # the one line that explains the failure is off-screen exactly when it decides
  # something. Full output still prints live; the DECIDING lines are repeated
  # immediately above the prompt that asks what to do about them.
  local pf_log="" pf_rc=0
  pf_log="$(mktemp 2>/dev/null)" || pf_log=""
  if [ -n "$pf_log" ]; then
    as_deploy_sh >"$pf_log" 2>&1 <<EOS || pf_rc=$?
set -a; . ${ENV_FILE}; set +a
$(backup_env_prefix) bash ${APP_DIR}/scripts/backup.sh --preflight
EOS
    cat "$pf_log"
  else
    as_deploy_sh <<EOS || pf_rc=$?
set -a; . ${ENV_FILE}; set +a
$(backup_env_prefix) bash ${APP_DIR}/scripts/backup.sh --preflight
EOS
  fi
  if [ "$pf_rc" = 0 ]; then
    ok "preflight passed"
    [ -n "$pf_log" ] && rm -f "$pf_log"
  else
    warn "preflight FAILED. The nightly would fail the same way, and so will the run below."
    if [ -n "$pf_log" ] && grep -qE 'ABORT|refus' "$pf_log" 2>/dev/null; then
      printf '\n'
      grep -E 'ABORT|refus' "$pf_log" | tail -6 | sed 's/^/         /'
      printf '\n'
    fi
    [ -n "$pf_log" ] && rm -f "$pf_log"
    warn "Fix it, then:  $SELF --only backup"
    # Default NO, and the wording says why: preflight checks CONFIG, so a config
    # that fails here fails identically after the minutes the real dump costs.
    # The offer remains only for the operator who has read the reason above and
    # knows it does not apply to them.
    confirm "Continue to the real run anyway (it will almost certainly fail the same way)?" \
      || return 0
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
  # `|| echo 0` inside a command substitution whose body is a PIPELINE is a trap
  # under `set -o pipefail`, and it bit here for real: when $dest does not exist,
  # `ls` fails, `wc -l` has ALREADY printed 0, and pipefail then makes the whole
  # pipeline fail — so the fallback appends a SECOND 0 and n_files becomes the
  # two-line string "0\n0". The next test said
  #     [: 0
  #     0: integer expected
  # and the operator saw "0\n0 artefacts — expected four" in the middle of a
  # failed backup, which is exactly the moment to be legible. Count the entries
  # only when the directory is there; a missing directory is 0 by construction.
  if [ -d "$dest" ]; then
    n_files="$(find "$dest" -mindepth 1 -maxdepth 1 | wc -l | tr -d ' ')"
  else
    n_files=0
  fi
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

  # ── Retention, MULTIPLIED OUT rather than quoted.
  #
  # This is the one moment in the product's life when the day-size, the
  # retention constant and the free space are all in one process. Nothing after
  # today computes it: backup.sh writes a FULL tar of the uploads tree plus a
  # full pg_dumpall every night into ${DATA_ROOT}/backups — the same filesystem
  # as the live cluster, the live uploads and Redis — and prunes at the START of
  # a run (backup.sh:289), so peak occupancy is BACKUP_KEEP_DAYS+1 day
  # directories. RUNBOOK §9.5 on the outcome: "A full data disk means Postgres
  # refuses writes: circulation stops. Treat it as a full outage." — every
  # library on the box, at once, arriving silently, because Alertmanager sits
  # behind a profile that is off while its receivers are still [PLACEHOLDER]s.
  #
  # A warning, never a gate. On day one this always says "fits", which is
  # correct and worth printing: it puts the baseline in the transcript.
  if [ "$DRY" = 0 ] && [ -d "$dest" ]; then
    local day_kib avail_kib keep state proj_kib av_kib
    day_kib="$(du -sk "$dest" 2>/dev/null | awk '{print $1}' || true)"
    avail_kib="$(df -Pk "$DATA_ROOT" 2>/dev/null | df_avail_kib || true)"
    # +1 because the prune runs at the START of a run: the day being written
    # coexists with BACKUP_KEEP_DAYS older ones for the length of the run.
    keep="$(env_get "$ENV_FILE" BACKUP_KEEP_DAYS 2>/dev/null || true)"
    case "$keep" in ''|*[!0-9]*) keep=14 ;; esac
    keep=$(( keep + 1 ))
    set -- $(retention_verdict "${day_kib:-}" "$keep" "${avail_kib:-}" || true)
    state="${1:-unknown}"; proj_kib="${2:-0}"; av_kib="${3:-0}"
    case "$state" in
      unknown) note "could not project retention (du or df produced nothing usable)" ;;
      fits)
        ok "retention projection: ${keep} x $(( ${day_kib:-0} / 1024 )) MiB = $(( proj_kib / 1024 / 1024 )) GiB against $(( av_kib / 1024 / 1024 )) GiB free on ${DATA_ROOT}" ;;
      *)
        warn "RETENTION PROJECTION IS ${state}: ${keep} day-directories x $(( ${day_kib:-0} / 1024 )) MiB"
        warn "= $(( proj_kib / 1024 / 1024 )) GiB, against $(( av_kib / 1024 / 1024 )) GiB free on ${DATA_ROOT} — the SAME"
        warn "filesystem as the live Postgres cluster, the live uploads and Redis, both of"
        warn "which grow underneath it. Three levers, all in the runbook:"
        warn "  * lower BACKUP_KEEP_DAYS in $ENV_FILE"
        warn "  * grow the logical volume (§10.1 — online, no downtime)"
        warn "  * set RCLONE_REMOTE and keep fewer local days"
        _logline "WARN retention projection ${state}: proj=${proj_kib} KiB avail=${av_kib} KiB keep=${keep}" ;;
    esac
  fi

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

  # ── WILL THIS BOX COME BACK? SEVEN separate things on it are boot-time state
  #    — docker, cron, fail2ban, the origin-lockdown unit, ufw, the clock, and
  #    the data volume's own mount — installed by six different steps, and until
  #    now not one of them was exercised as a SET. (The table below checks seven;
  #    an earlier version of this comment said six and the closing summary said
  #    six with it, which is the kind of drift that makes a reader stop counting
  #    and start assuming.) step_firewall already makes the argument for its own
  #    unit — "a unit that is enabled but fails on boot is indistinguishable
  #    from a working one until the next reboot, which will be during an
  #    incident" — and the argument generalises from that unit to the box.
  #
  #    Read-only, so --verify-only carries it, which is exactly what you run
  #    after the rehearsal reboot the closing summary asks for.
  printf '\n  Boot-time state — everything that has to come back by itself:\n'
  local u st
  for u in docker cron fail2ban libriant-origin-firewall; do
    if systemctl is-enabled "$u" >/dev/null 2>&1; then
      st="$(systemctl is-active "$u" 2>/dev/null || true)"
      printf '    ok   %-28s enabled, currently %s\n' "$u" "${st:-unknown}"
    else
      printf '    FAIL %-28s NOT enabled — it will not start after a reboot\n' "$u"
      VERIFY_RC=$((VERIFY_RC + 1))
    fi
  done
  # PIPED, not bare: ufw_is_active reads stdin, and calling it with none would
  # sit waiting on the operator's terminal for input that is never coming.
  if ufw status 2>/dev/null | ufw_is_active; then printf '    ok   %-28s active\n' ufw
  else printf '    FAIL %-28s NOT active\n' ufw; VERIFY_RC=$((VERIFY_RC + 1)); fi
  if command -v timedatectl >/dev/null 2>&1; then
    if [ "$(timedatectl show 2>/dev/null | td_get NTPSynchronized || true)" = yes ]; then
      printf '    ok   %-28s synchronised\n' 'the clock (admin TOTP)'
    else
      printf '    FAIL %-28s NOT synchronised — admin MFA enrolment will fail\n' 'the clock (admin TOTP)'
      VERIFY_RC=$((VERIFY_RC + 1))
    fi
  fi
  if data_root_mounted; then
    assert_data_root_persistent report
  else
    printf '    ..   %-28s not a separate mount (acknowledged boot-disk install?)\n' "$DATA_ROOT"
  fi
  printf '\n'

  # Not a die: --verify-only wants the firewall and backup answers even when the
  # checkout is missing, so this reports and returns rather than taking the
  # whole run down.
  if [ ! -d "${APP_DIR}/.git" ]; then
    warn "$APP_DIR is not a checkout — the §3.9 probes cannot run"
    VERIFY_RC=$((VERIFY_RC + 1))
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
  # ADDITIVE, not an assignment. The boot-state table above this function's §3.9
  # body has already counted into VERIFY_RC, and `VERIFY_RC="$rc"` WIPED it:
  # a box with nothing enabled, ufw down, an unsynchronised clock and a data
  # volume that does not survive a reboot printed seven FAIL lines and then
  # `--verify-only` said "verification clean" and exited 0 — on the exact box the
  # closing summary now names --verify-only as the post-reboot check for.
  VERIFY_RC=$((VERIFY_RC + rc))

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
    stock)    printf '§3.1   Take stock (host name, RAM, disk, the timezone)' ;;
    clock)    printf 'The clock — NTP on, and SYNCHRONISED (admin TOTP)' ;;
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

EOF

  # ── THE REBOOT REHEARSAL, AND WHY IT IS CONDITIONAL.
  #
  # This block used to be unconditional, ninety-odd lines above the banner that
  # says the data volume DOES NOT SURVIVE A REBOOT. Read in order, the summary
  # told the operator to reboot and then told them what the reboot would cost —
  # and the chain it costs is the one this whole installer is most careful about:
  # an empty /mnt/libriant on the root disk, a stack that refuses to start, and a
  # catastrophe one `mkdir -p` away, that `mkdir -p` being the command
  # docker-compose.volume.yml itself tells you to run. So the rehearsal is only
  # OFFERED when the volume will actually come back.
  if data_root_mounted && [ -z "$(data_root_fstab_entry)" ] && ! data_root_mount_unit_enabled; then
    cat <<EOF
  DO NOT REBOOT THIS BOX YET.
    ${DATA_ROOT} is mounted and NOTHING brings it back — no /etc/fstab entry and
    no enabled .mount unit. A reboot right now leaves an empty directory on the
    boot disk where the database was. Fix that first (see the banner below),
    THEN rehearse the reboot, which is a thing worth doing while it is free.

EOF
  else
    cat <<EOF
  REHEARSE THE REBOOT NOW, WHILE IT IS FREE.
    Seven things on this box are boot-time state, installed by six different
    steps, and the only test that covers all seven at once is a reboot: docker,
    cron, fail2ban, the origin-lockdown unit, ufw, the clock, and the data
    volume's own mount. The box is not in DNS, so today that costs two minutes
    and nobody notices. The first UNPLANNED reboot will be during an incident,
    and it is a poor moment to discover that the data volume did not remount or
    that the origin lockdown unit fails on this kernel.

      sudo reboot
      # then, when it is back:
      findmnt ${DATA_ROOT}   # must name the DEVICE, not the root filesystem
      timedatectl            # NTP: yes, System clock synchronized: yes
      systemctl is-active docker cron fail2ban libriant-origin-firewall
      ufw status verbose
      sudo bash $SELF --verify-only
      # and the external scan again, from your laptop, over both families

    \`--verify-only\` already IS the post-reboot check — it re-runs §3.9, the
    firewall parser, the backup status and the boot-state table. It simply was
    never named as one.

EOF
  fi

  cat <<EOF
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

  THE CLOUDFLARE IP RANGES ARE HARDCODED IN THREE PLACES AND ROT SILENTLY.
    When Cloudflare publishes a new range, the origin firewall DROPs legitimate
    edge traffic from those POPs: partial 522s that look like a Cloudflare
    problem rather than an origin one. Nothing here refreshes the list.
      https://www.cloudflare.com/ips
      ${APP_DIR}/scripts/prod-bootstrap.sh   CF_V4 / CF_V6
      ${APP_DIR}/infra/caddy/Caddyfile        the (origin_guard) snippet
    All three must be edited together, and afterwards:  $SELF --only firewall
    (the unit is RemainAfterExit=yes, so it will not re-apply itself).

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
  # ── The data volume, and the clock. Both are read off the MACHINE here rather
  #    than remembered from a step, because the operator may have declined the
  #    offer, or answered on a previous run, or hand-edited /etc/fstab since.
  if data_root_mounted && [ -z "$(data_root_fstab_entry)" ] && ! data_root_mount_unit_enabled; then
    banner "THE DATA VOLUME DOES NOT SURVIVE A REBOOT"
    printf '  %s is mounted and there is no /etc/fstab entry and no enabled\n' "$DATA_ROOT"
    printf '  .mount unit. After the next reboot it is an empty directory on the boot disk,\n'
    printf '  the whole stack refuses to start, and the catastrophe is one `mkdir -p` away —\n'
    printf '  the very command docker-compose.volume.yml tells you to run. Fix it before you\n'
    printf '  walk away:  %s --only stock\n\n' "$SELF"
  fi
  if command -v timedatectl >/dev/null 2>&1 \
     && [ "$(timedatectl show 2>/dev/null | td_get NTPSynchronized || true)" != yes ]; then
    banner "THE CLOCK IS NOT SYNCHRONISED, AND ADMIN MFA IS A FUNCTION OF THE CLOCK"
    printf '  Admin TOTP has a ~90-second acceptance window, MFA is mandatory in production,\n'
    printf '  and a recovery code can only be minted after a TOTP code has already verified.\n'
    printf '  If this clock drifts you get an admin panel nobody can enter, and the symptom\n'
    printf '  is "invalid code" — which reads as a bad QR or a bad phone.\n'
    printf '    timedatectl set-ntp true   then   %s --only clock\n\n' "$SELF"
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
