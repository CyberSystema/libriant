# Deploying Libriant on Hetzner

A complete, step‑by‑step guide to running Libriant on a **single Hetzner Cloud
server** for a pilot of **up to ~20 libraries (tenants)**, plus exact procedures
for **vertical** (bigger box) and **horizontal** (more boxes / split services)
upgrades when you outgrow it.

It is written against this repository's real infra:
`infra/compose/docker-compose.prod.yml`, `infra/caddy/Caddyfile`,
`.env.prod.example`, `infra/deploy/fleet.yml`, `.github/workflows/deploy.yml`,
and the `scripts/` provisioning tooling.

> Throughout, replace `libriant.app` / `admin.libriant.app` with your real
> domains, and `203.0.113.10` with your server's IP.

---

## 0. What you are deploying

Single host, all containers on a private Docker network; only Caddy binds
80/443 to the internet:

```
                         Internet
                            │  80 / 443 (TCP+UDP/HTTP3)
                      ┌─────▼─────┐
                      │   caddy   │   TLS (Let's Encrypt), security headers,
                      └─────┬─────┘   /_assets static, maintenance fallback
                ┌───────────┼───────────┐
                ▼           ▼            ▼
            ┌───────┐   ┌───────┐    /webhooks/* → api
            │  web  │   │  api  │
            │ :3000 │   │ :3001 │
            └───────┘   └───┬───┘
                            │ (private "app" network)
        ┌───────────┬───────┴───────┬───────────┐
        ▼           ▼               ▼           ▼
    ┌────────┐ ┌──────────┐    ┌────────┐  ┌────────┐
    │postgres│ │ pgbouncer│    │ redis  │  │ worker │
    │  :5432 │ │  :5432   │    │ :6379  │  │ :3002  │ (BullMQ jobs + email)
    └────────┘ └──────────┘    └────────┘  └────────┘
```

Seven containers: `caddy`, `web`, `api`, `worker`, `postgres`, `pgbouncer`,
`redis`. Postgres/Redis/PgBouncer **never** bind to a host port — they are only
reachable on the internal `app` network.

Tenancy: one **control‑plane DB** (`libriant_control`) plus **one Postgres
database per tenant** (`tenant_<id>`), all on the same Postgres instance at this
scale. The API runs under `tsx` in production (per `apps/api/Dockerfile`); the
web app runs `next start`.

---

## 1. Server recommendation (≤ 20 tenants)

### Footprint at this scale

Libraries are small (hundreds–low thousands of books/members) and staff‑facing,
so concurrency is low (a handful of simultaneous requests platform‑wide). The
seven containers idle around **1.5–3 GB RAM**; with the OS + Docker daemon you
want **~4 GB used, 8 GB total** so backups, image pulls and request spikes never
press on memory. Images are built in CI (GHCR), so the host only **pulls** —
it does not need to compile anything.

### Pick

| Need                 | Hetzner type               | vCPU | RAM  | Disk       | ~€/mo\* |
| -------------------- | -------------------------- | ---- | ---- | ---------- | ------- |
| **Recommended**      | **CX32** (Intel, shared)   | 4    | 8 GB | 80 GB NVMe | ~€8     |
| Cheaper (ARM)        | CAX21 (Ampere, shared)     | 4    | 8 GB | 80 GB NVMe | ~€7     |
| Predictable perf     | CCX13 (AMD, **dedicated**) | 2    | 8 GB | 80 GB NVMe | ~€13    |
| Budget floor (tight) | CX22                       | 2    | 4 GB | 40 GB      | ~€4.5   |
| Backups offsite      | **Storage Box BX11**       | –    | –    | 1 TB       | ~€4     |

\* Approximate — **check current Hetzner pricing**. The project plan itself
targets a “Hetzner CX32” for the pilot, which is the sweet spot here.

**Recommendation: one `CX32` + one `BX11` Storage Box for offsite backups.**

- **Region:** pick the one nearest your libraries (e.g. `nbg1`/`fsn1`/`hel1` in
  the EU). Keep it consistent with where your Storage Box lives.
- **ARM note:** Prisma 7 is engine‑free (pure‑JS driver adapters) and the whole
  stack is Node/Docker, so **ARM (CAX) works fine** and is cheaper. Choose
  `CX32` only if you prefer x86 for zero surprises.
- **CX22 (4 GB) is viable but tight** — it leaves little headroom for the nightly
  `pg_dumpall` + storage tar. Add a 2 GB swap file (Part 4) if you use it.
- **Image:** Ubuntu 24.04 LTS (x86) or the ARM equivalent for CAX.

When to grow: see **Part J (vertical)** and **Part K (horizontal)**.

---

## 2. Prerequisites (before you touch a server)

- [ ] A **domain** you control (e.g. `libriant.app`) with access to its DNS.
- [ ] **GitHub repo** for this code with **GHCR** (GitHub Container Registry)
      images built by `.github/workflows/deploy.yml`, _or_ the ability to build
      images locally and push them.
- [ ] A **Stripe account** (test mode is fine to start) for billing keys.
- [ ] An **SSH keypair** for server access (`ssh-keygen -t ed25519`).
- [ ] `hcloud` CLI installed locally (optional but handy):
      `brew install hcloud` / see Hetzner docs. Create an API token in the
      Cloud Console → _Security → API tokens_ and `hcloud context create libriant`.
- [ ] Generate the production **secrets** now and keep them in your password
      manager (the next block).

Generate the secrets:

