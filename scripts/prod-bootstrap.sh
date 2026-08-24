#!/bin/sh
# Libriant - one-shot production bootstrap.
#
# Run by the compose `migrate` service before api/worker start (gated via
# `depends_on: condition: service_completed_successfully`). Idempotent, so it
# is safe to run on every deploy - that is exactly what makes deploys
# self-bootstrapping:
#
#   1. control-plane migrations     (FATAL - api can't serve without the schema)
#   2. seed cells/plans/feature-keys (FATAL - signup needs a cell + plans)
#   3. help-centre ingest           (best-effort)
#   4. existing-tenant migrations   (best-effort; new tenants self-migrate at
#                                    signup, and a manual fan-out always exists)
#   5. first admin                  (only if ADMIN_BOOTSTRAP_* are set)
#
# Migrations + seed run against Postgres DIRECTLY (PG_SUPERUSER_URL), never
# through pgbouncer: Prisma Migrate takes a session-level advisory lock that a
# transaction-mode pooler silently breaks.
#
# THREE modes do not run in the container. All are run as root ON THE HOST:
#   --firewall-only         apply the origin lockdown now
#   --firewall-status       show what is currently applied, and what to check
#   --firewall-install-unit make the lockdown survive a reboot (systemd)
# See origin_firewall() below for why they are here, why they are opt-in, and
# why ufw alone cannot do this.
set -eu

# ---------------------------------------------------------------------------
# Origin lockdown (authn-authz-01 / input-and-files-02 / input-and-files-03)
#
# This is the PRIMARY control. The edge matcher in infra/caddy/Caddyfile and the
# peer check in apps/api/src/platform/client-ip.ts are the two layers behind it,
# and they exist because this one is a hand-run script that can be flushed by a
# `docker network` change or a reboot. But only this layer can keep a hostile
# packet away from Caddy in the first place, and the IPv6 bypass below is the
# proof that the edge cannot be trusted to do it alone.
#
# Cloudflare's published ranges - https://www.cloudflare.com/ips. The SAME list
# is in infra/caddy/Caddyfile's (origin_guard) snippet; update both together.
# ---------------------------------------------------------------------------
CF_V4="173.245.48.0/20 103.21.244.0/22 103.22.200.0/22 103.31.4.0/22 141.101.64.0/18
108.162.192.0/18 190.93.240.0/20 188.114.96.0/20 197.234.240.0/22 198.41.128.0/17
162.158.0.0/15 104.16.0.0/13 104.24.0.0/14 172.64.0.0/13 131.0.72.0/22"
CF_V6="2400:cb00::/32 2606:4700::/32 2803:f800::/32 2405:b500::/32 2405:8100::/32
2a06:98c0::/29 2c0f:f248::/32"
LOCAL_V4="127.0.0.0/8 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16"
LOCAL_V6="::1/128 fc00::/7 fe80::/10"

# Public IPv6 to 80/443 is DROPPED outright by default - not narrowed to
# Cloudflare, dropped. Pass --allow-ipv6 to admit the Cloudflare v6 ranges
# instead, but read this first, because the default is the fix for the bypass
# that defeated the first attempt at all three findings:
#
#   The box has a public v6 address (2a01:4f8:13b:ac8::2). Docker publishes
#   443 on [::] as well as 0.0.0.0, but no compose network sets `enable_ipv6`,
#   so the caddy container has no v6 address of its own. A v6 connection
#   therefore cannot be DNATed to the container - it is carried by Docker's
#   USERLAND PROXY (`docker-proxy`), a process on the HOST, which accepts the v6
#   connection and opens a brand new IPv4 connection to the container FROM THE
#   BRIDGE GATEWAY. Two consequences, both fatal:
#     1. Caddy sees a private source address for every v6 client, so the
#        `private_ranges` arm of the edge matcher admitted them and their forged
#        CF-Connecting-IP became the rate-limit key. A verifier drove 25 logins
#        with rotating headers into 25 separate buckets through this path.
#     2. The connection never traverses FORWARD, so DOCKER-USER never sees it.
#        Every rule below that lives only in DOCKER-USER is invisible to it.
#        That is why the hook now also inserts into INPUT.
#   Even with the Cloudflare v6 ranges allowed and INPUT filtered, legitimate
#   Cloudflare traffic arriving over v6 would still reach Caddy from the bridge
#   gateway - collapsing every v6-carried visitor into ONE rate-limit bucket.
#   That is a self-inflicted outage, not a defence. So: no public v6 to 80/443
#   until the compose network has `enable_ipv6: true` (or the published ports
#   are bound to 0.0.0.0 explicitly, which removes the v6 listener entirely).
#   While this is in force the origin must NOT have proxied AAAA records - see
#   docs/RUNBOOK.md 3.2c and 5.4. Visitors still reach Cloudflare over IPv6;
#   only the Cloudflare-to-origin hop is v4.
ALLOW_PUBLIC_IPV6="no"

