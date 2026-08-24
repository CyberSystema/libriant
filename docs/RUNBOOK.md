# Libriant operations runbook — 195.201.13.95

The single authority for building, running, breaking and fixing Libriant on this
machine. It replaces `docs/deployment-hetzner.md` and `docs/server-handbook.md`
and absorbs what is still true from `docs/cutover-three-hosts.md`,
`docs/deploy-from-the-server.md` and `docs/billing-go-live.md`. Where those
documents disagree with this one, they are wrong — most of them describe
178.104.32.176, which no longer exists.

Written 2026-08-23. Hardware facts are measured, not remembered
(`docs/runbook-rewrite-2026-08-23/HOST-FACTS.md`). Anything unmeasured is
labelled **UNVERIFIED** where you would use it, never smoothed over.

---

## State of the world, 2026-08-23

Read this before you touch anything.

|                |                                                                                                                                                                 |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The box        | Bare. No docker, no `deploy` user, no `/srv/libriant`. `/mnt/libriant` is mounted and empty.                                                                    |
| Firewall       | **`ufw` is inactive.** Port 22 is open to the internet with nothing in front of it.                                                                             |
| SSH            | **`passwordauthentication yes`.** Root is key-only; every other account can be brute-forced.                                                                    |
| The stack      | **Has never run anywhere — not on a server, not in CI.**                                                                                                        |
| Does it start? | **No.** `BLOCKER supply-chain-06`. See §3.0.                                                                                                                    |
| Deploys        | Manual, from the box: `scripts/deploy-on-host.sh`. The GitHub workflow is `workflow_dispatch`-only and its `DEPLOY_KNOWN_HOSTS` secret still pins the dead box. |
| DNS            | `libriant.com` → Cloudflare, origin unreachable (522). `admin.libriant.com` exists and is equally dead. **`app.libriant.com` does not exist.**                  |
| Email          | `EMAIL_DRIVER=console`. Nothing is delivered, and the body is withheld from logs. `BLOCKER launch-readiness-01`.                                                |
| Billing        | `BILLING_ENABLED=false`, `STRIPE_DRIVER=fake`. The fake driver is an unauthenticated remote-write hole. `BLOCKER billing-02`.                                   |
| Backups        | None. Nothing installs the cron.                                                                                                                                |
| Alerting       | None. Nothing reaches a human.                                                                                                                                  |

Nine of the twelve audit blockers block public launch. **Do not put this box in
DNS.** A first deploy on a private, not-in-DNS box is legitimate and useful; a
cutover is not, yet.

