# Superseded — see [RUNBOOK.md](RUNBOOK.md)

This was the full build-and-deploy runbook. It has been replaced, in full, by **[docs/RUNBOOK.md](RUNBOOK.md)** —
specifically §1–§5 (machine, stack, first deploy, configuration, DNS/TLS).

**Do not follow the old version.** It was written for a server that no longer
exists and for CI-driven deploys that are switched off. A pre-release audit on
2026-08-23 found **122 incorrect statements** across these five documents — not
stale in tone, wrong in ways that mislead during an incident. Three that recurred:

- `/healthz` on the public hosts was presented as an "is the app up" check. It is
  a static `200` answered by Caddy before any proxying, and stays green through a
  total outage.
- Every capacity threshold described the previous machine, unverified.
- The Grafana tunnel named the wrong port.

The replacement is built from the current machine's **measured** facts
(`docs/runbook-rewrite-2026-08-23/HOST-FACTS.md`) and 323 cited findings
(`RECON.json`), and it flags at each instruction where an audit blocker means the
step cannot succeed yet.

The original 1041 lines remain in git history:

```bash
git log --follow -p -- docs/deployment-hetzner.md
```

---

## One correction that post-dates the rewrite: the origin trust boundary

Both this document and **RUNBOOK.md §3.2** describe the origin as unprotected,
and RUNBOOK.md §3.2c carries a `BLOCKER authn-authz-01` note saying no
Cloudflare restriction exists "in ufw, in any script, or at the edge". Two of
those three are now false — the control moved into code on 2026-08-24. What
follows is what the code actually does; §3.2c's note needs the same edit.

**1. The API no longer believes a forwarded header from just anyone.**
`apps/api/src/platform/client-ip.ts` honours `X-Real-IP` only when the immediate
TCP peer is a trusted proxy, and `main.ts` hands Express the same predicate
instead of `trust proxy: true`. The default trust set is loopback plus the
private ranges, which is exactly the compose topology (the API is only ever
reached from the Caddy container). `TRUSTED_PROXY_CIDRS` narrows it further —
a comma-separated list of CIDRs or bare addresses; a malformed value fails boot
rather than silently trusting nobody. **Nothing needs to be set for the standard
deploy.** A request that reaches the API from a public address is keyed on that
public address, whatever its headers claim.

**2. Caddy refuses origin traffic on every route that reaches the API.**
`infra/caddy/Caddyfile` defines a `(cloudflare_only)` snippet — a `remote_ip`
matcher over Cloudflare's published ranges plus `private_ranges` — imported at
the top of each `route` that proxies to `api:3001` (app host, admin host, and
the marketing site's `/apply`). Non-Cloudflare peers get a 403 before
`header_up X-Real-IP` runs. `private_ranges` is what keeps the on-host deploy
health checks (`curl --resolve libriant.com:443:127.0.0.1`) working.

If legitimate traffic ever starts getting 403s at the edge, check
<https://www.cloudflare.com/ips> against that snippet before anything else.

**3. The host firewall is now a script, not a paragraph — but it is opt-in.**

```bash
sudo sh /opt/libriant/scripts/prod-bootstrap.sh --firewall-only
```

It builds a `LIBRIANT-ORIGIN` chain (Cloudflare + private ranges RETURN,
everything else DROP) and hooks it into **`DOCKER-USER`** for 80/tcp and
443/tcp+udp, in both `iptables` and `ip6tables`. `DOCKER-USER` rather than ufw
because Docker's published-port rules sit ahead of ufw's INPUT chain — the point
RUNBOOK.md §3.2c makes correctly, and the reason `ufw allow from <cf-range>`
would have done nothing.

It is deliberately **not** part of the deploy. A DROP rule built from a range
list that has drifted takes the whole site down, and this one has never run on a
live box. Run it by hand, with a second SSH session already open, then verify
from **off** the box:

```bash
nmap -Pn  -p 80,443 <origin-v4>    # both must be filtered
nmap -6 -Pn -p 80,443 <origin-v6>
```

The rules do not survive a reboot. Re-run after one, or persist them.

Steps 1 and 2 are what actually close the finding — a forged `CF-Connecting-IP`
is worthless once the app checks its peer. Step 3 is defence in depth, and the
only one of the three that also stops direct-to-origin access to the web app
itself.