# Build/refresh the LIBRIANT-ORIGIN chain for one address family and hook it
# into BOTH DOCKER-USER and INPUT. Idempotent: the chain is flushed and each
# jump re-inserted on every run, so running this twice leaves exactly one of
# each rule.
apply_origin_chain() {
  bin="$1"
  allow="$2"

  # `iptables -N` on a fresh box needs the filter table to exist for this
  # family; if the binary cannot talk to the kernel at all, say so and stop
  # rather than half-applying.
  if ! "$bin" -S INPUT >/dev/null 2>&1; then
    echo "[bootstrap] FATAL: $bin cannot read the filter table - is this address family enabled in the kernel?" >&2
    exit 1
  fi

  "$bin" -N LIBRIANT-ORIGIN 2>/dev/null || "$bin" -F LIBRIANT-ORIGIN
  # Replies to connections we already accepted must never be re-judged.
  "$bin" -A LIBRIANT-ORIGIN -m conntrack --ctstate RELATED,ESTABLISHED -j RETURN
  for cidr in $allow; do
    "$bin" -A LIBRIANT-ORIGIN -s "$cidr" -j RETURN
  done
  "$bin" -A LIBRIANT-ORIGIN -j DROP

  # INPUT catches the userland-proxy path (docker-proxy is a host process, so
  # its inbound connection is INPUT, never FORWARD). DOCKER-USER catches the
  # normal DNAT path (published ports traverse FORWARD, and DOCKER-USER is the
  # one chain Docker guarantees it will not rewrite). Neither alone is enough,
  # and `ufw allow`/`ufw deny` is neither: Docker's DNAT rules are inserted
  # ahead of ufw's INPUT jump, so a ufw rule does not filter a published port.
  # Inserting at position 1 of INPUT puts us ahead of ufw's own jumps too, so
  # this works whether ufw is active or (as on this box today) inactive.
  for parent in INPUT DOCKER-USER; do
    if ! "$bin" -S "$parent" >/dev/null 2>&1; then
      echo "[bootstrap] WARN: $bin has no $parent chain - is Docker running with this address family enabled? Skipping $parent." >&2
      continue
    fi
    while "$bin" -D "$parent" -p tcp -m multiport --dports 80,443 -j LIBRIANT-ORIGIN 2>/dev/null; do :; done
    while "$bin" -D "$parent" -p udp --dport 443 -j LIBRIANT-ORIGIN 2>/dev/null; do :; done
    "$bin" -I "$parent" 1 -p tcp -m multiport --dports 80,443 -j LIBRIANT-ORIGIN
    "$bin" -I "$parent" 1 -p udp --dport 443 -j LIBRIANT-ORIGIN # HTTP/3
    echo "[bootstrap] $bin: LIBRIANT-ORIGIN applied to $parent (80/tcp, 443/tcp+udp)."
  done
}