```sh
echo "SESSION_SECRET=$(openssl rand -hex 32)"
echo "ADMIN_SESSION_SECRET=$(openssl rand -hex 32)"
echo "IMPERSONATION_SECRET=$(openssl rand -hex 32)"
echo "STORAGE_SIGNING_SECRET=$(openssl rand -hex 32)"
echo "MFA_MASTER_KEY=$(openssl rand -hex 32)"   # exactly 64 hex chars
echo "POSTGRES_PASSWORD=$(openssl rand -hex 24)"
```

> ⚠️ **Reconcile the image names before deploying.** The compose file pulls
> `ghcr.io/libriant/api` and `ghcr.io/libriant/web`, while the CI workflow pushes
> `ghcr.io/<owner>/libriant-api` and `ghcr.io/<owner>/libriant-web`. Make these
> agree: either edit `image:` in `infra/compose/docker-compose.prod.yml` to match
> what CI pushes (recommended), or adjust the workflow tags. Decide your final
> image names now and use them consistently below.

---

## 3. Part A — Provision the server

### Via the Cloud Console

1. **Create server** → choose your region → image **Ubuntu 24.04** → type
   **CX32** → add your SSH key → name it `cell-01` → **Create**.
2. Note the public IPv4 (and IPv6) address.

### Or via `hcloud`

```sh
hcloud ssh-key create --name libriant-deploy --public-key-from-file ~/.ssh/id_ed25519.pub
hcloud server create \
  --name cell-01 \
  --type cx32 \
  --image ubuntu-24.04 \
  --location nbg1 \
  --ssh-key libriant-deploy
hcloud server ip cell-01      # → your IPv4
```

### Cloud Firewall (network‑level — do this first)

Allow only SSH + HTTP/HTTPS. Postgres/Redis are never exposed.

```sh
hcloud firewall create --name libriant-edge
# inbound: SSH (lock to your IP if you have a static one), HTTP, HTTPS (incl. HTTP/3)
hcloud firewall add-rule libriant-edge --direction in --protocol tcp --port 22  --source-ips 0.0.0.0/0 --source-ips ::/0
hcloud firewall add-rule libriant-edge --direction in --protocol tcp --port 80  --source-ips 0.0.0.0/0 --source-ips ::/0
hcloud firewall add-rule libriant-edge --direction in --protocol tcp --port 443 --source-ips 0.0.0.0/0 --source-ips ::/0
hcloud firewall add-rule libriant-edge --direction in --protocol udp --port 443 --source-ips 0.0.0.0/0 --source-ips ::/0
hcloud firewall apply-to-resource libriant-edge --type server --server cell-01
```

> Tighten port 22 to your own IP/CIDR if it's static. Outbound is allowed by
> default (needed for ACME, GHCR pulls, Stripe, OpenLibrary, backups).

---

## 4. Part B — Host setup

SSH in as root, then harden and install Docker.

```sh
ssh root@203.0.113.10
```

```sh
# 1. Patch + base packages
apt-get update && apt-get -y upgrade
apt-get -y install git curl ufw fail2ban unattended-upgrades ca-certificates
dpkg-reconfigure -plow unattended-upgrades   # enable automatic security updates

# 2. Swap (cheap insurance against memory spikes; essential on a 4 GB box)
fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
sysctl -w vm.swappiness=10 && echo 'vm.swappiness=10' >> /etc/sysctl.d/99-libriant.conf

# 3. Docker Engine + Compose plugin (official convenience script)
curl -fsSL https://get.docker.com | sh
docker compose version   # sanity check

# 4. A non-root deploy user in the docker group (matches fleet.yml: user "deploy")
adduser --disabled-password --gecos "" deploy
usermod -aG docker deploy
mkdir -p /home/deploy/.ssh
cp ~/.ssh/authorized_keys /home/deploy/.ssh/authorized_keys
chown -R deploy:deploy /home/deploy/.ssh && chmod 700 /home/deploy/.ssh && chmod 600 /home/deploy/.ssh/authorized_keys

# 5. Host firewall (defense in depth behind the Cloud Firewall)
ufw default deny incoming && ufw default allow outgoing
ufw allow 22/tcp && ufw allow 80/tcp && ufw allow 443
ufw --force enable

# 6. SSH hardening
sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin prohibit-password/' /etc/ssh/sshd_config
systemctl reload ssh
```

### Directory layout + the repo

We run Compose **from a full repo checkout** so the relative volume mounts in
the compose file (`../../assets`, `../../locales`, `../caddy/...`) resolve
correctly. (The CI workflow's rsync flattens those trees — fine once it's
adjusted, but the repo checkout is the simplest correct path for a single host.)

```sh
# as deploy user
su - deploy
sudo mkdir -p /srv/libriant /var/log/libriant && sudo chown -R deploy:deploy /srv/libriant /var/log/libriant
git clone https://github.com/<owner>/libriant.git /srv/libriant/app
cd /srv/libriant/app
git checkout main      # or a release tag you trust
```

### The production env file

```sh
cp .env.prod.example /srv/libriant/.env.prod
chmod 600 /srv/libriant/.env.prod
nano /srv/libriant/.env.prod
```

Fill in **every** value (paste the secrets you generated in Part 2):