**Emergency shortcuts:** [§9 When it breaks](#9-when-it-breaks) ·
[§11 Quick reference](#11-quick-reference)

---

## 1. The machine

Measured on the box, 2026-08-23. Re-measure with the commands in §11 if you
suspect drift.

|          |                                                                                               |
| -------- | --------------------------------------------------------------------------------------------- |
| Address  | `195.201.13.95`                                                                               |
| CPU      | Intel Xeon E3-1275 v6 @ 3.80 GHz — 4 cores / 8 threads                                        |
| RAM      | 62 GiB usable, 1.0 GiB in use at rest                                                         |
| Swap     | 8 GiB on LVM (`vg0-swap`), 0 B used                                                           |
| Disks    | 2 × 476.9 GB NVMe in **software RAID1** — `md0` (1 GiB) → `/boot`, `md1` (475.8 GiB) → LVM PV |
| RAID     | Both arrays `[UU]`. Healthy.                                                                  |
| OS       | Ubuntu 26.04 LTS, kernel 7.0.0-30-generic                                                     |
| Timezone | **Europe/Berlin**                                                                             |

### Storage

```
vg0 (475.81 GiB PV on md1)
├── vg0-root   80 GiB  ext4  /              3.0G used of 79G   (4%)
├── vg0-data  250 GiB  ext4  /mnt/libriant   28K used of 246G  (1%)
└── vg0-swap    8 GiB  swap  [SWAP]
    137.81 GiB UNALLOCATED  ← the growth headroom (§10)
```

`/mnt/libriant` is a real separate filesystem (`/dev/mapper/vg0-data`, ext4,
`rw,relatime`), currently an **empty directory owned by `root:root`**. None of
the four bind-mount targets the compose overlay needs exist yet.

Two consequences worth internalising:

- The data volume is genuinely separate, so "backups on `/mnt/libriant` can't
  fill `/`" is true here. The boot disk is 80 GiB and carries `/var/lib/docker`
  — images, container logs and the Caddy access log all land there (§9.5).
- 137.81 GiB is unallocated in the same volume group, so `/mnt/libriant` can be
  grown online with no downtime and no provider ticket.

### Network

|           |                                                         |
| --------- | ------------------------------------------------------- |
| Interface | `enp0s31f6`                                             |
| IPv4      | `195.201.13.95/32`                                      |
| IPv6      | `2a01:4f8:13b:ac8::2/64` — **public IPv6**              |
| Listening | port 22 only (plus `systemd-resolved` on 127.0.0.53/54) |

IPv6 is the easy thing to miss. DNS needs `AAAA` records or IPv6 clients silently
never reach the host, and a firewall written only for IPv4 leaves v6 wide open.

### Installed / not installed

| Present                                   | Absent                                                   |
| ----------------------------------------- | -------------------------------------------------------- |
| `git` 2.53.0, `curl` 8.18.0, `ufw` 0.36.2 | **docker**, **docker compose**, node, pnpm, psql, rclone |

No `deploy` user. No `docker` group. No `/srv/libriant`. No containers, images or
volumes. No backup cron. No monitoring.

### Timezone decision

The box is on **Europe/Berlin**; the customers are in Greece (UTC+3 to Berlin's
UTC+2). Everything below — cron times, log timestamps, the backup window — is
**Berlin time**. A backup at 02:15 Berlin runs at 03:15 for a Greek library.
That is fine and deliberate. If you would rather reason in Athens time, change
it once, before the first deploy, and re-read every cron line in this document:

```bash
sudo timedatectl set-timezone Europe/Athens
timedatectl   # verify, then update this section
```

---

## 2. What you are operating

Eight compose services. Seven long-running, one one-shot. **Three** images built
on this box — `libriant-caddy`, `libriant-api`, `libriant-web` — and **three**
pulled: `postgres:16-alpine`, `edoburu/pgbouncer:v1.25.2-p0`, `redis:8-alpine`.
`migrate` and `worker` both reuse the `libriant-api` image, which is why eight
services need only six images.

Compose files, always both, always in this order:

```
infra/compose/docker-compose.prod.yml    the stack
infra/compose/docker-compose.volume.yml  rebinds 4 volumes onto /mnt/libriant
```

### The services

| Service     | Image                                                                        | Networks      | Limits (mem / cpu / pids) | Healthcheck                                           | What the healthcheck actually proves                                                                                                                                                                                                                                                                        |
| ----------- | ---------------------------------------------------------------------------- | ------------- | ------------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `caddy`     | built `libriant-caddy` (base `caddy:2-alpine`, **bakes the marketing site**) | edge, app     | 256m / 1 / 256            | `wget localhost:80/healthz` 30s/5s/5, no start_period | **Only that the Caddy process is alive.** Static 200. Stays green through a total outage.                                                                                                                                                                                                                   |
| `migrate`   | built `libriant-api`                                                         | **data only** | none / none / none        | none                                                  | — one-shot, must exit 0                                                                                                                                                                                                                                                                                     |
| `api`       | built `libriant-api`                                                         | app, data     | 1g / 1.5 / 1024           | `wget localhost:3001/readyz` 15s/5s/8, start 30s      | Real: Redis `PING` **and** `SELECT 1` on the control DB.                                                                                                                                                                                                                                                    |
| `web`       | built `libriant-web`                                                         | **app only**  | 768m / 1 / 512            | `wget localhost:3000/api/healthz` 15s/5s/8, start 30s | **Nothing.** A constant `{status:'ok'}`. Touches no dependency, not even the API.                                                                                                                                                                                                                           |
| `worker`    | built `libriant-api`                                                         | app, data     | 1g / 1 / 512              | `wget localhost:3002/readyz` 30s/5s/5, start 20s      | Real: all five BullMQ consumers running **and** Redis `PING`.                                                                                                                                                                                                                                               |
| `postgres`  | `postgres:16-alpine`                                                         | data          | 2g / 2 / 512              | `pg_isready -U libriant -d libriant_control`          | The cluster accepts connections.                                                                                                                                                                                                                                                                            |
| `pgbouncer` | `edoburu/pgbouncer:v1.25.2-p0`                                               | data          | 256m / 0.5 / 256          | `pg_isready -h localhost -p 5432 -U libriant`         | **Nothing useful** — the pooler answers this itself without touching Postgres, and nothing gates on it (`api` waits for `service_started`). UNVERIFIED whether `pg_isready` even exists in this image; if it does not, the container sits permanently `unhealthy` while working perfectly. Do not chase it. |
| `redis`     | `redis:8-alpine`                                                             | data          | 512m / 1 / 256            | `redis-cli ping`                                      | Redis responds.                                                                                                                                                                                                                                                                                             |

Caps sum to **5888 MiB (5.75 GiB)** and **8.0 cpus** against 62 GiB and 8 threads
— comfortable, with room to raise (§10.2). The compose file's own comment says
these "suit a ~4 GB host"; that arithmetic is wrong and the comment predates this
machine. Ignore it.

`migrate` has **no** memory, cpu or pid cap.

### The networks

| Network | Members                                              | Properties                                                          |
| ------- | ---------------------------------------------------- | ------------------------------------------------------------------- |
| `edge`  | caddy                                                | bridge                                                              |
| `app`   | caddy, api, web, worker                              | bridge, **has internet egress**                                     |
| `data`  | postgres, pgbouncer, redis, api, worker, **migrate** | bridge, **`internal: true` — no route to the host or the internet** |

Two consequences that explain most confusing failures:

- `web` is on `app` only. It **cannot reach Postgres or Redis at all**, by
  design. Everything it needs comes from `api`.
- `migrate` is on `data` only. It has **no internet egress**. This is why
  `supply-chain-06` cannot be worked around on the box (§3.0).

Only `caddy` publishes host ports: `80:80/tcp`, `443:443/tcp`, `443:443/udp`.
Docker publishes on `0.0.0.0` **and** `[::]`, and inserts rules into `DOCKER-USER`
ahead of ufw's INPUT chain — so a `ufw` rule does **not** filter 80/443. See §3.2.

### The start order

```
postgres  ──(healthy)──┬──> pgbouncer ──(started, not healthy)──┐
                       │                                        │
                       └──> migrate ──(must exit 0)──┬──> api ──(healthy)──> web ──(started)──┐
                                                     │           ▲                            │
redis ──(healthy)──────────────────────────────────► └──> worker │                            └──> caddy
                                                                 └──── redis (healthy)
```

Exactly:

- `pgbouncer` → postgres healthy
- `migrate` → postgres healthy **only**
- `api` → migrate **completed successfully** + postgres healthy + pgbouncer _started_ + redis healthy
- `worker` → migrate **completed successfully** + postgres healthy + redis healthy (**not** pgbouncer, even though its control URL points at it)
- `web` → api healthy
- `caddy` → web _started_ + api _started_ — deliberately loosened so an app outage cannot take the marketing site down

**If `migrate` does not exit 0, api / worker / web never start** and `dc ps`
shows them as `Created`, not `Restarting`. That reads like a different failure
than it is.

### Restart policy — read this once and remember it

Every long-running service is `restart: unless-stopped`; `migrate` is
`restart: 'no'`.

`unless-stopped` restarts a container when its **process exits**. Docker does
**not** restart a container that merely fails its healthcheck, and there is no
autoheal sidecar. An `api` marked `unhealthy` will sit there unhealthy, serving
500s, forever, and nothing will tell you.

`unless-stopped` also does not restart a container you stopped by hand. **`dc stop`
followed by a reboot leaves the stack down until you run `dc up -d`.**

### What `/healthz` is, and is not

The `(maintenance_check)` snippet is imported by the app, admin **and** marketing
vhosts. It matches `/healthz`, `/readyz`, `/metrics` and answers `respond "ok" 200`
**at the edge**. Caddy never contacts `api` or `web` for those paths.

> `curl https://app.libriant.com/healthz` returning 200 proves that Caddy is
> alive and TLS terminated. Nothing else. It stays 200 with api, web, postgres
> and redis all dead.

The same is true of the plaintext `:80` probe block, which is what the caddy
container healthcheck hits — a self-test that cannot go red while Caddy runs.

Real signals, in descending order of trust:

1. `docker inspect --format '{{.State.Health.Status}}'` on `api` and `worker`.
2. `api:3001/readyz` and `worker:3002/metrics` from inside the `app` network.
3. A real page: `https://libriant.com/pricing`, `https://app.libriant.com/`.

`/lbr-api/healthz`, `/lbr-api/readyz` and `/lbr-api/metrics` are correctly 404'd
at the edge, and the API additionally 404s `/metrics` for any request carrying
`x-real-ip`, `x-forwarded-for` or `x-forwarded-host`. Prometheus must scrape
`api:3001` directly on the private network.

### The four Caddy vhosts

| Host                                   | Serves                                                    | Notes                                                                                      |
| -------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `{$PUBLIC_HOST}` = `app.libriant.com`  | the product                                               | `handle_path /lbr-api/*` → api:3001, `handle /webhooks/*` → api:3001, catch-all → web:3000 |
| `{$ADMIN_HOST}` = `admin.libriant.com` | the admin panel                                           | same `/lbr-api/*`; `/` → 302 `/admin/login`; no `/webhooks` handler                        |
| `{$SITE_HOST}` = `libriant.com`        | the static marketing site, **baked into the caddy image** | no `/lbr-api/*` on purpose; only `/apply` and `/en/apply` proxy to api:3001                |
| `www.{$SITE_HOST}`                     | permanent redirect to apex                                | imports **neither** header snippet                                                         |

Plus a plaintext `http://` block that answers `/healthz` `/readyz` with `ok` 200
and permanently redirects everything else to HTTPS.

Because the marketing site is baked into the image: changing marketing copy is a
**rebuild**, a broken site build fails the deploy at `dc build`, and a Caddy
base-image CVE patch is a rebuild rather than a `pull`. The site build is strict
— it refuses to emit while `apps/site/site.config.json` contains a
`[PLACEHOLDER]`. It contains none today, but `privacy-legal-01` will make you
edit that file; if you leave a placeholder in it, **the Caddy image build fails**,
not just the legal page.

**UNVERIFIED — Caddy directive order.** Caddy sorts directives by its own global
order, not source order. If the catch-all `handle { reverse_proxy web:3000 }`
were evaluated before `handle_path /lbr-api/*`, every browser API call would fall
through to Next.js — whose production rewrite target is the _public_ origin — and
loop out through Cloudflare rather than failing cleanly. The Caddyfile records
two prior surprises from exactly this mechanism. Verify before the first cutover:

```bash
docker run --rm -v /srv/libriant/app/infra/caddy/Caddyfile:/etc/caddy/Caddyfile:ro \
  -e PUBLIC_HOST=app.libriant.com -e ADMIN_HOST=admin.libriant.com \
  -e SITE_HOST=libriant.com -e ACME_EMAIL=ops@libriant.com \
  caddy:2-alpine caddy adapt --config /etc/caddy/Caddyfile --adapter caddyfile --pretty
```

Good looks like: within the `app.libriant.com` route list, the `/lbr-api/*`
matcher appears **before** the unmatched catch-all to `web:3000`.

### Volumes and bind mounts

Six named volumes. The overlay rebinds **four** onto the data disk:

| Volume         | Host path                                           | On                           |
| -------------- | --------------------------------------------------- | ---------------------------- |
| `pg_data`      | `/mnt/libriant/postgres`                            | data disk                    |
| `redis_data`   | `/mnt/libriant/redis`                               | data disk                    |
| `storage`      | `/mnt/libriant/storage`                             | data disk                    |
| `caddy_data`   | `/mnt/libriant/caddy`                               | data disk                    |
| `caddy_config` | `/var/lib/docker/volumes/...`                       | **boot disk**                |
| `caddy_logs`   | `/var/lib/docker/volumes/libriant_caddy_logs/_data` | **boot disk**, up to ~1.4 GB |

Docker's local driver with `o: bind` does **not** create a missing device path,
so an unmounted data volume is a loud failure rather than a silently-fresh
database on the boot disk. `deploy-on-host.sh` pre-checks all four and dies with
the real cause.

**The origin certificate lives inside `caddy_data`.**
`/mnt/libriant/caddy/origin/{origin.crt,origin.key}` is bind-mounted read-only at
`/etc/caddy/origin`, and the same directory is also Caddy's `/data`. Anyone
"cleaning out" `/data` or `/mnt/libriant/caddy` deletes the certificate, and
every subsequent deploy hard-fails. It is in **no backup**.

Bind mounts, complete: caddy gets the Caddyfile, `maintenance.html`, `<repo>/assets`
and the origin dir; api / web / worker get `<repo>/assets` and `<repo>/locales`;
`migrate` gets `<repo>/scripts` → `/app/scripts` and `<repo>/locales` → `/app/locales`
(different mount points); postgres gets `postgres-init.sql`.

Two facts hidden in there:

- The `assets` and `locales` mounts on **`web` are inert**. The web service sets
  neither `ASSETS_ROOT` nor `LOCALES_ROOT`, so Next.js uses the copies baked into
  the image. Hot-swapping assets on the host works for the API and for Caddy's
  `/_assets/*` file server, **not** for Next.js pages.
- Because `migrate` bind-mounts the host checkout's `scripts/`, the bootstrap
  that runs is the **host checkout's** code against the **image's** node_modules.
  With `--skip-build` those can be different commits.

### Postgres, pgbouncer, Redis specifics

- **Postgres** `postgres:16-alpine`, user `libriant`, db `libriant_control`,
  started with `shared_preload_libraries=pg_stat_statements` and
  `max_connections=200`. `postgres-init.sql` creates `unaccent`, `pg_trgm`,
  `pg_stat_statements`, `pgcrypto`, `citext` and a `libriant_demo` database —
  **but only when PGDATA is empty**. After a restore, or on any existing cluster,
  that file never runs.
  `LANG=el_GR.UTF-8` is set and the compose comment claims Greek collation.
  **UNVERIFIED and probably a no-op** — Alpine/musl ships no locale definitions,
  so initdb records the name and collation falls back to byte order. Do not
  promise Greek sorting to a customer on the strength of that comment.
- **pgbouncer** transaction pooling, `scram-sha-256`, `MAX_CLIENT_CONN=500`,
  `DEFAULT_POOL_SIZE=20`, fronting **only** `libriant_control`. Tenant databases
  do not go through it. Migrations deliberately bypass it via `PG_SUPERUSER_URL`
  → `postgres:5432`, because Prisma Migrate's session-level advisory lock is
  silently broken by a transaction-mode pooler.
- **Redis** `redis:8-alpine`, `--appendonly yes`, `--maxmemory-policy allkeys-lru`
  with **no `--maxmemory`** — which makes the policy inert. That is deliberate
  (Redis also backs the BullMQ queues; eviction would drop live job keys) but it
  means there is no soft landing between "fine" and "cgroup-OOM-killed", and a
  killed Redis is a 100% outage (§9.3).

---

## 3. First deploy, from bare metal

### 3.0 It does not currently succeed. Read this first.

`BLOCKER supply-chain-06` — **the stack builds but does not run.**

`package.json:6` declares `"packageManager": "pnpm@11.22.0"`. All three
Dockerfiles run `corepack prepare pnpm@9.15.4 --activate`. Corepack always
honours the nearest `package.json` and ignores `prepare --activate`, so the pin
is inert. In the API runtime stage (`FROM base`, not `deps`) the only pnpm ever
written into `COREPACK_HOME=/opt/corepack` is 9.15.4; the directory is root-owned
and `a+rX` (readable, **not** writable) and the process runs as `USER node`. So
`prod-bootstrap.sh` → `pnpm db:migrate:deploy` makes corepack try to fetch and
cache 11.22.0, it cannot write the cache, and it exits 1.

And it cannot fetch anyway: `migrate` is on the `data` network, which is
`internal: true`. **No egress.** There is no host-side workaround —
`deploy-on-host.sh` does `git reset --hard` on every run and would discard a
local edit, and `package.json` is baked into the image regardless.

What you actually see:

```
▸ docker compose up
...
[bootstrap] FATAL: control-plane migration failed. If this is a P3009 'failed
migration' or drift, inspect with 'prisma migrate status' and resolve with
'prisma migrate resolve' before redeploying.
✗ compose up failed.
```

**Ignore the P3009 advice — it is a red herring.** Scroll up in the dumped
migrate log for the real line:

```
Failed to create cache directory. Please ensure the user has write access to
the target directory (/opt/corepack/v1)
```

Nothing is left half-applied: `migrate` exits before touching the database.

**The fix, before any of §3 is worth doing** (commit it, then deploy):

1. `apps/api/Dockerfile:30`, `apps/web/Dockerfile:9`, `infra/caddy/Dockerfile:16`
   → `corepack prepare pnpm@11.22.0 --activate`.
2. Add `ENV COREPACK_HOME=/opt/corepack` and `chmod -R a+rX` to the **web** image.
   Today the web container's PID 1 _is_ corepack: it has no `COREPACK_HOME`, so it
   downloads pnpm from npmjs.org **on every container start**, on the boot path.
   Every web restart currently depends on npmjs.org being up.
3. Add the `+sha224.<hash>` integrity suffix to `package.json:6`.
4. Add a CI job that builds the api image and runs
   `docker run --rm --user node <img> pnpm --version`. Nothing in CI builds or
   runs these images today, which is why this was invisible.

Verify locally before you push:

```bash
docker build -f apps/api/Dockerfile -t lbr-api-probe . \
  && docker run --rm --user node --network none -w /app lbr-api-probe pnpm --version
```

Good looks like: `11.22.0`, exit 0. That `--network none` is the point — it
reproduces the `data` network's isolation.

Everything below assumes that fix has landed. Steps 3.1–3.7 are safe and useful
regardless; **3.8 is the one that fails today.**

### 3.1 Get on the box and take stock

```bash
ssh root@195.201.13.95
```

```bash
uptime; free -h; df -h / /mnt/libriant; lsblk; cat /proc/mdstat
ufw status verbose
sshd -T | grep -E '^(permitrootlogin|passwordauthentication|pubkeyauthentication) '
```

Good looks like: matches §1. `[UU]` in `/proc/mdstat`. `ufw` says `inactive` and
sshd says `passwordauthentication yes` — both of which you are about to fix.

### 3.2 Harden — do this before anything is worth stealing

**a. SSH: turn off password authentication.** Find where it is set first;
OpenSSH uses the _first_ value it obtains, and drop-ins are read in lexical
order, so a `99-` file cannot override a `50-cloud-init.conf`.

```bash
sudo grep -rn -i '^\s*passwordauthentication' /etc/ssh/sshd_config /etc/ssh/sshd_config.d/
```

Comment out every hit you find, then add the authoritative drop-in:

```bash
sudo tee /etc/ssh/sshd_config.d/00-libriant.conf >/dev/null <<'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
PubkeyAuthentication yes
EOF
sudo sshd -t && sudo systemctl reload ssh
sudo sshd -T | grep -E '^(passwordauthentication|kbdinteractiveauthentication|permitrootlogin) '
```

Good looks like: `passwordauthentication no`, `kbdinteractiveauthentication no`,
`permitrootlogin prohibit-password`.

> **Keep your current SSH session open.** Open a _second_ Termius session and
> confirm you can still log in before you close the first. If you cannot, the
> first session is the only thing standing between you and a rescue boot.

**b. ufw: turn it on, with IPv6.** The box has public IPv6; a v4-only ruleset
leaves v6 open.

```bash
grep -i '^IPV6=' /etc/default/ufw     # must be IPV6=yes
# If it is not, fix it BEFORE enabling — ufw only reads this at enable time:
#   sudo sed -i 's/^IPV6=.*/IPV6=yes/' /etc/default/ufw
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 22/tcp comment 'ssh'
sudo ufw --force enable
sudo ufw status verbose
```

Good looks like: `Status: active`, default deny incoming, and **two** rules for
22 — `22/tcp` and `22/tcp (v6)`.

**c. Understand what ufw does not protect.** Once Docker is installed and the
stack is up, the caddy container publishes 80/443 through the `DOCKER-USER`
chain, **ahead of ufw's INPUT chain**. `ufw deny 80` will not close port 80.
The only check that cannot be fooled is an external scan from your laptop:

```bash
# from your laptop, NOT from the box
nmap -Pn -p 22,80,443,5432,6379,3300,9090 195.201.13.95
nmap -6 -Pn -p 22,80,443 2a01:4f8:13b:ac8::2
```

Good looks like, today: only 22 open. After the first deploy: 22, 80, 443 open,
and **nothing else** — in particular 5432 and 6379 must never appear (the `data`
network is `internal: true`, so they cannot be published even by accident).

> **`authn-authz-01` — the origin lockdown, and the three layers it needs.**
> Every rate limit, the `/apply` throttle and the brute-force login lockout are
> keyed on `X-Real-IP`, which Caddy sets from `CF-Connecting-IP`. Anyone who can
> reach the origin IP directly and forge that header reshapes all of them. As of
> 2026-08-24 there are three layers against that, and **all three have to hold**:
>
> 1. **The firewall.** `prod-bootstrap.sh --firewall-only` builds a
>    `LIBRIANT-ORIGIN` chain in `DOCKER-USER` — not in ufw, which Docker bypasses
>    — through **both `iptables` and `ip6tables`. A missing `ip6tables` is fatal,
>    not a warning**, because this box has a public IPv6 address. Add
>    `--allow-ipv6` only once AAAA records exist.
> 2. **The published ports.** `docker-compose.prod.yml` publishes on
>    `${EDGE_BIND_IPV4:-0.0.0.0}`, not the bare `443:443`. This is the layer that
>    is easiest to lose and the least obvious: the wildcard form also opens a
>    `[::]` listener, and because no compose network sets `enable_ipv6`, Docker
>    carries those v6 connections through the **userland proxy**, which
>    re-originates every one of them from the bridge gateway. The edge then sees
>    a private address, trusts it, and the header forgery works again over IPv6
>    while looking perfectly locked down over IPv4. This is not hypothetical — it
>    is how the first fix for this finding was defeated.
> 3. **The edge.** Every backend route in the Caddyfile imports `origin_guard`,
>    which matches on `remote_ip` (the connection) rather than on a header. One
>    route — `/webhooks/*` — shipped without it. `pnpm check:caddy` now fails the
>    build if any `reverse_proxy` to `api:` or `web:` lacks a guard.
>
> **Verify, do not assume** (§3.2c's scan is the outside view; this is the inside
> one):
>
> ```bash
> sudo bash scripts/prod-bootstrap.sh --firewall-status
> # must print a LIBRIANT-ORIGIN chain with jumps from BOTH INPUT and DOCKER-USER,
> # for both address families, and: "ok: no [::] listener"
> ```
>
> If that last line instead warns about a `[::]` listener, layer 2 has reverted
> and layers 1 and 3 do not cover the gap on their own. Fix the compose publish
> form before anything else.
>
> Still true, and still the only check that cannot be fooled: an external scan
> over **both** address families from a machine that is not this one.

**d. Baseline packages.**

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl git openssl fail2ban unattended-upgrades
sudo systemctl enable --now fail2ban
sudo systemctl is-active fail2ban unattended-upgrades
```

`git`, `curl` and `openssl` are not optional: `deploy-on-host.sh` only checks for
`docker`, and a missing `git` or `openssl` fails mid-run with a bare
`command not found` rather than a named precondition.

### 3.3 Docker

Ubuntu 26.04 is new. **UNVERIFIED** whether Docker's apt repo has published a
suite for this release; check before trusting the convenience script.

```bash
. /etc/os-release && echo "codename=$VERSION_CODENAME"
curl -fsSI "https://download.docker.com/linux/ubuntu/dists/$VERSION_CODENAME/Release" | head -1
```

Good looks like: `HTTP/1.1 200 OK`. If it 404s, pin to the previous LTS codename
deliberately and write down that you did.

```bash
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
  | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg
. /etc/os-release && echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
https://download.docker.com/linux/ubuntu $VERSION_CODENAME stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
docker --version && docker compose version
```

Good looks like: `Docker version 2x.x`, `Docker Compose version v2.x`. Compose
**v2** is required — the stack uses the non-Swarm `mem_limit` / `cpus` /
`pids_limit` keys, which only v2 honours.

### 3.4 The deploy user

Still in the root session from §3.1:

```bash
sudo adduser --disabled-password --gecos "" deploy
sudo usermod -aG docker deploy
sudo install -d -m 700 -o deploy -g deploy /home/deploy/.ssh
sudo cp /root/.ssh/authorized_keys /home/deploy/.ssh/authorized_keys
sudo chown deploy:deploy /home/deploy/.ssh/authorized_keys
sudo chmod 600 /home/deploy/.ssh/authorized_keys
```

**Give `deploy` sudo, and give it a password so sudo can authenticate.** This
step is easy to skip and everything after it breaks without it: `--disabled-password`
puts a `!` in the shadow field, so even after `usermod -aG sudo` every `sudo`
in this document fails with _"deploy is not in the sudoers file"_ or an
unpassable password prompt. Roughly a third of the commands below — the
directory creation in §3.5, the origin-cert `tee` in §3.7b, the backup cron in
§8.2, `du`/`iptables` in §9, `lvextend` in §10.1 — are `sudo`.

```bash
sudo usermod -aG sudo deploy
sudo passwd deploy      # choose a strong one; store it in the password manager
```

Setting a password does **not** re-open SSH password login: §3.2a turned
`PasswordAuthentication` off, so the password is usable only at a `sudo` prompt
on an already-authenticated key session.

Log out and back in **as `deploy`** — group membership is not retroactive:

```bash
ssh deploy@195.201.13.95
id            # expect: groups=...(sudo),...(docker)
docker ps     # expect: an empty table, not a permission error
sudo -v       # expect: it accepts the password you just set
```

**Everything from §3.5 onward runs as `deploy`**, using `sudo` where shown.

> `deploy-on-host.sh` checks only `command -v docker`. If `deploy` is not
> effectively in the `docker` group, preflight passes, the two prune calls
> swallow the permission error with `|| true`, and the failure surfaces much
> later at `dc build` as _permission denied while trying to connect to the Docker
> daemon socket_. Prove `docker ps` works now.

### 3.5 Directories

```bash
sudo mkdir -p /srv/libriant
sudo chown deploy:deploy /srv/libriant
sudo mkdir -p /var/log/libriant
sudo chown deploy:deploy /var/log/libriant

sudo mkdir -p /mnt/libriant/{postgres,redis,storage,caddy/origin,backups}
sudo chown -R 1000:1000 /mnt/libriant/storage       # ← required, enforced by nothing
sudo chown deploy:deploy /mnt/libriant/backups
ls -la /mnt/libriant
```

> **`chown 1000:1000 /mnt/libriant/storage` is the step that gets forgotten.**
> api and worker run as `USER node` = uid 1000, and Docker does not chown a bind
> mount. Skip it and you get a **fully healthy stack** that throws `EACCES` on
> the first cover upload — because `/readyz` checks Postgres and Redis and never
> touches storage. 1000 is the container's uid; it is not necessarily `deploy`'s.
> Postgres and Redis do **not** need this — their images start as root and chown
> their own data dirs.
>
> `deploy-on-host.sh` enforces `postgres`, `redis`, `storage`, `caddy`. It does
> **not** check `backups`. Nothing in the deploy path touches backups at all.

### 3.6 The checkout

The repo is private, so an HTTPS clone will not work — and `deploy-on-host.sh`
runs `git fetch origin` as `deploy` on **every** deploy, so a one-off credential
is not enough. Use a read-only GitHub Deploy Key.

As `deploy`:

```bash
ssh-keygen -t ed25519 -f ~/.ssh/github-deploy -N '' -C 'libriant deploy@195.201.13.95'
cat ~/.ssh/github-deploy.pub
```

Add that public key to GitHub → `CyberSystema/libriant` → Settings → Deploy keys
→ **read-only**. Then:

```bash
cat >> ~/.ssh/config <<'EOF'
Host github.com
  IdentityFile ~/.ssh/github-deploy
  IdentitiesOnly yes
EOF
chmod 600 ~/.ssh/config
ssh -T git@github.com
git clone git@github.com:CyberSystema/libriant.git /srv/libriant/app
cd /srv/libriant/app && git log -1 --format='%h %ad %s' --date=iso
```

Two things about that `ssh -T` that will make you think it failed when it did not:

- It is the **first** connection to github.com from this box, so it prompts
  `Are you sure you want to continue connecting?`. Type `yes` — or pre-seed the
  key with `ssh-keyscan github.com >> ~/.ssh/known_hosts` and compare the
  fingerprint against GitHub's published SSH key fingerprints first.
- On success it prints `Hi CyberSystema/libriant! You've successfully
authenticated, but GitHub does not provide shell access.` **and exits 1.**
  A non-zero exit here is the correct outcome; do not chase it.

Good looks like: a clone, and `git ls-remote --exit-code origin HEAD` exits 0.

### 3.7 `.env.prod` and the origin certificate

**a. Mint the secrets — interactively, exactly once.**

```bash
bash /srv/libriant/app/scripts/ensure-env.sh /srv/libriant/.env.prod
```

Run it **without** `--auto`, because `--auto` never prompts and the two values a
human must supply are the difference between a green deploy and one you cannot
log into:

| Prompt                     | Why it matters                                                                                                                        |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `ADMIN_BOOTSTRAP_EMAIL`    | Without it, no admin is created. `deploy-on-host.sh` prints a yellow warning.                                                         |
| `ADMIN_BOOTSTRAP_PASSWORD` | Without it, no admin is created and **nothing warns at all**. Minimum 12 characters (`bootstrap-admin.ts` exits non-zero below that). |

It prompts for `IMAGE_OWNER` first. **Leave it blank** — it is only an image-name
namespace for the GHCR path this box does not use (§4.6), and the template ships
it as the placeholder `your-github-owner`.

`prod-bootstrap.sh` creates the admin only when **both** values are non-empty.

The script generates and never overwrites: `SESSION_SECRET`, `HASH_PEPPER`,
`ADMIN_SESSION_SECRET`, `IMPERSONATION_SECRET`, `STORAGE_SIGNING_SECRET`,
`MFA_MASTER_KEY` (hex-32 each) and `POSTGRES_PASSWORD` (hex-24). It `umask 077`s,
`chmod 600`s the file, then copies any key present in `.env.prod.example` but
absent from your file.

Verify, then **immediately** copy the whole file into the password manager:

```bash
stat -c '%a %U:%G' /srv/libriant/.env.prod    # expect: 600 deploy:deploy
```

> **From this moment the host holds the only copy.** `backup.sh` deliberately
> does not capture `.env.prod` (a stolen backup would otherwise be total
> compromise). Three values are **irrecoverable if lost**: `MFA_MASTER_KEY` (the
> only decryptor of stored admin TOTP secrets — and MFA is mandatory in
> production with no recovery codes), `POSTGRES_PASSWORD` (the live cluster is
> keyed to it) and the origin certificate pair. See §4.4.

**b. Place the Cloudflare Origin certificate.**

Cloudflare dashboard → SSL/TLS → Origin Server → Create Certificate. Hostnames
must be **both** `libriant.com` **and** `*.libriant.com`. Save both PEM blocks to
the password manager first, then:

```bash
sudo tee /mnt/libriant/caddy/origin/origin.crt >/dev/null <<'PEM'
-----BEGIN CERTIFICATE-----
...
-----END CERTIFICATE-----
PEM
sudo tee /mnt/libriant/caddy/origin/origin.key >/dev/null <<'PEM'
-----BEGIN PRIVATE KEY-----
...
-----END PRIVATE KEY-----
PEM
sudo chmod 640 /mnt/libriant/caddy/origin/origin.crt
sudo chmod 600 /mnt/libriant/caddy/origin/origin.key
sudo chown root:root /mnt/libriant/caddy/origin/origin.*
openssl x509 -in /mnt/libriant/caddy/origin/origin.crt -noout -subject -issuer -dates -ext subjectAltName
```

Good looks like: issuer `CloudFlare Origin SSL Certificate Authority`, SANs
`DNS:libriant.com, DNS:*.libriant.com`, `notAfter` roughly 15 years out.

> The deploy checks only that the two **files exist**. An expired certificate, or
> one whose SANs omit `*.libriant.com`, produces a fully green deploy and then a
> Cloudflare **526** on every host. Nothing monitors this. Put the expiry in your
> calendar now, and add the check to your monthly rhythm (§6.7).

### 3.8 Deploy

**Set up the `dc` helper first (§6.1).** Everything from §3.9 onward is written
in terms of it, and the deploy itself does not create it. It is four lines in
`~/.bashrc`; go and add them now, then come back.

Dry run first — it runs every precondition check and prints the commit and tag
without touching anything:

```bash
cd /srv/libriant/app
bash scripts/deploy-on-host.sh --dry-run
```

Then, for real:

```bash
bash scripts/deploy-on-host.sh
```

> **Do not use `--skip-build` on a first deploy.** With no locally built images
> Compose falls back to pulling `ghcr.io/libriant/libriant-*:<sha>`, which does
> not exist. Nothing publishes to GHCR while deploys are manual.
>
> **Do not use `dc pull`.** Same reason. Every old document that says `dc pull`
> then `dc up -d` is wrong.

What the script does, in order:

1. Preconditions: checkout, `.env.prod`, `$DATA_ROOT` and its four subdirs,
   docker, both origin PEMs, and a warning on an empty `ADMIN_BOOTSTRAP_EMAIL`.
2. `git fetch origin` + `git reset --hard origin/main` — **host-local edits to
   tracked files are destroyed**. Pass `--no-fetch` to deploy the tree as-is.
3. Computes `IMAGE_TAG` = 12-char short SHA, `-dirty` if the tree is unclean.
   It is exported **after** sourcing `.env.prod` so the file's `IMAGE_TAG=latest`
   cannot clobber it.
4. `ensure-env.sh --auto`, then `set -a; . /srv/libriant/.env.prod; set +a`.
5. `docker image prune -af --filter 'until=72h'` and
   `docker builder prune -f --filter 'until=72h'`, both `|| true`.
6. `dc build` — 10–20 min cold. Budget ~15–20 GB in `/var/lib/docker`
   (**UNVERIFIED on this box**; measured on the dead machine).
7. `caddy validate` in a throwaway container, **before** anything is recreated.
8. `dc up -d --remove-orphans --force-recreate`, dumping the last 200 lines of
   migrate logs on failure. ← **fails today, `supply-chain-06`**
9. `dc exec caddy caddy reload`, falling back to recreating caddy.
10. A 180-second local health gate.

The health gate polls five signals every 5 s: `http://localhost/healthz` == 200,
`curl -sk --resolve libriant.com:443:127.0.0.1 https://libriant.com/` == 200, and
Docker health `healthy` for api, web and worker. It touches no public DNS, and on
timeout **it does not roll back**.

**Good looks like** — these are the script's literal strings:

```
▸ Healthy: origin + marketing site + api + web + worker
<dc ps table>
Deployed a1b2c3d4e5f6. This box is not in DNS yet, so nothing is public.
```

While it is still waiting you get one line every 5 s in the other shape —
`waiting… edge=200 site=000 api=starting web=starting worker=starting`. That
line is the _pending_ form, not the success form; the run has only succeeded
when you see `▸ Healthy:` and the `Deployed <tag>` line.

**But do not over-read it.** `web=healthy` is the constant healthcheck: a wrong
`API_INTERNAL_URL` or a broken `app` network passes the gate green while every
page renders an error. `api=healthy` and `worker=healthy` are real.

### 3.9 Post-deploy checks the script does not do

```bash
dc ps
dc logs migrate | tail -40
```

Read the migrate log properly. Only two steps are **fatal**: control-plane
`db:migrate:deploy` and `db:seed`. These are **best-effort and still exit 0**:

| Step              | If it silently fails                                             |
| ----------------- | ---------------------------------------------------------------- |
| `ingest:help`     | help articles missing                                            |
| `tenant:migrate`  | **live libraries left on an old schema** — re-run by hand (§6.5) |
| `admin:bootstrap` | **a green deploy nobody can log into**                           |

Any line reading `skipped (non-fatal)` is a job for you.

Then prove the things nothing else proves:

```bash
# uploads are writable by the container user
dc exec -T api sh -c 'touch /srv/libriant/storage/.probe && rm /srv/libriant/storage/.probe && echo STORAGE-OK'

# the web → api hop, which no healthcheck crosses
dc exec -T web sh -c 'wget -qO- http://api:3001/healthz' && echo WEB-TO-API-OK

# a real page, not a static probe
curl -sk --resolve libriant.com:443:127.0.0.1 -o /dev/null -w '%{http_code}\n' https://libriant.com/pricing
```

Good looks like: `STORAGE-OK`, `WEB-TO-API-OK`, `200`.

> `STORAGE-OK` proves the **directory** is writable by uid 1000. It does not
> prove uploads work. **`BLOCKER data-integrity-01`: every file upload returns
> HTTP 500 in the launch configuration** — the unlimited-plan `MAX_SAFE_INTEGER`
> sentinel overflows a Postgres `bigint`. Do not conclude from a green storage
> probe that a librarian can attach a cover image (§9.9).

**Logging into the admin panel before cutover is harder than it sounds — plan
for it.** The box is not in DNS, and a browser cannot be given `--resolve`. The
obvious workaround, a `/etc/hosts` line on your laptop pointing
`admin.libriant.com` at `195.201.13.95`, walks straight into two walls:

1. Caddy serves the **Cloudflare Origin CA** certificate, which no browser
   trusts (§5.2). You would have to install Cloudflare's Origin CA root into
   that machine's trust store.
2. Worse, the apex has asserted `includeSubDomains` HSTS and the pin is
   probably already in your browser (§5.3). An HSTS certificate error is
   **non-bypassable** — no "proceed anyway" button exists.

So pick one deliberately:

- **Defer it.** Do the cutover (§5.4) first and log in over real DNS. This is
  the normal choice, and it is why the deploy prints _"nothing is public"_
  rather than _"you are live"_.
- **Or** use a browser profile that has never seen `libriant.com`, with
  Cloudflare's Origin CA root installed and a `hosts` entry. Check the pin
  first at `chrome://net-internals/#hsts` → Query domain.

Either way, **MFA enrolment needs a browser** — it is mandatory in production
and cannot be disabled from `.env.prod` (`ADMIN_MFA_REQUIRED` is one of the
never-injected variables, §4.1). What you _can_ confirm from the box right now
is that the admin actually exists:

```bash
dc logs migrate | grep -i admin      # a line naming the email, not "not set - skipping"
dc exec -T postgres psql -U libriant -d libriant_control -tAc \
  "select email, role, status from admin_users;"
```

### 3.10 The nightly backup — a green deploy has none

Nothing installs it. Do it now, in the same sitting. §8.2.

---

## 4. Configuration

### 4.1 How configuration actually reaches a container

Three layers, and one rule that explains most surprises:

```
/srv/libriant/.env.prod
        │  set -a; . /srv/libriant/.env.prod; set +a       (deploy-on-host.sh)
        ▼
   shell environment
        │  ${VAR} interpolation in docker-compose.prod.yml
        ▼
   container environment
```

> **Compose injects only the variables it literally names.** A key you add to
> `.env.prod` that is not referenced in the `x-app-env` block **never reaches any
> container.** The compose file says this twice, in scar-tissue comments.

There is **no `env_file`** and no `--env-file` anywhere in the tooling, and
because `.env.prod` lives at `/srv/libriant/` rather than next to the compose
file, Compose's automatic `.env` discovery never fires either. Running
`docker compose ... up` without sourcing the file fails immediately on
`${POSTGRES_PASSWORD:?}`.

Three categories of variable, and knowing which is which saves an hour:

| Category                                                           | Count | Effect of editing `.env.prod`                                                                                                                                                                                                                           |
| ------------------------------------------------------------------ | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Pass-through** — named in compose, sourced from the file         | 27    | Works.                                                                                                                                                                                                                                                  |
| **Compose literals** — hard-coded in the compose file              | 13    | **Silently ignored.** `NODE_ENV`, `CONTROL_DATABASE_URL`, `REDIS_URL`, `PUBLIC_APP_URL`, `TENANT_PATH_PREFIX`, `SESSION_COOKIE_SECURE`, `STORAGE_ROOT`, `ASSETS_ROOT`, `LOCALES_ROOT`, `BILLING_RETURN_URL`, `BCRYPT_COST`, `PG_SUPERUSER_URL`, `PORT`. |
| **Never injected** — the app reads them, compose never passes them | 20    | **Silently ignored.** The code default always wins.                                                                                                                                                                                                     |

The never-injected set, in full, so you stop trying:
`ADMIN_COOKIE_NAME`, `ADMIN_MFA_REQUIRED`, `ADMIN_SESSION_TTL_SEC`,
`BILLING_GRACE_PERIOD_DAYS`, `EMAIL_MAX_ATTEMPTS`, `IMPERSONATION_COOKIE_NAME`,
`LOGIN_LOCKOUT_MS`, `MAX_FAILED_LOGINS`, `SESSION_ABSOLUTE_MAX_TTL_SEC`,
`SESSION_COOKIE_NAME`, `SESSION_REMEMBER_TTL_SEC`, `SESSION_TTL_SEC`,
`STORAGE_MAX_UPLOAD_BYTES`, `STORAGE_SIGNED_TTL_SEC`, `SUPPORT_KEY_TTL_SEC`,
`SUPPORT_SESSION_TTL_SEC`, `TENANT_CACHE_TTL_SEC`, `TENANT_CLIENT_CACHE_SIZE`,
`TENANT_CLIENT_IDLE_MS`, `RATE_LIMIT_DISABLED`.

(`RATE_LIMIT_DISABLED` being unreachable is a _safety_ property, and there are two
further in-code guards: the API refuses to boot in production if it is set, and
the rate limiter logs an error and ignores it.)

Changing any never-injected value means **editing the compose file**, which means
a commit — `deploy-on-host.sh` will `git reset --hard` a host-local edit away.

`bool()` accepts only `true`, `1`, `yes`, `on` (lower-cased, trimmed). Anything
else — `enabled`, `y`, `True ` with trailing junk — resolves to **false with no
warning**. That is how `BILLING_ENABLED` is parsed.

### 4.2 Hard requirements

Six keys are `${VAR:?}` at the **compose** layer. A missing one aborts
`docker compose up` before any container is created, with a named error:

`POSTGRES_PASSWORD`, `HASH_PEPPER`, `SESSION_SECRET`, `ADMIN_SESSION_SECRET`,
`IMPERSONATION_SECRET`, `MFA_MASTER_KEY`.

`MFA_MASTER_KEY` is additionally validated at boot against `/^[0-9a-fA-F]{64}$/`
— a typo exits the process with
`Env var MFA_MASTER_KEY must be 64 hex characters (a 32-byte key).`

`HASH_PEPPER` needs ≥ 32 chars; the other secrets ≥ 24.

Note that `.env.prod.example` claims to document every key and **omits
`HASH_PEPPER`** — one of the six compose hard-requires — along with
`APPLY_NOTIFY_TO`, `COMPOSE_PROJECT_NAME`, `LIBRIANT_DATA_ROOT`, `BACKUP_ROOT`,
`BACKUP_HEARTBEAT_URL`, `ADMIN_BOOTSTRAP_NAME/ROLE` and the eight
`*_MEM_LIMIT`/`*_CPUS` knobs. And `pnpm secrets audit` will report a healthy env
file that compose then refuses to start, because its registry is missing
`HASH_PEPPER`, `RESEND_API_KEY` and `DESKTOP_RELEASE_TOKEN`.

### 4.3 The production landmines

| Variable           | Value now | What it actually does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Blocker                    |
| ------------------ | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| `STRIPE_DRIVER`    | `none`    | Fixed 2026-08-24. Three postures now: `real`, `disabled` (the shipped default — no driver is constructed, billing operations refuse, and `POST /webhooks/stripe` answers 503 before reading a byte) and `fake`, which only exists for a declared `development`/`test` NODE_ENV. A legacy `.env.prod` still saying `fake` DOWNGRADES to `disabled` with a loud error rather than refusing to boot. The one configuration refused outright is `BILLING_ENABLED=true` with no driver that can transact. | `billing-02` — closed      |
| `EMAIL_DRIVER`     | `console` | Nothing is delivered — there is no Resend key, and that is expected for this launch. It is **no longer a dead end**: an owner admin can recover any account from the panel. See §4.3a. Do NOT go looking in `docker logs api`; the body is withheld under `NODE_ENV=production`.                                                                                                                                                                                                                     | `launch-readiness-01`      |
| `BILLING_ENABLED`  | `false`   | Not authoritative. `PlatformSettingsService` reads a `platform_settings` DB row and only falls back to the env value when the row is absent; the owner-only admin **Subscriptions** toggle writes that row. Nothing cross-validates enforcement-on against `STRIPE_DRIVER=fake`. See the box below before you touch it.                                                                                                                                                                              | `billing-03`, `billing-04` |
| `MAINTENANCE_HARD` | `false`   | Caddy-only edge takeover. **UNVERIFIED whether it works at all** — see §9.10.                                                                                                                                                                                                                                                                                                                                                                                                                        | —                          |

### 4.3a Recovering an account while no mail is delivered

`EMAIL_DRIVER=console` means the system composes every message and delivers
none. A librarian who forgets their password, or who never verified their
address, cannot get themselves back in. Until a mail provider is configured,
**this is the supported path** — a normal operation, not a workaround.

You need an **owner**-role admin session on `admin.libriant.com`.

1. Open **Account recovery** in the admin panel (`/admin/account-recovery`).
2. Find the person by e-mail or library.
3. Either:
   - **Mark the address verified** — for someone stuck behind an unverified
     e-mail who still knows their password; or
   - **Issue a reset link** — mints a fresh single-use link, valid for one hour.
4. Read the link to them over a channel you already trust — the phone number on
   their library's own website, not one supplied in the request. You are the
   delivery mechanism, so you are also the identity check.

Two properties worth knowing before you use it:

- **The stored message never contains a live link.** `email_outbox` holds a
  sealed reference, not the credential, so a backup or a database export cannot
  be turned into account takeover (`privacy-legal-06`). The panel mints the link
  when you ask for it, and Caddy's access log drops the `?token=` value, so
  following the link does not write it into the nightly backup either.
- **Every issue is recorded.** The action writes an audit row naming the admin,
  the account and the time. That record is the reason this is safe to have — an
  operator who can silently mint credentials for any account is not an
  administrator, they are a backdoor.

When a provider is finally configured this stays; it is also the answer to "the
mail went to spam".

> **Do not turn billing on — via `.env.prod` or the admin Subscriptions toggle —
> until three blockers are closed.** The toggle is one click and it is the
> point of no return for a paying customer.
>
> - `billing-02` — with `STRIPE_DRIVER=fake` still set, enforcement-on is
>   enforcement against a subscription state any internet host can rewrite.
>   Nothing in the code stops that combination.
> - **`BLOCKER billing-03`** — every plan change opens a **new** Stripe
>   subscription and abandons the old one, so an upgrade double-charges the
>   library. Blocks the first paying customer.
> - **`BLOCKER billing-04`** — there is **no VAT anywhere in the billing path**.
>   A Greek public library cannot book the receipt, and roughly 24% of every
>   euro collected is unaccounted for. Blocks the first paying customer.
>
> These two are the reason the twelve blockers split 9 / 3: they do not block
> a public launch on the free offer, but they block taking money.

`ensure-env.sh` writes `STRIPE_DRIVER=fake` and `EMAIL_DRIVER=console` into
`.env.prod` **on every deploy** (it runs with `--auto` from `deploy-on-host.sh`).
The compose file deliberately passes `EMAIL_DRIVER` through _unset_ so a
forgetful operator would get a loud boot failure — but `ensure-env.sh` makes that
fail-fast permanently unreachable, and re-adds the line if you delete it. Two
files in the same deploy path assert opposite policies. To change either driver
for real you must edit `.env.prod` **and** accept that `ensure_default` will not
overwrite your non-empty value (it only fills blanks) — so setting them once
sticks.

### 4.4 Secrets: what breaks if you lose or rotate each one

**Irrecoverable if lost — nothing on disk or in any backup can regenerate them:**

| Secret              | Consequence                                                                                                                                                                                                                                   |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MFA_MASTER_KEY`    | The only decryptor of stored admin TOTP secrets. Losing it orphans every enrolment; with MFA mandatory in production and **no recovery codes on `AdminUser`**, you are locked out of the admin panel. Classified rotation: _never_.           |
| `POSTGRES_PASSWORD` | Postgres applies it only at initdb. Once the cluster exists, the value in `.env.prod` must match `pg_authid` or every connection fails auth. Classified rotation: _never_ — changing it needs a coordinated `ALTER ROLE libriant PASSWORD …`. |
| origin cert + key   | `deploy-on-host.sh` says it outright: _no backup contains it_. A missing pair fails the deploy at `caddy validate` with the misleading message `Caddyfile is invalid`.                                                                        |

**Recoverable but disruptive:**

| Secret                   | Rotating it                                                 |
| ------------------------ | ----------------------------------------------------------- |
| `SESSION_SECRET`         | Logs out every library user.                                |
| `ADMIN_SESSION_SECRET`   | Logs out all platform admins.                               |
| `IMPERSONATION_SECRET`   | Kills live support sessions.                                |
| `STORAGE_SIGNING_SECRET` | 403s every outstanding signed download link until reissued. |
| `HASH_PEPPER`            | Resets the application-form IP throttle history.            |

Rotation procedure: edit `/srv/libriant/.env.prod`, update the password manager
**first**, then `dc up -d` to recreate the affected containers. `pnpm secrets`
exists but **cannot be run on this box**: the host has no Node toolchain, and the
`migrate` container — the only place `scripts/` is mounted — does not mount
`/srv/libriant/.env.prod`. Rotation here is hand-editing.

### 4.5 The admin password reset that nobody documented

There is **no admin password-change endpoint anywhere in the API**.
`bootstrap-admin.ts` is not create-only: when the email already exists it
**updates** `passwordHash` and `role` and resets `failedAttempts=0`,
`lockedUntil=null`, `status='active'`, `disabledAt=null` — and
`prod-bootstrap.sh` runs it on **every deploy**.

So: leaving `ADMIN_BOOTSTRAP_PASSWORD` in `.env.prod` silently re-applies that
password and re-enables a disabled admin at every deploy. That is the only admin
password-reset mechanism you have. Use it deliberately:

```bash
# set ADMIN_BOOTSTRAP_EMAIL + a new ADMIN_BOOTSTRAP_PASSWORD in /srv/libriant/.env.prod
bash scripts/deploy-on-host.sh --skip-build --no-fetch
dc logs migrate | grep -i admin
```

Good looks like: a line naming the admin email, not `ADMIN_BOOTSTRAP_* not set - skipping`.

### 4.6 Host-shaped variables worth knowing

| Variable             | Value                | Notes                                                                                                                                                                                                                                                                                                                                                    |
| -------------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PUBLIC_HOST`        | `app.libriant.com`   | The **app** host, not the apex. The compose file defaults it to `libriant.com` in `x-app-env` and `app.libriant.com` in the caddy block — an internal contradiction that would point the browser's API base at the marketing vhost, which has no `/lbr-api/*` handler. `ensure-env.sh` always sets it, so the defaults never fire. Treat it as required. |
| `PUBLIC_APEX_DOMAIN` | `libriant.com`       | Drives tenant-subdomain resolution and the CSRF Origin allow-list, and derives `EMAIL_FROM`. **Does not drive cookie scope** — cookies carry no `Domain` and use the `__Host-` prefix, which forbids it.                                                                                                                                                 |
| `ADMIN_HOST`         | `admin.libriant.com` | Load-bearing three times: excluded from tenant-subdomain resolution, the only Origin allowed for state-changing `/admin/*`, and the web app 404s `/admin` on any other host.                                                                                                                                                                             |
| `SITE_HOST`          | `libriant.com`       | Marketing vhost. No `/lbr-api/*` handler, on purpose.                                                                                                                                                                                                                                                                                                    |
| `EMAIL_FROM`         | derived              | Defaults to `Libriant <no-reply@${PUBLIC_APEX_DOMAIN}>` — from the **apex**, not `PUBLIC_HOST`. `.env.prod.example` says otherwise and is wrong.                                                                                                                                                                                                         |
| `ACME_EMAIL`         | `ops@libriant.com`   | **Dead configuration.** Every vhost serves a file certificate, so no ACME order is ever placed.                                                                                                                                                                                                                                                          |
| `LIBRIANT_DATA_ROOT` | `/mnt/libriant`      | Setting it in `.env.prod` **does nothing** — `deploy-on-host.sh` resolves it from the shell env and re-exports over whatever the file said. To relocate data, `export LIBRIANT_DATA_ROOT=… ` in the shell before invoking the script.                                                                                                                    |
| `IMAGE_OWNER`        | absent               | Irrelevant on the manual path. Compose falls back to `${IMAGE_OWNER:-libriant}` for local image tags. It matters only if you ever pull.                                                                                                                                                                                                                  |
| `APPLY_NOTIFY_TO`    | `info@libriant.com`  | Where marketing-form applications are notified. Interpolated by compose but absent from the template and from `ensure-env.sh`, so you would never see it.                                                                                                                                                                                                |

---

## 5. DNS and TLS

### 5.1 Measured state, 2026-08-23

| Name                  | State                                                                                                                                              | Action                                                                |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `libriant.com`        | A → 104.21.83.86, 172.67.218.62 (Cloudflare). AAAA → 2606:4700:3037::ac43:da3e, 2606:4700:3033::6815:5356. `https://` returns **522 after ~19 s**. | **Repoint**                                                           |
| `admin.libriant.com`  | **Exists**, proxied, same edge IPs, also **522**.                                                                                                  | **Repoint** — this is the surprise; every old doc thinks it is absent |
| `app.libriant.com`    | **NXDOMAIN** on 1.1.1.1 and 8.8.8.8.                                                                                                               | **Create** — this is where the product lives                          |
| `www.libriant.com`    | NXDOMAIN. No wildcard exists either.                                                                                                               | Decide                                                                |
| Nameservers           | `kim.ns.cloudflare.com`, `maciej.ns.cloudflare.com`                                                                                                | —                                                                     |
| `_dmarc.libriant.com` | NXDOMAIN                                                                                                                                           | see §5.6                                                              |
| CAA                   | none                                                                                                                                               | see §5.5                                                              |

**522, not 000.** Every existing document says the apex "returns 000" because
every one of them probes with `--max-time 5`. A 522 specifically means Cloudflare
_has_ an origin configured and cannot reach it — almost certainly the dead
178.104.32.176. **UNVERIFIED**: the hidden origin IP behind the orange cloud;
read it in the dashboard before cutover. Both `@` and `admin` are records to
**edit**, not absences to fill.

> Leaving `admin` pointed at a released Hetzner IP is a live risk: Hetzner will
> reassign that address to a stranger who can then answer for
> `admin.libriant.com`. Full (strict) is the only thing in the way.

Plaintext `http://` on both hosts already 301s to `https://` with a `CF-RAY`
header, so Always Use HTTPS (or an equivalent redirect rule) is already on.
**UNVERIFIED** which of the two it is; find out so a future operator does not
delete it by accident.

The Cloudflare **edge** certificate is `CN=libriant.com`, issued by Google Trust
Services, valid 2026-07-31 → 2026-10-29, SANs `libriant.com` and `*.libriant.com`.
It already covers `app.`, `admin.`, `www.` and any single-level tenant subdomain.
Adding a proxied `A app` needs no new public certificate.

### 5.2 There is no ACME here

Every HTTPS vhost imports `(cloudflare_origin)`, which is a single directive:

```
tls /etc/caddy/origin/origin.crt /etc/caddy/origin/origin.key
```

An explicit `tls <cert> <key>` **disables Caddy's automatic certificate
management** for that site. No ACME order is ever placed, for any host.

So: **you will never see "certificate obtained" in the Caddy logs.** Old docs tell
you to wait for that line. An operator waiting for it concludes a healthy deploy
has failed.

Two independent reasons ACME could not work anyway: Cloudflare terminates public
TLS so an HTTP-01 / TLS-ALPN-01 challenge never reaches the origin, and the
origin lockdown you want (§3.2c) would block the challenge even if it did.

The commented-out `*.libriant.com` wildcard vhost at the bottom of the Caddyfile
contemplates a Hetzner DNS-01 plugin. **Ignore it.** In a Cloudflare-proxied
architecture tenant subdomains need a proxied wildcard `A *` record and the same
`import cloudflare_origin` as everything else — no ACME, no DNS token. One level
only: `*.libriant.com` does not cover `*.app.libriant.com`, which is the standing
reason tenant subdomains must be `<slug>.libriant.com`.

(The Institutional plan's seed data already grants `custom_subdomain_enabled` —
a plan flag for a vhost that does not exist.)

### 5.3 HSTS, and why order matters

Both header snippets assert:

```
Strict-Transport-Security "max-age=31536000; includeSubDomains; preload"
```

from `app.`, `admin.` and the apex. One HTTPS response from `libriant.com` pins
**every** `*.libriant.com` name in that browser for 365 days. From that moment,
any subdomain's very first request must present a browser-trusted certificate.
HSTS errors are **non-bypassable** — there is no "proceed anyway".

**The pin is probably already in the wild.** The header has been in the Caddyfile
since 2026-05-29 and the apex had a working origin until 2026-08-22. Any browser
that visited in that window holds an unexpired `includeSubDomains` pin lasting
until as late as 2027-08-22. Yours is the most likely holder. Check with
`chrome://net-internals/#hsts` → Query domain.

`libriant.com` is **not** on the Chrome preload list today (`status: unknown`),
so the `preload` token is currently an unhonoured claim. **Do not submit it**
until all four hosts have been stable for weeks — withdrawal takes months.

### 5.4 The cutover order, and what breaks if you deviate

Do not start this until §3.0's blocker is fixed and the box is proven healthy
locally. DNS is the **last** step.

1. **Create the Origin CA certificate** for `libriant.com` **and**
   `*.libriant.com`. Store both PEMs in the password manager — nothing backs
   them up.
2. **Place them on the box** at `/mnt/libriant/caddy/origin/`, `chmod 600` the
   key. The deploy refuses to run without them.
3. **Set the zone SSL/TLS mode to Full (strict)** and confirm Always Use HTTPS —
   _before_ any record moves. **UNVERIFIED**: the current mode.
4. **Deploy and prove health locally**, still with zero DNS changes:
   `curl -sk --resolve libriant.com:443:127.0.0.1 https://libriant.com/pricing`.
5. **Then, in one Cloudflare change:**

   | Type     | Name    | Content               | Proxy                                                                                      |
   | -------- | ------- | --------------------- | ------------------------------------------------------------------------------------------ |
   | A        | `@`     | `195.201.13.95`       | **Proxied**                                                                                |
   | AAAA     | `@`     | `2a01:4f8:13b:ac8::2` | **Proxied**                                                                                |
   | A        | `app`   | `195.201.13.95`       | **Proxied**                                                                                |
   | AAAA     | `app`   | `2a01:4f8:13b:ac8::2` | **Proxied**                                                                                |
   | A        | `admin` | `195.201.13.95`       | **Proxied**                                                                                |
   | AAAA     | `admin` | `2a01:4f8:13b:ac8::2` | **Proxied**                                                                                |
   | A + AAAA | `www`   | same                  | **Proxied** — or a Cloudflare redirect rule instead. Pick one; do not leave it unresolved. |

   The box has public IPv6 and the Caddy container publishes on `[::]` as well as
   `0.0.0.0`, so AAAA records work. Omitting them is safe but wastes the v6 path;
   adding them **without** an IPv6 origin firewall rule (§3.2c) widens the same
   hole in a second address family.

6. **Verify all four names over public HTTPS before telling anyone** (§5.7).

**What breaks if you do it out of order:**

| Mistake                              | Symptom                                                                                                                                                                                                                                                   |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Repoint before Full (strict)         | Flexible mode makes the edge speak plain HTTP to `:80`, which the Caddyfile redirects back to HTTPS → **infinite redirect loop** on all three hosts at once.                                                                                              |
| Create `app` grey-cloud (DNS-only)   | The browser reaches Caddy directly and gets the **Origin CA** certificate, which no browser trusts. Behind HSTS that is a hard, unbypassable error. **Every `*.libriant.com` record must be orange-cloud** while the origin holds only an Origin CA cert. |
| Repoint the apex before `app` exists | The apex re-asserts `includeSubDomains`, and then `app.libriant.com`'s first-ever request must already be perfect — unrecoverable in that browser for a year if it is not.                                                                                |
| Deploy before the cert is on disk    | `Caddyfile is invalid` — a message that has nothing to do with the Caddyfile.                                                                                                                                                                             |
| Cert expired or wrong SANs           | Green deploy, then Cloudflare **526** on every host. The deploy only `test -f`s the files.                                                                                                                                                                |
| Leave `admin` on the dead IP         | A stranger who gets that IP reassigned can answer for `admin.libriant.com`.                                                                                                                                                                               |

### 5.5 CAA

There is no CAA record. Do not add one casually: Cloudflare Universal SSL is
currently issuing from Google Trust Services (`pki.goog`), and a CAA that omits
it breaks edge renewal on 2026-10-29.

### 5.6 Mail DNS

Today: SPF is `v=spf1 include:icloud.com ~all`; MX are iCloud; there is a single
iCloud DKIM CNAME; **`_dmarc` does not exist**.

SPF authorises iCloud **only**. Switching `EMAIL_DRIVER` to a real provider
without first publishing that provider's SPF include, its DKIM CNAMEs and a
`_dmarc` record means sending unauthenticated mail from a domain that already
publishes a policy. Do the DNS before you flip the driver.

### 5.7 Verifying TLS without fooling yourself

**curl takes SNI from the URL authority, never from `-H 'Host:'`, and `-k` cannot
rescue it.** Proven: `--resolve libriant.com:443:<ip>` presents `CN=libriant.com`;
`-H 'Host: libriant.com' https://<ip>/` dies with `sslv3 alert handshake failure`
and exchanges no certificate at all.

This is not pedantry — it is a live bug in `.github/workflows/deploy.yml:375`,
whose health gate uses the `-H 'Host:'` form, reports `site=000` for 150 s on a
perfectly healthy stack, fails the deploy and fires the automatic rollback.
`docs/server-handbook.md:683` has the same defect with `openssl s_client
-connect localhost:443` and no `-servername`.

Correct idioms:

```bash
# from the box, bypassing DNS and Cloudflare entirely
curl -sk --resolve libriant.com:443:127.0.0.1     -o /dev/null -w '%{http_code}\n' https://libriant.com/
curl -sk --resolve app.libriant.com:443:127.0.0.1 -o /dev/null -w '%{http_code}\n' https://app.libriant.com/

# what certificate is Caddy actually serving?
echo | openssl s_client -connect 127.0.0.1:443 -servername libriant.com 2>/dev/null \
  | openssl x509 -noout -subject -issuer -dates -ext subjectAltName
```

After cutover, from your laptop:

```bash
for h in libriant.com www.libriant.com app.libriant.com admin.libriant.com; do
  printf '%-24s %s\n' "$h" "$(curl -sS -o /dev/null -w '%{http_code}' --max-time 30 "https://$h/")"
done
```

Good looks like: `200` for the apex and app, `301` for www, `302` for admin
(it redirects `/` to `/admin/login`). **Never** use `/healthz` for this — §2.

Watch for Cloudflare Bot Fight Mode / a high security level 403ing automated
requests. **UNVERIFIED**: both settings. If an external probe gets a managed
challenge, add a WAF custom rule skipping the probe path.

---

## 6. Routine operations

### 6.1 The `dc` helper

Not a script in the repo — a shell function you add once. As `deploy`:

```bash
cat >> ~/.bashrc <<'EOF'

# --- Libriant ---
export COMPOSE_PROJECT_NAME=libriant
export LIBRIANT_DATA_ROOT=/mnt/libriant
set -a; . /srv/libriant/.env.prod; set +a
# .env.prod ships IMAGE_TAG=latest and no such image exists on this box.
# Recompute the tag exactly as deploy-on-host.sh does, AFTER sourcing.
export IMAGE_TAG="$(git -C /srv/libriant/app rev-parse --short=12 HEAD 2>/dev/null)$(git -C /srv/libriant/app diff --quiet 2>/dev/null || echo -dirty)"
dc() { ( cd /srv/libriant/app && docker compose \
  -f infra/compose/docker-compose.prod.yml \
  -f infra/compose/docker-compose.volume.yml "$@" ); }
EOF
exec bash -l
echo "IMAGE_TAG=$IMAGE_TAG"
dc config >/dev/null && echo DC-OK
docker images --format '{{.Repository}}:{{.Tag}}' | grep "libriant-api:$IMAGE_TAG"
```

Good looks like: `DC-OK`, an `IMAGE_TAG` that is a 12-hex short SHA (not
`latest`), and the `grep` finding a local image. Both `-f` files, always.
`COMPOSE_PROJECT_NAME=libriant` is what makes volume names like
`libriant_storage` resolve.

> **The `IMAGE_TAG` line is not decoration — omit it and `dc up -d` breaks the
> stack.** `ensure-env.sh` writes `IMAGE_TAG=latest` into `.env.prod`
> unconditionally; `deploy-on-host.sh` overrides it with the 12-char short SHA
> _after_ sourcing the file, and tags the images it builds with that SHA.
> Nothing tags anything `latest`. So a bare shell that sources `.env.prod` and
> runs `dc up -d` — the reboot procedure in §6.8, `dc up -d caddy` in §9.1,
> `dc run … migrate` in §6.4 — resolves
> `ghcr.io/libriant/libriant-api:latest`, which exists neither locally nor in
> any registry this box can pull from, and fails with a manifest/pull error.
> `dc ps`, `dc logs`, `dc exec` and `dc restart` are unaffected; anything that
> **creates** a container is not.
>
> If the checkout has moved since the last deploy, `git rev-parse HEAD` no
> longer matches the running images. Read the truth off a running container
> instead: `docker inspect -f '{{.Config.Image}}' libriant-api-1`.

### 6.2 Deploying a change

```bash
cd /srv/libriant/app && bash scripts/deploy-on-host.sh
```

| Flag           | Use                                                                 |
| -------------- | ------------------------------------------------------------------- |
| `--dry-run`    | preconditions + commit + tag, then stop. Cheap; use it when unsure. |
| `--ref <sha>`  | deploy an older commit. **This is your rollback.**                  |
| `--skip-build` | reuse images already on the box. Fast. Never on a first deploy.     |
| `--no-fetch`   | deploy the working tree as-is, skipping `git reset --hard`.         |

**Rollback** is `bash scripts/deploy-on-host.sh --ref <older-sha>`. The GitHub
workflow's rollback path is inoperable: it pulls from GHCR (nothing is published
there) and its `DEPLOY_KNOWN_HOSTS` secret still pins the dead box's SSH keys, so
`StrictHostKeyChecking` will refuse this machine. Before you ever re-enable the
workflow, re-key that secret against a fingerprint you verified out-of-band in
the Hetzner console.

Every `dc up -d` is a **user-visible 502 window**. No `reverse_proxy` block sets
`lb_try_duration`, three set no passive health at all, and on the api path
`fail_duration 10s` can amplify a 200 ms restart into a 10-second blackout.
Deploy when nobody is using it, or announce it (§9.10).

Caddyfile-only changes: `up -d` will not restart caddy (the config is a bind
mount), which is why the deploy script explicitly runs `caddy reload`.

### 6.3 Logs

```bash
dc logs -f --tail=200 api
dc logs migrate | tail -60          # after every deploy
dc logs --since 30m api worker
dc exec caddy sh -c 'tail -f /var/log/caddy/access.log'
```

Container logs: json-file, 50 MB × 5 per service ≈ 250 MB each, ~1.75 GB total,
all on the **boot disk**. Caddy's access log rolls at 100 MB × 14 ≈ 1.4 GB, also
on the boot disk.

> **Two hazards while reading logs during an incident.**
>
> 1. **Response `Set-Cookie` headers are logged verbatim.** The pino redact list
>    covers request headers only. The API's rolling logs are a store of live
>    session JWTs with a 30-day remember-me TTL — a token replayed from the log
>    file returned HTTP 200 on `/auth/me` in testing. Do not paste raw logs into
>    a ticket, a screenshot or a chat.
> 2. **`/readyz`'s useful body never reaches the caller.** The global filter
>    turns the 503 into a generic `supportCode` envelope. The dependency map is
>    logged on the same one-line JSON record as `declaredBody`, so recover it
>    with `dc logs api | grep <supportCode>`. And because the healthcheck polls
>    every 15 s, a dependency outage writes four stack traces a minute, burying
>    the real error while the incident is live.

### 6.4 The operator shell

The host has **no Node and no pnpm**. Every TypeScript script runs inside the
`migrate` container — the only service that bind-mounts `scripts/`:

```bash
dc run --rm --no-deps migrate sh -lc 'cd /app && pnpm <task>'
```

Because `scripts/` is bind-mounted from the host checkout, editing
`prod-bootstrap.sh` takes effect with no rebuild. Editing `package.json` or a
Dockerfile does not.

> **This does not work today either** — same `supply-chain-06` root cause; `pnpm`
> in that image exits 1. Test it first:
> `dc run --rm --no-deps migrate sh -lc 'pnpm --version'` → expect `11.22.0`.

### 6.5 Migrations

Control-plane migrations run automatically in the `migrate` one-shot on **every**
`dc up -d`, and they are **fatal**. You do not run them by hand. (Appendix C of
the old deployment doc claims the opposite; it is wrong.)

**Tenant** migrations are the dangerous half: `prod-bootstrap.sh` runs them
best-effort and swallows failure, so a green deploy can leave live libraries on
an old schema. After every deploy that touches the tenant schema:

```bash
dc logs migrate | grep -i -E 'tenant:migrate|skipped|non-fatal'
```

If anything was skipped, fan out by hand:

```bash
dc run --rm --no-deps migrate sh -lc 'cd /app && pnpm tenant:migrate --concurrency=4'
# or a subset:
dc run --rm --no-deps migrate sh -lc 'cd /app && pnpm tenant:migrate --only=slug-a,slug-b'
```

Individual tenant failures do not stop the batch; the command exits non-zero at
the end. Good looks like: exit 0 and every tenant reported migrated.

### 6.6 Adding a tenant

```bash
dc run --rm --no-deps migrate sh -lc "cd /app && pnpm tenant:create -- \
  --slug=acme \
  --name='Acme Public Library' \
  --owner-email=ops@acme.gr \
  --owner-name='Acme Operator' \
  --plan=community \
  --billing-mode=manual \
  --paid-until=2027-01-01 \
  --default-locale=el"
```

Required: `--slug`, `--name`, `--owner-email`, `--owner-name`. Optional:
`--primary-email`, `--default-locale`, `--plan`, `--billing-mode`, `--paid-until`,
`--cell`, `--owner-password`, `--dry-run`. Idempotent on slug; on a late failure
it tears the physical database back down.

Run `--dry-run` first. The generated owner password is printed **once**.

> With `EMAIL_DRIVER=console`, the owner will never receive a verification mail,
> and `EmailVerifiedGuard` sits on `POST /t/:slug/staff` — so they cannot invite a
> second librarian. Set `--owner-password` and hand it over out of band, and
> understand that the owner is the only user that tenant can have until
> `launch-readiness-01` is fixed.

**Relocating a tenant off-box silently stops all backups.** `backup.sh` aborts
the whole nightly run if any tenant's `dbUrl` host is not
`postgres`/`pgbouncer`/`localhost`/`127.0.0.1`, unless
`BACKUP_ALLOW_OFFHOST_TENANTS=1`. If you ever run `pnpm tenant:relocate`, fix the
cron in the same sitting.

### 6.7 The rhythm

Everything below is **Berlin time**.

**First, once — none of this exists yet:**

- [ ] backup cron (§8.2) and a verified first backup
- [ ] off-site remote (`RCLONE_REMOTE`) — see the caveats in §8.1
- [ ] `BACKUP_HEARTBEAT_URL` (§7.3)
- [ ] origin-certificate expiry in your calendar
- [ ] `unattended-upgrades` and `fail2ban` active (§3.2d)

**Weekly, ~10 minutes:**

```bash
uptime; free -h; df -h / /mnt/libriant; cat /proc/mdstat
dc ps
docker system df
ls -lh /mnt/libriant/backups/ | tail -5
tail -30 /var/log/libriant/backup.log
# ↓ requires supply-chain-06 to be fixed; `pnpm` exits 1 in that image today (§6.4)
dc run --rm --no-deps migrate sh -lc 'cd /app && pnpm tsx scripts/fleet-report.ts'
```

Good looks like:

| Signal                | Good                                       | Act                                        |
| --------------------- | ------------------------------------------ | ------------------------------------------ |
| `/proc/mdstat`        | `[UU]` on both arrays                      | anything else → §9                         |
| load average          | < 4.0 (4 cores / 8 threads)                | > 8 sustained                              |
| `free -h` available   | > 40 GiB of 62                             | < 8 GiB                                    |
| swap used             | 0                                          | any sustained use                          |
| `df -h /`             | < 60% of 79 G                              | > 80% → §9.5                               |
| `df -h /mnt/libriant` | < 60% of 246 G                             | > 70% → §10.1                              |
| `dc ps`               | 7 × `Up (healthy)`; `migrate` `Exited (0)` | any `unhealthy`, `Restarting` or `Created` |
| backups               | a directory for last night, 4 files        | missing → §8                               |
| PG connections        | < 150 of 200                               | > 160                                      |
| PG cache hit ratio    | > 0.95 (the alert threshold)               | below                                      |

Note `migrate` showing `Exited (0)` is **correct**, not a fault.

**Monthly:**

- Origin certificate: `openssl x509 -in /mnt/libriant/caddy/origin/origin.crt -noout -checkend 2592000 -dates`
  → good looks like `Certificate will not expire`.
- External scan from your laptop: `nmap -Pn -p 22,80,443,5432,6379 195.201.13.95`
  and the `-6` equivalent → only 22, 80, 443.
- `docker system df`; prune if images exceed a few GB.
- Read `dc logs --since 720h api | grep -i error | sort | uniq -c | sort -rn | head -20`.
- Confirm `.env.prod` in the password manager still matches the box.

**Quarterly:** the restore drill (§8.5). It has never been run to completion on a
real host.

### 6.8 Rebooting

```bash
dc stop                # optional; clean shutdown of Postgres
sudo reboot
# after it comes back:
dc up -d
dc ps
```

**The `dc up -d` is not optional.** `restart: unless-stopped` does not restart a
container you stopped by hand, so `dc stop` + reboot leaves the whole stack down.
If you reboot _without_ `dc stop`, the stack comes back on its own — but check
`dc ps` anyway.

---

## 7. Monitoring

### 7.1 What exists, and what is switched off

| Thing                                        | State                                                                                                                                       |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Prometheus, node-exporter, cAdvisor, Grafana | Exist in `infra/monitoring/docker-compose.monitoring.yml`. **Not started by any deploy step, script or workflow.** Not running on this box. |
| Alertmanager                                 | **Does not exist.** The `alerting:` block in `prometheus.yml` is commented out.                                                             |
| Alert rules                                  | 10, all liveness / host-capacity / Postgres-capacity. None can express an error rate or a latency.                                          |
| Grafana dashboards                           | **Zero.** Provisioning contains one datasource file and nothing else.                                                                       |
| Grafana contact points                       | **Zero.**                                                                                                                                   |
| Error tracker / APM                          | **None.** No Sentry, no OTel, nothing. The only durable record of an exception is container stdout.                                         |
| Uptime monitor                               | **None.** Nothing in the repo names a provider, an endpoint or an on-call address.                                                          |
| Caddy metrics                                | **None** — `admin off`, no `metrics` directive. The only publicly exposed component exports nothing.                                        |

**What reaches a human today: nothing.** Detection time for any outage is _until
you next look_, which the weekly rhythm sets at seven days.

The 10 rules, for when delivery exists: `TargetDown`, `LibriantApiDown`,
`HostLowMemory`, `HostSwapping`, `HostDiskFilling` (<15% free 15 m),
`HostDiskCritical` (<7% free 5 m), `HostHighCPU`, `LibriantPgConnectionsHigh`,
`LibriantPgConnectionsCritical`, `LibriantPgCacheHitLow` (<0.95). The Postgres
ones read `libriant_pg_*` gauges from the API's own `/metrics`, so they work
without the commented-out exporters.

`HostSwapping` is guarded by `SwapTotal > 0`; this box has 8 GiB of swap, so the
guard is satisfied and the rule is live. Note its actual trigger is **swap more
than 50% used for 10 minutes** — 4 GiB — which is far past the point the weekly
sweep's "any sustained swap use" would have you act. The rule is a backstop, not
an early warning.

The API's `/metrics` exposes eight gauges — uptime, build info, tenants by
status, storage bytes, PG connections / max / cache hit ratio, Redis memory.
**No request counter, no status-code breakdown, no latency histogram.** The
worker exposes uptime and running jobs per queue, and no success/failure gauge.
Gauges are TTL-cached 15 s and isolated with `Promise.allSettled`, so a _missing_
gauge means that subsystem failed, not that the API is down.

### 7.2 Bringing the monitoring stack up (optional)

```bash
cd /srv/libriant/app
# Keep it out of shell history and out of the app's env file.
sudo install -m 600 -o deploy -g deploy /dev/null /srv/libriant/.env.monitoring
printf 'GRAFANA_ADMIN_PASSWORD=%s\n' "$(openssl rand -hex 16)" > /srv/libriant/.env.monitoring
set -a; . /srv/libriant/.env.monitoring; set +a       # export, or compose cannot see it

docker compose -p libriant-monitoring \
  -f infra/monitoring/docker-compose.monitoring.yml up -d

docker run --rm --network libriant_app curlimages/curl -s -o /dev/null -w '%{http_code}\n' http://api:3001/metrics
cat /srv/libriant/.env.monitoring    # copy the password into the password manager, then log in once
```

Good looks like: `200`. The default `${LIBRIANT_APP_NETWORK:-libriant_app}` is
already correct because the **app** stack runs under
`COMPOSE_PROJECT_NAME=libriant`.

> **Two things in that command are load-bearing, and both are easy to lose.**
>
> 1. **The variable must be exported**, not merely assigned.
>    `GRAFANA_ADMIN_PASSWORD=… ` on its own line is a shell variable; Compose
>    reads the process environment, so the next line dies on
>    `GF_SECURITY_ADMIN_PASSWORD: ${GRAFANA_ADMIN_PASSWORD:?set GRAFANA_ADMIN_PASSWORD}`.
> 2. **`-p libriant-monitoring` is mandatory.** Your login shell exports
>    `COMPOSE_PROJECT_NAME=libriant` (§6.1), which would otherwise put
>    Prometheus, Grafana, node-exporter and cAdvisor into the _same_ Compose
>    project as the app — and the very next
>    `deploy-on-host.sh`, which runs `dc up -d --remove-orphans`, would delete
>    them as orphans without comment. Use the separate project name and the two
>    stacks stay independent.

Grafana is published on **`127.0.0.1:3300`**, so:

```bash
ssh -L 3300:127.0.0.1:3300 deploy@195.201.13.95
# then http://localhost:3300
```

(The handbook says port 3000. It is wrong — 3000 is the web container's internal
port and is not published at all.)

Two cautions:

- **No monitoring service declares any resource limit**, while every app service
  does. You would be adding unbounded memory demand next to a capped stack. On 62
  GiB that is survivable; add `mem_limit`s anyway.
- The four image pins date from 2024/early-2025 and none is pinned by digest.
  **UNVERIFIED** on Ubuntu 26.04 — cAdvisor v0.49.1 in particular has not been
  checked against this host's cgroup version, and a broken cAdvisor silently
  removes all per-container metrics.
- The commented-out postgres-exporter and redis-exporter **cannot work as
  written**: they declare `networks: [monitoring, app]`, but `postgres` and
  `redis` are on `data` only, which is `internal: true`. They would need to join
  `libriant_data` as a declared external network.

### 7.3 Minimum viable alerting — the concrete recipe

Three steps, in value order. The first is the cheapest real alert you can have
and covers the highest-consequence silent failure.

**1. A dead-man switch on the backup (do this today).**

Create a check at healthchecks.io (or any equivalent) with a period of 1 day and
a grace of 6 hours. Put its ping URL in `/srv/libriant/.env.prod`:

```
BACKUP_HEARTBEAT_URL=https://hc-ping.com/<uuid>
```

`backup.sh` pings it **on success only, at the very end**, after the rclone push.
That is enough for the failure that matters — a backup that stops happening —
because the check goes red when the ping stops. It is **not** enough for a
partial failure: none of `backup.sh`'s five abort gates ping anything. Improve it
by adding failure pings to the cron line:

```
... ; /srv/libriant/app/scripts/backup.sh >> /var/log/libriant/backup.log 2>&1 || curl -fsS -m 10 https://hc-ping.com/<uuid>/fail
```

Good looks like: the check turns green tomorrow morning and stays green.

**2. An off-box uptime check (after cutover only — the box is not in DNS).**

Point it at a URL that **traverses to the app**, never at `/healthz`:

- `https://app.libriant.com/` → Caddy → web:3000
- `https://libriant.com/pricing` → the marketing file server

Expect 200. If Cloudflare's Bot Fight Mode returns 403, add a WAF custom rule
skipping that path — otherwise the monitor is silently useless.

**3. Delivery for the ten rules that already exist.**

Either add an Alertmanager container to the monitoring compose and uncomment the
`alerting:` block, or use Grafana OSS 11.4's unified alerting with a contact
point. **Use a webhook-style contact point** (ntfy, Telegram, a Slack webhook):
Grafana's own SMTP is separate from the app's `EMAIL_DRIVER`, and with no mail
provider configured, email contact points do not work.

Until step 3 lands, do not use the word "page" about anything in this system.

### 7.4 The health surfaces that lie

Know these before you trust a dashboard:

| Surface                                  | Lie                                                                                                                                                                                                                                                                             |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `https://<any host>/healthz`             | Static 200 from Caddy. Green through a total outage.                                                                                                                                                                                                                            |
| caddy container health                   | Hits its own static `:80` probe. Cannot go red while the process lives.                                                                                                                                                                                                         |
| web container health                     | Constant `{status:'ok'}`. A deep probe (`/api/readyz`) exists and **nothing uses it**.                                                                                                                                                                                          |
| pgbouncer container health               | The pooler answers `pg_isready` itself. Nothing gates on it.                                                                                                                                                                                                                    |
| worker `/healthz` `scheduledLastResults` | **Actively wrong.** The runner stores `{at, message, ok:true}` and discards `counts`, so a sweep where 100% of tenants failed reports `ok:true` with a success-shaped message. Measured: `tenantsFailed: 49 of 49` alongside _"49 tenant(s) scanned; no member reminders due"_. |
| `libriant_worker_jobs_total`             | Referenced in the code's types. Does not exist.                                                                                                                                                                                                                                 |

And two things with no operator surface at all: abandoned email-outbox rows
(recoverable only by SQL; dormant while `EMAIL_DRIVER=console`) and per-tenant
scheduled-job failures.

> **`BLOCKER reliability-01` — the thing that `scheduledLastResults` row is
> hiding.** It is not only that the reporting is wrong; the job underneath it
> has never worked. `sendMemberNotifications()` constructs a fresh
> `RedisService` and the first statement of the per-tenant loop is a Redis
> `GET`. With `enableOfflineQueue: false` a command issued while the socket is
> still connecting rejects synchronously, so **every** tenant throws on its
> first await and the whole sweep drains in microseconds before the socket is
> ready. Measured against the live control plane: `tenantsScanned: 49,
tenantsFailed: 49`. `stripe-retry.job.ts` has the identical defect.
>
> Operationally: **due-soon reminders, overdue notices and hold-ready
> notifications have never been sent to anyone**, and `/healthz` reports
> `{"member-notifications":{"ok":true}}` while it happens. Do not tell a
> library that reminders are running. This is independent of
> `launch-readiness-01` — fixing the email driver will not fix it, because the
> job fails before it ever reaches the outbox.

---

## 8. Backup and restore

### 8.1 What is and is not backed up

`scripts/backup.sh` writes four artefacts to `$BACKUP_ROOT/$(date +%Y%m%d)/`:

| File                | Contents                                                                                                                                                                                                |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `postgres.sql.gz`   | `pg_dumpall --clean --if-exists` of the **whole cluster** — `libriant_control`, every `tenant_*` database, and all globals including role SCRAM verifiers. Restored with `psql -f`, never `pg_restore`. |
| `storage.tar.gz`    | the uploads tree                                                                                                                                                                                        |
| `caddy-logs.tar.gz` | best-effort; **never read by `restore.sh`**                                                                                                                                                             |
| `manifest.txt`      | host, completed_at, image_tag, file list                                                                                                                                                                |

`pg_dumpall` runs **inside** the postgres container, so no client is needed on the
host and version skew cannot occur for the nightly.

**Not backed up, at all:**

|                                      | Why it matters                                                                                                                                                                                                                                      |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/srv/libriant/.env.prod`            | Deliberate — a stolen backup would otherwise be total compromise. It also means the secrets are irrecoverable from backups. Note that the `pg_dumpall` globals carry only the SCRAM _verifier_ for the `libriant` role, not the plaintext password. |
| the origin certificate + key         | `caddy_data` is never touched. In the password manager only. Blocks the deploy if lost.                                                                                                                                                             |
| `caddy_config`                       | —                                                                                                                                                                                                                                                   |
| **Redis** (`redis_data`, appendonly) | The BullMQ queues, rate-limit counters and idempotency keys. In-flight jobs are lost on a restore.                                                                                                                                                  |
| WAL / PITR                           | **There is no WAL archiving and no point-in-time recovery.** RPO is the cron interval: **up to 24 hours of loss.**                                                                                                                                  |

**Retention.** Local: `BACKUP_KEEP_DAYS` (14), pruned at the start of each run.
Off-site: `rclone copy` into a per-day path with **no prune, no `--delete`, no
lifecycle rule** — off-site dailies accumulate forever.

> **`BLOCKER privacy-legal-02`.** No artefact is encrypted, anywhere, and the
> off-site copy is never pruned. The DPA promises _"regular encrypted backups"_
> and the privacy notice promises deleted copies _"age out of backups"_ on a
> 14-day cycle. Local dailies genuinely do age out; off-site ones never do, so an
> Art. 17 erasure never propagates out of the off-site copy. Both statements are
> untrue as deployed.
>
> Compounding it: the Caddy access log is tarred into the same unencrypted
> archive, and password-reset / email-verification URLs carry their raw token in
> the query string through a JSON access log with no URI filter. **The backup
> contains live account-takeover tokens in cleartext.**
>
> Fix before any real library's data lands here: encrypt each artefact before it
> leaves the host (`age -r <recipient>` with the key held off-host, or an rclone
> crypt remote), record key management in DPA Annex II, and add remote retention
> (`rclone delete --min-age ${BACKUP_KEEP_DAYS}d` or a storage-box lifecycle
> policy). Encrypting _on_ the app host is of limited value against an attacker
> who already has the host — the exposure that matters is the off-site leg.

### 8.2 Installing the nightly backup

**Nothing installs this.** Not the deploy, not any script, not CI. And nothing
warns you it is missing.

There are two cron lines in the repo and one of them is wrong — the header
comment in `backup.sh` sets no `BACKUP_ROOT` and would write to
`/srv/libriant/backups` on the **boot disk**. Use exactly this one:

```bash
sudo tee /etc/cron.d/libriant-backup >/dev/null <<'EOF'
# Libriant nightly backup — 02:15 Europe/Berlin
SHELL=/bin/bash
15 2 * * * deploy bash -lc 'set -a; . /srv/libriant/.env.prod; set +a; BACKUP_ROOT=/mnt/libriant/backups STORAGE_DIR=/mnt/libriant/storage COMPOSE_FILE=/srv/libriant/app/infra/compose/docker-compose.prod.yml /srv/libriant/app/scripts/backup.sh >> /var/log/libriant/backup.log 2>&1'
EOF
sudo chmod 644 /etc/cron.d/libriant-backup
```

Then run it once by hand, immediately, and read the output:

```bash
set -a; . /srv/libriant/.env.prod; set +a
BACKUP_ROOT=/mnt/libriant/backups STORAGE_DIR=/mnt/libriant/storage \
  COMPOSE_FILE=/srv/libriant/app/infra/compose/docker-compose.prod.yml \
  bash /srv/libriant/app/scripts/backup.sh
ls -lh /mnt/libriant/backups/$(date +%Y%m%d)/
```

Good looks like: four files, `postgres.sql.gz` comfortably over 1 KiB, and no
`WARN: RCLONE_REMOTE unset` if you have configured off-site.

> **`BACKUP_ROOT` cannot be set from `.env.prod`** — `ensure-env.sh` never writes
> it and the compose layer never reads it. It exists only in this cron line and
> in whatever you type by hand. The script's default is the boot disk. Carry the
> full env prefix on **every** manual invocation, every time.

`backup.sh` aborts the whole run — silently, apart from a line in a log nobody
reads — on any of five gates: the control-DB tenant query failing; an
off-host tenant (unless `BACKUP_ALLOW_OFFHOST_TENANTS=1`); a `postgres.sql.gz`
under 1024 bytes; `gzip -t` failing on either archive; a missing `STORAGE_DIR`
(unless `BACKUP_ALLOW_NO_STORAGE=1`). The only notification is `BACKUP_HEARTBEAT_URL`, and
it fires **on success only**. Set it (§7.3).

### 8.3 Restoring

**Destructive. It drops and recreates every database.** Requires `--yes`.

```bash
set -a; . /srv/libriant/.env.prod; set +a
BACKUP_ROOT=/mnt/libriant/backups \
STORAGE_DIR=/mnt/libriant/storage \
COMPOSE_FILE=/srv/libriant/app/infra/compose/docker-compose.prod.yml \
  bash /srv/libriant/app/scripts/restore.sh 20260823 --yes
```

> **`STORAGE_DIR=/mnt/libriant/storage` is mandatory and is the single most
> dangerous omission in this document.** `restore.sh` defaults it to
> `/srv/libriant/storage` — the **in-container** path. Omit it and the script
> `mkdir -p`s a fresh empty directory on the host, untars into it, prints
> _"storage restored"_ and _"restore complete"_, and exits 0 having recovered
> **zero uploads**. The tenant-count sanity check only counts databases, so it
> stays green. (Open high, `reliability-05`. `backup.sh` got the
> docker-volume-inspect resolution and a hard abort; `restore.sh` got neither.)

What it does, in order — this is the 2026-08-22 fix and it is worth knowing:

1. Resolve the day directory, require `postgres.sql.gz`, require `--yes`.
2. `gunzip -t` **both** archives before touching anything.
3. Pre-flight the stream filter and **refuse to run** unless exactly **2**
   self-role statements match, having changed nothing.
4. `dc stop api worker web pgbouncer`.
5. `pg_terminate_backend` every session except `template0` and self.
6. Install `trap restart_apps EXIT`.
7. Pipe the preamble + filtered dump into
   `psql -U libriant -d postgres -v ON_ERROR_STOP=1`.
8. Move existing `$STORAGE_DIR` contents into `$STORAGE_DIR/.pre-restore.<ts>/`,
   then untar into the clean tree.
9. Print cells/plans counts, check every `tenant_*` DB has 4/4 extensions, and
   **die** if the control plane lists more tenants than there are tenant
   databases.

**Why the filter exists.** A `pg_dumpall --clean` script `DROP`s and `CREATE`s the
very role `psql` is connected as. Under `ON_ERROR_STOP=1`, psql stops there —
_after_ the `DROP DATABASE` wave. Reproduced at the time as psql exit 3 with zero
databases remaining. The filter is prologue-scoped and count-asserted precisely
because both the over-broad and the silently-non-matching versions were tried and
both were worse.

**Three things that will bite on a rebuilt host:**

1. `pg_dumpall` emits a bare `DROP DATABASE template1;` and only precedes it with
   the `datistemplate=false` UPDATE when the _source's_ template1 was still a
   template — which it stops being the first time a cluster is restored into. So
   a second-generation dump kills a pristine target with _"cannot drop a template
   database"_, after the DROP wave. The preamble now handles this unconditionally.
2. **The restore overwrites the target's superuser password with the source's
   hash.** After a cross-host restore, the freshly minted `POSTGRES_PASSWORD` in
   the new `.env.prod` is **wrong**; the correct value is the password-manager
   entry for the **source** host. The drill asserts this, it is not a theory.
3. `ALTER ROLE` only overlays — `pg_dumpall` omits `CONNECTION LIMIT` when -1 and
   `VALID UNTIL` when null, so drift on the target survives a "successful"
   restore. The preamble resets both first; an expired `VALID UNTIL` would
   otherwise show up as _"password authentication failed"_ long after anyone is
   looking.

> **`restore.sh` will not bring the app back up today.** Its EXIT trap runs
> `dc up -d api worker web`, and `api` gates on `migrate` completing —
> `supply-chain-06`. The database work will finish and the application will stay
> down. Also note the fallback path `dc start api worker web` does not start
> dependencies, so `pgbouncer`, which the script stopped, would stay down on that
> branch.

**Rebuilding this box from nothing — the ordering that matters.** You need three
things from three different places:

| From                 | What                                                                                    |
| -------------------- | --------------------------------------------------------------------------------------- |
| the backup           | the data                                                                                |
| the password manager | **the source host's `POSTGRES_PASSWORD`, set into `.env.prod` before the first deploy** |
| the password manager | the origin cert + key, on disk before the first deploy                                  |

Set `POSTGRES_PASSWORD` **manually, first**. `ensure-env.sh`'s guard against
minting a fresh password over a surviving cluster **cannot fire** in this exact
scenario: it resolves the mountpoint via `docker volume inspect`, but a
local-driver bind volume still reports `/var/lib/docker/volumes/<name>/_data`
(which holds no `PG_VERSION`), and after a boot-disk rebuild `/var/lib/docker` is
gone entirely and docker may not even be installed. The guard returns "not
initialised" and overwrites your `.env.prod` in the act of failing.

### 8.4 What CI actually proves

`pnpm dr:drill` runs on every push to main and every PR, twice: against a
throwaway cluster on port 5433, and `--cross-cluster` against a second on 5434.
It is a genuinely good 30-check drill — negative control on password auth, a
partial disaster rather than a clean wipe, locale-independent SQLSTATE counting,
full row census, byte-identical `pg_dump --schema-only` diffs, sequence
`last_value`, grants, role attributes, live TCP authentication, and the
rebuilt-host password flip.

**It proves the Postgres restore stream, and only that.** It invokes neither
`backup.sh` nor `restore.sh` — it re-implements `pg_dumpall --clean --if-exists |
gzip -9` inline. So it does **not** cover:

- the storage tarball — no tar leg at all
- `backup.sh`'s guards, volume resolution, size/gzip gates, prune, manifest, rclone
- `restore.sh`'s container stop/start ordering, EXIT trap, archive validation,
  tenant-count assertion
- the off-site leg — nothing ever pulls a backup back from `RCLONE_REMOTE`
- scale — the fixture is 502 rows and a ~5 KB dump in 3.4 s
- restoring an **old** dump against **newer** code (Prisma migration drift)

**RTO is UNKNOWN.** No restore has ever been executed on a real host. The
2026-08-22 restore bug had never worked, and the drill that would have caught it
had never been run. Do not quote a number until you have one.

### 8.5 The drill — quarterly, and it has never been done

1. Take a fresh backup by hand (§8.2) and note its size and duration.
2. On a throwaway host, or a second cluster on this one, restore it with the
   **full** env prefix and `time` it. Record the Postgres leg and the storage
   untar separately.
3. Verify: control-plane tenant count matches tenant database count; each
   `tenant_*` DB has 4/4 extensions; a spot-checked cover image actually opens.
4. Prove the off-site leg by pulling a day back down from `RCLONE_REMOTE` and
   restoring **that** copy, not the local one.
5. Write down the wall-clock. That number is your RTO.

Two drill hazards: an aborted `dr-drill.sh` leaves the shared role with
`statement_timeout=1s` and `CONNECTION LIMIT 7` (the EXIT trap restores only the
password), which later shows up as _"canceling statement due to statement
timeout"_ and _"too many connections for role"_ pointing nowhere near a shell
script that exited hours earlier. And `restore.sh` must never be pointed at
production to "test" it.

---

## 9. When it breaks

Symptom index. Start here at 3am.

| Symptom                              | Section                                 |
| ------------------------------------ | --------------------------------------- |
| Nothing loads, Cloudflare error page | [9.1](#91-site-down-cloudflare-error)   |
| Site loads, app 500s or won't log in | [9.2](#92-app-down)                     |
| Everything 500s, including admin     | [9.3](#93-redis-down)                   |
| Data errors, `/readyz` 503           | [9.4](#94-postgres-down)                |
| Writes fail, `no space left`         | [9.5](#95-disk-full)                    |
| Worker restarts, emails stop         | [9.6](#96-oom)                          |
| Deploy failed                        | [9.7](#97-deploy-failed)                |
| 526 / certificate error              | [9.8](#98-certificate-expired-or-wrong) |
| One library broken, others fine      | [9.9](#99-one-tenant-broken)            |
| I need to take it down on purpose    | [9.10](#910-the-customer-facing-levers) |

**First ninety seconds, always:**

```bash
ssh deploy@195.201.13.95
dc ps
docker inspect --format \
  '{{.Name}} {{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}no-healthcheck{{end}}' \
  $(docker ps -aq --filter label=com.docker.compose.project=libriant)
curl -s -o /dev/null -w 'edge=%{http_code}\n' http://localhost/healthz
curl -sk --resolve libriant.com:443:127.0.0.1 -o /dev/null -w 'site=%{http_code}\n' https://libriant.com/pricing
free -h; df -h / /mnt/libriant; uptime
```

Remember `migrate` `Exited (0)` is correct, and `edge=200` proves only that Caddy
is alive.

The `{{if .State.Health}}` guard in that template is not tidiness: `-aq` includes
`migrate`, which has **no healthcheck**, and a bare `{{.State.Health.Status}}`
makes `docker inspect` abort the whole command with _"nil pointer evaluating
types.Health.Status"_ — printing nothing for any container. `deploy-on-host.sh`
uses the same guard for the same reason.

### 9.1 Site down (Cloudflare error)

**Confirm.** Read the Cloudflare error number — it tells you where the fault is.

| Code          | Means                                                  | Go to                      |
| ------------- | ------------------------------------------------------ | -------------------------- |
| **522**       | Cloudflare cannot reach the origin at all              | below                      |
| **526**       | Origin certificate invalid/expired under Full (strict) | §9.8                       |
| **502/504**   | Caddy reached, upstream failed                         | §9.2                       |
| Redirect loop | SSL/TLS mode is Flexible, not Full (strict)            | fix the zone setting, §5.4 |

For a 522, from the box:

```bash
dc ps caddy
curl -s -o /dev/null -w '%{http_code}\n' http://localhost/healthz
sudo ss -tlnp | grep -E ':(80|443)'
```

Then from your laptop: `nmap -Pn -p 80,443 195.201.13.95`.

**Fix.**

- Caddy not running → `dc up -d caddy`, then `dc logs --tail=100 caddy`.
- Caddy running but ports closed externally → something changed in
  `DOCKER-USER`/ufw. `sudo iptables -S DOCKER-USER; sudo ip6tables -S DOCKER-USER`.
- Ports open and Caddy healthy → the fault is Cloudflare-side: check the record
  still points at `195.201.13.95` and is proxied, and check SSL/TLS mode.

**Tell the customer.** This is a full outage of the app _and_ the marketing site.
`MAINTENANCE_HARD` cannot help — it lives in the thing that is down. Use email
(from a personal mailbox; the platform sends nothing) or whatever channel you
have. Say: we have an outage affecting the whole service, we are working on it,
next update in 30 minutes.

### 9.2 App down

The site loads, the app does not.

**Confirm.**

```bash
docker inspect --format '{{.State.Health.Status}}' libriant-api-1 libriant-web-1 libriant-worker-1
dc logs --tail=100 api
dc exec -T api sh -c 'wget -qO- http://localhost:3001/readyz' ; echo "exit=$?"
```

`/readyz` returning a generic `supportCode` envelope rather than a dependency
map is expected — recover the map with `dc logs api | grep <supportCode>`.

**Fix, in order of likelihood.**

| Finding                                 | Action                                                                                                            |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| api `unhealthy`, Redis or PG in the log | §9.3 / §9.4                                                                                                       |
| api `Created`, never started            | `migrate` did not exit 0 → §9.7                                                                                   |
| api `unhealthy` and stuck               | **Docker will not restart it.** `dc restart api`.                                                                 |
| api healthy but pages error             | The `web → api` hop. `dc exec -T web sh -c 'wget -qO- http://api:3001/healthz'`. No healthcheck crosses this hop. |
| Just deployed                           | `bash scripts/deploy-on-host.sh --ref <previous-sha>`                                                             |

**Tell the customer.** The marketing site is up, so if the outage will last, set
a system-mode window (§9.10) — but read the caveats there first.

### 9.3 Redis down

**This is the worst failure mode in the system and it does not look like Redis.**

**Confirm.** Every route returns 500 — including `/healthz`, `/readyz`,
`/metrics`, and the `/admin/system-mode` recovery lever itself.

```bash
dc ps redis
dc exec -T redis redis-cli ping        # expect PONG
dc logs --tail=100 redis
```

**Why.** `SystemModeMiddleware` runs on `forRoutes('*')` and its `ALWAYS_PASS`
branch still awaits `resolveGlobal()` → a Redis `GET` with
`enableOfflineQueue: false`. `readCache`/`writeCache` have no catch, in both
`SystemModeService` and `TenantResolverService`. `BLOCKER boot-and-config-01`.

**Fix.**

```bash
dc up -d redis
dc exec -T redis redis-cli ping
```

Recovery is automatic ~2 seconds after Redis returns. No restart of api or worker
is needed, no data is lost. If Redis was OOM-killed, see §9.6; if its data volume
is corrupt, `dc stop redis && sudo mv /mnt/libriant/redis/appendonlydir{,.bad} && dc up -d redis`
— you lose queued jobs and rate-limit counters, not durable data.

**During the outage, the in-app maintenance lever does not work.** The only
maintenance mode available is `MAINTENANCE_HARD` on Caddy — and see §9.10 about
whether even that fires.

### 9.4 Postgres down

**Confirm.**

```bash
dc ps postgres pgbouncer
dc exec -T postgres pg_isready -U libriant -d libriant_control
dc logs --tail=200 postgres
df -h /mnt/libriant
```

`/readyz` correctly 503s and tenant reads 500. `/healthz` stays 200 **only while
the global system-mode blob is warm in Redis** — with a cold cache it falls
through to the control DB and 500s too. Liveness depends on both dependencies.

**Fix.**

| Finding                                | Action                                                                                                                                            |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| container exited                       | `dc up -d postgres`, read the log for the reason                                                                                                  |
| `no space left on device`              | §9.5, then restart                                                                                                                                |
| corrupt / won't start                  | §8.3 restore. This is the one that costs you up to 24 hours of data.                                                                              |
| `too many connections`                 | §9.4b                                                                                                                                             |
| running but the app can't authenticate | `POSTGRES_PASSWORD` in `.env.prod` no longer matches `pg_authid` — usually after a cross-host restore (§8.3). Use the **source host's** password. |

The API self-heals within ~3 s of Postgres returning.

**9.4b Connection exhaustion.** `TENANT_CLIENT_CACHE_SIZE` (50) ×
`TENANT_DB_POOL_MAX` (5) = **250 possible tenant connections against
`max_connections=200`**, and pgbouncer fronts only `libriant_control` — tenant
URLs go direct to `postgres:5432`. The documented mitigation
(`pinWorkerConnLimit()` in four cron jobs) is a **no-op under Prisma 7 driver
adapters**.

```bash
dc exec -T postgres psql -U libriant -d libriant_control -c \
  "select count(*), state from pg_stat_activity group by state;"
```

Immediate relief: `dc restart worker` (drops its pools), then `dc restart api`.
Real fix: raise `max_connections` (needs a compose edit and a Postgres restart)
or lower the API's ceiling. `LibriantPgConnectionsHigh/Critical` are the only
alert rules that would catch this.

### 9.5 Disk full

**Confirm which disk.**

```bash
df -h / /mnt/libriant
docker system df
sudo du -sh /var/lib/docker/* 2>/dev/null | sort -rh | head
sudo du -sh /var/lib/docker/containers/* 2>/dev/null | sort -rh | head -5
du -sh /mnt/libriant/* 2>/dev/null | sort -rh
```

**Boot disk (`/`, 80 GiB)** — the likelier one. Known consumers:

| Consumer                                                  | Ceiling                              |
| --------------------------------------------------------- | ------------------------------------ |
| container json-file logs                                  | ~250 MB × 7 ≈ 1.75 GB                |
| Caddy access log (`caddy_logs`, **not** on the data disk) | ~1.4 GB                              |
| Docker images and build cache                             | grows without bound                  |
| `BACKUP_ROOT` if left at its default                      | grows without bound — check for this |
| Prometheus TSDB, if you started monitoring                | 30 d retention                       |

Fix, least destructive first:

```bash
docker image prune -af --filter until=72h
docker builder prune -f
ls -la /srv/libriant/backups 2>/dev/null   # backups on the WRONG disk? move them
dc exec caddy sh -c 'ls -lh /var/log/caddy/'
```

**Data disk (`/mnt/libriant`, 250 GiB)** — Postgres, Redis, uploads, backups.
Do not delete anything under `postgres/` or `redis/`. Trim old backup days, then
**grow the volume** — there are 137.81 GiB unallocated and it is an online
operation (§10.1).

**Tell the customer.** A full data disk means Postgres refuses writes: circulation
stops. Treat it as a full outage, set `read_only` if the lever works, and be
explicit that no data was lost.

### 9.6 OOM

**Confirm.**

```bash
dc ps                       # look for a recently-restarted worker
docker inspect libriant-worker-1 --format '{{.State.OOMKilled}} {{.RestartCount}}'
sudo dmesg -T | grep -i -E 'killed process|out of memory' | tail -20
docker stats --no-stream
free -h; swapon --show
```

**The usual cause is the export worker.** `BLOCKER performance-01`: it buffers
every row of every table in memory **before** the `MAX_EXPORT_ROWS` check. One
table alone reached RSS 1462 MB against `WORKER_MEM_LIMIT=1g`. All five queue
consumers live in **one process**, so the kill takes down the email outbox,
imports and all nine cron sweeps for **every** tenant. BullMQ's stalled checker
re-runs it once and then fails it — two kills, not a loop.

**Fix now.**

```bash
dc up -d worker
docker inspect --format '{{.State.Health.Status}}' libriant-worker-1
```

Then find and cancel the offending export. Raising `WORKER_MEM_LIMIT` in
`.env.prod` (§10.2) buys headroom on a 62 GiB box and is a reasonable stopgap —
it does not fix the unbounded buffer.

`next build` during a deploy can also be OOM-killed (exit 137). On this box, with
62 GiB and 8 GiB of swap, that is unlikely; if it happens, build one service at a
time.

### 9.7 Deploy failed

The script does **not** roll back. It says so:
_"Deploy finished but the stack is not healthy. Nothing was rolled back."_

**Confirm where it stopped.**

```bash
dc ps
dc logs migrate | tail -80
```

| Failure                                                                      | Meaning                                                                                                              | Fix                                                                                                           |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `is not a git checkout` / `.env.prod is missing` / `$DATA_ROOT/x is missing` | preflight                                                                                                            | §3.5–3.7                                                                                                      |
| `origin certificate missing`                                                 | preflight                                                                                                            | §3.7b                                                                                                         |
| `dc build` exit 137                                                          | OOM                                                                                                                  | build one service at a time                                                                                   |
| `dc build` fails in the site build                                           | a `[PLACEHOLDER]` in `apps/site/site.config.json`                                                                    | fix the config; this fails the **Caddy image**, not just a page                                               |
| `Caddyfile is invalid`                                                       | usually **not** the Caddyfile — the origin cert is missing, and `validate` provisions file certificates              | §3.7b                                                                                                         |
| `permission denied … docker daemon socket`                                   | `deploy` is not effectively in the `docker` group                                                                    | §3.4                                                                                                          |
| migrate log ends in `FATAL: control-plane migration failed … P3009`          | **`supply-chain-06`.** Ignore the P3009 advice. Scroll up for `Failed to create cache directory … /opt/corepack/v1`. | §3.0                                                                                                          |
| genuine P3009 / drift                                                        | a real failed migration                                                                                              | `dc run --rm --no-deps migrate sh -lc 'cd /app && pnpm prisma migrate status'` and resolve before redeploying |
| gate times out at 180 s with api unhealthy                                   | app-level                                                                                                            | §9.2                                                                                                          |

**Rollback:** `bash scripts/deploy-on-host.sh --ref <previous-sha>`. Get the sha
from `git -C /srv/libriant/app log --oneline -10`.

### 9.8 Certificate expired or wrong

**Symptom:** Cloudflare **526** on every host, all at once, with no deploy and no
code change. The deploy only `test -f`s the two files, so a green deploy proves
nothing about validity.

**Confirm.**

```bash
openssl x509 -in /mnt/libriant/caddy/origin/origin.crt -noout -subject -issuer -dates -ext subjectAltName
openssl x509 -in /mnt/libriant/caddy/origin/origin.crt -noout -checkend 0 && echo VALID || echo EXPIRED
echo | openssl s_client -connect 127.0.0.1:443 -servername libriant.com 2>/dev/null \
  | openssl x509 -noout -subject -dates
```

**Fix.** Issue a new Origin CA certificate in Cloudflare for `libriant.com` **and**
`*.libriant.com`, save both PEMs to the password manager, write them to
`/mnt/libriant/caddy/origin/`, then:

```bash
dc exec caddy caddy reload --config /etc/caddy/Caddyfile
# if reload does not pick it up:
dc up -d --force-recreate caddy
```

If the files were **deleted** (someone cleaned `/data` or `/mnt/libriant/caddy` —
remember the origin dir lives inside `caddy_data`), the next deploy will refuse
to run at all. Restore from the password manager first.

**Tell the customer.** Every browser shows a Cloudflare error. Full outage.

### 9.9 One tenant broken

**Confirm it is one tenant.** Another library's `/t/<other-slug>/` works.

```bash
dc run --rm --no-deps migrate sh -lc 'cd /app && pnpm tsx scripts/fleet-report.ts'
dc logs --since 1h api | grep -i '<slug>'
dc exec -T postgres psql -U libriant -d libriant_control -c \
  "select slug, status, db_url, cell_id from tenants where slug='<slug>';"
```

| Finding                                                                           | Fix                                                                                        |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| tenant DB on an old schema (after a deploy where `tenant:migrate` said _skipped_) | `dc run --rm --no-deps migrate sh -lc 'cd /app && pnpm tenant:migrate --only=<slug>'`      |
| tenant DB missing extensions (after a restore)                                    | `postgres-init.sql` only runs on an empty PGDATA — create them by hand                     |
| stale cached tenant record                                                        | the Redis key is `tenant:slug:<slug>`; `dc exec -T redis redis-cli del tenant:slug:<slug>` |
| this tenant only, needs a window                                                  | per-tenant system mode: `POST /admin/system-mode/tenants/:tenantId` (§9.10)                |
| uploads 500                                                                       | `BLOCKER data-integrity-01` — see below                                                    |

> **`BLOCKER data-integrity-01`: every file upload returns HTTP 500 in the launch
> configuration.** The unlimited-plan `MAX_SAFE_INTEGER` sentinel overflows a
> Postgres `bigint`. If a library reports that cover images will not upload, this
> is why, and it is not tenant-specific — it is the configuration.

### 9.10 The customer-facing levers

The product ships three. **The incident docs it replaces never mention any of
them.** Each has a caveat you need before you pull it.

**a. System mode (the normal lever).** Owner-only, in the admin panel at
`https://admin.libriant.com/admin/system-mode`, or via the API on the admin host.

| Mode                     | Effect                                                                         |
| ------------------------ | ------------------------------------------------------------------------------ |
| `normal` (0)             | pass through                                                                   |
| `under_construction` (1) | pass through + a banner in the tenant UI                                       |
| `read_only` (2)          | block mutations (POST/PATCH/PUT/DELETE) → 503. Catalogue browsing still works. |
| `out_of_order` (3)       | block everything except bypass routes                                          |
| `maintenance` (3)        | same enforcement, different branding and message                               |

Global or per-tenant; stricter wins; equal severity picks the more specific so
its message is what the user sees.

```
GET    /admin/system-mode/current
POST   /admin/system-mode/global               {mode, messageMarkdown?, startsAt?, endsAt?, allowAdminBypass?}
POST   /admin/system-mode/tenants/:tenantId    same body
POST   /admin/system-mode/events/:id/end       end an active window now
DELETE /admin/system-mode/events/:id           cancel a scheduled one
```

Reachable at `https://admin.libriant.com/lbr-api/admin/system-mode/...` with the
admin session cookie and a matching `Origin: https://admin.libriant.com` header —
but at 3am, use the UI.

`ALWAYS_PASS` keeps `/healthz`, `/readyz`, `/metrics`, `/system-mode/*`,
`/admin/system-mode/*`, `/admin/auth/*`, `/webhooks/stripe` and `/apply` open, so
a window can always be lifted. `/admin/*` and `/auth/admin/*` honour
`allowAdminBypass`, and active impersonation sessions pass.

> **Two caveats before you pull it.**
>
> 1. **If Redis is down, the lever itself 500s** (`boot-and-config-01`, §9.3).
> 2. **Signed-in tenant users currently crash instead of seeing the takeover
>    screen** (`frontend-03`, high): the tenant layout awaits
>    `Promise.all([currentSystemMode, currentImpersonation])` before the takeover
>    branch, and `currentImpersonation` rethrows non-401/403. Anonymous visitors
>    are fine. Prefer `read_only` over `maintenance` where it will do, and expect
>    complaints from logged-in staff.

**b. `MAINTENANCE_HARD` (the edge fallback).** Caddy-only, meant to survive a
total app outage — it serves `maintenance.html` from disk without touching
upstream, on the app and admin vhosts. The marketing site deliberately keeps
serving.

```bash
sed -i 's/^MAINTENANCE_HARD=.*/MAINTENANCE_HARD=true/' /srv/libriant/.env.prod
grep MAINTENANCE_HARD /srv/libriant/.env.prod
set -a; . /srv/libriant/.env.prod; set +a
dc up -d --force-recreate caddy
curl -sk --resolve app.libriant.com:443:127.0.0.1 -o /dev/null -w '%{http_code}\n' \
  -D- https://app.libriant.com/ | grep -i x-maintenance
```

Good looks like: an `X-Maintenance: hard` header. **A recreate, not a reload** —
the placeholder is substituted by the Caddyfile lexer at parse time.

> **UNVERIFIED, and you must test it before you need it.** The matcher is
> `@hard_maint vars {$MAINTENANCE_HARD:false} "true"`. The `{$VAR}` form is
> substituted at parse time, so the matcher becomes the literal
> `vars true "true"` — and Caddy's `vars` matcher looks the **left operand up as
> a variable name**. If no variable named `true` exists, the takeover never
> fires and the documented last-resort lever is dead. Verify with:
>
> ```bash
> docker run --rm -v /srv/libriant/app/infra/caddy/Caddyfile:/etc/caddy/Caddyfile:ro \
>   -e MAINTENANCE_HARD=true -e PUBLIC_HOST=app.libriant.com \
>   -e ADMIN_HOST=admin.libriant.com -e SITE_HOST=libriant.com \
>   caddy:2-alpine caddy adapt --config /etc/caddy/Caddyfile --adapter caddyfile --pretty \
>   | grep -A6 '"vars"'
> ```
>
> Do this on a calm afternoon, not during an incident.

Turn it off by setting `MAINTENANCE_HARD=false` and recreating caddy again.

**c. Announcements.** A banner pushed to tenants, managed at
`/admin/announcements` (`POST /admin/announcements`, `POST /admin/announcements/:id/expire`,
`GET /admin/announcements/:id/stats`), with per-tenant tag targeting. Use this
for planned work and for the "we're back" message. Users can dismiss and
acknowledge.

**d. What you cannot do.** `EMAIL_DRIVER=console` means the platform sends
**nothing** — no incident mail, no status update, no password reset. Every
customer communication is you, from a personal mailbox, by hand. Plan for that.

**Breach notification.** The DPA commits to notifying controllers of a
personal-data breach _"without undue delay"_, with the clock running from
awareness. If an incident involves unauthorised access to member data — including
children's — that clock is legal, not operational. Write down the time you became
aware, in the first minutes, before you start fixing.

---

## 10. Growing

### 10.1 Extending `/mnt/libriant` — online, no downtime

There are **137.81 GiB unallocated in `vg0`**. This is the answer to "the data
volume is filling up".

```bash
sudo vgs                                  # confirm VFree
sudo lvs
df -h /mnt/libriant

sudo lvextend -L +50G /dev/vg0/data       # or -l +100%FREE to take it all
sudo resize2fs /dev/mapper/vg0-data       # ext4, online, no unmount

df -h /mnt/libriant
```

Good looks like: `df` immediately shows the new size, containers keep running,
nothing restarts. Grow in steps rather than consuming all 137.81 GiB at once —
the free extents are also your snapshot space and your headroom for a second
project.

`/` (80 GiB) can be grown the same way if `/var/lib/docker` becomes the pressure
point:

```bash
sudo lvextend -L +20G /dev/vg0/root && sudo resize2fs /dev/mapper/vg0-root
```

Both arrays are RAID1 across two 476.9 GB NVMe devices, so a single drive failure
is survivable. Watch it:

```bash
cat /proc/mdstat                          # both must read [UU]
sudo mdadm --detail /dev/md1 | head -20
```

`[U_]` or `[_U]` means one member has dropped. The array still serves; replacing
the drive is a Hetzner Robot ticket. Do not reboot casually while degraded.

### 10.2 Resource caps, and when to raise them

Eight knobs, all interpolated by compose from `.env.prod`, all **undocumented in
the template** — add them yourself:

```
CADDY_MEM_LIMIT=256m    CADDY_CPUS=1
API_MEM_LIMIT=1g        API_CPUS=1.5
WEB_MEM_LIMIT=768m      WEB_CPUS=1
WORKER_MEM_LIMIT=1g     WORKER_CPUS=1
PG_MEM_LIMIT=2g         PG_CPUS=2
PGBOUNCER_MEM_LIMIT=256m PGBOUNCER_CPUS=0.5
REDIS_MEM_LIMIT=512m    REDIS_CPUS=1
```

Defaults total **5.75 GiB** against 62 GiB, and **8.0 cpus** against 8 threads.
Memory is nowhere near the ceiling; CPU is fully committed at the caps, which is
fine (they are limits, not reservations) but means a busy Postgres and a busy
build compete.

Raise when:

| Signal                                    | Change                                                                                                                                           |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| worker OOM-killed on exports (§9.6)       | `WORKER_MEM_LIMIT=3g` — a stopgap, not a fix for `performance-01`                                                                                |
| Postgres cache hit ratio < 0.95 sustained | `PG_MEM_LIMIT=8g` **and** actual Postgres tuning                                                                                                 |
| `next build` exit 137                     | not a cap — that is the host; build one service at a time                                                                                        |
| Redis memory climbing toward 512m         | raise `REDIS_MEM_LIMIT` **and** set a real `--maxmemory` below it. Measured at 50 seeded tenants: 1.4 MB. A long-horizon risk, not a launch one. |

> **Postgres tuning is not settable from `.env.prod`.** The compose file sets the
> Postgres command inline to only `shared_preload_libraries=pg_stat_statements`
> and `max_connections=200`. There is no passthrough for `shared_buffers`,
> `effective_cache_size`, `work_mem` or `maintenance_work_mem` — a value in
> `.env.prod` is silently dropped. Changing them means editing the compose file
> and committing it. And raise `PG_MEM_LIMIT` **first**: `shared_buffers=8GB`
> against a 2 GB `mem_limit` OOM-kills the container instantly.

### 10.3 When one box stops being enough

Real ceilings on this machine:

| Ceiling                 | Value                                                                      |
| ----------------------- | -------------------------------------------------------------------------- |
| CPU                     | 4 cores / 8 threads — cannot be raised                                     |
| RAM                     | 62 GiB — unlikely to be the constraint                                     |
| Mirrored storage        | ~475 GiB total in `vg0`, of which 137.81 GiB is still free                 |
| Postgres connections    | `max_connections=200` against an API ceiling of **250** (`performance-06`) |
| Single point of failure | **everything.** One box, one Postgres, one Redis. No HA.                   |

The first thing that actually runs out is likely CPU (4 cores, shared between
Postgres, the API, the worker and any `next build`) or the connection ceiling —
not disk and not RAM.

The move, when it comes, is the cell architecture the code already has:
`tenant-relocate.ts` opens a per-tenant `read_only` window, drains, dumps and
restores to another Postgres host, rewrites `tenants.db_url` and `cell_id`, and
busts the Redis cache. `--drain-seconds` must exceed the 30 s system-mode cache
TTL. It leaves the source DB intact; `--drop-source` is a separate, explicit run.

**Before relocating anything: set `BACKUP_ALLOW_OFFHOST_TENANTS=1` in the cron
line, or the nightly backup will abort for every tenant, silently.**

Hosting other projects on this box is reasonable — there is ample RAM and free
LVM extents — with two rules: give each project its own logical volume from the
reserve, and never let another project's container publish a port into
`DOCKER-USER` without re-running the external `nmap`.

---

## 11. Quick reference

### Getting in

```bash
ssh deploy@195.201.13.95
ssh -L 3300:127.0.0.1:3300 deploy@195.201.13.95     # Grafana tunnel
```

### Paths

|                            |                                                                     |
| -------------------------- | ------------------------------------------------------------------- |
| Checkout                   | `/srv/libriant/app`                                                 |
| Secrets                    | `/srv/libriant/.env.prod` (600 deploy:deploy)                       |
| Data root                  | `/mnt/libriant` (`vg0-data`, 250 GiB)                               |
| Postgres / Redis / uploads | `/mnt/libriant/{postgres,redis,storage}`                            |
| Origin cert                | `/mnt/libriant/caddy/origin/{origin.crt,origin.key}`                |
| Backups                    | `/mnt/libriant/backups/YYYYMMDD/`                                   |
| Backup log                 | `/var/log/libriant/backup.log` (rotated by nothing; kilobytes/year) |
| Container logs             | `dc logs` — json-file on the **boot disk**                          |
| Caddy access log           | inside `caddy_logs`, on the **boot disk**                           |

### Commands

```bash
# state
dc ps
docker inspect --format '{{.Name}} {{if .State.Health}}{{.State.Health.Status}}{{else}}no-healthcheck{{end}}' $(docker ps -q)
docker stats --no-stream
free -h; df -h / /mnt/libriant; cat /proc/mdstat; uptime

# logs
dc logs -f --tail=200 api
dc logs migrate | tail -60
dc logs --since 30m api worker

# deploy
bash scripts/deploy-on-host.sh --dry-run
bash scripts/deploy-on-host.sh
bash scripts/deploy-on-host.sh --ref <sha>          # rollback
bash scripts/deploy-on-host.sh --skip-build --no-fetch

# restart
dc restart api
dc up -d                                            # after any manual `dc stop`
dc up -d --force-recreate caddy                     # after a MAINTENANCE_HARD change
dc exec caddy caddy reload --config /etc/caddy/Caddyfile

# operator shell (all TypeScript runs here; host has no Node)
dc run --rm --no-deps migrate sh -lc 'cd /app && pnpm <task>'
dc run --rm --no-deps migrate sh -lc 'cd /app && pnpm tsx scripts/fleet-report.ts'
dc run --rm --no-deps migrate sh -lc 'cd /app && pnpm tenant:migrate --only=<slug>'

# health that is real
curl -s -o /dev/null -w 'edge=%{http_code}\n' http://localhost/healthz         # Caddy only!
curl -sk --resolve libriant.com:443:127.0.0.1 -o /dev/null -w '%{http_code}\n' https://libriant.com/pricing
dc exec -T api sh -c 'wget -qO- http://localhost:3001/readyz'
dc exec -T redis redis-cli ping
dc exec -T postgres pg_isready -U libriant -d libriant_control

# TLS
echo | openssl s_client -connect 127.0.0.1:443 -servername libriant.com 2>/dev/null \
  | openssl x509 -noout -subject -dates -ext subjectAltName
openssl x509 -in /mnt/libriant/caddy/origin/origin.crt -noout -checkend 2592000 -dates

# backup / restore  (env prefix is NOT optional)
set -a; . /srv/libriant/.env.prod; set +a
BACKUP_ROOT=/mnt/libriant/backups STORAGE_DIR=/mnt/libriant/storage \
  COMPOSE_FILE=/srv/libriant/app/infra/compose/docker-compose.prod.yml \
  bash scripts/backup.sh
BACKUP_ROOT=/mnt/libriant/backups STORAGE_DIR=/mnt/libriant/storage \
  COMPOSE_FILE=/srv/libriant/app/infra/compose/docker-compose.prod.yml \
  bash scripts/restore.sh <YYYYMMDD> --yes

# grow the data volume (online)
sudo vgs && sudo lvextend -L +50G /dev/vg0/data && sudo resize2fs /dev/mapper/vg0-data

# external truth (from your laptop, never from the box)
nmap -Pn -p 22,80,443,5432,6379 195.201.13.95
nmap -6 -Pn -p 22,80,443 2a01:4f8:13b:ac8::2
```

### Five things to remember

1. `/healthz` is a **static 200 from Caddy** on every host. It proves nothing.
2. Docker **does not restart an unhealthy container**, and `dc stop` + reboot
   leaves the stack down. `dc up -d`.
3. `deploy-on-host.sh` runs **`git reset --hard`**. Host-local edits to tracked
   files are gone.
4. **`STORAGE_DIR=/mnt/libriant/storage` on every restore**, or it recovers zero
   uploads and tells you it succeeded.
5. `MFA_MASTER_KEY`, `POSTGRES_PASSWORD` and the origin cert are **in no backup**.
   The password manager is the only copy.

---

## Appendix — the unknowns register

Things nobody has measured. Each is flagged inline where you would use it; this
is the list to work through on a calm afternoon.

This is **not** the complete set. The recon that produced this document recorded
88 unknowns across seven areas; the 16 below are the ones that sit under an
instruction someone will actually follow. The full register is the `unknowns`
arrays in `docs/runbook-rewrite-2026-08-23/RECON.json`.

| #   | Unknown                                                                                                                                                                                                         | How to settle it                                                                          |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| 1   | Does the corepack fix actually make `migrate` pass end to end?                                                                                                                                                  | §3.0 build probe with `--network none`                                                    |
| 2   | Caddy directive order — does `/lbr-api/*` really win over the catch-all?                                                                                                                                        | §2, `caddy adapt`                                                                         |
| 3   | Does `MAINTENANCE_HARD` fire at all, or is the `vars` matcher dead?                                                                                                                                             | §9.10b, `caddy adapt` with the flag on                                                    |
| 4   | Does `edoburu/pgbouncer:v1.25.2-p0` contain `pg_isready`?                                                                                                                                                       | `docker run --rm --entrypoint sh edoburu/pgbouncer:v1.25.2-p0 -c 'command -v pg_isready'` |
| 5   | Is `LANG=el_GR.UTF-8` a no-op on `postgres:16-alpine`?                                                                                                                                                          | `docker run --rm postgres:16-alpine locale -a`                                            |
| 6   | Which Postgres client major do the api/worker images carry? A 17/18 client emits `SET transaction_timeout = 0;` which 16 rejects — it would break the customer-facing SQL export the way it once broke restore. | `dc run --rm --no-deps --entrypoint sh api -c 'pg_dump --version; psql --version'`        |
| 7   | Does Docker's apt repo publish a suite for Ubuntu 26.04?                                                                                                                                                        | §3.3                                                                                      |
| 8   | What IP do the `@` and `admin` records actually point at?                                                                                                                                                       | Cloudflare dashboard → DNS                                                                |
| 9   | Zone SSL/TLS mode, Always Use HTTPS source, Bot Fight Mode, security level                                                                                                                                      | Cloudflare dashboard / API                                                                |
| 10  | Does an Origin CA cert for `libriant.com, *.libriant.com` already exist? Is it in the password manager?                                                                                                         | Cloudflare → SSL/TLS → Origin Server                                                      |
| 11  | Does `docker volume inspect libriant_storage` report the bind target or the `/var/lib/docker` path — and does the bind persist while api/worker are stopped (i.e. during a restore)?                            | §8, `findmnt` before and after `dc stop api worker`                                       |
| 12  | Real RTO, at production data volume                                                                                                                                                                             | §8.5 drill                                                                                |
| 13  | `next build` peak memory and `/var/lib/docker` growth on this box                                                                                                                                               | `docker system df` after the first cold build                                             |
| 14  | Does the web container's baked-asset fallback resolve inside the Next.js server bundle? Nothing checks it — `/api/healthz` does not read assets.                                                                | `dc exec -T web sh -c 'ls -l /app/assets/manifest.json /app/locales/el/common.json'`      |
| 15  | Do the four monitoring image pins still work on this host's cgroup version?                                                                                                                                     | §7.2                                                                                      |
| 16  | Does `DEPLOY_KNOWN_HOSTS` still pin the dead box?                                                                                                                                                               | `gh secret list`, then `ssh-keyscan` compared out-of-band against the Hetzner console     |

---

## How this document was built and checked

Written 2026-08-23, then fact-checked against its sources on the same day. This
section exists so the next operator knows exactly how much of the document is
load-bearing evidence and how much is still inference.

### Sources

| Source                                                                  | What it supplied                                                                                                                                                                                                                                                                                  |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/runbook-rewrite-2026-08-23/HOST-FACTS.md`                         | Every hardware, storage, network and installed-package claim in §1, §9.5, §10.1 and §10.3. Measured on the box on 2026-08-23.                                                                                                                                                                     |
| `docs/runbook-rewrite-2026-08-23/RECON.json`                            | 323 verified facts across seven areas (stack-topology, first-deploy, env-and-secrets, dns-tls, backup-dr, day2-ops, monitoring-incident), each carrying a `file:line` or the command that produced it. Also the 122 recorded errors in the documents this one replaces, and 88 recorded unknowns. |
| `docs/audit/pre-release-2026-08-23/BLOCKERS.json` and `FINAL-REPORT.md` | The twelve blockers, of which nine block public launch and three block the first paying customer.                                                                                                                                                                                                 |
| The repository itself                                                   | Every command, path, port, image tag and default was read out of the file it lives in, not from RECON's summary of it.                                                                                                                                                                            |

### What was verified, and how

- **Hardware.** Every number in §1 was compared line by line with HOST-FACTS.
  All match: 62 GiB RAM, 8 GiB swap, 80 GiB `/`, 250 GiB `/mnt/libriant`
  (79 G / 246 G as `df` reports them), 137.81 GiB unallocated in `vg0`,
  2 × 476.9 GB NVMe in RAID1, kernel 7.0.0-30-generic, `enp0s31f6`,
  `2a01:4f8:13b:ac8::2/64`, `git` 2.53.0 / `curl` 8.18.0 / `ufw` 0.36.2. **No
  invented numbers survive.** In particular the dead box's "64 GB DDR4" appears
  nowhere.
- **Compose and Caddy.** Read directly: all eight services, the seven
  healthchecks and their exact intervals, the three network tiers and
  `internal: true` on `data`, the six named volumes and the four the overlay
  rebinds, all seven `mem_limit`/`cpus` pairs (summing to 5888 MiB and 8.0
  cpus), the `json-file` 50m × 5 logging anchor, `restart: unless-stopped` vs
  `migrate`'s `restart: 'no'`, the four vhosts, the `(maintenance_check)` and
  `(maintenance_takeover)` snippets, and the `tls` line that rules out ACME.
- **Scripts.** `deploy-on-host.sh`, `ensure-env.sh`, `prod-bootstrap.sh`,
  `backup.sh`, `restore.sh` and `bootstrap-admin.ts` were read end to end. The
  deploy order in §3.8, the five backup abort gates, the restore sequence in
  §8.3 and the 12-character admin-password minimum all come from the code.
- **Env categories.** The 27 pass-through / 13 compose-literal / 20
  never-injected split was cross-checked against the `x-app-env` block. The six
  `${VAR:?}` hard-requires were confirmed at their compose lines.
- **Citations.** All seven `file:line` references were opened. Two were off and
  are corrected here: the SNI-broken CI health check is
  `.github/workflows/deploy.yml:375` (was cited as `:373`, which is a comment
  line), and the `openssl s_client` defect is `docs/server-handbook.md:683`
  (was `:681`). The other five — `package.json:6`,
  `apps/api/Dockerfile:30`, `apps/web/Dockerfile:9`,
  `infra/caddy/Dockerfile:16`, `docs/deploy-from-the-server.md:113` — are
  exact. A further eleven unnumbered claims (Grafana's `127.0.0.1:3300`, the
  ten alert-rule names, the eight API gauges, `admin_users`, the four
  `postgres-init.sql` extensions, the `tenant:slug:<slug>` Redis key, and
  others) were confirmed in the repo.
- **Inherited errors.** Checked against every `existing_doc_errors` entry in
  RECON. The two most contagious are handled explicitly and repeatedly: the
  `/healthz` static-200 trap (§2, §7.4, §9, §11) and Grafana's port, which is
  **3300**, not 3000 (§7.2). Also not inherited: `dc pull`, "certificate
  obtained" in the Caddy log, `-H 'Host:'` instead of `--resolve`, the
  Cloudflare-range ufw rule described as if it existed, `admin.libriant.com`
  described as absent, the apex "returning 000" rather than 522, the
  64 GB Postgres tuning block, the NVMe serial numbers, the phantom `ops`
  helper, and Appendix C's claim that migrations are manual.

### What this pass changed

Fifteen defects were found and fixed in place. The five that would have stopped
an operator cold:

1. **`deploy` could not use `sudo`.** It was created `--disabled-password` and
   added only to `docker`, yet roughly a third of the commands from §3.5 onward
   are `sudo`. §3.4 now adds it to `sudo` and sets a password, and states that
   everything from §3.5 runs as `deploy`.
2. **The `dc` helper left `IMAGE_TAG=latest`.** Sourcing `.env.prod` in a plain
   shell picks up the `latest` that `ensure-env.sh` writes; nothing is ever
   tagged `latest`, so `dc up -d` — the reboot procedure, `dc up -d caddy`,
   `dc run … migrate` — would have failed on a missing image. §6.1 now
   recomputes the tag the way `deploy-on-host.sh` does.
3. **`dc` was used from §3.9 but only defined in §6.1.** §3.8 now sends you to
   set it up first.
4. **The monitoring bring-up was doubly broken:** `GRAFANA_ADMIN_PASSWORD` was
   assigned without `export` (Compose would have aborted on `${…:?}`), and
   without `-p libriant-monitoring` the stack would have joined project
   `libriant` and been deleted by the next deploy's `--remove-orphans`.
5. **`docker inspect --format '{{.State.Health.Status}}'` over `-aq`** aborts on
   `migrate`, which has no healthcheck — the 3am triage block printed nothing.
   Both occurrences now carry the `{{if .State.Health}}` guard.

Also corrected: a fabricated "good looks like" deploy output that used the
_waiting_ line rather than the script's real success strings; "four pulled"
images (it is three); the backup abort-gate count (five, not six); the
`HostSwapping` threshold, which is 50% of swap for 10 minutes and is a backstop
rather than an early warning; the missing `--filter until=72h` on the builder
prune; the two citation line numbers; and the unstated `IMAGE_OWNER` prompt in
`ensure-env.sh`.

Three blockers that touch an instruction were not flagged at the instruction and
now are:

- **`reliability-01`** at §7.4 — member notifications fail for 100% of tenants
  on every run and report success. Due-soon, overdue and hold-ready notices have
  never been sent to anyone. Fixing `EMAIL_DRIVER` will not fix it.
- **`billing-03` and `billing-04`** at the `BILLING_ENABLED` row in §4.3 — plan
  changes double-charge, and there is no VAT anywhere in the billing path. Both
  block the first paying customer, and the admin Subscriptions toggle that
  triggers them is one click.
- **`data-integrity-01`** additionally at §3.9, because the `STORAGE-OK` probe
  goes green while every upload 500s.

One instruction was found to be **not executable as written and was rewritten
rather than trimmed**: "log into the admin panel once, over the local resolve,
and enrol MFA" (§3.9). A browser cannot be given `--resolve`; a `/etc/hosts`
entry reaches an origin serving a Cloudflare Origin CA certificate no browser
trusts; and the apex's `includeSubDomains` HSTS pin — probably already in your
browser — makes that error non-bypassable. §3.9 now names the two real options
and gives the from-the-box check that _is_ possible.

### What remains unverified

Nothing in this document has been executed on 195.201.13.95. It has never been
deployed to, and this pass did not change that.

- **The whole of §3 is untested end to end**, and §3.8 cannot succeed at all
  until `supply-chain-06` is fixed and the images rebuilt.
- The 16 items in the appendix, all of which are flagged inline where they
  matter. Chief among them: whether the corepack fix actually makes `migrate`
  pass, whether Caddy's directive order puts `/lbr-api/*` ahead of the
  catch-all, whether `MAINTENANCE_HARD`'s `vars` matcher fires at all, whether
  Docker's apt repo publishes a suite for Ubuntu 26.04, and the four Cloudflare
  dashboard settings nobody has read.
- **RTO is unknown.** No restore has ever run to completion on a real host. CI
  proves the Postgres restore stream and nothing else.
- The build-cost figures in §3.8 (10–20 min, ~15–20 GB of `/var/lib/docker`)
  were measured on the dead machine and are marked UNVERIFIED where they appear.
- Correctness of this document's _reasoning_ about code it read but did not run
  — the `IMAGE_TAG` and `--remove-orphans` hazards above are read-and-inferred,
  not reproduced on a box. Both are cheap to confirm on the first deploy; do so.
