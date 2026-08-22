# Deploying Libriant on **CyberSystema-1**

_Libriant is a **[CyberSystema](https://cybersystema.com)** product._

A clean, friendly, step-by-step guide to running Libriant on your Hetzner
**dedicated** server **CyberSystema-1**. You work mostly from **Termius over
SSH**, so every step here is a short command you can paste.

**Your setup at a glance**

| Thing      | Value                                                                |
| ---------- | -------------------------------------------------------------------- |
| Server     | **CyberSystema-1** — Hetzner **dedicated** (Server Auction)          |
| CPU / RAM  | Intel Xeon E3-1275 v6 — 4 cores / 8 threads · **64 GB DDR4 ECC**     |
| Disks      | **2 × NVMe in software RAID1** (confirm sizes with `lsblk`)          |
| Data       | `/mnt/libriant` — a partition **on the RAID**, not a separate volume |
| OS         | **Ubuntu 26.04 LTS** (installed via `installimage` from rescue)      |
| Your tools | **Termius** (SSH) as the main workplace                              |
| Scale      | a pilot of up to ~20 libraries (tenants)                             |

> This runbook is filled in for **CyberSystema-1**, public IPv4
> `195.201.13.95`. Everything runs on this one box, across three hosts:
>
> **2026-08-22:** the previous server, `178.104.32.176`, was lost — ports 22 and
> 443 both time out and the deploy workflow died on it. `195.201.13.95` replaces
> it and has not been deployed to yet. Deploys are currently manual and run on
> the box: see [deploy-from-the-server.md](deploy-from-the-server.md).
>
> | Host                 | Serves                           | Variable      |
> | -------------------- | -------------------------------- | ------------- |
> | `libriant.com`       | the marketing site, static files | `SITE_HOST`   |
> | `app.libriant.com`   | the app, `/lbr-api/*`, webhooks  | `PUBLIC_HOST` |
> | `admin.libriant.com` | the admin panel                  | `ADMIN_HOST`  |
>
> **`PUBLIC_HOST` is no longer the apex.** It is the APP host. The registrable
> domain — which tenant subdomains and the CSRF origin check key off — is
> `PUBLIC_APEX_DOMAIN`, and it stays `libriant.com`. Confusing those two is the
> most likely way to break a deploy here.
>
> Moving an existing host to this layout is a one-time sequence with two
> irreversible steps: see **[cutover-three-hosts.md](cutover-three-hosts.md)**.
>
> The marketing site adds no process, no port and no container. It is rendered
> in CI and baked into the Caddy image, because **the host has no Node** —
> changing marketing copy means a commit, never a command on the box.

**The big idea — backups ARE your recovery.** This is a dedicated machine, so
there is **no detachable volume and no "Rebuild that keeps your data"**. Both
NVMe drives are mirrored in **RAID1**, which protects you when a _disk_ dies —
but reinstalling the OS wipes everything, and RAID does not protect against
`rm -rf`, a bad migration, or ransomware.

That makes **Part 11 (backups) the single most important section in this
document.** On the cloud version of this runbook you could reinstall and remount;
here, a reinstall means **restore from backup**. Set up the offsite copy on day
one and test a restore before your first real library goes live. (See Part 16.)

> **After the box is running**, day-to-day operation lives in
> **[`server-handbook.md`](server-handbook.md)** — hardware facts, health checks,
> monitoring, backup drills, symptom-indexed troubleshooting, LVM procedures,
> and how to host your other projects alongside Libriant. This runbook builds the
> server; the handbook runs it.

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

## Part 2 — Install the OS (rescue + `installimage`)

Dedicated servers are managed from **Hetzner Robot**, not the Cloud Console, and
they arrive in the **Rescue System** with no OS installed. You install it
yourself — this is the biggest difference from a cloud server.

**1. Register your SSH public key.** Robot → _Server → Key management_ → add your
**public** key (in Termius: your key → _Export Public Key_) → name it
`libriant-key`. Selecting it in the next step means the rescue system accepts your
key instead of emailing you a password.

**2. Activate the Rescue System.** Robot → **CyberSystema-1** → _Rescue_ tab →
Linux, 64-bit, pick `libriant-key` → **Activate**. Then _Reset_ → **Execute an
automatic hardware reset**. After a minute the box boots into rescue.

**3. SSH in and run the installer.**

```sh
ssh root@<your-server-ip>       # rescue system
installimage
```

In the menu choose **Ubuntu → Ubuntu 26.04 LTS (64-bit)**. An editor opens with
the install config. Set these:

```text
DRIVE1 /dev/nvme0n1
DRIVE2 /dev/nvme1n1

SWRAID 1
SWRAIDLEVEL 1

HOSTNAME CyberSystema-1

PART /boot  ext4   1G
PART swap   swap   8G
PART /      ext4  80G
PART /mnt/libriant ext4  all
```

- **`SWRAID 1` + `SWRAIDLEVEL 1` is not optional.** Two drives mirrored means a
  single disk failure costs you nothing but a support ticket. Without it, one
  dead NVMe is a full restore-from-backup.
- The separate `/mnt/libriant` partition keeps a full root filesystem from taking
  Postgres down with it. **It does _not_ survive a reinstall** — `installimage`
  formats what you tell it to. See Part 16.
- Confirm your device names first with `lsblk`; older boxes may present `sda`/`sdb`.

Save and exit (`F10` in the nano-style editor), confirm, and let it run. Then
`reboot` and SSH back in on your key.

**4. Verify the mirror came up before you do anything else.**

```sh
cat /proc/mdstat                # every array should read [UU], not [U_]
lsblk
```

**5. Lock down the network.** Dedicated servers have no Cloud Firewall. You have
two layers; use the host one.

Robot's own packet filter (_Server → Firewall_) is **stateless and limited to a
few rules** — usable as a coarse outer net, but fiddly. The host firewall is the
real control:

```sh
apt-get update && apt-get -y install ufw
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 443/udp                # HTTP/3
ufw enable
```

> ⚠️ **Docker bypasses ufw.** Published container ports are inserted into
> `iptables` ahead of ufw's chains, so `ufw deny` will _not_ stop traffic to a
> port a container published. Libriant's prod compose deliberately keeps
> Postgres, Redis and PgBouncer on the private Docker network with **no host
> port**, so only Caddy is exposed — keep it that way. After Part 8, verify from
> your laptop:
>
> ```sh
> nmap -Pn -p 22,80,443,5432,6379 <your-server-ip>
> ```
>
> 5432 and 6379 must show `filtered`/`closed`. If either is `open`, a container
> is publishing it and the firewall will not save you.

---

## Part 3 — Connect with Termius

1. In Termius: **New Host** → Address `195.201.13.95`, Username `root`, and pick
   your key under _SSH_.
2. Connect. You're now at a `root@` prompt on the fresh server.

From here, everything is SSH. Patch the box first:

```sh
apt-get update && apt-get -y upgrade
```

---

## Part 4 — Check the data partition and RAID

`installimage` already created `/mnt/libriant` on the mirror in Part 2, so there
is **nothing to format here** — unlike the cloud version of this runbook, where
`/mnt/libriant` was a separate attachable volume.

**1. Confirm the mirror is healthy and the partition is mounted.**

```sh
cat /proc/mdstat                       # arrays must read [UU]
df -h /mnt/libriant                    # your data partition
findmnt /mnt/libriant
```

If `/proc/mdstat` shows `[U_]` the array is **degraded** — one drive is gone or
resyncing. Do not put customer data on a degraded array; open a Robot ticket
(hardware replacement is included in your contract).

**2. Create the data folders** the app will use:

```sh
mkdir -p /mnt/libriant/{postgres,redis,storage,caddy,backups}
```

**3. Turn on RAID and disk-health alerting.** On a cloud volume Hetzner watched
the storage for you. Here it is your job:

```sh
apt-get -y install mdadm smartmontools
# email on a degraded array
sed -i 's/^MAILADDR.*/MAILADDR you@example.com/' /etc/mdadm/mdadm.conf
systemctl enable --now mdmonitor
# weekly SMART self-test on both drives
systemctl enable --now smartd
```

> **Watch NVMe wear specifically.** Auction machines often ship with
> consumer-grade M.2 drives, whose endurance is far lower than datacenter U.2
> parts. Postgres plus nightly dumps writes steadily, so check every few months:
>
> ```sh
> smartctl -A /dev/nvme0n1 | grep -i -E 'percentage_used|data_units_written'
> smartctl -A /dev/nvme1n1 | grep -i -E 'percentage_used|data_units_written'
> ```
>
> `percentage_used` is the drive's own wear estimate. Both drives are the same
> age and take identical writes under RAID1, so they will wear together and can
> fail together — which is exactly why the **offsite** backup in Part 11 matters
> more than the mirror does.

`/mnt/libriant` now holds every byte that matters — but unlike a cloud volume, it
does **not** survive a reinstall. Part 11 is what saves you.

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

# 5. Host firewall — on dedicated this is your PRIMARY firewall, not a second
#    layer. Already configured in Part 2; this is the idempotent re-run.
ufw default deny incoming && ufw default allow outgoing
ufw allow 22/tcp && ufw allow 80/tcp && ufw allow 443
ufw --force enable
```

**Ubuntu Pro (free — do it now).** A personal token covers up to **5 machines**
at no cost and buys you two things that matter on a single box with no failover:

```sh
pro attach <your-token>        # token from https://ubuntu.com/pro/dashboard
pro enable livepatch
pro status                     # confirm esm-infra + livepatch are enabled
```

- **Livepatch** applies kernel CVE fixes **without rebooting**. With libraries
  mid-circulation and no second server to fail over to, "patch now, reboot at a
  quiet moment" is worth the five minutes of setup.
- **ESM** extends security updates to thousands of extra packages, for 10 years.

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

**Write the env file** — you don't fill it in by hand. Run the initializer and
it generates every random secret for you (Postgres password, session secrets,
MFA key, …) and asks only for the three things it can't invent: your GitHub
owner, and the first admin login:

```sh
cd /srv/libriant/app
bash scripts/ensure-env.sh        # interactive — fills /srv/libriant/.env.prod
```

It is **idempotent and never overwrites an existing value**, so it's safe to
re-run, and the deploy workflow runs it again (`--auto`) on every push to fill
anything missing — meaning a fresh host self-provisions its secrets. The only
keys you ever touch by hand are the operator settings:

| Key                                                  | What                                                                                     | Default                                   |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------- |
| `IMAGE_OWNER`                                        | your GitHub owner/org, **lowercase** (GHCR namespace)                                    | — (asked)                                 |
| `ADMIN_BOOTSTRAP_EMAIL` / `ADMIN_BOOTSTRAP_PASSWORD` | first admin login, auto-created on deploy                                                | — (asked)                                 |
| `PUBLIC_HOST` — the APP host, **not** the apex       | where the product is served                                                              | `app.libriant.com`                        |
| `SITE_HOST`                                          | where the marketing site is served                                                       | `libriant.com`                            |
| `PUBLIC_APEX_DOMAIN`                                 | the registrable domain: tenant subdomains + the CSRF origin check derive from it         | `libriant.com`                            |
| `ADMIN_HOST` / `ACME_EMAIL`                          | admin panel, ACME contact                                                                | `admin.libriant.com` / `ops@libriant.com` |
| `HASH_PEPPER`                                        | peppers the IP hash behind the application form's throttle — `openssl rand -hex 32`      | generated by `ensure-env.sh`              |
| `STRIPE_DRIVER` / `EMAIL_DRIVER`                     | `fake` / `console` for a trial; flip to `real` / `smtp` (+ keys / `SMTP_URL`) to go live | `fake` / `console`                        |

Everything else (the random secrets, `COMPOSE_PROJECT_NAME`,
`LIBRIANT_DATA_ROOT`, `IMAGE_TAG`, …) is filled automatically. See
`.env.prod.example` for the full annotated list. `chmod 600` is applied for you.

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

## Part 7 — DNS + TLS (Cloudflare)

Cloudflare is the registrar, DNS, **and** CDN — we run the hosts **behind its
proxy** (orange-cloud) for caching + DDoS protection. Because Cloudflare
terminates TLS at its edge, Caddy can't use Let's Encrypt here; it serves a
**Cloudflare Origin Certificate** and Cloudflare validates it in **Full
(strict)** mode.

**1. DNS records** — Cloudflare dashboard → `libriant.com` zone → **DNS →
Records** (nameservers already point at Cloudflare since it's your registrar):

| Type | Name    | Value           | Proxy          |
| ---- | ------- | --------------- | -------------- |
| A    | `@`     | `195.201.13.95` | **Proxied** 🟠 |
| A    | `admin` | `195.201.13.95` | **Proxied** 🟠 |

> Proxied records resolve to Cloudflare's edge, **not** your box — so
> `dig +short libriant.com` returns Cloudflare IPs. That's expected. Deploys
> SSH to the box by **raw IP** (`fleet.yml`), so they don't depend on this.

**2. Origin certificate** — dashboard → **SSL/TLS → Origin Server → Create
Certificate**. Keep defaults, hostnames `libriant.com` **and** `*.libriant.com`,
15-year validity → **Create**. **Save both PEM blocks in your password manager
first** — they are not in any backup, and a reinstall wipes the copy on disk.
Then paste them onto the box:

```sh
mkdir -p /mnt/libriant/caddy/origin
nano /mnt/libriant/caddy/origin/origin.crt    # paste "Origin Certificate"
nano /mnt/libriant/caddy/origin/origin.key    # paste "Private Key"
chmod 600 /mnt/libriant/caddy/origin/origin.key
```

Compose mounts that folder read-only into Caddy at `/etc/caddy/origin`, and the
Caddyfile already points `tls` at `origin.crt` / `origin.key`.

**3. SSL/TLS mode** — dashboard → **SSL/TLS → Overview** → set the mode to **Full
(strict)**. Under **Edge Certificates**, turn on **Always Use HTTPS**.

**4. Lock the origin to Cloudflare** — so nobody bypasses the proxy to hit the
box directly (which would also let them spoof the real-client-IP header). In the
host firewall (Part 2), replace the blanket `ufw allow 80,443` with Cloudflare's
ranges only:

```sh
ufw delete allow 80/tcp && ufw delete allow 443/tcp && ufw delete allow 443/udp
for ip in $(curl -s https://www.cloudflare.com/ips-v4) $(curl -s https://www.cloudflare.com/ips-v6); do
  ufw allow from "$ip" to any port 80  proto tcp
  ufw allow from "$ip" to any port 443 proto tcp
  ufw allow from "$ip" to any port 443 proto udp
done
ufw status numbered
```

Leave **22** open to your own IP — SSH deploys reach the box directly. Re-run
this when Cloudflare publishes new ranges (rarely, but it does happen).

> The real visitor IP arrives via Cloudflare's `CF-Connecting-IP` header, which
> the Caddyfile forwards to the app as `X-Real-IP` for rate-limiting + audit.
> The origin cert does **not** survive a reinstall — restore it from your password
> manager (Part 16, step 6). A 15-year Cloudflare cert needs no re-validation,
> so this is a copy-paste, not a re-issue.

**5. Bot protection vs. automated checks.** With **Bot Fight Mode** on, or the
security level set to **I'm Under Attack**, Cloudflare serves a _managed
challenge_ (`cf-mitigated: challenge`) to every request — browsers solve it
transparently, but `curl` / uptime probes get a **403**. That's expected, and
the deploy does **not** rely on the public URL (it health-checks the origin on
the host over SSH). If you want an external monitor to reach `/healthz`, add
_Security → WAF → Custom rules_: `(http.request.uri.path eq "/healthz")` →
**Skip**. For a normal public app, keep the security level at **Medium** so
visitors aren't challenged on every page load.

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

## Part 9 — Bootstrap the platform (automatic)

**There is no manual bootstrap step.** Every `dc up` / deploy runs a one-shot
`migrate` service to completion _before_ `api` and `worker` start
(`depends_on: condition: service_completed_successfully`). It runs
`scripts/prod-bootstrap.sh`, which is idempotent:

1. control-plane migrations (`pnpm db:migrate:deploy`) — **fatal** if it fails
2. seed cells + feature keys + starter plans (`pnpm db:seed`) — **fatal**
3. help-centre articles (`pnpm ingest:help`) — best-effort
4. existing-tenant migrations (`pnpm tenant:migrate`) — best-effort
5. first admin (`pnpm admin:bootstrap`) — only if `ADMIN_BOOTSTRAP_*` are set

So once you've set `ADMIN_BOOTSTRAP_EMAIL` / `ADMIN_BOOTSTRAP_PASSWORD` (Part 6,
via `ensure-env.sh`), the schema, seed data, and your admin account are all
created on the next deploy. If `migrate` fails, `api` never starts and the
deploy reports failure — migration errors can't slip through silently.

**Run it now** (first time, or after pulling a release that adds migrations):

```sh
dc up -d            # runs migrate -> then starts the stack
dc logs migrate     # see the bootstrap output
dc ps               # api should be "healthy"
```

Then visit `https://admin.libriant.com` → log in with your `ADMIN_BOOTSTRAP_*`
credentials → **MFA page** → scan the QR in an authenticator app → verify.

> **Manual escape hatch.** To run a single step yourself (e.g. re-seed) without
> a full `up`, exec into a throwaway container:
> `dc run --rm --no-deps migrate sh -lc 'cd /app && pnpm db:seed'`.

**Libraries (tenants)** are created two ways:

- **Self-service (normal):** a librarian signs up at `https://libriant.com` and
  everything is provisioned automatically (database, schema, owner, storage).
- **Operator-provisioned (optional):**

```sh
dc run --rm --no-deps migrate sh -lc "cd /app && pnpm tenant:create -- \
  --slug=acme --name='Acme Public Library' \
  --owner-email=ops@acme.org --owner-name='Acme Operator' \
  --plan=community --billing-mode=manual"
```

> The `migrate` service carries the repo `scripts/` mount + DB env, so it
> doubles as your operator shell for occasional one-off commands —
> `dc run --rm --no-deps migrate sh -lc 'cd /app && pnpm <task>'`.

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
Caddy log, and prunes old dailies. Set `BACKUP_ROOT` to the data volume so
backups land on `/mnt/libriant/backups`; the uploads path is auto-detected from
the storage Docker volume (no `STORAGE_DIR` needed).

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
BACKUP_ROOT=/mnt/libriant/backups \
  /srv/libriant/app/scripts/backup.sh
ls -lh /mnt/libriant/backups/$(date +%Y%m%d)/
```

**Schedule it** nightly at 02:15 (root cron that loads your env):

```sh
sudo tee /etc/cron.d/libriant-backup >/dev/null <<'CRON'
15 2 * * * deploy bash -lc 'set -a; . /srv/libriant/.env.prod; set +a; COMPOSE_FILE=/srv/libriant/app/infra/compose/docker-compose.prod.yml BACKUP_ROOT=/mnt/libriant/backups /srv/libriant/app/scripts/backup.sh >> /var/log/libriant/backup.log 2>&1'
CRON
```

**Restore drill** (practise before you need it). Use `scripts/restore.sh` — it
does this safely where a hand-rolled `psql | tar` does not: it stops
api/worker/web and terminates open DB connections **before** the `pg_dumpall`
DROP wave (otherwise it half-aborts), restores under `ON_ERROR_STOP=1`, moves
the existing uploads tree aside into `.pre-restore.<timestamp>/` before
untarring (a faithful point-in-time copy, not an additive merge), and restarts
the app services on exit. Pass the same volume paths the backup uses:

```sh
COMPOSE_FILE=/srv/libriant/app/infra/compose/docker-compose.prod.yml \
BACKUP_ROOT=/mnt/libriant/backups \
STORAGE_DIR=/mnt/libriant/storage \
  /srv/libriant/app/scripts/restore.sh <date> --yes   # <date> = YYYYMMDD
```

---

> **Applications are covered by the nightly backup with no extra wiring.** They
> live in `libriant_control`, which `pg_dumpall` already dumps whole. On
> Cloudflare D1 they were backed up by nothing at all. Two things are
> deliberately NOT backed up and do not need to be: the built marketing site
> (regenerated from the edge image on every deploy) and `spotsRemaining` (which
> is tracked in git).

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

> **Deploys are manual and run on the box as of 2026-08-22.** The push trigger
> is removed from `deploy.yml`; it is `workflow_dispatch` only. The current
> procedure is [deploy-from-the-server.md](deploy-from-the-server.md). What
> follows describes the CI path, which is accurate for when it is switched back
> on — see that page for the two things to fix first.

**Deploys run through CI.** Push to `main` (or trigger the _deploy_ workflow from
the Actions tab). CI builds the images, pushes them to GHCR, SSHes to
CyberSystema-1, checks out the exact commit at `/srv/libriant/app`, and runs the
same `dc`-style `pull` + `up -d` you'd run by hand — SHA-pinned, data on the
volume, with a `/healthz` gate.

**Turn on CI/CD — one-time setup:**

1. **`IMAGE_OWNER`** is set in `.env.prod` (Part 6) to your GitHub owner/org,
   lowercase. CI pushes — and the host pulls — `ghcr.io/$IMAGE_OWNER/libriant-{api,web}`.
2. **DNS is live** (Part 7): `libriant.com` resolves to the box with a valid
   cert. `fleet.yml`'s `ssh:` is the **raw IP**, not the hostname — the apex is
   Cloudflare-proxied and Cloudflare's edge does not carry port 22. CI does not
   health-check a public URL either; it SSHes in and curls `localhost`, so
   `health_host` in `fleet.yml` is informational only.
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
   _(Not while deploys are manual — run `scripts/deploy-on-host.sh` instead.)_

> **Heads-up:** CI does `git reset --hard`, so host-local edits to **tracked**
> files (e.g. tuning the `postgres` command in the compose file) are overwritten
> on the next deploy. Keep customisations in `.env.prod` or an untracked
> override file.

**Manual deploy** (fallback / break-glass) is always available:

```sh
cd /srv/libriant/app && git pull
dc pull && dc up -d --remove-orphans
```

**✅ Migrations are automatic.** Both manual `dc up` and the CI deploy run the
one-shot `migrate` service (control-plane migrate + seed + tenant fan-out)
to completion before `api`/`worker` start (Part 9). You don't run migrations by
hand. To watch them: `dc logs migrate`.

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
- **CLI:** `dc run --rm --no-deps migrate sh -lc 'cd /app && pnpm fleet:report'`
  (add `-- --json` for machine output).
- **/metrics:** the api exposes Prometheus gauges (`libriant_tenants_total`,
  `libriant_pg_connections`, `libriant_pg_cache_hit_ratio`, …) for charting.

**Server-level (free, self-hosted).** `infra/monitoring/` ships a ready
Prometheus + Grafana + node-exporter + cAdvisor stack:

```sh
cd /srv/libriant/app/infra/monitoring
GRAFANA_ADMIN_PASSWORD=pick-one docker compose -f docker-compose.monitoring.yml up -d
# Grafana is bound to localhost only — reach it through an SSH tunnel:
#   (in Termius / locally)  ssh -L 3300:127.0.0.1:3300 deploy@195.201.13.95
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

**There is no vertical scaling on a dedicated box.** You cannot rescale a
CPU, add RAM, or grow a disk on an auction server — the hardware is fixed for its
lifetime. Your two permanent ceilings are **4 cores / 8 threads** and the usable
RAID1 capacity (confirm with `df -h /mnt/libriant`).

You do, however, have 64 GB of RAM and a workload that is nowhere near it. Spend
it on Postgres before you spend money on hardware — add to the `postgres`
`command:` in the prod compose:

```text
-c shared_buffers=8GB -c effective_cache_size=24GB -c work_mem=32MB
```

then `dc up -d postgres`. With every tenant database cached in RAM, four cores go
a very long way.

**When you genuinely outgrow it**, the move is to a _different machine_, not a
bigger one:

1. Order the new server (dedicated is month-to-month, so run both briefly).
2. Back up and verify (Part 11).
3. Follow Parts 2–8 on the new box.
4. Restore (Part 16), re-point DNS, then cancel the old server.

Budget a weekend. The compose stack is portable, which is the whole reason this
is a migration and not a rebuild.

**Relieve pressure without replacing the box:**

- **Storage** — move uploads to a Storage Box or object storage. The control
  plane already keeps each tenant's `storage_url`, so this is config, not code.
- **CPU** — the app and worker can move to a second cheap box before Postgres has
  to; see `infra/deploy/fleet.yml`.

**Horizontal (later):** move Postgres to its own box, add app nodes behind a
Hetzner Load Balancer, shard tenants across cells. The architecture already
keeps each tenant's `db_url`/`storage_url` in the control plane, so these are
config changes, not rewrites — see `infra/deploy/fleet.yml` and the
`scripts/tenant-*` tooling.

---

## Part 16 — Disaster recovery (read this before you need it)

> ⚠️ **This section replaced a cloud-only procedure.** The earlier version of this
> runbook said a Rebuild kept your data and "no restore needed". **That is false on
> dedicated hardware.** `installimage` formats the drives, including
> `/mnt/libriant`. If you follow the old steps you lose everything.

### What each layer actually protects against

| Failure                             | Protected by                 | Cost to recover                  |
| ----------------------------------- | ---------------------------- | -------------------------------- |
| One NVMe dies                       | **RAID1**                    | Nothing — swap the drive, resync |
| Both drives die / fire / theft      | **Offsite backup** (Part 11) | Full rebuild + restore           |
| `rm -rf`, bad migration, ransomware | **Offsite backup** only      | Full restore                     |
| OS broken, reinstall needed         | **Offsite backup** only      | Full rebuild + restore           |

**RAID1 is not a backup.** It mirrors your mistakes instantly and both drives are
the same age under identical write load. Backups are the only layer that covers
the bottom three rows.

### Before you need it: prove the restore works

A backup you have never restored is a hope, not a plan. **Do this before your
first real library goes live**, and again whenever `backup.sh` changes:

```sh
# pull yesterday's dump from the Storage Box to a scratch dir
mkdir -p /tmp/restore-drill && cd /tmp/restore-drill
rclone copy "$BACKUP_REMOTE:$(date -d yesterday +%Y%m%d)" .
# restore into a throwaway database and count rows
gunzip -c *.sql.gz | psql -h 127.0.0.1 -U libriant -d postgres
```

Write down how long it took. That number is your real RTO, and it is the honest
answer when a library asks what happens if something goes wrong.

### Full recovery, from nothing

1. **Get the machine back.** Same server if the OS broke; a new one from Robot or
   the auction if the hardware is gone. Dedicated is month-to-month, so ordering a
   replacement is quick — but **auction stock is one-of-one**, so expect to take
   whatever is available rather than the identical box.
2. **Part 2** — rescue → `installimage` → **`SWRAID 1` / `SWRAIDLEVEL 1`** →
   firewall. Confirm `[UU]` in `/proc/mdstat`.
3. **Part 5** (base setup) and **Part 6** (clone the repo, restore `.env.prod`).
   > `.env.prod` is **not** in any backup by design — it holds every secret. Keep
   > it in your password manager. Without it nothing else here helps.
4. **Restore the data** — see `scripts/restore.sh`:
   ```sh
   cd /srv/libriant/app
   BACKUP_ROOT=/mnt/libriant/backups bash scripts/restore.sh <YYYYMMDD> --yes
   ```
   This recreates the control database and every tenant database, and unpacks
   uploads back into `/mnt/libriant/storage`.
5. **Start and verify** — `dc up -d`, then Part 12. Check `/readyz`, log into the
   admin panel, and open one real tenant's catalogue.
6. **Re-issue TLS.** Caddy's certificates lived on the old disk. Cloudflare Origin
   Certificates (Part 7) are the easy path — reinstall the same cert and key from
   your password manager; nothing needs to be re-validated.
7. **Tell the libraries.** If data was lost between the last backup and the
   failure, say so plainly and say what window. Your programme terms promise them
   an export at any time; a quiet gap is far worse than an honest one.

### The gap you are accepting

Backups run **nightly**. A failure at 23:00 loses up to a day of circulation —
loans, returns, new members. For a library that is recoverable from memory and
paper slips, which is why nightly is a reasonable trade at this scale.

If that stops being acceptable — say, at 20+ libraries — turn on Postgres WAL
archiving to the Storage Box for point-in-time recovery. That is a change to the
`postgres` service config, not a re-architecture.

---

## Part 17 — Managing the box from Robot

**`hcloud` does not manage dedicated servers.** It is the Hetzner _Cloud_ CLI;
your machine lives in **Robot**, a separate product with a separate login and its
own webservice API. Skip it.

Day-to-day you need very little:

| Task                    | Where                                                          |
| ----------------------- | -------------------------------------------------------------- |
| Reboot / hardware reset | Robot → **CyberSystema-1** → _Reset_                           |
| Boot into rescue        | Robot → _Rescue_ tab, then _Reset_                             |
| Report a failed disk    | Robot → _Support_ → include `/proc/mdstat` output              |
| Coarse packet filter    | Robot → _Firewall_ (stateless; the host `ufw` is the real one) |
| Reverse DNS             | Robot → _IPs_ → edit rDNS                                      |
| Cancel the server       | Robot → _Cancellation_ (month-to-month)                        |

> **Order of operations on a suspected disk failure:** check `/proc/mdstat`
> first. If it reads `[U_]`, the mirror is already carrying you and there is no
> rush — take a fresh backup, _then_ open the ticket. Do not reboot a degraded
> array before backing up.

### Reaching your data from the Rescue System

Rescue runs entirely in RAM and never touches your drives, so booting it is safe
even when you only want to copy one file off a broken box.

Activate it in Robot → _Rescue_ (Linux, 64-bit, select your key), then Robot →
_Reset_ → _Execute an automatic hardware reset_. **Two things catch people out:**
activation is armed for **one boot only** and disarms after **60 minutes** if you
do not reboot, and the rescue system has a **different SSH host key**, so you will
get `REMOTE HOST IDENTIFICATION HAS CHANGED`. Compare the fingerprint Robot
displays, then clear the old entry:

```sh
ssh-keygen -R <your-server-ip>
ssh root@<your-server-ip>          # also listens on port 222
```

Once in, your disks are **not** mounted. With RAID + LVM it takes three steps:

```sh
mdadm --assemble --scan            # bring the mirror up (usually automatic)
cat /proc/mdstat                   # want [UU]; [U_] = degraded but still readable

vgchange -ay                       # ← THE STEP EVERYONE FORGETS
lvs                                # you should now see root, data, swap

mkdir -p /mnt/old
mount /dev/vg0/root /mnt/old
mount /dev/vg0/data /mnt/old/mnt/libriant
```

Without `vgchange -ay` the logical volumes never appear as devices and it looks
exactly as though your data is gone. It is not — the volume group is simply
inactive. Unmount in reverse order (`data` first) before rebooting.

Pull the backups off **before** you attempt any repair:

```sh
scp -r /mnt/old/mnt/libriant/backups/ you@laptop:~/libriant-emergency/
```

**If the box will not answer SSH even in rescue**, escalate: Robot → your server
→ _Support_ → **Remote Console**. Hetzner attaches a KVM-over-IP and emails you
the URL — **free for 3 hours**, chargeable after. That is the path for BIOS and
boot-menu problems. **vKVM** sits in between: it boots your installed OS inside a
VM, which is the right tool specifically for a firewall lockout.

Escalation order, cheapest first: **rescue → vKVM → KVM console.**

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

| Symptom                                   | Check                                                                                                                                                                                                                                                                                   |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Containers won't start                    | Is the volume mounted? `df -h /mnt/libriant`                                                                                                                                                                                                                                            |
| No TLS / cert errors (5xx)                | Cloudflare SSL mode = **Full (strict)**? Origin cert present at `/mnt/libriant/caddy/origin/`? `dc logs caddy`                                                                                                                                                                          |
| Marketing site 404s or is blank, app fine | `SITE_HOST` unset in `.env.prod` so the vhost never matched, or the edge image is stale. `docker compose $FILES exec caddy ls /srv/libriant/site/index.html`                                                                                                                            |
| App down, marketing site fine             | Working as designed — the site is files inside Caddy and does not depend on api or web. `MAINTENANCE_HARD=true` blacks out only the vhosts importing `maintenance_takeover`, which the site vhost deliberately does not                                                                 |
| Public URL returns **403**                | Cloudflare _managed challenge_ (browsers fine, `curl` blocked). Lower Security Level / Bot Fight Mode, or add a `/healthz` Skip rule (Part 7.5). Origin itself: `curl -sko /dev/null -w '%{http_code}' --resolve $PUBLIC_HOST:443:127.0.0.1 https://$PUBLIC_HOST/healthz` should be 200 |
| `api` not ready                           | `dc logs api`; is Postgres healthy in `dc ps`?                                                                                                                                                                                                                                          |
| Out of memory during backup               | swap on? (`free -h`); or grow the box (Part 15)                                                                                                                                                                                                                                         |
| Stripe state stale                        | webhook secret set + endpoint reachable? (Part 10)                                                                                                                                                                                                                                      |