```ini
PUBLIC_HOST=libriant.app
ADMIN_HOST=admin.libriant.app
ACME_EMAIL=ops@libriant.app
MAINTENANCE_HARD=false
IMAGE_TAG=latest                 # or a pinned short-SHA from CI

POSTGRES_PASSWORD=<from openssl>

SESSION_SECRET=<from openssl>
ADMIN_SESSION_SECRET=<from openssl>
IMPERSONATION_SECRET=<from openssl>
MFA_MASTER_KEY=<64 hex chars>
STORAGE_SIGNING_SECRET=<from openssl>

STRIPE_DRIVER=real               # use "fake" only for a non-billing trial
STRIPE_API_KEY=sk_live_or_test_xxx
STRIPE_WEBHOOK_SECRET=whsec_xxx  # filled in Part F

RCLONE_REMOTE=                   # set in Part G for offsite backups
BACKUP_KEEP_DAYS=14
```

> The compose file refuses to start if `SESSION_SECRET`, `ADMIN_SESSION_SECRET`,
> `IMPERSONATION_SECRET`, `MFA_MASTER_KEY` or `POSTGRES_PASSWORD` are missing
> (they use the `${VAR:?error}` form). Good — it fails loudly, not silently.

### Authenticate to GHCR (if your images are private)

```sh
echo "<GitHub PAT with read:packages>" | docker login ghcr.io -u <github-user> --password-stdin
```

(Or make the GHCR packages public and skip this.)

---

## 5. Part C — DNS

Point your domains at the server. Both the apex and the admin host are required
(the Caddyfile serves both and issues a cert for each).

| Record               | Type | Value                    |
| -------------------- | ---- | ------------------------ |
| `libriant.app`       | A    | `203.0.113.10`           |
| `libriant.app`       | AAAA | `<your IPv6>` (optional) |
| `admin.libriant.app` | A    | `203.0.113.10`           |
| `admin.libriant.app` | AAAA | `<your IPv6>` (optional) |

Wait for propagation (`dig +short libriant.app` returns your IP). Caddy needs
the DNS to resolve **before** it can complete the Let's Encrypt HTTP‑01
challenge.

> Custom per‑tenant subdomains (`*.libriant.app`) are a later Pro/Enterprise
> feature and need a **DNS‑01** wildcard challenge — see the commented wildcard
> block at the bottom of `infra/caddy/Caddyfile`. Not needed for the pilot.

---

## 6. Part D — First bring‑up

```sh
cd /srv/libriant/app
set -a && . /srv/libriant/.env.prod && set +a     # export all env vars

docker compose -f infra/compose/docker-compose.prod.yml pull
docker compose -f infra/compose/docker-compose.prod.yml up -d
```

Watch it come up:

```sh
docker compose -f infra/compose/docker-compose.prod.yml ps
docker compose -f infra/compose/docker-compose.prod.yml logs -f caddy api web
```

You want: `postgres` healthy → `pgbouncer`/`redis` up → `api`/`web` healthy →
`caddy` healthy. Caddy will obtain TLS certs on first start (watch its logs for
“certificate obtained”).

At this point the app is up but the **databases are empty** — finish in Part E.

> **Tip — a reusable “ops runner”.** Several admin tasks need the repo's
> `scripts/`, which are **not** baked into the runtime image, and Postgres/Redis
> are not reachable from the host. Run them in a throwaway Node container
> attached to the app network, with the repo mounted. Paste this helper into
> your shell (run from `/srv/libriant/app`):
>
> ```sh
> # Compose creates the network as "<project>_app". Default project = folder
> # name ("app"); confirm with: docker network ls | grep app
> APP_NET="$(docker network ls --format '{{.Name}}' | grep -E '_app$' | head -1)"
> ops() {
>   docker run --rm --network "$APP_NET" \
>     -v /srv/libriant/app:/repo -w /repo \
>     -e CONTROL_DATABASE_URL="postgresql://libriant:${POSTGRES_PASSWORD}@pgbouncer:5432/libriant_control" \
>     -e PG_SUPERUSER_URL="postgresql://libriant:${POSTGRES_PASSWORD}@postgres:5432/libriant_control" \
>     -e REDIS_URL="redis://redis:6379" \
>     -e STORAGE_ROOT="/srv/libriant/storage" \
>     node:20-bookworm-slim sh -lc "corepack enable && $*"
> }
> # First call installs deps into the mounted repo (one-time, ~1-2 min):
> ops "pnpm install --frozen-lockfile && pnpm db:generate"
> ```
>
> Migrations that only touch `db-control`/`db-tenant` can alternatively run
> straight in the api container, e.g.
> `docker compose -f infra/compose/docker-compose.prod.yml exec api pnpm db:migrate:deploy`.

---

## 7. Part E — Bootstrap the platform

Run these once, in order, using the `ops` helper from Part D.

```sh
cd /srv/libriant/app && set -a && . /srv/libriant/.env.prod && set +a

# 1. Apply the control-plane schema (creates the ~25 control tables)
ops "pnpm db:migrate:deploy"

# 2. Seed cells + the 15 feature keys + 5 starter plans + 75 plan-feature values
ops "pnpm db:seed"

# 3. Load the bundled help-centre articles into Postgres FTS (both locales)
ops "pnpm ingest:help"

# 4. Create the first Libriant staff/admin account (control-plane, separate
#    from tenant users). Then enrol MFA in the UI before using support access.
ADMIN_BOOTSTRAP_EMAIL=you@yourco.com \
ADMIN_BOOTSTRAP_PASSWORD='a-long-admin-passphrase' \
  ops "ADMIN_BOOTSTRAP_EMAIL=$ADMIN_BOOTSTRAP_EMAIL ADMIN_BOOTSTRAP_PASSWORD='$ADMIN_BOOTSTRAP_PASSWORD' pnpm admin:bootstrap"
```

### Creating tenants (libraries)

Two ways:

- **Self‑service (normal):** a librarian visits `https://libriant.app`, clicks
  _Create account_, and signup provisions everything automatically — the tenant
  database, its schema, default settings, the owner user, and the storage
  directory. This is the path your pilot libraries use.
- **Operator‑provisioned (optional):** to pre‑create a library on a specific
  plan / billing mode:
  ```sh
  ops "pnpm tenant:create -- \
    --slug=acme \
    --name='Acme Public Library' \
    --owner-email=ops@acme.org \
    --owner-name='Acme Operator' \
    --plan=community \
    --billing-mode=manual"
  ```

### Enrol admin MFA

Log in at `https://admin.libriant.app` → MFA page → scan the QR / enter the
secret in an authenticator app → verify. MFA is **mandatory** before the
break‑glass support flow will work.

---

## 8. Part F — Stripe webhook

Billing state stays correct only if Stripe can reach your webhook.

1. Stripe Dashboard → _Developers → Webhooks → Add endpoint_.
2. URL: `https://libriant.app/webhooks/stripe`
3. Events: `customer.subscription.created/updated/deleted`,
   `invoice.payment_succeeded`, `invoice.payment_failed`.
4. Copy the **Signing secret** (`whsec_…`) into `STRIPE_WEBHOOK_SECRET` in
   `/srv/libriant/.env.prod`, then recreate the api + worker:
   ```sh
   set -a && . /srv/libriant/.env.prod && set +a
   docker compose -f infra/compose/docker-compose.prod.yml up -d api worker
   ```
5. Use Stripe's “Send test webhook” and confirm a 200 in the api logs.

---

## 9. Part G — Backups (do this on day one)

The repo ships `scripts/backup.sh`: it `pg_dumpall`s **all** databases (control +
every tenant), tars `/srv/libriant/storage`, snapshots the Caddy access log,
writes a manifest, prunes dailies older than `BACKUP_KEEP_DAYS`, and optionally
`rclone`‑copies everything offsite.

### Offsite target — Hetzner Storage Box (recommended)

1. Order a **Storage Box** (BX11) in the Console; note its SSH/SFTP host + user.
2. Install + configure `rclone` on the host:
   ```sh
   sudo apt-get -y install rclone
   rclone config    # new remote "storagebox", type "sftp", host/user/pass from Hetzner
   ```
3. Set `RCLONE_REMOTE=storagebox:libriant-backups` in `/srv/libriant/.env.prod`.

### Schedule it

The script reads env from the shell; wire a root cron that sources `.env.prod`:

```sh
sudo tee /etc/cron.d/libriant-backup >/dev/null <<'CRON'
15 2 * * * deploy bash -lc 'set -a; . /srv/libriant/.env.prod; set +a; COMPOSE_PROJECT_NAME=app /srv/libriant/app/scripts/backup.sh >> /var/log/libriant/backup.log 2>&1'
CRON
```

> `COMPOSE_PROJECT_NAME` must match your actual project (folder name `app` →
> `app`; the script defaults to `libriant` — set it to match, or rename your
> project). Verify the volume path it derives for Caddy logs
> (`/var/lib/docker/volumes/<project>_caddy_logs/_data`).

Run it once manually and confirm a non‑trivial `postgres.sql.gz` appears under
`/srv/libriant/backups/<date>/` and lands in the Storage Box:

```sh
set -a && . /srv/libriant/.env.prod && set +a
COMPOSE_PROJECT_NAME=app /srv/libriant/app/scripts/backup.sh
```

### Restore drill (practise before you need it)

```sh
# 1. Stop the app (keep data services), or restore into a fresh DB.
gunzip -c /srv/libriant/backups/<date>/postgres.sql.gz | \
  docker compose -f infra/compose/docker-compose.prod.yml exec -T postgres psql -U libriant -d postgres
# 2. Restore storage:
docker run --rm -v app_storage:/dst -v /srv/libriant/backups/<date>:/bak alpine \
  sh -c 'tar -C /dst -xzf /bak/storage.tar.gz'
```

Also enable **Hetzner automated server backups/snapshots** in the Console for a
whole‑disk safety net (cheap, separate from the logical backups above).

---

## 10. Part H — Verify

```sh
curl -fsS https://libriant.app/healthz && echo            # edge up
curl -fsS https://libriant.app/api/readyz | jq            # web → api reachable
curl -fsS https://libriant.app/readyz | jq                # api: redis + controlDb true
# Worker is internal; check it directly on the host:
docker compose -f infra/compose/docker-compose.prod.yml exec worker wget -qO- http://localhost:3002/readyz
```

Then in a browser: visit `https://libriant.app` (gets redirected to `/el` or
`/en` by `Accept‑Language`), create a test library, add a book, check it out —
and confirm `https://admin.libriant.app` shows the admin login.

---

## 11. Part I — Day‑2 operations

### Routine deploys

Two options:

- **CI (recommended once stable):** push to `main` (or run the _deploy_ workflow
  manually). It builds + pushes images and, for each host in
  `infra/deploy/fleet.yml`, rsyncs infra and runs `compose pull && up -d`. Set
  the repo secrets `DEPLOY_SSH_KEY` (a private key whose public half is in
  `deploy`'s `authorized_keys`) and a `production` environment. Confirm
  `fleet.yml`'s `ssh:`/`user:` match your host (`cell-01.libriant.app`,
  `deploy`).
- **Manual:** on the host,
  ```sh
  cd /srv/libriant/app && git pull
  set -a && . /srv/libriant/.env.prod && set +a
  docker compose -f infra/compose/docker-compose.prod.yml pull
  docker compose -f infra/compose/docker-compose.prod.yml up -d --remove-orphans
  ```