# Defence in depth behind the app's own trust boundary
# (apps/api/src/platform/client-ip.ts) and Caddy's origin_guard: with those two
# in place a forged CF-Connecting-IP is already worthless, and this stops it
# arriving at all.
#
# DELIBERATELY NOT run as part of a deploy. A DROP rule built from a list that
# has drifted takes the whole site offline, and this one has never executed on a
# live box - putting it in the automatic path would make every deploy a gamble
# on a control nobody has watched work. Run it by hand, then verify from OFF the
# box (`nmap -Pn -p 80,443 <origin-v4>` from a non-Cloudflare address must show
# filtered, and `nmap -6 -Pn -p 80,443 <origin-v6>` must show filtered) with a
# second SSH session open.
origin_firewall() {
  require_root
  if ! command -v iptables >/dev/null 2>&1; then
    echo "[bootstrap] FATAL: iptables not found - this mode runs on the HOST, not in the migrate container." >&2
    exit 1
  fi
  echo "[bootstrap] applying origin lockdown: Cloudflare ranges + private ranges only ..."
  apply_origin_chain iptables "$CF_V4 $LOCAL_V4"
  if ! command -v ip6tables >/dev/null 2>&1; then
    # Not a warning any more. Without ip6tables the box's public IPv6 address
    # is an unfiltered second front door to the same ports, which is exactly
    # the hole this mode exists to close - refuse rather than half-close it.
    echo "[bootstrap] FATAL: ip6tables not found, but the box has public IPv6." >&2
    echo "[bootstrap] Install iptables/ip6tables (apt-get install -y iptables) and re-run;" >&2
    echo "[bootstrap] a v4-only lockdown is not a lockdown." >&2
    exit 1
  fi
  if [ "$ALLOW_PUBLIC_IPV6" = "yes" ]; then
    echo "[bootstrap] --allow-ipv6: admitting Cloudflare IPv6 ranges. Only correct once the"
    echo "[bootstrap] compose network sets enable_ipv6 - otherwise every v6 visitor shares one"
    echo "[bootstrap] rate-limit bucket (see the comment above ALLOW_PUBLIC_IPV6)."
    apply_origin_chain ip6tables "$CF_V6 $LOCAL_V6"
  else
    echo "[bootstrap] dropping ALL public IPv6 to 80/443 (the userland-proxy bypass)."
    apply_origin_chain ip6tables "$LOCAL_V6"
  fi
  echo "[bootstrap] origin lockdown applied."
  echo "[bootstrap] These rules do NOT survive a reboot, and 'docker network' changes can"
  echo "[bootstrap] recreate DOCKER-USER. Run --firewall-install-unit so systemd reapplies"
  echo "[bootstrap] them after docker.service on every boot, and re-run this after any"
  echo "[bootstrap] compose network change."
  echo "[bootstrap] Verify from OFF the box: nmap -Pn -p 80,443 <origin-v4> must show filtered,"
  echo "[bootstrap] and nmap -6 -Pn -p 80,443 <origin-v6> must show filtered."
}

# What is actually in force right now. Reads only - safe to run any time, and
# the first thing to run when the site 522s or when "is the origin locked down?"
# needs an answer that is not a guess.
origin_firewall_status() {
  require_root
  for bin in iptables ip6tables; do
    command -v "$bin" >/dev/null 2>&1 || { echo "[bootstrap] $bin: NOT INSTALLED"; continue; }
    echo "--- $bin: LIBRIANT-ORIGIN ---"
    "$bin" -S LIBRIANT-ORIGIN 2>/dev/null || echo "  (chain absent - the lockdown is NOT applied)"
    echo "--- $bin: jumps into it ---"
    { "$bin" -S INPUT 2>/dev/null; "$bin" -S DOCKER-USER 2>/dev/null; } | grep LIBRIANT-ORIGIN \
      || echo "  (no jump - the chain exists but nothing sends traffic to it)"
  done
  echo
  echo "[bootstrap] A chain with jumps from BOTH INPUT and DOCKER-USER is what 'applied' means."
  echo "[bootstrap] On-box output proves nothing about the internet: confirm with an external"
  echo "[bootstrap] nmap over both address families."
}

