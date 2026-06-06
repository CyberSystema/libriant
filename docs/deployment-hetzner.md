# Deploying Libriant on **CyberSystema-1**

_Libriant is a **[CyberSystema](https://cybersystema.com)** product._

A clean, friendly, step-by-step guide to running Libriant on your Hetzner server
**CyberSystema-1**, with all data living on the attached **64 GB `libriant`
volume**. You work mostly from **Termius over SSH**, so every step here is a
short command you can paste.

**Your setup at a glance**

| Thing       | Value                                                                |
| ----------- | -------------------------------------------------------------------- |
| Server      | **CyberSystema-1** (Hetzner CPX32 — 4 AMD vCPU, 8 GB RAM, 160 GB OS) |
| Data volume | **`libriant`** — 64 GB block volume, mounted at `/mnt/libriant`      |
| OS          | **Ubuntu 26.04 LTS** (fresh reinstall)                               |
| Your tools  | **Termius** (SSH) as the main workplace                              |
| Scale       | a pilot of up to ~20 libraries (tenants)                             |

> This runbook is filled in for **CyberSystema-1**: apex `libriant.com`, admin
> `admin.libriant.com`, and public IPv4 `178.104.32.176`. Reusing it for a
> different host? Swap those three values. The app reads the domain from
> `/srv/libriant/.env.prod` (`PUBLIC_HOST` / `ADMIN_HOST`) at runtime — the repo
> defaults just mirror it.

**The big idea — why the volume matters.** A Hetzner **Rebuild** wipes the boot
disk but **keeps attached volumes**. We put _all your data_ (databases, uploads,
TLS certificates, backups) on the `libriant` volume. So you can reinstall the OS
any time, remount the volume, and everything comes straight back. (See Part 16.)

---

## Part 0 — What you're building

One server, all containers on a private Docker network. Only Caddy (the web
front door) is reachable from the internet.

```
                    Internet
                       │  80 / 443 (HTTPS + HTTP/3)
                 ┌─────▼─────┐
                 │   caddy   │  TLS, security headers, maintenance page
                 └─────┬─────┘
            ┌──────────┼──────────┐
            ▼          ▼          ▼
        ┌───────┐  ┌───────┐  /webhooks/* → api
        │  web  │  │  api  │
        │ :3000 │  │ :3001 │
        └───────┘  └───┬───┘
                       │  (private network — never exposed)
       ┌───────┬───────┴───────┬───────────┐
       ▼       ▼               ▼           ▼
   ┌────────┐┌──────────┐  ┌───────┐  ┌────────┐
   │postgres││ pgbouncer│  │ redis │  │ worker │
   └────────┘└──────────┘  └───────┘  └────────┘
        └──────────┴───── data on /mnt/libriant ───┘
```

Seven containers: `caddy`, `web`, `api`, `worker`, `postgres`, `pgbouncer`,
`redis`. Postgres / Redis / PgBouncer **never** bind to a host port.

Tenancy: one **control database** (`libriant_control`) plus **one database per
library** (`tenant_<id>`), all on the same Postgres instance at this scale.

---

## Part 1 — Before you start

A short checklist. Tick these off first.

- [ ] A **domain** you control (e.g. `libriant.com`) with access to its DNS.
- [ ] Your **SSH key** in **Termius** (Keychain → your key). You'll register its
      **public** half with Hetzner in Part 2.
- [ ] A **GitHub repo** for this code. CI builds images to
      `ghcr.io/<owner>/libriant-api` + `…-web`; the compose file pulls the same
      path via `IMAGE_OWNER` (you set it in `.env.prod`, Part 6). Decide your
      GitHub owner/org now — you'll use it **lowercase**.
- [ ] A **Stripe** account (test mode is fine to start).
- [ ] **Secrets generated** and saved in your password manager — run this on
      your laptop (or any shell) and keep the output safe:

```sh
echo "SESSION_SECRET=$(openssl rand -hex 32)"
echo "ADMIN_SESSION_SECRET=$(openssl rand -hex 32)"
echo "IMPERSONATION_SECRET=$(openssl rand -hex 32)"
echo "STORAGE_SIGNING_SECRET=$(openssl rand -hex 32)"
echo "MFA_MASTER_KEY=$(openssl rand -hex 32)"   # 64 hex chars
echo "POSTGRES_PASSWORD=$(openssl rand -hex 24)"
```

---

## Part 2 — Reinstall CyberSystema-1 (clean)

All in the **Hetzner Cloud Console** (web UI) — these are cloud actions, not
SSH.

**1. Register your SSH public key** (so you can log in by key after the
rebuild). _Security → SSH keys → Add SSH key_ → paste your **public** key (in
Termius: your key → _Export Public Key_) → name it `libriant-key`.

**2. Rebuild the server.** Open **CyberSystema-1** → _Rebuild_ → choose **Ubuntu
26.04** → make sure `libriant-key` is selected → **Rebuild**.

> ✅ The rebuild wipes the **boot disk** only. Your **`libriant` volume stays
> attached and untouched** — its data (if any) is preserved. The server keeps
> the same IP.

**3. Lock down the network.** _Firewalls → Create Firewall_ → name `libriant-edge`
→ add these **inbound** rules → **Apply to → CyberSystema-1**:

| Protocol | Port | Source                                |
| -------- | ---- | ------------------------------------- |
| TCP      | 22   | your IP/CIDR (or `0.0.0.0/0`, `::/0`) |
| TCP      | 80   | `0.0.0.0/0`, `::/0`                   |
| TCP      | 443  | `0.0.0.0/0`, `::/0`                   |
| UDP      | 443  | `0.0.0.0/0`, `::/0` (HTTP/3)          |

> Outbound is open by default (needed for TLS certs, image pulls, Stripe,
> backups). Tighten port 22 to your own IP if it's static.

---

## Part 3 — Connect with Termius

1. In Termius: **New Host** → Address `178.104.32.176`, Username `root`, and pick
   your key under _SSH_.
2. Connect. You're now at a `root@` prompt on the fresh server.

From here, everything is SSH. Patch the box first:

```sh
apt-get update && apt-get -y upgrade
```

---

## Part 4 — Mount the `libriant` volume

This is the foundation: all data lives here. Do it before installing anything
else.

**1. Find the volume.** It's the 64 GB disk:

```sh
lsblk -f
```

You'll see your boot disk plus a ~64 GB device (e.g. `sdb`). If its `FSTYPE`
column is **empty**, it's blank and safe to format. If it shows a filesystem you
want to keep, **skip the next step** and just mount it.

**2. Format it once** (⚠️ this **erases** the volume — you said you want it
clean):

```sh
mkfs.ext4 -L libriant /dev/sdb        # use the device name from lsblk
```

**3. Mount it at `/mnt/libriant` and make it permanent.** We mount by label, so
it survives reboots and reinstalls:

```sh
mkdir -p /mnt/libriant
echo 'LABEL=libriant /mnt/libriant ext4 defaults,nofail 0 2' >> /etc/fstab
mount -a
df -h /mnt/libriant                    # confirm: ~63 GB available
```

**4. Create the data folders** the app will use:

```sh
mkdir -p /mnt/libriant/{postgres,redis,storage,caddy,backups}
```

That's it — `/mnt/libriant` now holds (or will hold) every byte that matters.

---

## Part 5 — Base server setup

Still as `root`. Five short blocks.

```sh
# 1. Base packages + automatic security updates
apt-get -y install git curl ufw fail2ban unattended-upgrades ca-certificates
dpkg-reconfigure -plow unattended-upgrades

# 2. A little swap (cheap insurance during nightly backups)
fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
sysctl -w vm.swappiness=10 && echo 'vm.swappiness=10' >> /etc/sysctl.d/99-libriant.conf

# 3. Docker Engine + Compose (official installer; auto-detects Ubuntu 26.04)
curl -fsSL https://get.docker.com | sh
docker compose version

# 4. A non-root "deploy" user that can run Docker
adduser --disabled-password --gecos "" deploy
usermod -aG docker deploy
mkdir -p /home/deploy/.ssh
cp ~/.ssh/authorized_keys /home/deploy/.ssh/authorized_keys
chown -R deploy:deploy /home/deploy/.ssh && chmod 700 /home/deploy/.ssh && chmod 600 /home/deploy/.ssh/authorized_keys

# 5. Host firewall (a second layer behind the Cloud Firewall)
ufw default deny incoming && ufw default allow outgoing
ufw allow 22/tcp && ufw allow 80/tcp && ufw allow 443
ufw --force enable
```

**SSH hardening** — use a drop-in file (not `sed`), because Ubuntu's cloud image
ships its own SSH drop-in and sshd uses the _first_ value it finds:

```sh
cat >/etc/ssh/sshd_config.d/00-libriant.conf <<'EOF'
PasswordAuthentication no
PermitRootLogin prohibit-password
KbdInteractiveAuthentication no
EOF
sshd -t && systemctl reload ssh
# Confirm the EFFECTIVE settings are what you expect:
sshd -T | grep -Ei '^(passwordauthentication|permitrootlogin|kbdinteractiveauthentication) '
```

> **Don't lock yourself out.** Keep this Termius session open and open a
> **second** Termius session to confirm key login still works _before_ you close
> this one. `reload` keeps your current session alive, so a typo can't kick you
> out mid-session.

Now add Termius as a host for the **`deploy`** user too (same IP, same key,
username `deploy`) — that's your day-to-day login.

---

## Part 6 — Get the code & configure

Switch to the `deploy` user (the data dirs and code live where it can reach
them).

```sh
# as root: hand the app + log dirs to deploy
mkdir -p /srv/libriant /var/log/libriant
chown -R deploy:deploy /srv/libriant /var/log/libriant /mnt/libriant/backups

# become deploy
su - deploy

# The repo is PRIVATE, so give this box read access once (also used by CI):
#  1) A read-only GitHub Deploy Key for git over SSH
ssh-keygen -t ed25519 -f ~/.ssh/github-deploy -N ''
printf 'Host github.com\n  IdentityFile ~/.ssh/github-deploy\n  IdentitiesOnly yes\n' >> ~/.ssh/config
ssh-keyscan github.com >> ~/.ssh/known_hosts 2>/dev/null
cat ~/.ssh/github-deploy.pub
#     → add the printed key at GitHub → repo → Settings → Deploy keys → Add,
#       leave "Allow write access" UNCHECKED (read-only is all CI needs).
#  2) Log in to GHCR so `docker compose pull` can fetch private images
#     (a classic PAT with the read:packages scope):
echo "<YOUR_GHCR_PAT>" | docker login ghcr.io -u <your-github-username> --password-stdin

# clone over SSH (uses the deploy key above)
git clone git@github.com:<owner>/libriant.git /srv/libriant/app
cd /srv/libriant/app && git checkout main
```

> Two host credentials, each minimally scoped: a **repo-scoped read-only deploy
> key** (git) and a **`read:packages`-only PAT** (GHCR pull). Alternatively, make
> just the two GHCR _packages_ public (repo stays private) to skip the
> `docker login` entirely.

**Write the env file** at `/srv/libriant/.env.prod` (paste your saved secrets):

```sh
nano /srv/libriant/.env.prod
chmod 600 /srv/libriant/.env.prod
```

```ini
# --- hosts ---
PUBLIC_HOST=libriant.com
ADMIN_HOST=admin.libriant.com
ACME_EMAIL=ops@libriant.com
MAINTENANCE_HARD=false

# --- images (GHCR) ---
IMAGE_OWNER=your-github-owner   # LOWERCASE; matches what CI pushes
IMAGE_TAG=latest                # CI sets this to the commit SHA per deploy

# --- postgres + secrets (from Part 1) ---
POSTGRES_PASSWORD=...
SESSION_SECRET=...
ADMIN_SESSION_SECRET=...
IMPERSONATION_SECRET=...
MFA_MASTER_KEY=...            # 64 hex chars
STORAGE_SIGNING_SECRET=...

# --- billing ---
STRIPE_DRIVER=real
STRIPE_API_KEY=...
STRIPE_WEBHOOK_SECRET=        # fill in Part 10

# --- data + backups live on the libriant volume ---
COMPOSE_PROJECT_NAME=libriant
LIBRIANT_DATA_ROOT=/mnt/libriant
STORAGE_DIR=/mnt/libriant/storage
BACKUP_ROOT=/mnt/libriant/backups
BACKUP_KEEP_DAYS=14
RCLONE_REMOTE=                # fill in Part 11
```

**Set up your Termius shortcut.** Add this to `deploy`'s `~/.bashrc` so every
session loads your env and gives you a short **`dc`** command (Docker Compose
with both the prod file and the volume overlay):

```sh
cat >> ~/.bashrc <<'EOF'

# --- Libriant ---
export COMPOSE_PROJECT_NAME=libriant
export LIBRIANT_DATA_ROOT=/mnt/libriant
[ -f /srv/libriant/.env.prod ] && { set -a; . /srv/libriant/.env.prod; set +a; }
dc() { ( cd /srv/libriant/app && docker compose \
  -f infra/compose/docker-compose.prod.yml \
  -f infra/compose/docker-compose.volume.yml "$@" ); }
EOF
source ~/.bashrc
```

From now on, `dc <anything>` = the whole stack, data on your volume. Try
`dc config >/dev/null && echo OK`.

---

## Part 7 — DNS

Point your domain at CyberSystema-1, then wait for it to propagate.

| Record               | Type | Value            |
| -------------------- | ---- | ---------------- |
| `libriant.com`       | A    | `178.104.32.176` |
| `admin.libriant.com` | A    | `178.104.32.176` |

```sh
dig +short libriant.com          # should return your IP before you continue
```

TLS is automatic — Caddy fetches Let's Encrypt certificates on first start
(Part 8), and they're stored on the volume so they survive reinstalls.

---

## Part 8 — First start

```sh
dc pull
dc up -d
```

Watch it come alive:

```sh
dc ps
dc logs -f caddy api web
```

Healthy order: `postgres` → `pgbouncer`/`redis` → `api`/`web` → `caddy`. In the
Caddy logs you'll see "certificate obtained". The site is up — but the
**databases are still empty**. Finish in Part 9.

> Sanity-check the data landed on the volume:
> `ls /mnt/libriant/postgres` should now be full of Postgres files.

---

## Part 9 — Bootstrap the platform

A few admin tasks need the repo's `scripts/` (not baked into the images) and
access to Postgres/Redis. Paste this one-time **`ops`** helper, then run the
steps in order:

```sh
APP_NET="$(docker network ls --format '{{.Name}}' | grep -E '_app$' | head -1)"
ops() {
  docker run --rm --network "$APP_NET" -v /srv/libriant/app:/repo -w /repo \
    -e CONTROL_DATABASE_URL="postgresql://libriant:${POSTGRES_PASSWORD}@pgbouncer:5432/libriant_control" \
    -e PG_SUPERUSER_URL="postgresql://libriant:${POSTGRES_PASSWORD}@postgres:5432/libriant_control" \
    -e REDIS_URL="redis://redis:6379" -e STORAGE_ROOT="/srv/libriant/storage" \
    node:24-bookworm-slim sh -lc "corepack enable && $*"
}

ops "pnpm install --frozen-lockfile && pnpm db:generate"   # one-time, ~1-2 min
ops "pnpm db:migrate:deploy"   # 1. control-plane schema
ops "pnpm db:seed"             # 2. cells + feature keys + starter plans
ops "pnpm ingest:help"         # 3. help-centre articles into Postgres search
```

**Create your admin account** (then enrol MFA — it's mandatory):

```sh
ADMIN_BOOTSTRAP_EMAIL=you@yourco.com \
ADMIN_BOOTSTRAP_PASSWORD='a-long-admin-passphrase' \
  ops "ADMIN_BOOTSTRAP_EMAIL=$ADMIN_BOOTSTRAP_EMAIL ADMIN_BOOTSTRAP_PASSWORD='$ADMIN_BOOTSTRAP_PASSWORD' pnpm admin:bootstrap"
```

Then visit `https://admin.libriant.com` → log in → **MFA page** → scan the QR in
an authenticator app → verify.

**Libraries (tenants)** are created two ways:

- **Self-service (normal):** a librarian signs up at `https://libriant.com` and
  everything is provisioned automatically (database, schema, owner, storage).
- **Operator-provisioned (optional):**

```sh
ops "pnpm tenant:create -- --slug=acme --name='Acme Public Library' \
  --owner-email=ops@acme.org --owner-name='Acme Operator' \
  --plan=community --billing-mode=manual"
```

---

## Part 10 — Stripe webhook

Billing stays correct only if Stripe can reach your webhook.

1. Stripe Dashboard → _Developers → Webhooks → Add endpoint_.
2. URL: `https://libriant.com/webhooks/stripe`
3. Events: `customer.subscription.created/updated/deleted`,
   `invoice.payment_succeeded`, `invoice.payment_failed`.
4. Copy the **Signing secret** (`whsec_…`) into `STRIPE_WEBHOOK_SECRET` in
   `/srv/libriant/.env.prod`, reload your shell, and restart the app:

```sh
source ~/.bashrc
dc up -d api worker
```

5. Use Stripe's "Send test webhook" and confirm a `200` in `dc logs api`.

---

## Part 11 — Backups (do this on day one)

`scripts/backup.sh` dumps **all** databases, tars your uploads, snapshots the
Caddy log, and prunes old dailies. Because your env points `BACKUP_ROOT` and
`STORAGE_DIR` at the volume, backups land on `/mnt/libriant/backups`.

**Offsite copy — Hetzner Storage Box (recommended).** A BX11 is cheap and keeps
a copy off the server:

```sh
sudo apt-get -y install rclone
rclone config        # new remote "storagebox", type "sftp", details from Hetzner
```

Then set `RCLONE_REMOTE=storagebox:libriant-backups` in `.env.prod`.

**Run it once to confirm** a non-trivial `postgres.sql.gz` appears:

```sh
source ~/.bashrc
COMPOSE_FILE=/srv/libriant/app/infra/compose/docker-compose.prod.yml \
  /srv/libriant/app/scripts/backup.sh
ls -lh /mnt/libriant/backups/$(date +%Y%m%d)/
```

**Schedule it** nightly at 02:15 (root cron that loads your env):

```sh
sudo tee /etc/cron.d/libriant-backup >/dev/null <<'CRON'
15 2 * * * deploy bash -lc 'set -a; . /srv/libriant/.env.prod; set +a; COMPOSE_FILE=/srv/libriant/app/infra/compose/docker-compose.prod.yml /srv/libriant/app/scripts/backup.sh >> /var/log/libriant/backup.log 2>&1'
CRON
```

**Restore drill** (practise before you need it):

```sh
# Postgres:
gunzip -c /mnt/libriant/backups/<date>/postgres.sql.gz | \
  dc exec -T postgres psql -U libriant -d postgres
# Uploads:
sudo tar -C /mnt/libriant/storage -xzf /mnt/libriant/backups/<date>/storage.tar.gz
```

---

## Part 12 — Verify

```sh
curl -fsS https://libriant.com/healthz && echo        # edge up
curl -fsS https://libriant.com/readyz | jq            # api: redis + DB true
curl -fsS https://libriant.com/api/readyz | jq        # web → api reachable
dc exec worker wget -qO- http://localhost:3002/readyz # worker (internal)
```

Then in a browser: open `https://libriant.com`, create a test library, add a
book, check it out — and confirm `https://admin.libriant.com` shows the admin
login.

---

## Part 13 — Living in Termius (your cheat sheet)

Everything below assumes your `~/.bashrc` shortcut from Part 6 (so `dc` and your
env are ready in every session).

```sh
dc ps                       # health of all containers
dc logs -f api              # follow a service's logs (api/web/worker/caddy)
dc restart api              # restart one service
dc stop                     # graceful stop (drains cleanly — safe before reboot)
dc up -d                    # start / re-create after a change
```

**Deploys run through CI.** Push to `main` (or trigger the _deploy_ workflow from
the Actions tab). CI builds the images, pushes them to GHCR, SSHes to
CyberSystema-1, checks out the exact commit at `/srv/libriant/app`, and runs the
same `dc`-style `pull` + `up -d` you'd run by hand — SHA-pinned, data on the
volume, with a `/healthz` gate.

**Turn on CI/CD — one-time setup:**

1. **`IMAGE_OWNER`** is set in `.env.prod` (Part 6) to your GitHub owner/org,
   lowercase. CI pushes — and the host pulls — `ghcr.io/$IMAGE_OWNER/libriant-{api,web}`.
2. **DNS is live** (Part 7): `libriant.com` resolves to the box with a valid
   cert. CI health-checks `https://libriant.com/healthz`, and `fleet.yml`'s
   `ssh:` is already `libriant.com`.
3. **Deploy key (runner → server)** — a dedicated keypair, authorized for
   `deploy`, private half stored as the `DEPLOY_SSH_KEY` repo secret:
   ```sh
   ssh-keygen -t ed25519 -f libriant-ci -N ''          # on your laptop
   # append libriant-ci.pub to /home/deploy/.ssh/authorized_keys on the server
   # GitHub → Settings → Secrets and variables → Actions → New secret:
   #   DEPLOY_SSH_KEY = the PRIVATE key (contents of ./libriant-ci)
   ```
4. **`production` environment** — GitHub → Settings → Environments → New →
   `production` (add an approval rule if you want a manual gate before deploys).
5. **Server read access** — CI runs `git fetch` + `docker compose pull` on the
   box. Your repo is **private**, so this is the deploy key + `docker login ghcr.io`
   you set up in **Part 6** (CI's `git fetch` reuses `deploy`'s deploy key; the
   pull reuses its GHCR login). Nothing more to add here. _(Image **push** uses
   the built-in `GITHUB_TOKEN` — you never create a token for that.)_
6. **Push to `main`** → watch Actions: _build → deploy → healthy_. The first
   push deploys the stack; then run the one-time DB bootstrap (Part 9).

> **Heads-up:** CI does `git reset --hard`, so host-local edits to **tracked**
> files (e.g. tuning the `postgres` command in the compose file) are overwritten
> on the next deploy. Keep customisations in `.env.prod` or an untracked
> override file.

**Manual deploy** (fallback / break-glass) is always available:

```sh
cd /srv/libriant/app && git pull
dc pull && dc up -d --remove-orphans
```

**⚠️ Migrations are NOT automatic.** After any deploy that changes the schema:

```sh
ops "pnpm db:migrate:deploy"   # control-plane
ops "pnpm tenant:migrate"      # fans out to EVERY tenant database
```

**Maintenance window:**

- _Soft (preferred):_ admin UI → _System mode_ → `maintenance` or `read_only`.
- _Hard (last resort):_ set `MAINTENANCE_HARD=true` in `.env.prod`, then
  `source ~/.bashrc && dc up -d caddy`. Revert to `false` and re-up when done.

**Roll back** to a known-good image: set `IMAGE_TAG=<old-sha>` in `.env.prod`,
then `source ~/.bashrc && dc up -d`. (The deploy workflow tags images with the
commit SHA precisely so you can pin back.)

---

## Part 14 — Capacity & monitoring

Two layers of visibility ship with the project.

**App-level (how many libraries, how big, how close to limits).**

- **Admin UI:** the **Capacity** page (admin → _Capacity_) shows libraries by
  status, Postgres connections, cache-hit ratio, disk %, storage, and the
  heaviest tenants.
- **CLI:** `ops "pnpm fleet:report"` (add `-- --json` for machine output).
- **/metrics:** the api exposes Prometheus gauges (`libriant_tenants_total`,
  `libriant_pg_connections`, `libriant_pg_cache_hit_ratio`, …) for charting.

**Server-level (free, self-hosted).** `infra/monitoring/` ships a ready
Prometheus + Grafana + node-exporter + cAdvisor stack:

```sh
cd /srv/libriant/app/infra/monitoring
GRAFANA_ADMIN_PASSWORD=pick-one docker compose -f docker-compose.monitoring.yml up -d
# Grafana is bound to localhost only — reach it through an SSH tunnel:
#   (in Termius / locally)  ssh -L 3300:127.0.0.1:3300 deploy@178.104.32.176
# then open http://localhost:3300  (import dashboards 1860 + 14282)
```

**What to watch, and what it means:**

| Signal               | Healthy       | When it crosses → do                       |
| -------------------- | ------------- | ------------------------------------------ |
| RAM available / swap | >20%, no swap | swapping → grow the box (Part 15)          |
| PG cache hit ratio   | >99%          | <95% sustained → more RAM (Part 15)        |
| PG connections / max | <60%          | >80% → tune PgBouncer pool                 |
| Volume disk used     | <80%          | >85% → resize the volume / offload backups |

---

## Part 15 — Growing the server

**Vertical (first choice): `CPX32 → CCX23`.** Swaps 4 _shared_ vCPU + 8 GB for 4
_dedicated_ vCPU + 16 GB, on the **same 160 GB boot disk**, and your data volume
just comes along untouched.

1. Back up and confirm it (Part 11).
2. Soft-stop: admin UI → maintenance, then `dc stop`.
3. Console → **CyberSystema-1** → _Power → Power off_.
4. Console → _Rescale_ → pick **`CCX23`** → **Keep disk** → _Rescale_.
5. Console → _Power on_, then `dc up -d` and re-check `/readyz`.
6. With 16 GB you can give Postgres more cache — add to the `postgres`
   `command:` in the prod compose: `-c shared_buffers=4GB -c effective_cache_size=9GB`,
   then `dc up -d postgres`.

> **Resize the volume** independently any time: Console → Volumes → `libriant` →
> _Resize_, then on the host `sudo resize2fs /dev/sdb`.

**Horizontal (later):** move Postgres to its own box, add app nodes behind a
Hetzner Load Balancer, shard tenants across cells. The architecture already
keeps each tenant's `db_url`/`storage_url` in the control plane, so these are
config changes, not rewrites — see `infra/deploy/fleet.yml` and the
`scripts/tenant-*` tooling.

---

## Part 16 — Reinstalling later (the volume payoff)

Because all data lives on the `libriant` volume, a clean reinstall is quick and
loss-free:

1. Console → **CyberSystema-1** → _Rebuild_ → **Ubuntu 26.04** (volume stays
   attached, data preserved).
2. **Part 4**, but **skip the `mkfs` step** — the volume already has your data;
   just `mkdir -p /mnt/libriant` + the fstab line + `mount -a`.
3. **Part 5** (base setup) and **Part 6** (clone repo, restore `.env.prod`, add
   the `~/.bashrc` shortcut).
4. `dc pull && dc up -d`.

Your databases, uploads, and TLS certs are exactly as you left them — **no
restore needed**. (Keep a copy of `.env.prod` in your password manager; it's the
one thing not on the volume.)

---

## Part 17 — Optional: the `hcloud` CLI

Everything above uses the Console + SSH. If you'd rather script the
cloud-platform actions from your laptop, install Hetzner's CLI:

```sh
brew install hcloud
hcloud context create libriant      # paste an API token (Console → Security)
```

Common equivalents:

```sh
hcloud server poweroff CyberSystema-1
hcloud server change-type --keep-disk CyberSystema-1 ccx23   # rescale
hcloud server poweron CyberSystema-1
hcloud server describe CyberSystema-1
ssh root@"$(hcloud server ip CyberSystema-1)"
```

---

## Appendix

### A. Ports

| Port                              | Who   | Exposed?      |
| --------------------------------- | ----- | ------------- |
| 80, 443 (TCP+UDP)                 | Caddy | **public**    |
| 3000 web · 3001 api · 3002 worker | app   | internal only |
| 5432 postgres/pgbouncer · 6379    | data  | internal only |

### B. Where things live

| What            | Path                                  |
| --------------- | ------------------------------------- |
| Code (the repo) | `/srv/libriant/app` (boot disk)       |
| Secrets         | `/srv/libriant/.env.prod` (boot disk) |
| Postgres data   | `/mnt/libriant/postgres` (volume)     |
| Redis data      | `/mnt/libriant/redis` (volume)        |
| Uploads         | `/mnt/libriant/storage` (volume)      |
| TLS certs       | `/mnt/libriant/caddy` (volume)        |
| Backups         | `/mnt/libriant/backups` (volume)      |

### C. Pre-flight gotchas

- **Image names** must match between the compose file and CI (Part 1).
- **Migrations are manual** after schema-changing deploys (Part 13).
- **MFA is mandatory** before the break-glass support flow works.
- The **volume must be mounted** before `dc up` — the overlay fails safe (the
  stack won't start) rather than writing a fresh DB to the boot disk.

### D. Troubleshooting

| Symptom                     | Check                                                             |
| --------------------------- | ----------------------------------------------------------------- |
| Containers won't start      | Is the volume mounted? `df -h /mnt/libriant`                      |
| No TLS / cert errors        | DNS points at the box? `dig +short libriant.com`; `dc logs caddy` |
| `api` not ready             | `dc logs api`; is Postgres healthy in `dc ps`?                    |
| Out of memory during backup | swap on? (`free -h`); or grow the box (Part 15)                   |
| Stripe state stale          | webhook secret set + endpoint reachable? (Part 10)                |