### ⚠️ Migrations are NOT automatic

Neither the CI workflow nor `compose up` runs database migrations. **After any
deploy that changes the schema**, apply them yourself:

```sh
ops "pnpm db:migrate:deploy"      # control-plane schema
ops "pnpm tenant:migrate"         # fans out tenant migrations across ALL tenant DBs
```

`scripts/tenant-migrate.ts` iterates every row in `tenants`, dials each
`db_url`, and applies pending tenant migrations — so adding a column to the
tenant schema is one command, whether you have 3 tenants or 300. Do this inside
a read‑only window (see below) if a migration is not backward‑compatible.

### Maintenance / read‑only windows

- **Soft (preferred):** from the admin UI → _System mode_ → set `maintenance`
  (global takeover) or `read_only` (GETs pass, writes return 503). The app
  serves a branded, translated takeover page.
- **Hard (last resort):** set `MAINTENANCE_HARD=true` in `.env.prod` and
  `docker compose ... up -d caddy`. Caddy then serves the static
  `maintenance.html` from disk **even if api/web are down**. Revert to `false`
  and recreate caddy when done.

### Logs, status, rollback

```sh
docker compose -f infra/compose/docker-compose.prod.yml logs -f api          # follow api
docker compose -f infra/compose/docker-compose.prod.yml ps                   # health
# Roll back to a known-good image tag:
#   set IMAGE_TAG=<old-short-sha> in .env.prod, then:
set -a && . /srv/libriant/.env.prod && set +a
docker compose -f infra/compose/docker-compose.prod.yml up -d
```

(That's why the deploy workflow tags images with the commit SHA, not just
`latest` — you can always pin back.)

### Graceful shutdown

The API enables NestJS shutdown hooks and the image runs under `tini`, so
`docker compose stop` drains connections cleanly before exit — safe to use
before any reboot/resize.

---

## 12. Capacity & monitoring (watch these before you scale)

You can't manage what you can't see. Libriant ships **two layers** of
visibility — app-level (how many libraries, how big, how close to limits) and
server-level (CPU/RAM/disk/containers) — both **free**.

### 12.1 App-level — fleet & capacity (built in)

- **Admin UI:** `https://admin.libriant.app` → **Capacity** in the sidebar. Shows
  the tenant census (total **and** by status / plan / cell — not just active),
  per‑tenant DB + storage sizes (heaviest first), and the host signals
  (Postgres connections vs. max, cache‑hit ratio, Redis memory, disk %), with
  amber/red colouring when a signal gets tight.
- **API (JSON):** `GET /admin/fleet/overview` (admin‑authed) — the same data for
  scripting/monitoring.
- **CLI (on the server):** a human‑readable report, great for SSH or a daily
  cron snapshot:
  ```sh
  ops "pnpm fleet:report"          # via the ops helper from Part D
  ops "pnpm fleet:report -- --json"  # machine-readable
  ```
  ```
  Libraries (total)   24      by status: active 22, suspended 1, archived 1
  PG connections      8 / 100 (8%)      PG cache hit ratio  99.94%
  Tenant DBs total    185 MB across 21  Disk (storage vol)  749 GB / 926 GB (81%)
  Top libraries by total size: …
  ```
  Daily snapshot cron (optional):
  ```sh
  0 7 * * * deploy bash -lc 'set -a; . /srv/libriant/.env.prod; set +a; cd /srv/libriant/app && pnpm fleet:report >> /var/log/libriant/fleet.log 2>&1'
  ```