# Reapply on boot. Not iptables-persistent / netfilter-persistent on purpose:
# those save and restore the WHOLE table, Docker's generated chains included,
# and restoring a stale copy of Docker's rules before dockerd has rebuilt them
# is its own outage. Re-running the script after docker.service is up rebuilds
# exactly our chain from the list in this file and nothing else.
origin_firewall_install_unit() {
  require_root
  script_path=$(cd "$(dirname "$0")" && pwd)/$(basename "$0")
  if [ ! -f "$script_path" ]; then
    echo "[bootstrap] FATAL: cannot resolve my own path ($script_path) to write a unit for." >&2
    exit 1
  fi
  cat > /etc/systemd/system/libriant-origin-firewall.service <<UNIT
[Unit]
Description=Libriant origin lockdown (Cloudflare-only 80/443, v4 + v6)
# The chain hooks into DOCKER-USER, which does not exist until dockerd has
# built it, so this must run after Docker - not just after the network.
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/bin/sh $script_path --firewall-only

[Install]
WantedBy=multi-user.target
UNIT
  systemctl daemon-reload
  systemctl enable libriant-origin-firewall.service
  echo "[bootstrap] installed + enabled libriant-origin-firewall.service (runs $script_path --firewall-only after docker.service)."
  echo "[bootstrap] It reads the Cloudflare list from that file, so a git pull changes what it applies."
  echo "[bootstrap] NOTE: the unit does NOT pass --allow-ipv6. If you deliberately admitted the"
  echo "[bootstrap] Cloudflare v6 ranges, edit ExecStart to match, or the next reboot silently"
  echo "[bootstrap] reverts to dropping public IPv6 and Cloudflare starts seeing 522s over v6."
  echo "[bootstrap] Test it now: systemctl start libriant-origin-firewall && systemctl status libriant-origin-firewall"
}

require_root() {
  if [ "$(id -u)" != "0" ]; then
    echo "[bootstrap] FATAL: this mode must run as root (try sudo)." >&2
    exit 1
  fi
}

for arg in "$@"; do
  case "$arg" in
    --allow-ipv6) ALLOW_PUBLIC_IPV6="yes" ;;
  esac
done

case "${1:-}" in
  --firewall-only)
    origin_firewall
    exit 0
    ;;
  --firewall-status)
    origin_firewall_status
    exit 0
    ;;
  --firewall-install-unit)
    origin_firewall_install_unit
    exit 0
    ;;
esac

cd /app

# Point the Prisma CLI + seed client straight at Postgres for DDL.
export CONTROL_DATABASE_URL="${PG_SUPERUSER_URL:-${CONTROL_DATABASE_URL:-}}"

# Fail fast + legibly if neither URL is set — otherwise Prisma dies with an
# opaque "Environment variable not found" that, run as a detached one-shot, is
# easy to mistake for a migration error.
if [ -z "${CONTROL_DATABASE_URL:-}" ]; then
  echo "[bootstrap] FATAL: neither PG_SUPERUSER_URL nor CONTROL_DATABASE_URL is set — cannot run migrations or seed." >&2
  exit 1
fi

echo "[bootstrap] applying control-plane migrations ..."
if ! pnpm db:migrate:deploy; then
  echo "[bootstrap] FATAL: control-plane migration failed. If this is a P3009 'failed migration' or drift, inspect with 'prisma migrate status' and resolve with 'prisma migrate resolve' before redeploying." >&2
  exit 1
fi

echo "[bootstrap] seeding cells, feature keys, plans ..."
if ! pnpm db:seed; then
  echo "[bootstrap] FATAL: control-plane seed failed." >&2
  exit 1
fi

echo "[bootstrap] ingesting help-centre articles (best-effort) ..."
pnpm ingest:help || echo "[bootstrap] help ingest skipped (non-fatal)"

echo "[bootstrap] migrating existing tenant databases (best-effort) ..."
pnpm tenant:migrate || echo "[bootstrap] tenant migrate skipped (non-fatal)"

if [ -n "${ADMIN_BOOTSTRAP_EMAIL:-}" ] && [ -n "${ADMIN_BOOTSTRAP_PASSWORD:-}" ]; then
  echo "[bootstrap] ensuring first admin (${ADMIN_BOOTSTRAP_EMAIL}) ..."
  pnpm admin:bootstrap || echo "[bootstrap] admin bootstrap failed (non-fatal)"
else
  echo "[bootstrap] ADMIN_BOOTSTRAP_* not set - skipping admin creation"
fi

echo "[bootstrap] done."