- **Prometheus gauges:** the API's internal `/metrics` exposes
  `libriant_tenants_total{status=…}`, `libriant_storage_used_bytes`,
  `libriant_pg_connections`, `libriant_pg_connections_max`,
  `libriant_pg_cache_hit_ratio`, `libriant_redis_used_memory_bytes` (+ the
  worker's `libriant_worker_jobs_running`). These are scraped by the stack
  below and drive the alerts. `/metrics` is internal‑only (Caddy short‑circuits
  the public path), so these counts are never exposed to tenants.

### 12.2 Server-level — free self-hosted monitoring (Prometheus + Grafana)

A complete, free, open‑source stack lives in `infra/monitoring/`:
**Prometheus** (scrape + store + alert), **node-exporter** (host CPU/RAM/disk/
network), **cAdvisor** (per‑container usage), **Grafana** (dashboards + alerts).
It attaches to the app's private network to also scrape Libriant's own
`/metrics`.

**Bring it up** (after the main stack is running):

```sh
cd /srv/libriant/app
# 1. Find the main stack's app network (created by the prod compose):
export LIBRIANT_APP_NETWORK="$(docker network ls --format '{{.Name}}' | grep -E '_app$' | head -1)"
# 2. Set a Grafana admin password:
export GRAFANA_ADMIN_PASSWORD="$(openssl rand -hex 16)"; echo "Grafana admin pw: $GRAFANA_ADMIN_PASSWORD"
# 3. Start the monitoring stack:
docker compose -f infra/monitoring/docker-compose.monitoring.yml up -d
```

**Open Grafana** — it binds to `127.0.0.1` only (never public). Use an SSH
tunnel from your laptop:

```sh
ssh -L 3300:127.0.0.1:3300 deploy@cell-01.libriant.app
# then open http://localhost:3300  (user: admin, pw: the one you set)
```

The Prometheus datasource is **auto‑provisioned**. Import two community
dashboards by ID (Grafana → Dashboards → Import):

- **1860** — _Node Exporter Full_ (host CPU/RAM/disk/network).
- **14282** — _cAdvisor_ (per‑container resources).

For a Libriant‑specific panel, query the gauges directly, e.g.
`libriant_tenants_total`, `libriant_pg_connections / libriant_pg_connections_max`,
`libriant_pg_cache_hit_ratio`.

**Alerts** — `infra/monitoring/alerts.yml` ships 10 rules covering exactly the
capacity signals (validated with `promtool`):

| Alert                                    | Fires when                     | Meaning / action                                  |
| ---------------------------------------- | ------------------------------ | ------------------------------------------------- |
| `LibriantApiDown` / `TargetDown`         | a target is unreachable        | the app or an exporter is down                    |
| `HostLowMemory`                          | available RAM < 12% (10m)      | cache headroom gone → **scale up (Part J)**       |
| `HostSwapping`                           | swap > 50% (10m)               | memory pressure → scale up                        |
| `HostDiskFilling` / `HostDiskCritical`   | disk free < 15% / < 7%         | offload backups/storage; free space now           |
| `HostHighCPU`                            | CPU busy > 85% (15m)           | bulk import/report, or scale CPU                  |
| `LibriantPgConnectionsHigh` / `Critical` | connections > 80% / 95% of max | lower PgBouncer `DEFAULT_POOL_SIZE` (Parts J & K) |
| `LibriantPgCacheHitLow`                  | cache hit < 95% (15m)          | working set outgrew RAM → scale up or shard       |

They show in the Prometheus + Grafana **Alerts** views out of the box. To get
**notified** (email / Slack / ntfy), run a free **Alertmanager** and point
`prometheus.yml`'s `alerting:` block at it (a commented stub is included).

> **Lighter free alternative:** if you'd rather one container with zero config,
> **Netdata** (`docker run -d --name netdata -p 127.0.0.1:19999:19999 …
netdata/netdata`) gives per‑second host + container dashboards and built‑in
> alerts out of the box. The Prometheus stack above is the better choice once
> you want long‑term retention, custom alerts, and to chart the `libriant_*`
> app gauges alongside host metrics.

### 12.3 What to watch, and what it tells you to do

| Signal                             | Healthy                  | When it crosses → do                                                       |
| ---------------------------------- | ------------------------ | -------------------------------------------------------------------------- |
| **RAM available / swap**           | RAM avail > 20%, no swap | low/ swapping → **vertical upgrade** (Part J), bigger RAM                  |
| **PG cache hit ratio**             | > 99%                    | < 95% sustained → more RAM (vertical) or **shard tenants** (Part K)        |
| **PG connections / max**           | < 60%                    | > 80% → tune PgBouncer pool; > 95% → urgent                                |
| **Disk used**                      | < 80%                    | > 85% → backups to Storage Box, files to Object Storage (Part K Stage 4)   |
| **Tenant count / heaviest tenant** | within plan-for capacity | nearing your CCX/CPX limit → split Postgres (Part K Stage 1) or add a cell |

The monitoring stack is the early‑warning system; the upgrade procedures below
(Parts J & K) are what you do when it goes amber.

---

## 13. Part J — Vertical upgrade (scale the single box up)

Use this first: it's the cheapest way to buy headroom (e.g. `CX32 → CX42 → CX52`,
or `CAX21 → CAX31`). Signs you need it: sustained high RAM/CPU, slow page loads,
backups pressing on memory, Postgres connection pressure.

> **Hetzner rules you must know:**
>
> - The server must be **powered off** to change type.
> - **Disk growth is irreversible.** If you let the new type's larger disk be
>   applied, you can never rescale _down_ to a smaller‑disk type again. To keep
>   the option to downscale, choose **“keep disk size”** when rescaling.
> - CPU/RAM changes are reversible (as long as the disk wasn't grown).

### Step by step

1. **Backup first.** Run the backup, confirm it's good, and (optionally) take a
   Hetzner snapshot:
   ```sh
   set -a && . /srv/libriant/.env.prod && set +a
   COMPOSE_PROJECT_NAME=app /srv/libriant/app/scripts/backup.sh
   hcloud server create-image --type snapshot --description "pre-resize $(date +%F)" cell-01
   ```
2. **Announce + enter maintenance** (admin UI → System mode → `maintenance`),
   or set `MAINTENANCE_HARD=true` + recreate caddy.
3. **Drain + stop** cleanly:
   ```sh
   cd /srv/libriant/app
   docker compose -f infra/compose/docker-compose.prod.yml stop   # graceful (tini + shutdown hooks)
   ```
4. **Power off** the server:
   ```sh
   hcloud server poweroff cell-01      # or Console → Power → Power off
   ```
5. **Change the type:**
   ```sh
   # Keep disk size so you can downscale later (recommended):
   hcloud server change-type --keep-disk cell-01 cx42
   # ...or accept the bigger disk (irreversible):
   # hcloud server change-type cell-01 cx42
   ```
   (Console: _server → Rescale → pick type → choose “Keep disk” → Rescale_.)
6. **Power on:**
   ```sh
   hcloud server poweron cell-01
   ```
7. **If you grew the disk**, confirm the filesystem expanded (Hetzner's images
   auto‑grow the root partition on boot via cloud‑init):
   ```sh
   df -h /            # should reflect the new size
   # If not auto-grown:
   sudo growpart /dev/sda 1 && sudo resize2fs /dev/sda1
   ```
8. **Bring the stack back + verify**, then exit maintenance:
   ```sh
   cd /srv/libriant/app && set -a && . /srv/libriant/.env.prod && set +a
   docker compose -f infra/compose/docker-compose.prod.yml up -d
   curl -fsS https://libriant.app/readyz | jq
   # System mode → back to normal (or MAINTENANCE_HARD=false + recreate caddy)
   ```
9. **Tune Postgres for the new RAM (optional but worthwhile on a bigger box).**
   The compose passes only `max_connections=200` + `pg_stat_statements`. On
   CX42+ you may want larger `shared_buffers`/`effective_cache_size`. Add flags
   to the postgres `command:` in the compose file (e.g.
   `-c shared_buffers=2GB -c effective_cache_size=6GB`) and recreate `postgres`.
   PgBouncer's `DEFAULT_POOL_SIZE=20` / `MAX_CLIENT_CONN=500` are already
   generous for ≤20 tenants; raise only if you see pool exhaustion.

**Downtime:** a few minutes (the resize itself). Plan a low‑traffic window.

---

## 14. Part K — Horizontal upgrade (split services / add nodes)

When one box can't grow further (or you want resilience), follow the project's
designed scaling path. Each stage is **configuration, not a rewrite** — the
architecture keeps per‑tenant `db_url`/`storage_url` in the control plane, runs
stateless app processes with sessions in Redis, and fans out via `fleet.yml` and
the `scripts/tenant-*` tooling.

| Stage   | Topology change                         | Code changes                          |
| ------- | --------------------------------------- | ------------------------------------- |
| 0 (now) | one host: all containers                | —                                     |
| **1**   | **dedicated Postgres host**             | none (update URLs + `tenants.db_url`) |
| **2**   | **2+ app hosts behind a Load Balancer** | none (sessions already in Redis)      |
| 3       | **tenant sharding across cells**        | none (`tenant-relocate.ts`)           |
| 4       | **storage → S3 / Object Storage**       | none (`storage-migrate.ts`)           |

### Stage 1 — Move Postgres to its own server

1. Provision a second Hetzner server (e.g. a `CCX`/`CX` with more RAM for the
   DB) **on a private network** with `cell-01`:
   ```sh
   hcloud network create --name libriant-net --ip-range 10.0.0.0/16
   hcloud network add-subnet libriant-net --type cloud --network-zone eu-central --ip-range 10.0.0.0/24
   hcloud server create --name db-01 --type ccx13 --image ubuntu-24.04 --location nbg1 --ssh-key libriant-deploy --network libriant-net
   hcloud server attach-to-network cell-01 --network libriant-net   # if not already
   ```
   Note the private IPs (e.g. `db-01` = `10.0.0.3`). Keep Postgres on the
   **private** network only; never expose 5432 publicly.
2. Stand up Postgres on `db-01` (its own minimal compose with just the
   `postgres` service from this repo, same image/extensions/`postgres-init.sql`).
3. **Migrate the data** during a maintenance window:
   ```sh
   # on cell-01: dump everything
   docker compose -f infra/compose/docker-compose.prod.yml exec -T postgres \
     pg_dumpall -U libriant --clean --if-exists | gzip -9 > /tmp/all.sql.gz
   # restore into db-01 (run from a host that can reach 10.0.0.3)
   gunzip -c /tmp/all.sql.gz | psql "postgresql://libriant:${POSTGRES_PASSWORD}@10.0.0.3:5432/postgres"
   ```
4. **Repoint the app** at the new DB host. Edit the compose so `postgres`/
   `pgbouncer` point at `db-01` (or run PgBouncer on `db-01`), and update
   `.env.prod`‑derived URLs — `CONTROL_DATABASE_URL`, `PG_SUPERUSER_URL` — to use
   `10.0.0.3`.
5. **Rewrite every tenant's `db_url`** (they currently point at the old host):
   ```sql
   -- connect to the control DB on db-01
   UPDATE tenants SET "dbUrl" = replace("dbUrl", '@postgres:5432', '@10.0.0.3:5432');
   ```
   Then **bust the caches** so the new addresses take effect immediately:
   ```sh
   docker compose -f infra/compose/docker-compose.prod.yml exec redis \
     redis-cli --scan --pattern 'lbr:tenant:*' | xargs -r -n50 docker compose ... exec redis redis-cli del
   ```
   (Or just `redis-cli FLUSHDB` during the maintenance window.)
6. Bring the app back, `curl …/readyz`, run a tenant smoke test, exit
   maintenance. Remove the local `postgres` container from `cell-01` once
   confirmed healthy.

### Stage 2 — Multiple app hosts behind a Load Balancer

Sessions live in Redis and the app is stateless, so this is additive.

1. Provision `cell-01b` (another app host) on the same private network, with
   Docker + the repo + `.env.prod`. Point its `CONTROL_DATABASE_URL`/
   `REDIS_URL` at the **shared** DB + Redis hosts (private IPs). Run only
   `web` + `api` + `worker` there (DB/Redis/Caddy centralised — see below).
2. Create a **Hetzner Load Balancer**, add both app hosts as targets, health
   check `/healthz`:
   ```sh
   hcloud load-balancer create --name libriant-lb --type lb11 --location nbg1
   hcloud load-balancer add-service libriant-lb --protocol https --listen-port 443 --destination-port 443
   hcloud load-balancer add-target libriant-lb --server cell-01
   hcloud load-balancer add-target libriant-lb --server cell-01b
   # health check → HTTP /healthz on 80
   ```
   Point DNS for `libriant.app`/`admin.libriant.app` at the **LB** IP.
3. TLS: either keep **Caddy on each app node** (LB does TCP passthrough on 443),
   or terminate TLS at the LB and run Caddy in HTTP‑only mode. Keeping Caddy per
   node preserves the existing security‑headers + maintenance behaviour with no
   config change.
4. **Run exactly one worker.** The scheduled jobs (`scripts/jobs/*`) assume a
   single sweeper. If you add app nodes, run the `worker` service on **one** node
   only (or add distributed locking before scaling it). The HTTP `api`/`web` can
   scale freely.
5. Add the new host to `infra/deploy/fleet.yml` so CI deploys to both:
   ```yaml
   hosts:
     - {
         name: cell-01,
         user: deploy,
         ssh: cell-01.libriant.app,
         project: libriant,
         cell_id: cell-01,
         region: eu-central,
       }
     - {
         name: cell-01b,
         user: deploy,
         ssh: cell-01b.libriant.app,
         project: libriant,
         cell_id: cell-01,
         region: eu-central,
       }
   ```

### Stage 3 — Tenant sharding (cells)

When a single DB host gets hot, add a **cell** (a new DB host + app capacity)
and split tenants across cells. New tenants land on the least‑loaded cell;
existing ones move with the relocation script (minimal downtime: dump → restore
→ flip `db_url` → invalidate caches).

```sh
# Add a cell row + DB host, then relocate a tenant to it:
ops "pnpm tenant:relocate -- --slug=acme --to-cell=cell-02"
```

Add the new cell to `fleet.yml` (`cell_id: cell-02`). No app‑code change —
`tenants.cell_id` + `tenants.db_url` drive everything.

### Stage 4 — Storage to S3 / Object Storage

Move per‑tenant files off local disk onto S3‑compatible storage (Hetzner Object
Storage, MinIO, etc.). New tenants get `storage_url = s3://…`; migrate existing
ones driver‑to‑driver:

```sh
ops "pnpm storage:migrate -- --slug=acme --to=s3://libriant-acme/…"
```

The `StorageService` dispatches on the URL scheme (`file://` / `s3://`), so
different tenants can sit on different backends during the migration.

> Stages 3 and 4 ship as working scaffolding/stubs in `scripts/` — exercise them
> in staging before relying on them in production.

---

## 15. Appendix

### A. Ports

| Port                                        | Who   | Exposed?      |
| ------------------------------------------- | ----- | ------------- |
| 80, 443 (TCP+UDP)                           | Caddy | **public**    |
| 3000 web · 3001 api · 3002 worker           | app   | internal only |
| 5432 postgres · 5432 pgbouncer · 6379 redis | data  | internal only |

### B. Key environment variables (`/srv/libriant/.env.prod`)

`PUBLIC_HOST`, `ADMIN_HOST`, `ACME_EMAIL`, `IMAGE_TAG`, `POSTGRES_PASSWORD`,
`SESSION_SECRET`, `ADMIN_SESSION_SECRET`, `IMPERSONATION_SECRET`,
`MFA_MASTER_KEY` (64 hex), `STORAGE_SIGNING_SECRET`, `STRIPE_DRIVER`,
`STRIPE_API_KEY`, `STRIPE_WEBHOOK_SECRET`, `MAINTENANCE_HARD`, `RCLONE_REMOTE`,
`BACKUP_KEEP_DAYS`. The compose derives `CONTROL_DATABASE_URL`, `REDIS_URL`,
`PUBLIC_APP_URL`, `STORAGE_ROOT`, etc. from these — don't hand‑set those.

### C. Pre‑flight gotchas (specific to this repo)

1. **Image names** — make `infra/compose/docker-compose.prod.yml`'s `image:`
   match what CI pushes to GHCR (`ghcr.io/libriant/api` vs
   `ghcr.io/<owner>/libriant-api`). Fix before first deploy.
2. **Run compose from the repo checkout** so `../../assets`, `../../locales`,
   `../caddy/*` resolve. The CI rsync currently merges those trees into one
   folder — adjust it (or keep using the repo‑checkout path) before relying on
   CI for the volume mounts.
3. **`scripts/` isn't in the runtime image** — admin/tenant/ingest tooling runs
   via the `ops` helper (Node container on the app network with the repo
   mounted). DB/seed migrations can also run in the api container directly.
4. **Migrations never run automatically** — always `ops "pnpm db:migrate:deploy"`
   and `ops "pnpm tenant:migrate"` after a schema‑changing deploy.
5. **Greek collation** — the compose sets `LANG=el_GR.UTF-8` on the Alpine
   Postgres image, which doesn't ship glibc locales. Accent‑insensitive search
   (the `unaccent` extension) works regardless. If you need OS‑level Greek
   _sort_ order, switch the image to Debian `postgres:16` (or use an ICU
   collation) — not required for the pilot.

### D. Troubleshooting

- **Caddy can't get a cert** → DNS not pointing at the host yet, or ports 80/443
  blocked. `dig +short libriant.app`; check the Cloud Firewall + `ufw status`.
- **api `readyz` shows `controlDb:false`** → DB not migrated, wrong
  `POSTGRES_PASSWORD`, or pgbouncer not up. Check `docker compose … logs postgres pgbouncer`.
- **402 on creating books/members** → the tenant is on a plan/limit; expected.
- **Compose refuses to start citing a missing var** → a required secret is empty
  in `.env.prod`.
- **Out of memory during backup** → add/enlarge swap (Part 4) or move to the next
  server size (Part J).

---

_Keep this file in sync with `infra/compose/docker-compose.prod.yml`,
`infra/caddy/Caddyfile`, and `.github/workflows/deploy.yml` — they are the source
of truth for the running topology._
