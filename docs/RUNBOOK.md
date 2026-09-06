# Libriant operations runbook — 195.201.13.95

**This is the only operational document.** There is no second place to look.
It replaced five documents, which were deleted on 2026-08-28 —
`docs/deployment-hetzner.md`, `docs/server-handbook.md`,
`docs/cutover-three-hosts.md`, `docs/deploy-from-the-server.md` and
`docs/billing-go-live.md`. Their originals are in git history
(`git log --follow -p -- docs/<name>.md`) and they are wrong where they disagree
with this file; most of them describe 178.104.32.176, which no longer exists.
`README.md` is for working on the code, not for operating a server.

Written 2026-08-23; extended 2026-08-28 with `scripts/install-server.sh` (§3),
the complete variable reference (§4.2a), backup encryption and the dead man's
switch (§8.1a, §8.1b), control-database retention (§8.6) and what the deleted
documents still carried. Hardware facts are measured, not remembered
(`docs/runbook-rewrite-2026-08-23/HOST-FACTS.md`). Anything unmeasured is
labelled **UNVERIFIED** where you would use it, never smoothed over.

---

## State of the world, 2026-08-23

Read this before you touch anything.

|                |                                                                                                                                                                                         |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The box        | Bare. No docker, no `deploy` user, no `/srv/libriant`. `/mnt/libriant` is mounted and empty. **One command provisions all of it** — `scripts/install-server.sh`, §3.                    |
| Firewall       | **`ufw` is inactive.** Port 22 is open to the internet with nothing in front of it. The origin lockdown (§3.2c) has never run on a live box.                                            |
| SSH            | **`passwordauthentication yes`.** Root is key-only; every other account can be brute-forced.                                                                                            |
| The stack      | **Has never run anywhere — not on a server, not in CI.**                                                                                                                                |
| Does it start? | Nothing known stops it. `supply-chain-06` is fixed in the repository and **unproven on a box** — §3.0.                                                                                  |
| Deploys        | Manual, from the box: `scripts/deploy-on-host.sh`. The GitHub workflow is `workflow_dispatch`-only and its `DEPLOY_KNOWN_HOSTS` secret still pins the dead box.                         |
| DNS            | `libriant.com` → Cloudflare, origin unreachable (522). `admin.libriant.com` exists and is equally dead. **`app.libriant.com` does not exist.**                                          |
| Email          | `EMAIL_DRIVER=console`. Nothing is delivered, and the body is withheld from logs. `BLOCKER launch-readiness-01`. Account recovery is §4.3a, and it works.                               |
| Billing        | `BILLING_ENABLED=false`, `STRIPE_DRIVER=none`. `billing-02` and `billing-03` are closed; **`BLOCKER billing-04` — no VAT anywhere in the billing path** — still blocks taking money.    |
| Backups        | None yet. Nothing in the deploy path installs the cron; `install-server.sh --only backup` does (§8.2). `backup.sh` refuses to run without encryption and a dead man's switch (§8.1a/b). |
| Alerting       | Prometheus evaluates all 32 rules on every deploy. **Nothing reaches a human**: `alertmanager.yml` still has `[PLACEHOLDER]` receivers (§7.1, §7.3).                                    |

Of the twelve audit blockers, **three are still open**: `launch-readiness-01`
(no mail is delivered), `privacy-legal-01` (the legal documents still carry
`[PLACEHOLDER]`s) and `billing-04` (no VAT). The first two block a public
launch; the third blocks taking money. **Do not put this box in DNS.** A first
deploy on a private, not-in-DNS box is legitimate and useful; a cutover is not,
yet.

**Emergency shortcuts:** [§9 When it breaks](#9-when-it-breaks) ·
[§11 Quick reference](#11-quick-reference) · `sudo bash install-server.sh --status`
(what is provisioned and what is not) · `sudo bash install-server.sh --verify-only`
(the read-only §3.9 probes, the firewall verdict and the backup status — asks
nothing, changes nothing)

## Where to look

**At 3am, start here.** The section numbers are stable and every `§n.n` in this
document is a real heading you can search for.

| If you are here because…                            | Go to                                                                                                                                |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| The site returns a Cloudflare error (522, 526, 502) | [§9.1](#91-site-down-cloudflare-error)                                                                                               |
| Pages load but the app is broken                    | [§9.2](#92-app-down)                                                                                                                 |
| A deploy just failed                                | [§9.7](#97-deploy-failed)                                                                                                            |
| The disk is full                                    | [§9.5](#95-disk-full)                                                                                                                |
| One library is broken and the rest are fine         | [§9.9](#99-one-tenant-broken)                                                                                                        |
| You must restore from a backup                      | [§8.3a](#83a-the-restore-you-actually-have-today) — **`restore.sh` does not run; that section is the working path**                  |
| You are provisioning a brand-new box                | [§3, the one command](#the-one-command)                                                                                              |
| You need to know what a variable does               | [§4.2a](#42a-every-variable-and-who-actually-reads-it)                                                                               |
| A setting you edited had no effect                  | [§4.1](#41-how-configuration-actually-reaches-a-container), then [§4.2b](#42b-checking-what-a-container-actually-got)                |
| You are adding a library                            | [§6.6](#66-adding-a-tenant)                                                                                                          |
| Somebody is locked out of the admin panel           | [§4.5](#45-the-admin-password-reset-that-nobody-documented), [§4.5a](#45a-the-lost-authenticator--getting-back-into-the-admin-panel) |
| You are about to point DNS at this box              | [§5.4](#54-the-cutover-order-and-what-breaks-if-you-deviate) — **read it before, not during**                                        |
| An e-mail or link on the public site renders wrong  | [§5.4a](#54a-cloudflare-dashboard-settings-that-must-stay-off) — the edge rewrites HTML the origin never sent                        |
| You need to tell the libraries something            | [§9.11](#911-telling-the-libraries)                                                                                                  |
| Personal data may have leaked                       | [§9.11c](#911c-personal-data-breach--the-one-with-a-clock) — **72-hour clock**                                                       |
| You just want the command                           | [§11](#11-quick-reference)                                                                                                           |

**Every section.**

- **[State of the world, 2026-08-23](#state-of-the-world-2026-08-23)**
- **[1. The machine](#1-the-machine)**
  [Storage](#storage) · [Network](#network) · [Installed / not installed](#installed--not-installed) · [Timezone decision](#timezone-decision)
- **[2. What you are operating](#2-what-you-are-operating)**
  [The services](#the-services) · [The networks](#the-networks) · [The start order](#the-start-order) · [Restart policy — read this once and remember it](#restart-policy--read-this-once-and-remember-it) · [What /healthz is, and is not](#what-healthz-is-and-is-not) · [The four Caddy vhosts](#the-four-caddy-vhosts) · [Volumes and bind mounts](#volumes-and-bind-mounts) · [Postgres, pgbouncer, Redis specifics](#postgres-pgbouncer-redis-specifics)
- **[3. First deploy, from bare metal](#3-first-deploy-from-bare-metal)**
  [Getting the script onto a box with no checkout](#getting-the-script-onto-a-box-with-no-checkout) · [Before you start — the seven things it will ask you for](#before-you-start--the-seven-things-it-will-ask-you-for) · [The one command](#the-one-command) · [Flags](#flags) · [Resuming, which is the normal way to use it](#resuming-which-is-the-normal-way-to-use-it) · [The three ways this script could ruin your day](#the-three-ways-this-script-could-ruin-your-day) · [What each step does, and what it will ask you](#what-each-step-does-and-what-it-will-ask-you) · [What the installer does not do, and you still must](#what-the-installer-does-not-do-and-you-still-must) · [The manual path — §3.0 to §3.10](#the-manual-path--30-to-310) · [3.0 The pnpm toolchain in the images — historical, and why it is fine now](#30-the-pnpm-toolchain-in-the-images--historical-and-why-it-is-fine-now) · [3.1 Get on the box and take stock](#31-get-on-the-box-and-take-stock) · [3.1a The clock, which is an authentication input here](#31a-the-clock-which-is-an-authentication-input-here) · [3.1b Is the data volume mounted, or mounted for ever?](#31b-is-the-data-volume-mounted-or-mounted-for-ever) · [3.2 Harden — do this before anything is worth stealing](#32-harden--do-this-before-anything-is-worth-stealing) · [3.3 Docker](#33-docker) · [3.4 The deploy user](#34-the-deploy-user) · [3.5 Directories](#35-directories) · [3.6 The checkout](#36-the-checkout) · [3.7 .env.prod and the origin certificate](#37-envprod-and-the-origin-certificate) · [3.8 Deploy](#38-deploy) · [3.9 Post-deploy checks the script does not do](#39-post-deploy-checks-the-script-does-not-do) · [3.10 The nightly backup — a green deploy has none](#310-the-nightly-backup--a-green-deploy-has-none)
- **[4. Configuration](#4-configuration)**
  [4.1 How configuration actually reaches a container](#41-how-configuration-actually-reaches-a-container) · [4.2 Hard requirements](#42-hard-requirements) · [4.2a Every variable, and who actually reads it](#42a-every-variable-and-who-actually-reads-it) · [4.2b Checking what a container actually got](#42b-checking-what-a-container-actually-got) · [4.2c The Postgres timeouts, and what is exempt](#42c-the-postgres-timeouts-and-what-is-exempt) · [4.2d REDIS_MAXMEMORY moves with three other numbers](#42d-redis_maxmemory-moves-with-three-other-numbers) · [4.2e Backup encryption: the keys that are not in the template](#42e-backup-encryption-the-keys-that-are-not-in-the-template) · [4.2f Retention: five keys in the template, three that are real, none that reach a container](#42f-retention-five-keys-in-the-template-three-that-are-real-none-that-reach-a-container) · [4.2g Configured, and decorative](#42g-configured-and-decorative) · [4.3 The production landmines](#43-the-production-landmines) · [4.3a Recovering an account while no mail is delivered](#43a-recovering-an-account-while-no-mail-is-delivered) · [4.3b Before you flip subscriptions on: the two checks, and the commands that perform them](#43b-before-you-flip-subscriptions-on-the-two-checks-and-the-commands-that-perform-them) · [4.3c The price catalogue, and the screen that says whether this host can charge](#43c-the-price-catalogue-and-the-screen-that-says-whether-this-host-can-charge) · [4.4 Secrets: what breaks if you lose or rotate each one](#44-secrets-what-breaks-if-you-lose-or-rotate-each-one) · [4.5 The admin password reset that nobody documented](#45-the-admin-password-reset-that-nobody-documented) · [4.5a The lost authenticator — getting back into the admin panel](#45a-the-lost-authenticator--getting-back-into-the-admin-panel) · [4.5b Freezing — and un-freezing — a library account](#45b-freezing--and-un-freezing--a-library-account) · [4.6 Host-shaped variables worth knowing](#46-host-shaped-variables-worth-knowing)
- **[5. DNS and TLS](#5-dns-and-tls)**
  [5.1 Measured state, 2026-08-23](#51-measured-state-2026-08-23) · [5.2 There is no ACME here](#52-there-is-no-acme-here) · [5.3 HSTS, and why order matters](#53-hsts-and-why-order-matters) · [5.4 The cutover order, and what breaks if you deviate](#54-the-cutover-order-and-what-breaks-if-you-deviate) · [5.5 CAA](#55-caa) · [5.6 Mail DNS](#56-mail-dns) · [5.7 Verifying TLS without fooling yourself](#57-verifying-tls-without-fooling-yourself)
- **[6. Routine operations](#6-routine-operations)**
  [6.1 The dc helper](#61-the-dc-helper) · [6.2 Deploying a change](#62-deploying-a-change) · [6.3 Logs](#63-logs) · [6.4 The operator shell](#64-the-operator-shell) · [6.5 Migrations](#65-migrations) · [6.6 Adding a tenant](#66-adding-a-tenant) · [6.7 The rhythm](#67-the-rhythm) · [6.8 Rebooting](#68-rebooting)
- **[7. Monitoring](#7-monitoring)**
  [7.1 What exists, and what is switched off](#71-what-exists-and-what-is-switched-off) · [7.2 The monitoring stack (started by every deploy)](#72-the-monitoring-stack-started-by-every-deploy) · [7.3 Minimum viable alerting — the concrete recipe](#73-minimum-viable-alerting--the-concrete-recipe) · [7.4 The health surfaces that lie](#74-the-health-surfaces-that-lie)
- **[8. Backup and restore](#8-backup-and-restore)**
  [8.1 What is and is not backed up](#81-what-is-and-is-not-backed-up) · [8.1a Encryption — the decision backup.sh will not make for you](#81a-encryption--the-decision-backupsh-will-not-make-for-you) · [8.1b The dead man's switch — backup.sh refuses to run without one](#81b-the-dead-mans-switch--backupsh-refuses-to-run-without-one) · [8.2 Installing the nightly backup](#82-installing-the-nightly-backup) · [8.3 Restoring](#83-restoring) · [8.3a The restore you actually have today](#83a-the-restore-you-actually-have-today) · [8.4 What CI actually proves](#84-what-ci-actually-proves) · [8.5 The drill — quarterly, and it has never been done](#85-the-drill--quarterly-and-it-has-never-been-done) · [8.6 The other retention — the control database, and the five names that govern it](#86-the-other-retention--the-control-database-and-the-five-names-that-govern-it)
- **[9. When it breaks](#9-when-it-breaks)**
  [9.1 Site down (Cloudflare error)](#91-site-down-cloudflare-error) · [9.2 App down](#92-app-down) · [9.3 Redis down](#93-redis-down) · [9.4 Postgres down](#94-postgres-down) · [9.5 Disk full](#95-disk-full) · [9.6 OOM](#96-oom) · [9.7 Deploy failed](#97-deploy-failed) · [9.8 Certificate expired or wrong](#98-certificate-expired-or-wrong) · [9.9 One tenant broken](#99-one-tenant-broken) · [9.10 The customer-facing levers](#910-the-customer-facing-levers) · [9.11 Telling the libraries](#911-telling-the-libraries)
- **[10. Growing](#10-growing)**
  [10.1 Extending /mnt/libriant — online, no downtime](#101-extending-mntlibriant--online-no-downtime) · [10.2 Resource caps, and when to raise them](#102-resource-caps-and-when-to-raise-them) · [10.3 When one box stops being enough](#103-when-one-box-stops-being-enough)
- **[11. Quick reference](#11-quick-reference)**
  [Getting in](#getting-in) · [Paths](#paths) · [Commands](#commands) · [Six things to remember](#six-things-to-remember)
- **[Appendix — the unknowns register](#appendix--the-unknowns-register)**
- **[How this document was built and checked](#how-this-document-was-built-and-checked)**
  [Sources](#sources) · [What was verified, and how](#what-was-verified-and-how) · [What this pass changed](#what-this-pass-changed) · [What remains unverified](#what-remains-unverified)

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

IPv6 is the easy thing to miss, and the answer is counter-intuitive: **the
origin is deliberately IPv4-only and must have no `AAAA` records** (§3.2c layer
2, §5.4). Visitors still reach Cloudflare over IPv6; only the Cloudflare→origin
hop is v4. What the public address does mean is that a firewall written only for
IPv4 leaves a second front door wide open — which is why a missing `ip6tables` is
fatal to `prod-bootstrap.sh` rather than a warning.

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

Nine compose services. Eight long-running, one one-shot. **Three** images built
on this box — `libriant-caddy`, `libriant-api`, `libriant-web` — and **three**
pulled, each pinned by digest since `supply-chain-05`: `postgres:16-alpine`,
`edoburu/pgbouncer:v1.25.2-p0`, `redis:8-alpine`. `migrate` and `worker` both
reuse the `libriant-api` image and `pgbouncer-probe` reuses the `postgres` one,
which is why nine services need only six images.

Compose files, always both, always in this order:

```
infra/compose/docker-compose.prod.yml    the stack
infra/compose/docker-compose.volume.yml  rebinds 4 volumes onto /mnt/libriant
```

### The services

| Service           | Image                                                                        | Networks      | Limits (mem / cpu / pids) | Healthcheck                                            | What the healthcheck actually proves                                                                                                                                                                                                                                                                                            |
| ----------------- | ---------------------------------------------------------------------------- | ------------- | ------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `caddy`           | built `libriant-caddy` (base `caddy:2-alpine`, **bakes the marketing site**) | edge, app     | 256m / 1 / 256            | `wget localhost:80/healthz` 30s/5s/5, no start_period  | **Only that the Caddy process is alive.** Static 200. Stays green through a total outage.                                                                                                                                                                                                                                       |
| `migrate`         | built `libriant-api`                                                         | **data only** | none / none / none        | none                                                   | — one-shot, must exit 0                                                                                                                                                                                                                                                                                                         |
| `api`             | built `libriant-api`                                                         | app, data     | 1g / 1.5 / 1024           | `wget localhost:3001/readyz` 15s/5s/8, start 30s       | Real: Redis `PING` **and** `SELECT 1` on the control DB.                                                                                                                                                                                                                                                                        |
| `web`             | built `libriant-web`                                                         | **app only**  | 768m / 1 / 512            | `wget localhost:3000/api/readyz` 15s/5s/8, start 30s   | Real since `boot-and-config-08`: it fetches `${API_INTERNAL_URL}/readyz` with a 3 s timeout and 503s on failure, so it **does** cross the web→api hop. It probed the constant `/api/healthz` until then, and could not go red no matter what was behind it. `/api/healthz` still exists as pure liveness.                       |
| `worker`          | built `libriant-api`                                                         | app, data     | 1g / 1 / 512              | `wget localhost:3002/readyz` 30s/5s/5, start 20s       | Real: every consumer in `apps/api/src/queues/consumers.ts` running **and** Redis `PING`. A 503 body names which one is down.                                                                                                                                                                                                    |
| `postgres`        | `postgres:16-alpine`                                                         | data          | 2g / 2 / 512              | `pg_isready -U libriant -d libriant_control`           | The cluster accepts connections.                                                                                                                                                                                                                                                                                                |
| `pgbouncer`       | `edoburu/pgbouncer:v1.25.2-p0`                                               | data          | 256m / 0.5 / 256          | **none**                                               | `boot-and-config-15` removed it. `pg_isready` was answered by pgbouncer's own startup-packet reply and stayed green with Postgres unreachable. The real probe is the sidecar below.                                                                                                                                             |
| `pgbouncer-probe` | `postgres:16-alpine` (the same digest), entrypoint `sleep`                   | data          | 128m / 0.25 / 64          | `psql -h pgbouncer -c 'select 1'` 30s/10s/3, start 30s | The only probe that tells "the pooler answers" from "the pooler can reach Postgres". `api` deliberately does **not** gate on it — a broken diagnostic must not be an outage — but **the deploy health gate does** (§3.8). At 3am: api unhealthy + probe unhealthy is the pooler path; api unhealthy + probe healthy is the API. |
| `redis`           | `redis:8-alpine`                                                             | data          | 512m / 1 / 256            | `redis-cli ping`                                       | Redis responds.                                                                                                                                                                                                                                                                                                                 |

Caps sum to **6016 MiB (5.875 GiB)** and **8.25 cpus** against 62 GiB and 8
threads — comfortable on memory, and slightly over-committed on CPU, which is
fine because these are limits and not reservations. Room to raise either (§10.2).
The compose file's own comment says these "suit a ~4 GB host"; that arithmetic is
wrong and the comment predates this machine. Ignore it.

`migrate` has **no** memory, cpu or pid cap.

### The networks

| Network | Members                                                               | Properties                                                          |
| ------- | --------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `edge`  | caddy                                                                 | bridge                                                              |
| `app`   | caddy, api, web, worker                                               | bridge, **has internet egress**                                     |
| `data`  | postgres, pgbouncer, pgbouncer-probe, redis, api, worker, **migrate** | bridge, **`internal: true` — no route to the host or the internet** |

Two consequences that explain most confusing failures:

- `web` is on `app` only. It **cannot reach Postgres or Redis at all**, by
  design. Everything it needs comes from `api`.
- `migrate` is on `data` only. It has **no internet egress**. This is why
  `supply-chain-06` cannot be worked around on the box (§3.0).

Only `caddy` publishes host ports, and never in the bare `80:80` form: they are
`${EDGE_BIND_IPV4:-0.0.0.0}:80:80`, `:443:443` and `:443:443/udp`. **That
explicit v4 bind removes the `[::]` listener entirely**, which is layer 2 of the
origin lockdown and the reason the origin has no `AAAA` records (§3.2c, §5.4).
Docker inserts its own rules into `DOCKER-USER` ahead of ufw's INPUT chain, so a
`ufw` rule does **not** filter 80/443. See §3.2.

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
- `pgbouncer-probe` → pgbouncer _started_ (it is a diagnostic; nothing gates on it)
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

1. `docker inspect --format '{{.State.Health.Status}}'` on `api`, `worker`, `web`
   and `pgbouncer-probe`. All four are real probes now; `caddy`'s is not.
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

**Who owns them, and why it is a group.** `caddy` runs as **uid 1000, gid 0**
with no capabilities (supply-chain-07), so it can only reach a file as that
file's owner or through group 0. All three of its writable volumes are therefore
`0:0` and group-writable — `/mnt/libriant/caddy` at `775`, and the two boot-disk
volumes `g+rwX` — while the origin pair inside stays `0:0 640`, group-**readable**
only. That the container is not the owner of the private key it reads is the
point of the arrangement, and the group is 0 rather than 1000 because gid 1000 is
a human login. Converting a box that predates this: §3.7c.

Bind mounts, complete: caddy gets the Caddyfile, `maintenance.html`, `<repo>/assets`
and the origin dir; api / web / worker get `<repo>/assets` and `<repo>/locales`;
`migrate` gets `<repo>/scripts` → `/app/scripts` and `<repo>/locales` → `/app/locales`
(different mount points); postgres gets `postgres-init.sql`.

Two facts hidden in there:

- The `assets` and `locales` mounts on **`web` used to be inert** and are not any
  more. `boot-and-config-13`: compose merges nothing from `x-app-env` into the
  `web` service's own `environment:` block, so `ASSETS_ROOT` and `LOCALES_ROOT`
  had to be repeated there — until they were, Next.js silently fell back to the
  copies baked into the image, and editing `/srv/libriant/locales` on the host
  changed everything the API served and nothing a visitor saw. Both are now set
  on `web`, so a host-side edit reaches every service.
- Because `migrate` bind-mounts the host checkout's `scripts/`, the bootstrap
  that runs is the **host checkout's** code against the **image's** node_modules.
  With `--skip-build` those can be different commits.

### Postgres, pgbouncer, Redis specifics

- **Postgres** `postgres:16-alpine`, user `libriant`, db `libriant_control`,
  started with `shared_preload_libraries=pg_stat_statements`,
  `max_connections=${PG_MAX_CONNECTIONS:-200}`,
  `statement_timeout=${PG_STATEMENT_TIMEOUT:-60s}` and
  `idle_in_transaction_session_timeout=${PG_IDLE_TX_TIMEOUT:-120s}` (§4.2c).
  `stop_grace_period: 120s`, so a shutdown checkpoint is never SIGKILLed into WAL
  crash recovery. `postgres-init.sql` creates `unaccent`, `pg_trgm`,
  `pg_stat_statements`, `pgcrypto`, `citext` and a `libriant_demo` database —
  **but only when PGDATA is empty**. After a restore, or on any existing cluster,
  that file never runs.
  Greek collation is now real rather than aspirational: `POSTGRES_INITDB_ARGS`
  passes `--locale-provider=icu --icu-locale=el-GR --locale=C.UTF-8`, which does
  not depend on musl shipping a locale definition, and `postgres-init.sql`
  asserts it on that same first run. It applies **at initdb only** — an existing
  cluster keeps whatever it was built with and cannot be changed in place without
  a full reindex, so this has to be right before the first library is
  provisioned.
- **pgbouncer** transaction pooling, `scram-sha-256`, `MAX_CLIENT_CONN=500`,
  `DEFAULT_POOL_SIZE=20`, fronting **only** `libriant_control`. Tenant databases
  do not go through it. Migrations deliberately bypass it via `PG_SUPERUSER_URL`
  → `postgres:5432`, because Prisma Migrate's session-level advisory lock is
  silently broken by a transaction-mode pooler.
- **Redis** `redis:8-alpine`, `--appendonly yes`,
  `--maxmemory ${REDIS_MAXMEMORY:-320mb} --maxmemory-policy noeviction`.
  `reliability-18` put both halves in: it used to carry `allkeys-lru` with no
  `--maxmemory` at all, which made the policy inert **and** named the one
  behaviour its own comment said would lose live BullMQ job keys. With
  `noeviction` Redis never drops a key; at the ceiling it refuses **writes** with
  an OOM error the app sees and logs, while reads and the existing queues keep
  working. That is the soft landing there used to be none of — a killed Redis is
  still a 100% outage (§9.3). The ceiling moves with three other numbers: §4.2d.

---

## 3. First deploy, from bare metal

There are two ways through this section and they build the same box.

**`scripts/install-server.sh` is the first one.** It executes §3.1 to §3.10,
plus §6.1's `dc` helper and the origin lockdown a green deploy leaves undone,
in one command. It orchestrates the scripts that already exist —
`ensure-env.sh`, `deploy-on-host.sh`, `prod-bootstrap.sh`, `backup.sh` — and
reimplements none of them; everything it does itself is the glue this section
describes in prose.

It has **never been run against a real server** — nothing in this document has,
the stack has never run anywhere. What has been exercised is its own decision
logic: `bash scripts/install-server.sh --self-test` needs no root, no network
and no Docker, and printed `195 passed, 0 failed` on a developer machine on
2026-08-28. That covers the lockout counter, the PEM and certificate checks, the
`--firewall-status` verdict, the cron line it writes and the `dc` block it
writes. It does not cover the box.

**§3.0 to §3.10 below are the second one.** They are the same steps, by hand,
and they stay because a script that dies at step 11 is only useful next to the
prose that says what step 11 was for. Read them when the installer stops, when
you want to know what it did, or when you would rather type it yourself.

### Getting the script onto a box with no checkout

The `checkout` step is tenth of seventeen: the repository is not on the machine
when you start, so the script cannot come from it.

```bash
# from your laptop
scp scripts/install-server.sh root@195.201.13.95:/root/
ssh root@195.201.13.95
sudo bash /root/install-server.sh
```

It is a single self-contained bash file (~250 KB, 4,963 lines) with no
dependency on anything else in the repo, so pasting it into an editor on the box
works too. Once the `checkout` step has run there is a copy at
`/srv/libriant/app/scripts/install-server.sh`, and that is the one to use for
every later `--only` / `--from` run — the firewall step invokes
`prod-bootstrap.sh` **out of the checkout**, so the two must not drift.

### Before you start — the eight things it will ask you for

The script's own briefing lists these and stops until you type `READY`. It is
right about all eight; get them in front of you first, because most of them are
things a shell cannot invent for you at 02:00.

Every one of them is asked in the **first fifteen minutes**, before the build.
That is deliberate and it is a property worth preserving when editing the
script: the briefing tells you the cold build is 10–20 minutes and to run it
under tmux, so walking away is the reasonable response, and a prompt waiting
behind a finished build is a prompt nobody answers for an hour. The only
question after the build is _"run the backup once now"_, which cannot be asked
earlier because it needs the stack up.

|                                                                                                                                              |                                                                                                                                                                                                                                                                                                                                                                                                                    |
| -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **1. A second SSH session, already open and working.**                                                                                       | The `ssh` step disables password authentication. If the key you rely on stops working after that, only the provider console or a rescue boot gets you back in.                                                                                                                                                                                                                                                     |
| **2. The Cloudflare Origin certificate — both PEM blocks.**                                                                                  | Hostnames must be **both** the apex and `*.<apex>`. No backup contains this pair; if it is not in your password manager it exists nowhere else.                                                                                                                                                                                                                                                                    |
| **3. A browser logged in to GitHub**, with rights to add a read-only Deploy Key to `git@github.com:CyberSystema/libriant.git`.               | The `checkout` step generates the key, prints it, and **stops and waits for you**.                                                                                                                                                                                                                                                                                                                                 |
| **4. The first admin e-mail and password**, 12 characters minimum.                                                                           | Without the e-mail no admin is created and the deploy prints a yellow warning. Without the password no admin is created and **nothing warns at all**. `bootstrap-admin.ts` exits non-zero below 12 characters.                                                                                                                                                                                                     |
| **5. A password for the `deploy` account**, and somewhere to store it.                                                                       | `sudo` cannot authenticate without one and roughly a third of this document is `sudo`.                                                                                                                                                                                                                                                                                                                             |
| **6. A backup encryption decision:** an `age` **recipient** (public key, `age1…`, the identity kept off this host) or a gpg passphrase file. | `backup.sh` refuses to run without one, so this is not something to defer to the morning. §8.                                                                                                                                                                                                                                                                                                                      |
| **7. tmux or screen.**                                                                                                                       | The image build is 10–20 minutes cold and an SSH drop in the middle of it kills the run. The `briefing` step checks `$TMUX` and `$STY` and warns when both are empty; it does not refuse.                                                                                                                                                                                                                          |
| **8. The name this box should have**, or a decision to keep the provider's.                                                                  | Offered in `stock`, defaulting to no change. Nothing on this stack **reads** it; three things **write** it, and all three are read during an incident — `backup.sh`'s per-run manifest (`host=$(hostname)`), the GitHub Deploy Key's comment, and the install transcript's header. The deploy key is **never regenerated**, so declining is permanent in the one label you read when deciding which key to revoke. |

### The one command

```bash
sudo bash install-server.sh
```

Before it touches anything it prints what it found, which is also the fastest
answer to "what state is this box in":

```
Libriant installer — docs/RUNBOOK.md §3, §6.1, §8.2, on <hostname> as root

  This box, right now:
    ubuntu           <VERSION_ID> <VERSION_CODENAME>
    timezone         Europe/Berlin
    ufw              Status: inactive
    sshd passwords   yes
    docker           not installed
    deploy user      absent
    checkout         absent
    .env.prod        absent
    origin cert      absent
    backup cron      absent
```

Good looks like, on the bare box §1 describes: exactly that — the right-hand
column is read off the machine, not remembered, and every value in it is one a
later step fixes.

Then the seventeen steps run in order. A step that has work to do announces itself
with its own banner — `▸ §3.2a SSH — disabling password authentication` — and a
step that is already true of the machine prints the numbered form instead,
`▸ [3/16] §3.2a SSH password authentication OFF (lockout guard)` followed by
`ok   already satisfied — skipping (--force to run it anyway)`, and costs
nothing. The counter appears only on that skipped form and under `--dry-run`;
for the full picture use `--status`.

### Flags

| Flag                                          | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--status`                                    | Print the seventeen-row step table and exit. Read-only. It runs without root, as do `--self-test`, `--list-steps` and `--help`, and says so: the privileged answers (`ufw`, `sshd`, `passwd`) then read as pending. (The script's own root-gate message (the `die` in `main()` behind the `id -u` gate) offers you "two things you CAN do without root" and names only `--status` and `--self-test`; `--list-steps` and `--help` `exit 0` inside the argument parser at `:4803-4804`, before the gate is reached. Four, not two.) |
| `--dry-run`                                   | Print what each step would do; change nothing. Needs root, because most of what it inspects needs root.                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `--verify-only`                               | The §3.9 probes, the firewall status and the backup status. Nothing else, no questions — the one mode that is safe from a cron job or a checklist.                                                                                                                                                                                                                                                                                                                                                                                |
| `--from <step>`                               | Resume at a named step and run everything after it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `--only <step[,step…]>`                       | Run just these, satisfied or not.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `--skip <step[,step…]>`                       | Run everything except these.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `--force`                                     | Run steps even when they report themselves satisfied.                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `--list-steps`                                | Print the seventeen step ids and stop.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `--repo <git-url>`                            | The checkout source. Default `git@github.com:CyberSystema/libriant.git` (§3.6's).                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `--origin-crt <file>` / `--origin-key <file>` | Read the origin pair from files instead of pasting the two PEM blocks.                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `--replace-origin-cert`                       | Replace an **existing** origin pair. Backs the old one up first as `origin.crt.bak-<timestamp>` beside it.                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `--self-test`                                 | Run the internal tests and exit. Touches only a temp directory, needs no root and no network.                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `--help`                                      | The whole leading comment block, which is the source this section was written from.                                                                                                                                                                                                                                                                                                                                                                                                                                               |

A typo in `--from` / `--only` / `--skip` is refused by name — `unknown step
'orgin_cert'` — rather than matching nothing and printing a closing summary as
though the box had been provisioned.

### Resuming, which is the normal way to use it

Every step decides whether it is needed by inspecting the **machine**, not by
reading a marker of what a previous run believed. So re-running after a failure
is not a recovery procedure, it is the intended workflow.

```bash
sudo bash install-server.sh --status
```

```
Libriant install status   state: /var/lib/libriant-install

   1/17 [pending] briefing  What to have in front of you
   2/17 [pending] stock     §3.1   Take stock (host name, RAM, disk, the timezone)
   3/17 [pending] clock     The clock — NTP on, and SYNCHRONISED (admin TOTP)
   4/17 [pending] ssh       §3.2a  SSH password authentication OFF (lockout guard)
   5/17 [pending] ufw       §3.2b  ufw, with IPv6, allowing the real ssh port
   6/17 [pending] packages  §3.2d  Baseline packages, fail2ban, unattended-upgrades
   7/17 [pending] docker    §3.3   Docker from its own apt repository
   8/17 [pending] user      §3.4   The deploy user: docker, sudo, a password, keys
   9/17 [pending] dirs      §3.5   Directories on the data volume
  10/17 [pending] checkout  §3.6   Deploy key + checkout (pauses for GitHub)
  11/17 [pending] env       §3.7a  ensure-env.sh, interactively — never --auto
  12/17 [pending] cert      §3.7b  The Cloudflare origin certificate
  13/17 [pending] dchelper  §6.1   The dc helper in the deploy shell
  14/17 [pending] deploy    §3.8   The deploy (builds images — 10-20 min cold)
  15/17 [pending] backup    §8.2   The nightly backup — nothing else installs it
  16/17 [pending] firewall  authn-authz-01  Origin lockdown, v4 AND v6
  17/17 [pending] verify    §3.9   The checks the deploy script does not do
```

`done` is green, `pending` is dim, and `ran*` is yellow — the script's own
legend, _"ran before, but the machine no longer satisfies the check"_. Only two
steps write a marker at all (`briefing` and `backup`), so in practice `ran*` is
the `backup` row telling you the cron file has gone since you settled the
encryption and dead-man's-switch questions. That is the row to read twice.

Four steps — `stock`, `env`, `cert`, `verify` — have no machine-visible end
state and always report pending; they are cheap, and they re-check rather than
redo.

When a step fails, the exit trap names it and hands you the resume command:

```
  The run stopped inside step 'deploy' (exit 1). Nothing after it has run.
  Every step decides what it needs by inspecting the machine, so resuming is
  the normal way to use this:
      /root/install-server.sh --status
      /root/install-server.sh --from deploy
```

State, and the transcript of every decision the run made, live in
`/var/lib/libriant-install` (mode 0700, root) — `install.log` at 0600, and
verbatim copies of the sshd configuration as it was found under
`sshd-backups/`. Neither holds a secret; this script never prints one.

> **It refuses to start without a terminal.** `--dry-run` and `--verify-only`
> are exempt; everything else dies with _"no terminal"_. That is not fussiness:
> `ensure-env.sh`'s prompts are bare `read -rp` on stdin, so a run whose stdin
> is `/dev/null` would take the empty default for `IMAGE_OWNER`,
> `ADMIN_BOOTSTRAP_EMAIL` **and** `ADMIN_BOOTSTRAP_PASSWORD` without pausing —
> a fully green deploy nobody can log into, which is §3.7a's whole warning. The
> installer's own prompts read `/dev/tty` when stdin is a pipe, so
> `sudo bash install-server.sh </dev/null` from an interactive session is
> supported; a session with no controlling terminal at all is not.

### The three ways this script could ruin your day

#### 1. Locking you out

Three steps here can cost you the machine and each carries its own guard.

**`ssh` — §3.2a turns password authentication off.** If no account has a usable
`authorized_keys` that is a permanent lockout, so the step refuses to write the
drop-in until it has _counted_ a real public key for an account that can still
log in. It parses the file the way sshd does, which is not the same as
`[ -s authorized_keys ]`:

- a `@revoked` line, a `@cert-authority` line and a lapsed `expiry-time="…"`
  are all **non-empty and authenticate nobody** holding a bare key. CA lines are
  reported separately, never counted;
- `AuthorizedKeysFile` is resolved out of `sshd -T` with its `%h`/`%u` tokens
  expanded, because a guard that inspects a file sshd never opens is not a
  guard;
- `AllowUsers` / `AllowGroups` / `DenyUsers` / `DenyGroups` are honoured — a
  hardening image that ships `AllowGroups sudo` makes an otherwise perfect key
  worthless;
- the account you are **actually logged in as** is inspected, via `who am i` and
  `logname`, not just `root` and `$SUDO_USER`. Someone who ssh'd in as `ubuntu`
  and used `su -` leaves `SUDO_USER` unset;
- `StrictModes` permission bits are checked on the home directory, `.ssh` and
  the key file. sshd silently ignores a group- or world-writable one, and
  `ssh-keygen -lf` prints the key happily while authentication fails anyway.

It validates with `sshd -t`, then checks the **effective** configuration with
`sshd -T` — all three of §3.2a's values — while the running sshd is still the
old working one, and reloads only after that. If any check fails it restores
every file it edited, removes the drop-in it created, reloads, and dies. When
it did change something it then demands you type `VERIFIED` to confirm a second
session works.

**`ufw` — §3.2b enables a default-deny firewall.** It reads the ssh port from
the **listening socket** and never assumes 22: `ss -Hlntp`, then `ssh.socket`'s
`ListenStream`, then `sshd -T`, then `$SSH_CONNECTION`, unioned. On a
socket-activated box — Ubuntu's default since 22.10 — `sshd_config`'s `Port` is
ignored and `sshd -T` answers a different question from the one being asked. It
proves the allow rule is in the ruleset with `ufw show added` **before**
`ufw --force enable`, and if the firewall comes up with no `(v6)` rule on a box
with a global IPv6 address it turns ufw back **off** rather than leave you
reachable only over v4.

If nothing can tell it where sshd listens, it refuses outright rather than
guess.

**`firewall` — authn-authz-01 inserts a DROP at INPUT position 1.** The
`LIBRIANT-ORIGIN` chain is jumped into for tcp 80,443 and udp 443 only, and
ends `-j DROP` for everything outside Cloudflare's published ranges, loopback
and RFC1918. If
sshd is on 443 — a common way through a corporate egress filter — that is a
lockout that looks completely green, because your running session survives on
the chain's `RELATED,ESTABLISHED` RETURN. The step reads the listening ssh port
and **dies** rather than apply it, naming the port. When it can read the port
and it is neither 80 nor 443 it says so explicitly instead of asking you to
promise.

#### 2. Destroying an existing install

Assume this **will** be re-run on a box that is already half — or fully —
provisioned.

- **No secret is ever minted here.** `ensure-env.sh` owns that and never
  overwrites an existing value. A `POSTGRES_PASSWORD` keyed to a live cluster is
  unrecoverable.
- **An existing origin certificate is validated, never replaced**, unless
  `--replace-origin-cert`, which backs the old pair up first.
- **No data directory is ever removed**, and the recursive `chown` on
  `storage` only runs when the ownership is actually wrong.
- **An existing deploy key is never regenerated** — the public half is
  registered in GitHub and a new key silently breaks every future fetch.
- **The `git reset --hard` inside `deploy-on-host.sh` is announced before
  anyone confirms anything**, with the list of dirty tracked files _and_ the
  list of commits on this checkout that are not on `origin/main`. Untracked
  files are listed separately as surviving, so the confirmation is never asked
  for something that is not at risk.

> **The sharpest edge here is `POSTGRES_PASSWORD` after a provider Rebuild, and
> it will not look like a disaster while it is happening.**
>
> `ensure-env.sh`'s guard refuses to mint a fresh `POSTGRES_PASSWORD` when it
> finds `$LIBRIANT_DATA_ROOT/postgres/PG_VERSION` — it exits 3 with
> _"POSTGRES_PASSWORD is missing but an initialized Postgres cluster exists."_
> A Hetzner Rebuild wipes the boot disk, `/etc/fstab` with it, and leaves the
> data volume **intact but not mounted**. `/mnt/libriant` is then an empty
> directory on the root filesystem with 250 GiB of live library data sitting
> invisibly underneath it, and that guard is pointed at the empty directory. It
> does not fire.
>
> One `y` and: `dirs` creates `postgres/ redis/ storage/ backups/ env/` on the
> **boot disk**; `ensure-env.sh` mints a fresh password; the deploy initialises
> a **second, empty** cluster; the health gate goes green; §3.9 passes; and
> fourteen days of backups are scheduled onto the boot disk. Every library's
> data is still on the volume, unreachable, and the running app is keyed to a
> password that cannot open it. The moment anyone mounts the volume the entire
> install disappears behind the mount.
>
> So `stock`, `dirs` and `env` all call the same check, and it does not ask a
> vague question:
>
> - an **fstab entry for `$DATA_ROOT` that is not mounted** is a failed mount,
>   not a design choice — it dies and tells you to `mount /mnt/libriant`;
> - a **formatted block device mounted nowhere** is the same story with the
>   fstab lost — it names the device and warns;
> - otherwise a box genuinely without a data volume is a legitimate decision, so
>   you type `BOOTDISK`, not `y`, and the choice is written to the transcript.

> **And the second question, which that check used to skip entirely: is the
> volume mounted _for ever_?**
>
> `mountpoint -q` answers "right now". The fstab probe above used to live inside
> the **not-mounted** branch, so a volume mounted **by hand** — the obvious
> response to that `BOOTDISK` refusal, and what you do after a Rebuild to get
> the install moving — short-circuited to _"ok, a mounted filesystem"_ and was
> never looked at again. It has no `/etc/fstab` entry, so it is gone at the next
> reboot, and the reboot you do not schedule is the one during an incident.
>
> What that costs, precisely: `/mnt/libriant` is an empty directory on the root
> filesystem, the compose overlay binds `$DATA_ROOT/postgres`, `/redis`,
> `/storage` and `/caddy` **by path**, and a bind to a path that does not exist
> is a hard mount failure — so the whole cell refuses to start. That much is the
> "safe failure" `docker-compose.volume.yml` claims and it is survivable. The
> catastrophe is one command later, and it is the command that file's own header
> tells you to run: `mkdir -p ${LIBRIANT_DATA_ROOT}/{postgres,redis,storage,caddy}`.
> Do that on an unmounted box and you are back in the second-empty-cluster case
> above, this time with no Rebuild to blame.
>
> So the mounted branch now checks persistence too, and on a mounted-but-not-
> persistent volume it **offers the fstab line**, derived from the live mount so
> it cannot be wrong about what to mount:
>
> ```
> UUID=<from blkid>  /mnt/libriant  ext4  defaults,nofail,x-systemd.device-timeout=30  0  2
> ```
>
> `UUID=`, never `/dev/sdX`: a cloud volume's device name is not stable across
> reboots, which is the very event this line exists to survive. `nofail` is
> deliberate — **without** it a mount that fails at boot fails `local-fs.target`
> and drops the box into emergency mode with no sshd, which on a remote machine
> means the provider console; **with** it the box boots, SSH works, and the stack
> refuses to start. Loud, recoverable, remote. You type `FSTAB`, `/etc/fstab` is
> copied into `/var/lib/libriant-install/` first, the result is validated with
> `findmnt --verify`, and a rejection **restores the original and dies** rather
> than leave a line that could brick the next boot. An enabled systemd `.mount`
> unit counts as persistent too.
>
> That validation is **differential, not absolute**, and the difference matters:
> `findmnt --verify` reports on the _whole file_, so a pre-existing complaint
> elsewhere in `/etc/fstab` — a stale `/mnt/old` whose target directory is gone,
> a removed swapfile entry, an fstype this kernel does not have — used to be
> attributed to the line the installer had just written, restoring it and dying
> at **step 2 of 17** while telling you a correct line was the one thing that
> could cost you the box. A baseline is now taken _before_ the write with the
> same command; when it was already unhappy, the new line is **left in place**
> and you are told to fix the pre-existing entry and not reboot until you have.
>
> Two more things it checks that "is there a line?" does not. It compares the
> entry's **source** against the device actually mounted there, because the
> match is on the mountpoint alone and this script's own `BOOTDISK` refusal asks
> you to hand-write a UUID copied by eye — one wrong character produced a green
> _"it comes back after a reboot"_ from the very check written to catch it. And
> it refuses to compose a line at all for a source that is not a plain block
> device: `findmnt -no SOURCE` prints `/dev/sda2[/@sub]` for a btrfs subvolume
> and `host:/export` for NFS, and writing either literal into `/etc/fstab`
> produces a line that cannot mount.

#### 3. Leaving with a clock nobody is disciplining

Admin MFA is **mandatory** in production (`ADMIN_MFA_REQUIRED` defaults on
outside development, `apps/api/src/config/env.ts:420`) and cannot be turned off
from `.env.prod`. TOTP is a function of the wall clock:
`apps/api/src/support/mfa.service.ts:89` verifies with `epochTolerance: 30`, a
~90-second total acceptance window.

**Recovery codes do not rescue a skewed box, and the reason is worth reading
twice.** They are minted at exactly one moment —
`apps/api/src/support/mfa.controller.ts:227`, immediately after a TOTP code has
verified — and the shell escape hatch refuses to help before that:
`scripts/bootstrap-admin.ts:213` exits 1 with _"has no authenticator enrolled,
so a recovery code would never be accepted at sign-in"_. There is no path to a
recovery code that does not first pass a clock check. A box a minute off has an
admin panel **nobody can ever enter**, the symptom is _"invalid code"_ — which
reads as a bad QR or a bad phone — and it is discovered after the cutover.

Three cheaper failures arrive first and are all mis-attributed:

| Skew          | What you actually see                                                                                         |
| ------------- | ------------------------------------------------------------------------------------------------------------- |
| behind        | every apt source is _"Release file … is not valid yet"_ and `packages` dies on empty package lists            |
| off by months | TLS fails on `download.docker.com` and on the ghcr.io pulls, with errors that name the **repository**         |
| ahead         | `openssl x509 -checkend 0` in `cert` calls a perfectly good Cloudflare Origin certificate **already expired** |

The `clock` step therefore runs **third**, before `ssh` and before anything that
uses apt or TLS. It checks the one thing that needs no network at all — that
`date` does not read earlier than the mtime of a file this box itself wrote,
because a file cannot be written in the future — then reads `NTP` and
`NTPSynchronized` off `timedatectl show`. `NTPSynchronized` is the kernel's own
bit, so it answers for chrony, ntpd and systemd-timesyncd alike and the step
does not care which is installed; it installs `systemd-timesyncd` only when
`CanNTP=no` says the box has none at all, and never puts a second NTP client
beside a working one.

A fresh box that has not converged yet is **waited for**, up to 90 seconds,
rather than refused. If it still will not synchronise you get the fix, the
chicken-and-egg escape for when the clock has already broken apt
(`timedatectl set-ntp false` → `set-time` → `set-ntp true`), and a typed `SKEW`
acknowledgement — because there is a legitimate box behind that prompt: one
whose egress blocks udp/123 and whose clock was set by hand and is correct.

> **What watches this after the install.** `node-exporter`'s `timex` collector
> scrapes `node_timex_sync_status` on this box, and `infra/monitoring/alerts.yml`
> now carries **`HostClockNotSynchronised`** — `node_timex_sync_status == 0` for
> `15m`, severity `critical` — which is what catches drift after today. Like
> every other rule here it is evaluated by Prometheus immediately and **delivers
> nothing** until Alertmanager has real receivers instead of `[PLACEHOLDER]`s
> (§7.3). Until then it is visible in the Prometheus Alerts view and wakes
> nobody.

### What each step does, and what it will ask you

| Step       | Runbook        | What it does, and what it asks                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ---------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `briefing` | —              | Prints the eight things above and the three guards. Warns if you are not in tmux/screen. **Asks:** type `READY`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `stock`    | §3.1           | `uptime`, `free`, `df`, `lsblk`, `/proc/mdstat`, `ufw status`, `sshd -T`. Refuses to continue past a **degraded RAID array** without a confirmation. Asserts the data root is a filesystem **and that it survives a reboot** (the fstab offer above). Warns when the filesystem holding `/var/lib/docker` has under **25 GiB** free — measured there rather than on `/`, because an operator who moves the image store makes the old check answer a question nobody asked — because the cold build wants ~15–20 GiB, a figure this document marks **UNVERIFIED** on this box, and the script repeats the caveat rather than presenting it as fact. Reads `MemTotal` and `SwapTotal` out of `/proc/meminfo` (never `free`, whose columns are localised) and warns under **6 GiB of RAM + swap**, naming `deploy-on-host.sh`'s own remedy for an exit 137: `dc build web` then `dc build api`. On a box with **no swap at all** it also notes that the `HostSwapping` alert is guarded by `node_memory_SwapTotal_bytes > 0` and can therefore never fire. **Asks:** the §1 timezone decision, once, before the first deploy — validated against `timedatectl list-timezones`, and if a backup cron already exists you type `MOVE`, because changing the zone moves the 02:15 window. **Asks:** whether to set the **host name** — offered, never imposed. Nothing on this stack reads it, but `backup.sh:415` writes `host=$(hostname)` into every backup manifest and the GitHub Deploy Key carries it in its comment, and both are read during an incident. If you change it, `/etc/hosts` gets the matching `127.0.1.1` line in the same breath — without it every later `sudo` prints _"unable to resolve host"_, which nobody will connect to this script.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `clock`    | —              | Proves network time is on **and that the kernel calls the clock synchronised** — `NTP=yes` and `NTPSynchronized=yes` off `timedatectl show`, parsed with an anchored reader because **`CanNTP=yes` contains the substring `NTP=`** — so `grep NTP=` and `case *NTP=*` both return `CanNTP`'s value, and `timedatectl show` prints `CanNTP` **before** `NTP`, so the wrong one is hit first every time. (An earlier version of this row claimed the collision was with `NTPSynchronized=`; it is not — that key has an `S` where the `=` would be — and the self-test built around the wrong claim could not fail. There is now a fixture in systemd's own print order that does.) Also checks the one thing that needs no network: that `date` does not read **earlier** than the mtime of a file this box wrote — `/var/lib/dpkg/status` and `/etc/machine-id` only, and **not** the installer file itself, which is by definition a file that was _copied onto_ the box with a foreign mtime that `scp -p` and `rsync -a` preserve; including it made a perfectly synchronised box demand the `SKEW` acknowledgement. Below 300 seconds behind, that check warns rather than refusing. Installs `systemd-timesyncd` only when `CanNTP=no`, never a second client beside a working one. Waits up to **90 seconds** for a freshly-booted box to converge rather than refusing it. **Asks:** on an unsynchronised clock, type `SKEW` after confirming the printed time against a phone — see §"Leaving with a clock nobody is disciplining" above for why this is not a checklist item.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `ssh`      | §3.2a          | The lockout guard above, then the `00-libriant.conf` drop-in. Comments out every competing `PasswordAuthentication` **and** `KbdInteractiveAuthentication` it finds in `/etc/ssh/sshd_config` and `sshd_config.d/*.conf`, keeping the originals under `/var/lib/libriant-install/sshd-backups/`. **Asks:** type `VERIFIED` that a second session works — but only when it actually changed something.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `ufw`      | §3.2b          | Installs `ufw` and `iproute2` first if missing, because it runs _before_ the packages step and needs `ss` to read the real port. Sets `IPV6=yes` in `/etc/default/ufw`, default deny in / allow out, allows every ssh port it found, proves the rule, enables. Ends with the §3.2c banner: **ufw does not filter 80/443 once Docker is up**, and prints the two `nmap` commands with this box's own addresses.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `packages` | §3.2d          | Installs `ca-certificates curl git openssl fail2ban unattended-upgrades ufw cron iproute2 iptables` (`BASE_PACKAGES` in `install-server.sh`) — the same ten §3.2d lists, four of which that section used to omit. `iptables` because `prod-bootstrap.sh` exits **FATAL** without `ip6tables`; `iproute2` because `--firewall-status` needs `ss` to prove there is no `[::]` listener; `cron` because `/etc/cron.d/libriant-backup` is an inert text file without a cron daemon. Writes `/etc/apt/apt.conf.d/20auto-upgrades` (`is-active` can be green while nothing is scheduled), and adds a `fail2ban` `ignoreip` for the address **this session came from**, so a long provisioning session cannot ban you.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `docker`   | §3.3           | Probes `https://download.docker.com/linux/ubuntu/dists/$VERSION_CODENAME/Release` and, on a 404, **asks which codename to pin to** rather than silently falling back — then re-probes that answer and records the decision in the transcript. Re-asserts `chmod a+r` on the keyring outside the already-present branch, because apt verifies as `_apt` and a 600 keyring fails the next update with an error naming the _repository_. Dies unless `docker compose` reports major version ≥ 2. Writes `/etc/docker/daemon.json` **before** installing `docker-ce`, so the daemon reads it on its first start and no restart is ever needed on a first install: `ip6tables: true` plus a `log-opts` default of `50m × 5`. The `ip6tables` line is the point — `firewall` dies on _"ip6tables has no jump from DOCKER-USER"_ and its own message punts you to _"a docker daemon.json question"_, a file this installer never used to write. Docker Engine has defaulted it to true since v28, so on a current `docker-ce` the honest answer to _what breaks without it_ is **probably nothing**; what it buys is determinism and the removal of a documented failure branch. The `log-opts` line is **not** about log rotation on this stack — `docker-compose.prod.yml:140`'s `*logging` anchor already caps all nine services at `50m × 5` and the monitoring overlay caps its five at `20m × 5`, a ~2.65 GB ceiling against an 80 GiB root; it bounds a service added later without the anchor, and any ad-hoc `docker run` left detached. It **never sets `ipv6`** — a different setting, and one of four changes that must be made together (`docker-compose.prod.yml:817`). If the file already exists it is **reported, never edited**: there is no `jq` in `BASE_PACKAGES` and a half-merged `daemon.json` stops dockerd from starting at all. You get a per-key report and the exact JSON to merge, plus — if dockerd is already running — `systemctl restart docker` **followed by** `install-server.sh --only firewall`, which is not optional: dockerd rebuilds `DOCKER-USER` on start and `libriant-origin-firewall.service` is `Type=oneshot RemainAfterExit=yes` with no `PartOf=docker.service`. An already-working Docker skips the apt work entirely, so a re-run cannot stop to ask which codename to pin on a box that already has Docker. |
| `user`     | §3.4           | Creates `deploy`, adds it to `docker` **and** `sudo`, copies in `authorized_keys` only when `deploy` has none of its own. **Asks:** a password, twice, at least 12 characters and no single quote — then proves it with `sudo -v` **as `deploy`, through a pipe**, which is the one check §3.4's two proxies do not perform. A failed `sudo -v` is a warning, not a die: everything the installer runs is root, so it does not block the install — it blocks a third of this runbook, later. Proves `docker ps` works as `deploy` through the same fresh-process path every later step uses.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `dirs`     | §3.5           | Creates `/srv/libriant`, `/var/log/libriant`, and the six directories the deploy and the backup need — `postgres`, `redis`, `storage`, `caddy` (as `caddy/origin`, so the parent exists either way), `backups`, and `env` at mode 700 owned by `deploy`. Its closing assertion checks the six parents, `postgres redis storage caddy backups env` (the closing loop of `step_dirs()`), and prints `all six data directories exist; storage is uid 1000; env is 700 deploy`. `chown -R 1000:1000` on `storage`, and only when the ownership is actually wrong, because a recursive chown over a populated uploads tree is minutes of pointless IO. Also `chown -R 0:0` + `775` on `caddy`, `755` on `caddy/origin` (the recursive chown reaches it, the group-writable `chmod` deliberately does not — and without the `755` neither the container nor `deploy`'s own preflight `stat` could traverse it), and `g+rwX` on the `caddy_config` / `caddy_logs` volumes if they already exist — the edge runs as uid 1000 in group 0 and writes all three (§3.7c). Also creates **`/var/lib/node_exporter/textfile`**, which §3.5 does not list: it must exist and be owned by `deploy` _before_ the deploy, or the monitoring compose file's bind mount makes Docker create it as root and the nightly backup then cannot write its metric.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `checkout` | §3.6           | Generates an ed25519 deploy key (never regenerating an existing one), upserts a marked `github.com` block in `~/.ssh/config`, and seeds `known_hosts` by showing you the fingerprints it just fetched and asking whether they match GitHub's published list — a mismatch stops the run. **Asks:** it prints the public key and **pauses** while you add it to GitHub as read-only. It proves access with `git ls-remote --exit-code`, never with `ssh -T`, and retries up to five times.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `env`      | §3.7a          | Re-asserts the data-root check, then runs `ensure-env.sh` **interactively, never `--auto`**, from the real terminal. Afterwards it asserts `600 deploy:deploy`, that the on-volume copy at `/mnt/libriant/env/.env.prod` exists, that `MFA_MASTER_KEY` is exactly 64 hex characters, that `STORAGE_SIGNING_SECRET` differs from `SESSION_SECRET`, and warns on duplicate keys. Makes you acknowledge it if `ADMIN_BOOTSTRAP_*` came out empty, then **pauses** so you copy the file into the password manager.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `cert`     | §3.7b          | Reads `SITE_HOST` and `PUBLIC_APEX_DOMAIN` out of `.env.prod` so it knows which names the certificate must cover. Collects the two PEM blocks from the terminal (discarding anything before `-----BEGIN`, stripping CR from a Windows paste) or from `--origin-crt`/`--origin-key`. Validates **before** installing: both PEMs balanced, both parse, and the certificate and key are a **matching pair**. Installs both `640 root:root`, re-checks the pair on the _installed_ files, then verifies issuer, SANs and expiry — dying on an already-expired certificate and warning at under 30 days. On a re-run over an existing pair it does not replace it, but it does **converge the ownership** (`0:0`, mode 640) — which is how a box installed before supply-chain-07 is prepared for the non-root edge (§3.7c).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `dchelper` | §6.1           | Upserts §6.1's block into `deploy`'s `.bashrc` as a marked region, with two additions: if `git` cannot answer, it reads `IMAGE_TAG` off the running `libriant-api-1` container, and if both sources come up empty it warns at login instead of exporting an empty tag.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `deploy`   | §3.8           | Announces what `git reset --hard` would destroy, offers `--no-fetch` instead, runs `deploy-on-host.sh --dry-run`, then — after a confirmation — the real deploy. **Never `--skip-build`.** **Re-asserts the disk headroom check** rather than trusting the one `stock` printed fifteen steps ago — everything since has eaten into it, and `--only deploy` / `--from deploy`, which is the resume you take after a build that failed, skipped it entirely. Brackets the build with `df` and records the **cold build's actual footprint** in the transcript, with `docker system df` beside it. That closes a registered unknown: §3.8's ~15–20 GiB was measured on the dead box. The delta can legitimately be **negative** — `deploy-on-host.sh` prunes before it builds. The 25 GiB threshold is deliberately **not** changed on the strength of one measurement.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `backup`   | §8.2           | **Asks nothing you have not already been asked** — the encryption decision (age recipient / gpg passphrase file / typed `PLAINTEXT`), a `BACKUP_HEARTBEAT_URL`, and whether an absent off-site copy is a deliberate `BACKUP_ALLOW_LOCAL_ONLY=1` are all asked at the **`env`** step, because they are `.env.prod` keys and because this step runs _after_ the 10–20 minute build that the briefing tells you to walk away from. They are re-offered here (`--only backup` is a supported entry point) and every already-answered one prints a single `ok` line. Asking them here also meant the copy of `.env.prod` you took at the `env` step's password-manager pause was **stale**, because this step then appended `BACKUP_AGE_RECIPIENT` to it. The one prompt that remains after the build is _"run the backup once now"_, which needs the stack up. **Asks:** Writes `/etc/cron.d/libriant-backup`, runs `backup.sh --preflight`, then the real backup, then `--check-cron`. Refuses an `age` **identity** pasted where the **recipient** belongs. Then **multiplies retention out** instead of quoting it: `du` on the day it just wrote × `BACKUP_KEEP_DAYS + 1` (the prune runs at the _start_ of a run, so the day being written coexists with the retained ones) against `df` on `$DATA_ROOT` — the same filesystem as the live cluster, the live uploads and Redis. It warns at **70 %**, not 100 %, because both of those grow underneath it. Day one always says _fits_, which is correct and worth having in the transcript as the baseline. It is a warning, never a gate, and it never edits `BACKUP_KEEP_DAYS`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `firewall` | authn-authz-01 | `prod-bootstrap.sh --firewall-only`, then `--firewall-install-unit`, then **starts the unit** to prove it works — a unit that is enabled but fails on boot is indistinguishable from a working one until the next reboot, which will be during an incident. Then it parses `--firewall-status` itself and treats a missing `ip6tables` chain, a missing jump from either `INPUT` or `DOCKER-USER` on either family, and a `[::]` listener as **FATAL**.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `verify`   | §3.9           | Opens with a **boot-time state table** — `docker`, `cron`, `fail2ban`, `libriant-origin-firewall`, `ufw`, the clock and the data root's fstab entry, all read-only — because **seven** separate things on this box are boot-time state, installed by six different steps, and until now not one of them was exercised as a **set**. Every FAIL in that table now **adds** to the exit status; it used to be overwritten by the §3.9 result one line later, so a box that failed all seven still printed _"verification clean"_ and exited 0. That is what makes `--verify-only` the post-reboot check the closing summary asks you to run. Then every probe in §3.9, run as `deploy` with §6.1's preamble, plus two §6.1 assertions that can only mean something once an image exists: that `IMAGE_TAG` is not `latest`/empty/`-dirty`, and that a **local** `libriant-api:$IMAGE_TAG` image is there. **Read the message, not `$?`.** The embedded §3.9 script exits with the number of failed checks (its closing `exit "$fails"`), but the step captures that and collapses it: a 90 — §6.1's own refusal, meaning `IMAGE_TAG` could not be determined at all because `git` said nothing in `/srv/libriant/app` and no `libriant-api-1` container is running — is rewritten to 1 and reported as _"§3.9 could not run: IMAGE_TAG could not be determined"_, and every other non-zero is **added** to `VERIFY_RC` and reported as _"§3.9: N check(s) failed"_ while still exiting 1. `install-server.sh` itself only ever exits **0 or 1** (the `VERIFY_RC` gate in `main()`, for both `--verify-only` and a full run). Do not script against a count; there is none. For a 90, deploy first, then `--verify-only`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

> **`backup` runs before `firewall`, and that is deliberate.** The firewall step
> dies on any FATAL finding, and one of those — _"ip6tables has no jump from
> DOCKER-USER"_ — is produced by Docker whenever its daemon has ip6tables off.
> That is an entirely plausible box state, it has nothing to do with backups,
> and in the other order it meant the one thing this installer exists to add —
> the nightly backup nothing else installs and nothing warns is missing — was
> never reached. An operator who could not resolve an ip6tables question walked
> away from a production box with zero backups, which looks exactly like a box
> that has them.
>
> If you hit that wall, the backup is already installed and only the read-only
> verification is left:
>
> ```bash
> sudo bash install-server.sh --verify-only
> sudo bash install-server.sh --from firewall --skip firewall
> ```

### What the installer does not do, and you still must

- **The external scan, from a machine that is not this one, over both address
  families.** On-box output proves nothing about the internet, and this is the
  only check that cannot be fooled. The script prints the commands with the
  addresses it read off the box, and prints a literal
  `[PLACEHOLDER: this box's public IPv4 — read it with: ip -4 addr]` rather than
  a made-up address when it cannot tell:

  ```bash
  # from your laptop, NOT from the box
  nmap -Pn -p 22,80,443,5432,6379,3300,9090 195.201.13.95
  nmap -6 -Pn -p 22,80,443 2a01:4f8:13b:ac8::2
  ```

  Expect ssh, 80 and 443 and nothing else; 80/443 **filtered** from a
  non-Cloudflare address once the `firewall` step has run. 5432 and 6379 must
  never appear — the `data` network is `internal: true`. 3300 (Grafana) and 9090
  (Prometheus) must never appear either: they are published on `127.0.0.1` only,
  and the post-deploy scan is the one moment that bind can be proved to have
  held.

- **Rehearse the reboot, now, while it is free — but not before the data volume
  is in `/etc/fstab`.** Seven things on this box are boot-time state, installed
  by six different steps, and the only test that covers all seven at once is a
  reboot. The closing summary **withholds** this instruction, and prints _"do not
  reboot this box yet"_ in its place, on a box where `$DATA_ROOT` is mounted with
  no fstab entry and no enabled `.mount` unit: there, a reboot is the first move
  in the chain that ends with a second, empty Postgres cluster on the boot disk. The box is not in DNS yet, so today that
  costs two minutes and nobody notices; the first **unplanned** reboot will be
  during an incident, and that is a poor moment to discover that the data volume
  did not remount or that the origin lockdown unit fails on this kernel. The
  `firewall` step already makes this argument about its own unit — _"a unit that
  is enabled but fails on boot is indistinguishable from a working one until the
  next reboot"_ — and the argument generalises from that unit to the box.

  ```bash
  sudo reboot
  # then, when it is back:
  findmnt /mnt/libriant   # must name the DEVICE, not the root filesystem
  timedatectl             # NTP: yes, System clock synchronized: yes
  systemctl is-active docker cron fail2ban libriant-origin-firewall
  ufw status verbose
  sudo bash install-server.sh --verify-only
  # and the external scan again, from your laptop, over both families
  ```

  `--verify-only` already **is** the post-reboot check — it re-runs §3.9, the
  firewall parser, the backup status and the boot-state table. It simply was
  never named as one. The installer does **not** reboot for you: it can be
  re-run against a live box, and a prompt that can be answered `y` by reflex on
  a live box is worse than a paragraph.

- **Copy `/srv/libriant/.env.prod` and both origin PEM blocks into the password
  manager.** They are in no backup. `MFA_MASTER_KEY`, `POSTGRES_PASSWORD` and
  the origin pair are irrecoverable if lost (§4.4). The script pauses and tells
  you to; it cannot do it.

- **Put the origin certificate's `notAfter` in your calendar.** Nothing monitors
  it. An expired origin certificate is a fully green deploy and a Cloudflare
  **526** on every host.

- **DNS and the cutover (§5.4).** It does not put the box in DNS, deliberately —
  which is why the deploy prints _"nothing is public"_ rather than _"you are
  live"_.

- **Alerting.** The deploy starts Prometheus and evaluates every rule, but
  Alertmanager sits behind a compose profile that only switches on once
  `infra/monitoring/alertmanager.yml` has real receivers instead of
  `[PLACEHOLDER]`s. Until then nothing wakes anybody up — including the backup
  dead-man's switch and the disk-full alerts. §7.3.

- **Mail.** `EMAIL_DRIVER=console`; nothing is delivered and nothing in the
  installer depends on delivery. Account recovery is done by an owner admin from
  `/admin/account-recovery` (§4.3a).

- **The quarterly restore drill (§8.5), which has never been done**, and MFA
  enrolment, which needs a browser (§3.9).

The script prints this same list when it finishes, and it re-reads the
outstanding promises **off the machine** rather than remembering what you
answered on some earlier run. Six of them get their own banner: no
`/etc/cron.d/libriant-backup` at all; `BACKUP_ALLOW_LOCAL_ONLY=1` with no
`RCLONE_REMOTE`, so the nightly no longer complains while every backup on this
box still dies with this box; `BACKUP_ALLOW_PLAINTEXT=1`, which makes the Art. 28
DPA a municipality signs untrue; an origin lockdown that is applied but not
installed as a boot unit; a **data volume with no `/etc/fstab` entry**, which is
gone at the next reboot; and a **clock the kernel does not call synchronised**,
which is an admin panel nobody can enter.

---

### The manual path — §3.0 to §3.10

Everything below is §3 done by hand. It is the reference for what the installer
did, for the step it stopped on, and for the operator who would rather type it.
The mapping from step id to section is in the table above.

### 3.0 The pnpm toolchain in the images — historical, and why it is fine now

This section used to open "It does not currently succeed. Read this first." and
describe `BLOCKER supply-chain-06`: the Dockerfiles prepared pnpm 9.15.4 while
`package.json` declared 11.22.0, so corepack tried to fetch the declared version
at container start, on the `data` network — which is `internal: true`, no egress
— and the one-shot `migrate` exited 1. `api` and `worker` gate on migrate, so
the whole stack never started, and the visible error was a Prisma P3009 that
pointed nowhere near the cause.

**None of that can happen any more, and neither can anything else in its class.**
Two changes, in order:

1. The pins were corrected to 11.22.0 everywhere, and `scripts/check-pnpm-pins.mjs`
   now asserts on every push that all three Dockerfiles agree with
   `package.json`'s `packageManager`.
2. Corepack itself is gone. `corepack enable` exits 127 in
   `node:26-alpine@sha256:aadf416b` — the binary is not in the image, and the
   digest pin means it will not reappear. All three Dockerfiles now
   `npm install -g pnpm@11.22.0` at build time instead.

The second is what closes the class rather than the instance. Corepack RESOLVED
the package manager lazily, at run time, which is precisely why a wrong pin
became a runtime outage rather than a build failure — and why `COREPACK_HOME`
had to be warmed and made world-readable so the non-root `node` user would not
re-fetch pnpm from npmjs.org on every container start. A global install lands
the binary in `/usr/local/bin`, readable and executable by every user, resolved
at build time. Nothing reaches for the network after the image is built, so
neither the missing-cache failure nor the no-egress failure has anywhere to
occur.

`check:pnpm-pins` guards all three properties: the version matches, the install
is a real instruction rather than a line of prose (it was briefly satisfied by a
comment quoting the old command), and nothing has reintroduced corepack.

Verify against a built image:

```bash
docker build -f apps/api/Dockerfile -t lbr-api-probe . \
  && docker run --rm --user node --network none -w /app lbr-api-probe pnpm --version
```

`--network none` is the point: it proves pnpm resolves with no egress at all,
which is the condition the `migrate` one-shot actually runs under.

### 3.1 Get on the box and take stock

**Installer step:** `stock` — `sudo bash install-server.sh --only stock`.

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

Two things in that output are checks and not just scenery, and both are easy to
scroll past:

- **`df` is measured on the filesystem that holds `/var/lib/docker`**, not on
  `/`. They are the same today; they are not the same on a box where someone
  moved the image store. Under 25 GiB and the cold build is a coin toss.
- **`free` is not the check** — `/proc/meminfo` is, because `free`'s columns are
  localised and have been renumbered between releases. Under ~6 GiB of RAM plus
  swap a cold `next build` is OOM-killed and all you get is `exit 137`. The
  remedy is in `deploy-on-host.sh:273` and it is to build one service at a time:
  `dc build web`, then `dc build api`.

And `df -h /mnt/libriant` answering is **not** proof the volume is persistent —
see 3.1a.

### 3.1a The clock, which is an authentication input here

**Installer step:** `clock` — `sudo bash install-server.sh --only clock`.

```bash
timedatectl
timedatectl timesync-status     # Offset: should be milliseconds
```

Good looks like `NTP service: active` **and** `System clock synchronized: yes`.
The second is the kernel's own bit (`NTPSynchronized` in `timedatectl show`), so
it answers identically for chrony, ntpd and systemd-timesyncd — you do not need
to care which is installed, and you should not install a second one beside a
working one.

If it is not synchronised:

```bash
timedatectl set-ntp true
```

If apt is **already** broken by the clock — every source reporting
_"Release file … is not valid yet"_ — that is the chicken and egg. Set the time
by hand first, then turn NTP back on:

```bash
timedatectl set-ntp false
timedatectl set-time '[PLACEHOLDER: YYYY-MM-DD HH:MM:SS, from a phone]'
timedatectl set-ntp true
# and only if apt still refuses, once:
apt-get -o Acquire::Check-Valid-Until=false update
```

Why this is its own section rather than a line in 3.1: **admin MFA is mandatory
and TOTP is a function of this clock.** The window is ~90 seconds, and a
recovery code can only be minted after a TOTP code has already verified —
`bootstrap-admin.ts` refuses to issue one for an admin with no authenticator
enrolled. A box a minute off has an admin panel nobody can ever enter, and the
symptom is _"invalid code"_. See §"Leaving with a clock nobody is disciplining"
above for the full chain and for the three cheaper failures that arrive first.

### 3.1b Is the data volume mounted, or mounted for ever?

```bash
findmnt /mnt/libriant                       # mounted right now?
findmnt --fstab /mnt/libriant               # and after a reboot?
```

Both must answer. The second is the one nobody checks. A volume mounted by hand
passes every other check in this document and is an empty directory on the root
filesystem after the next reboot; the whole cell then refuses to start, and one
`mkdir -p` later you have a second, empty Postgres cluster on the boot disk. If
the second command is silent:

```bash
blkid -s UUID -o value "$(findmnt -no SOURCE /mnt/libriant)"
# then add to /etc/fstab, and validate it BEFORE rebooting:
# UUID=<that>  /mnt/libriant  ext4  defaults,nofail,x-systemd.device-timeout=30  0  2
findmnt --verify
```

`nofail` deliberately: without it a failed mount drops the box to emergency mode
with no sshd, which on a remote machine means the provider console.

### 3.2 Harden — do this before anything is worth stealing

**Installer steps:** `ssh` (3.2a), `ufw` (3.2b), `packages` (3.2d). 3.2c is a
banner the `ufw` step prints and a scan only you can run.

**3.2a SSH: turn off password authentication.** Find where it is set first;
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

**3.2b ufw: turn it on, with IPv6.** The box has public IPv6; a v4-only ruleset
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

**3.2c Understand what ufw does not protect.** Once Docker is installed and the
stack is up, the caddy container publishes 80/443 through the `DOCKER-USER`
chain, **ahead of ufw's INPUT chain**. `ufw deny 80` will not close port 80.
The only check that cannot be fooled is an external scan from your laptop:

```bash
# from your laptop, NOT from the box
nmap -Pn -p 22,80,443,5432,6379,3300,9090 195.201.13.95
nmap -6 -Pn -p 22,80,443 2a01:4f8:13b:ac8::2
```

Good looks like, today: only 22 open. After the first deploy and **before** the
origin lockdown below: 22, 80, 443 open, and **nothing else** — in particular
5432 and 6379 must never appear (the `data` network is `internal: true`, so they
cannot be published even by accident), and neither must 3300 (Grafana) or 9090
(Prometheus), which are published on `127.0.0.1` only.

> **`authn-authz-01` — the origin lockdown, and the four layers it needs.**
> Every rate limit, the `/apply` throttle and the brute-force login lockout are
> keyed on `X-Real-IP`, which Caddy sets from `CF-Connecting-IP`. Anyone who can
> reach the origin IP directly and forge that header reshapes all of them. There
> are four layers against that, and **all four have to hold**:
>
> 1. **The firewall.** `prod-bootstrap.sh --firewall-only` builds a
>    `LIBRIANT-ORIGIN` chain jumped into from **both `INPUT` and `DOCKER-USER`**
>    — not in ufw, which Docker bypasses — through **both `iptables` and
>    `ip6tables`. A missing `ip6tables` is fatal, not a warning**, because this
>    box has a public IPv6 address. The chain RETURNs for Cloudflare's published
>    ranges, loopback and RFC1918, and ends `-j DROP`. Do **not** add
>    `--allow-ipv6`: see the four-part change in §5.4 that has to happen first.
> 2. **The published ports.** `docker-compose.prod.yml` publishes on
>    `${EDGE_BIND_IPV4:-0.0.0.0}`, not the bare `443:443`. This is the layer that
>    is easiest to lose and the least obvious: the wildcard form also opens a
>    `[::]` listener, and because no compose network sets `enable_ipv6`, Docker
>    carries those v6 connections through the **userland proxy**, which
>    re-originates every one of them from the bridge gateway. The edge then sees
>    a private address, trusts it, and the header forgery works again over IPv6
>    while looking perfectly locked down over IPv4. This is not hypothetical — it
>    is how the first fix for this finding was defeated. It is also why the
>    origin has **no AAAA records** (§5.4).
> 3. **The edge.** Every backend route in the Caddyfile imports `origin_guard`,
>    which matches on `remote_ip` (the connection) rather than on a header. One
>    route — `/webhooks/*` — shipped without it. `pnpm check:caddy` now fails the
>    build if any `reverse_proxy` to `api:` or `web:` lacks a guard.
> 4. **The API itself.** `apps/api/src/platform/client-ip.ts` honours
>    `X-Real-IP` only when the immediate TCP peer is a trusted proxy; an
>    untrusted peer **is** the client and its headers are ignored (`clientIp()`).
>    `main.ts` hands Express the **same** predicate instead of
>    `trust proxy: true` — the blanket form made `req.ip` client-controlled,
>    which is how the second spoof vector in `authn-authz-01` worked. It also
>    does **not** fall back to `req.ip` when `X-Real-IP` is absent, because
>    `req.ip` is derived from `X-Forwarded-For`, i.e. from exactly the
>    client-authored surface the function exists to distrust. Alone, this
>    guarantees that a direct hit on `api:3001` — a misconfiguration, a container
>    joined to the app network — cannot pick its own rate-limit bucket.
>
>    **`TRUSTED_PROXY_CIDRS` — nothing needs to be set for the standard
>    deploy.** The default trust set is loopback plus every private and
>    link-local range (`127.0.0.0/8`, `::1/128`, `10.0.0.0/8`, `172.16.0.0/12`,
>    `192.168.0.0/16`, `169.254.0.0/16`, `fe80::/10`, `fc00::/7`), which is
>    exactly the compose topology: the API is never published to a host port, so
>    its only possible peer is the Caddy container. Set the variable only to
>    narrow it — a comma-separated list of CIDRs or bare addresses. A malformed
>    value **throws at boot**, not on the first request, with
>    `TRUSTED_PROXY_CIDRS contains "…", which is not an IP address or CIDR.`
>    It is one of the never-injected variables (§4.1), so narrowing it is a
>    compose edit and a commit. The set in force is on the API's first log line,
>    so you never have to guess:
>
>    ```bash
>    dc logs api | grep 'trusted proxies'
>    ```
>
>    Good looks like:
>    `[libriant-api] listening on :3001 (production) — trusted proxies: 127.0.0.0/8,::1/128,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,169.254.0.0/16,fe80::/10,fc00::/7`
>
>    What this layer does **not** guarantee, stated so nobody mistakes it for
>    more: from inside the API, Caddy is Caddy no matter what Caddy believed.
>    Layers 1–3 are what make the header worth honouring in the first place.
>
> **Verify, do not assume** (the scan above is the outside view; this is the
> inside one):
>
> ```bash
> sudo bash scripts/prod-bootstrap.sh --firewall-status
> # must print a LIBRIANT-ORIGIN chain with jumps from BOTH INPUT and DOCKER-USER,
> # for both address families, and: "ok: no [::] listener"
> ```
>
> If that last line instead warns about a `[::]` listener, layer 2 has reverted
> and layers 1, 3 and 4 do not cover the gap on their own. Fix the compose
> publish form before anything else.

**The lockdown does not survive a reboot on its own.** `iptables` rules are
kernel state; nothing reinstates them. There is a unit for it, and installing it
is a separate mode of the same script:

```bash
# root, on the host. The installer's `firewall` step does both, then STARTS the
# unit to prove it works.
sudo sh /srv/libriant/app/scripts/prod-bootstrap.sh --firewall-only
sudo sh /srv/libriant/app/scripts/prod-bootstrap.sh --firewall-install-unit
```

Good looks like:
`[bootstrap] installed + enabled libriant-origin-firewall.service (runs /srv/libriant/app/scripts/prod-bootstrap.sh --firewall-only after docker.service).`

Two things about it that will bite:

- **The unit does not pass `--allow-ipv6`.** The script says so itself. If you
  ever admit the Cloudflare v6 ranges by hand, a reboot silently reverts to the
  default DROP.
- **The chain hooks into `DOCKER-USER`, which does not exist until dockerd has
  created it**, which is why this is a systemd unit ordered `After=docker.service`
  rather than an `rc.local` line. A unit that is _enabled_ but fails on boot is
  indistinguishable from a working one until the next reboot, which will be
  during an incident — so start it now and check it:
  `sudo systemctl start libriant-origin-firewall && systemctl is-active libriant-origin-firewall`
  → `active`.

All three `prod-bootstrap.sh` firewall modes are hand-run rather than part of the
deploy, deliberately: a DROP rule built from a range list that has drifted takes
the whole site down. **UNVERIFIED — none of them has ever run on a live box.**
Run them with a second SSH session already open.

**After the lockdown, the external scan means something different.** Re-scan from
off the box; the change _is_ the proof:

```bash
# from your laptop, NOT from the box
nmap -Pn    -p 22,80,443 195.201.13.95
nmap -6 -Pn -p 22,80,443 2a01:4f8:13b:ac8::2
```

Good looks like: 22 open; **80 and 443 filtered on both families**. Port 22 is
in the scan on purpose — it is the control: it proves the box is still reachable
and that `filtered` on 80/443 is the DROP rule doing its job rather than the
whole host having gone away. If they still
read `open`, the chain is not hooked in — check with `--firewall-status`. A scan
that says `open` while `--firewall-status` says the chain exists means the jump
landed in only one parent; the script inserts into both, so a partial state means
an interrupted run.

> **If legitimate traffic starts getting 403s at the edge, or Cloudflare starts
> getting 522s, check <https://www.cloudflare.com/ips> before anything else.**
> The list changes rarely and it does change. It appears **three** times in this
> repository and all three must be updated together:
>
> | Where                                           | What it is                                       |
> | ----------------------------------------------- | ------------------------------------------------ |
> | `infra/caddy/Caddyfile` — `@untrusted_peer_…`   | the 403 matcher                                  |
> | `infra/caddy/Caddyfile` — `@cf_peer_…`          | who may name someone else via `CF-Connecting-IP` |
> | `scripts/prod-bootstrap.sh` — `CF_V4` / `CF_V6` | the firewall RETURN list                         |
>
> Both files say so in their own comments. Updating the Caddyfile and forgetting
> the script gives you a firewall that drops traffic the edge would have
> admitted, and the symptom is a 522 with a perfectly healthy stack behind it.

**3.2d Baseline packages.**

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl git openssl fail2ban \
  unattended-upgrades ufw cron iproute2 iptables
sudo systemctl enable --now fail2ban
sudo systemctl is-active fail2ban unattended-upgrades
```

`git`, `curl` and `openssl` are not optional: `deploy-on-host.sh` only checks for
`docker`, and a missing `git` or `openssl` fails mid-run with a bare
`command not found` rather than a named precondition.

The last four are the ones this list used to omit, and each has a failure that
looks like something else. `iptables` because `prod-bootstrap.sh` exits **FATAL**
without `ip6tables` (§3.2c). `iproute2` because `--firewall-status` needs `ss` to
prove there is no `[::]` listener, and because §3.2b reads the real ssh port off
the listening socket. `cron` because `/etc/cron.d/libriant-backup` is an inert
text file without a cron daemon — which is a backup that silently never runs
(§8.2). `ufw` because §3.2b enables it. `install-server.sh` installs all ten.

Two things `systemctl is-active` does not prove, both worth a minute now:

```bash
sudo fail2ban-client status sshd        # UNVERIFIED on Ubuntu 26.04 — the jail
                                        # may not be enabled by default
cat /etc/apt/apt.conf.d/20auto-upgrades # unattended-upgrades can be `active`
                                        # while nothing is scheduled
```

### 3.3 Docker

**Installer step:** `docker`.

Ubuntu 26.04 is new. **UNVERIFIED** whether Docker's apt repo has published a
suite for this release; check before trusting the convenience script.

```bash
. /etc/os-release && echo "codename=$VERSION_CODENAME"
curl -fsSI "https://download.docker.com/linux/ubuntu/dists/$VERSION_CODENAME/Release" | head -1
```

Good looks like: `HTTP/1.1 200 OK`. If it 404s, pin to the previous LTS codename
deliberately and write down that you did.

Write `/etc/docker/daemon.json` **before** installing `docker-ce`, so the daemon
reads it on its very first start and no restart is ever needed:

```bash
sudo install -d -m 0755 /etc/docker
sudo tee /etc/docker/daemon.json >/dev/null <<'JSON'
{
  "ip6tables": true,
  "log-driver": "json-file",
  "log-opts": {
    "max-size": "50m",
    "max-file": "5"
  }
}
JSON
```

`ip6tables` is the line that matters here: without it dockerd may build no
ip6tables chains, `ip6tables -S DOCKER-USER` finds nothing, and `prod-bootstrap.sh
--firewall-status` reports a missing jump that the installer treats as **FATAL**.
Docker Engine has defaulted it to true since v28, so on a current `docker-ce`
this is determinism rather than a fix. `log-opts` is **not** about log rotation
on this stack — `docker-compose.prod.yml`'s `*logging` anchor already caps every
service — it bounds an ad-hoc `docker run` and any service added later without
the anchor. Do **not** add `"ipv6": true`: that is a different setting and one of
four changes that must be made together (§2, the networks).

**If the file already exists, do not edit it blind.** There is no `jq` here and a
half-merged `daemon.json` stops dockerd from starting at all. Merge the keys by
hand, then:

```bash
sudo systemctl restart docker
sudo bash install-server.sh --only firewall   # NOT optional — see below
```

The second line is belt and braces rather than the load-bearing step it used to
be. dockerd rebuilds `DOCKER-USER` on start, taking the `LIBRIANT-ORIGIN` jump
with it, and `libriant-origin-firewall.service` is `Type=oneshot` /
`RemainAfterExit=yes` — so systemd considered it already active and had no
reason to run it again. The unit now carries `PartOf=docker.service`, which
propagates docker's restart to it, so the lockdown re-applies by itself once
dockerd is back and has rebuilt its chains.

> A unit installed before 2026-09-02 does **not** have that line: `PartOf` is
> written into the unit file at install time, so an existing box keeps the old
> one until you re-run `--firewall-install-unit`. Check with
> `systemctl show libriant-origin-firewall -p PartOf`; an empty answer means run
> `sudo bash scripts/prod-bootstrap.sh --firewall-install-unit` once, then
> verify externally per §5.7 — from a machine with working IPv6.

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

**Installer step:** `user`.

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

**Installer step:** `dirs`.

```bash
sudo mkdir -p /srv/libriant
sudo chown deploy:deploy /srv/libriant
sudo mkdir -p /var/log/libriant
sudo chown deploy:deploy /var/log/libriant

sudo mkdir -p /mnt/libriant/{postgres,redis,storage,caddy/origin,backups}
sudo chown -R 1000:1000 /mnt/libriant/storage       # ← required, enforced by nothing
sudo chown deploy:deploy /mnt/libriant/backups
# The same trap, for the edge, and with a different answer. /mnt/libriant/caddy
# IS caddy_data — Caddy's /data, which it writes at startup — and since
# supply-chain-07 the edge runs as uid 1000 in GROUP 0. Group, not owner,
# because the Cloudflare origin private key lives in this same tree (origin/)
# and group 0 is the one group no human login on this box belongs to. 775 and
# not 770: deploy-on-host.sh stats that key as `deploy` and has to traverse
# here; at 770 the stat fails and every deploy dies saying the cert is missing.
sudo chown -R 0:0 /mnt/libriant/caddy
sudo chmod 775 /mnt/libriant/caddy
sudo chmod 755 /mnt/libriant/caddy/origin    # ← so `deploy` can stat the key
# `env` holds the on-volume copy of .env.prod that ensure-env.sh writes, and it
# is the FIRST recovery source that script names when POSTGRES_PASSWORD is lost
# but the cluster survives — the boot-disk-rebuild case. It was missing from
# this list, and /mnt/libriant is root-owned, so ensure-env.sh (which runs as
# deploy) could not create it and reported
#   ! could not create /mnt/libriant/env - no on-volume copy made
# while still finishing "Done". Owned by deploy because ensure-env.sh writes it
# unprivileged; 700 because it holds every secret the stack has.
sudo install -d -m 700 -o deploy -g deploy /mnt/libriant/env
# Beyond §3.5's original list, and not on the data volume: node-exporter's
# textfile collector reads this directory, and `backup.sh` REFUSES to run when
# neither it is writable nor BACKUP_HEARTBEAT_URL is set — a backup that stops
# happening has to be noticeable. It must exist, owned by deploy, BEFORE the
# deploy: the monitoring compose file bind-mounts it, so Docker would otherwise
# create it as root and the nightly backup could not write its metric, exiting 1
# every night in a log nobody reads. `install-server.sh` creates it in the
# `dirs` step.
sudo install -d -m 755 -o deploy -g deploy /var/lib/node_exporter/textfile
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
>
> **`chmod 775 /mnt/libriant/caddy` is the same trap wearing a different hat.**
> `storage` needs a uid because api and worker run as `USER node` = 1000 and own
> what they write. The edge needs a **group**, because the same directory tree
> also holds the origin private key and the container must not be its owner. On
> a box that already has data in `/data`, this is not enough on its own — see
> §3.7c.

### 3.6 The checkout

**Installer step:** `checkout` — it pauses while you register the key.

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

**Installer steps:** `env` (3.7a), `cert` (3.7b).

**3.7a Mint the secrets — interactively, exactly once.**

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
`MFA_MASTER_KEY` and `TENANT_DB_MASTER_KEY` — `openssl rand -hex 32`, so **64 hex
characters each**, not 32 — plus `POSTGRES_PASSWORD` and
`GRAFANA_ADMIN_PASSWORD` at `-hex 24`, 48 characters. The byte count is the argument, not the length: regenerate one by
hand with `openssl rand -hex 16` and the API refuses to boot, because
`MFA_MASTER_KEY` must be exactly 64 hex (AES-256) and `install-server.sh`'s
`env` step asserts that. `GRAFANA_ADMIN_PASSWORD` is generated here rather than
left to you because `grafana`'s compose entry has no default for it (`:?`) and
both deploy paths now bring the monitoring stack up. It `umask 077`s,
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

**3.7b Place the Cloudflare Origin certificate.**

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
sudo chmod 640 /mnt/libriant/caddy/origin/origin.key
sudo chown root:root /mnt/libriant/caddy/origin/origin.*
sudo openssl x509 -in /mnt/libriant/caddy/origin/origin.crt -noout -subject -issuer -dates -ext subjectAltName
```

`sudo` on that last line is not decoration, and it was missing here and in four
other places in this document. The three lines above it make the cert
`640 root:root`, so reading it as the deploy user fails with

    Could not open file or uri for loading certificate from …/origin.crt
    error:8000000D:system library:BIO_new_file:Permission denied

which reads like a corrupt certificate and is not. Every documented `openssl
x509 -in` against this path now carries `sudo`; keep it when you copy one.

**`0:0` at mode `640` is load-bearing, not tidiness — and the `640` on the key
is the half that looks like a mistake.** Caddy runs as **uid 1000 in group 0**
inside its container and, since supply-chain-07, holds **no capabilities at
all**. Reading a file whose permission bits deny you is exactly what
CAP_DAC_OVERRIDE is for, and it is gone — so the key has to be reachable as the
file's owner or as its group, and 1000 is not the owner. It reads it **as a
member of group 0**. A key at `600`, or one owned by `deploy`, means every HTTPS
vhost fails to load its certificate and the edge is down.

**Group 0 and not group 1000**, which would have been the obvious pairing for a
uid-1000 process: this is the Cloudflare Full-strict private key, and gid 1000 is
a human login on most images — `deploy` here. The only member of group 0 is
`root`, which could read the file already, so widening 600 → 640 gives away
nothing. (Root on this box is not a meaningful boundary anyway: `deploy` is in
the `docker` group.)

`scripts/deploy-on-host.sh` refuses to deploy if the key is anything other than
uid 0, gid 0 and mode 640 or 440, and its message names the fix. It checks the
certificate the same way.

> **A box installed before this change has the key at `600` and will not
> deploy.** That is deliberate — a `600` key produces a green build and a dark
> edge. The conversion is §3.7c below, and it is safe to run while the current
> edge is serving.
>
> **Both** deploy paths refuse it: `scripts/deploy-on-host.sh` and the `deploy`
> GitHub workflow. The workflow's copy of this gate accepted `0:600` until this
> change, which was the dangerous way round — on an unconverted box it would have
> **passed** and then recreated the stack with a key the new edge cannot open. It
> moved in the same commit. If you ever edit one arm, edit both.

Good looks like: issuer `CloudFlare Origin SSL Certificate Authority`, SANs
`DNS:libriant.com, DNS:*.libriant.com`, `notAfter` roughly 15 years out.

> The deploy checks only that the two **files exist**. An expired certificate, or
> one whose SANs omit `*.libriant.com`, produces a fully green deploy and then a
> Cloudflare **526** on every host. Nothing monitors this. Put the expiry in your
> calendar now, and add the check to your monthly rhythm (§6.7).

**3.7c Converting a box installed before the edge went non-root.**

**Skip this on a fresh install** — §3.5 and §3.7b already produce the right
ownership. This is for a box that is **serving right now** with `caddy` running
as uid 0, which is every box installed before supply-chain-07 finished.

What changes, and what each thing breaks if it is missed:

| Thing                                     | Was          | Becomes         | If you skip it                                                       |
| ----------------------------------------- | ------------ | --------------- | -------------------------------------------------------------------- |
| `origin.key`                              | `0:0 600`    | `0:0 640`       | every HTTPS vhost fails to load its certificate — the edge is dark   |
| `/mnt/libriant/caddy` (= Caddy's `/data`) | `0:0 755`    | `0:0 775` + g+w | Caddy cannot write its own storage                                   |
| `libriant_caddy_config`, `_caddy_logs`    | `0:0 755`    | g+rwX           | Caddy cannot open `/var/log/caddy/access.log` and **exits at start** |
| the container                             | uid 0, 1 cap | uid 1000, gid 0 | —                                                                    |

**Every step below is safe to stop after.** The permission changes keep `root`'s
own access, so the uid-0 edge that is serving now keeps working through all of
them; nothing is recreated until step 6.

**Prove that after every step.** This is the whole safety argument, so do not
take it on faith — it is three seconds:

```bash
for h in libriant.com app.libriant.com admin.libriant.com; do
  printf '%-20s %s\n' "$h" \
    "$(curl -sk --resolve "$h:443:127.0.0.1" -o /dev/null -w '%{http_code}' --max-time 5 "https://$h/")"
done
curl -si http://localhost/healthz | head -1
```

Any of `200` / `301` / `302` is serving (the admin host redirects `/` to
`/admin/login`). **`000` is a TLS failure** — the handshake never completed —
and on this change that means the certificate or the key. Stop and read the
container log: `dc logs --tail 50 caddy`.

**1. Sync the checkout (as `deploy`). Nothing running is touched.**

```bash
cd /srv/libriant/app
git status --short          # host-local edits to tracked files are about to go
git fetch origin && git reset --hard origin/main
```

Then start a **fresh login shell** — `dc` computes `IMAGE_TAG` from the checkout
at login, and the commit just moved (§6.1). Type this on its own, not as part of
a pasted block:

```bash
exec bash -l
```

```bash
cd /srv/libriant/app
git rev-parse --short=12 HEAD && echo "$IMAGE_TAG"   # these two must match
```

Sync **before** touching permissions, not after. `deploy-on-host.sh` reads the
key's mode in its preflight, and the copy of that gate on disk right now still
demands `600` — a box with the new permissions and the old script refuses to
deploy. Fail-closed, but pointless.

**2. Build the new edge image (as `deploy`). Still nothing recreated.**

```bash
dc build caddy
```

**3. Fix the origin key (as `root`). The running edge keeps reading it.**

```bash
sudo chmod 640 /mnt/libriant/caddy/origin/origin.key
sudo chown 0:0 /mnt/libriant/caddy/origin/origin.*
sudo stat -c '%u:%g %a %n' /mnt/libriant/caddy/origin/origin.*   # 0:0 640 both
```

`640` and not `600` is the whole trick: `root` still reads it as the owner, so
the uid-0 container serving right now is unaffected, and uid 1000 reads it as a
member of group 0. There is no moment when only one of the two can.

**4. Fix the three writable volumes (as `root`).**

```bash
# caddy_data — the bind under the volume overlay. `origin` is pruned so the
# private key never becomes group-writable.
sudo chown -R 0:0 /mnt/libriant/caddy
sudo find /mnt/libriant/caddy -path /mnt/libriant/caddy/origin -prune -o -exec chmod g+rwX {} +
sudo chmod 775 /mnt/libriant/caddy
# origin/ is pruned from the chmod but NOT from the chown above. If it arrived
# owned by `deploy` at 700 it is now 0:0 700 and nothing can traverse it — not
# the container, and not the preflight `stat` that runs as `deploy`, which would
# then report the certificate as MISSING. 755 gives nothing away: the two files
# inside are 640.
sudo chmod 755 /mnt/libriant/caddy/origin

# caddy_config and caddy_logs — Docker-managed, on the boot disk. Ask the daemon
# where they are; never assemble /var/lib/docker/volumes/<name>/_data by hand.
for v in libriant_caddy_config libriant_caddy_logs; do
  mp="$(sudo docker volume inspect -f '{{ .Mountpoint }}' "$v")"
  sudo chown -R 0:0 "$mp" && sudo chmod -R g+rwX "$mp"
  echo "$v -> $mp"
done
```

`775` and not `770`: `deploy-on-host.sh` runs as `deploy` and `stat`s the origin
key in its preflight, which has to traverse `/mnt/libriant/caddy`. At `770` that
`stat` fails, the gate reads the failure as a **missing certificate**, and every
deploy dies claiming the cert is gone.

> Steps 3 and 4 together are what `sudo bash scripts/install-server.sh --only dirs`
> and `--only cert` do, and those are converging — running them on an already
> converted box changes nothing. Use whichever you prefer; do not use both halves
> from different sources.

**5. Rehearse the bind, before anything is recreated (as `deploy`).**

This is the step that answers the only question this change could not settle
off-box: whether `net.ipv4.ip_unprivileged_port_start=0` lets a non-root process
bind 80 and 443 **on this kernel**, including the IPv6 dual-stack socket Go
actually opens. It runs the new image with the new service definition and **no
published ports**, so it cannot collide with the edge that is serving.

```bash
cd /srv/libriant/app && timeout 15 docker compose \
  -f infra/compose/docker-compose.prod.yml \
  -f infra/compose/docker-compose.volume.yml \
  run --rm --no-deps -T caddy; echo "exit=$?"
```

That is `dc` written out: `timeout` cannot run a shell function, and `dc` is one
(§6.1). Run it from the login shell of step 1 — it is what exported `IMAGE_TAG`
and the `.env.prod` values this needs.

- **Good:** `exit=124` (the timeout killed a healthy process) and the log says
  `serving initial configuration`.
- **Stop here:** `bind: permission denied` — the sysctl is not doing what this
  change assumes on this kernel. Nothing has been recreated; the box is still
  serving. There **is** a fallback, below; do not continue past this step without
  it.
- **Stop here:** `open /etc/caddy/origin/origin.key: permission denied` — step 3
  did not take.
- **Stop here:** `open /var/log/caddy/access.log: permission denied` — step 4 did
  not take, or it missed the log volume.
- **Stop here:** an error from the daemon about the sysctl at container create —
  this Docker cannot set it per-container. Nothing has been recreated.

**Then, whatever it printed, put the ownership back.** The rehearsal shares
`caddy_data` and `caddy_logs` with the container that is serving right now and it
ran as uid 1000, so anything it _created_ is `1000:0` at mode `600` — and the
uid-0 Caddy that is still running has `cap_drop: [ALL]`, no `CAP_DAC_OVERRIDE`,
and cannot read those back on its next restart. The window is small (the existing
files were made group-writable in step 4; only a fresh file, such as a log roll,
lands 1000-owned) and this is idempotent, so run it on success too:

```bash
sudo chown -R 0:0 /mnt/libriant/caddy
for v in libriant_caddy_config libriant_caddy_logs; do
  sudo chown -R 0:0 "$(sudo docker volume inspect -f '{{ .Mountpoint }}' "$v")"
done
docker ps -a --filter name=caddy-run --format '{{.Names}} {{.Status}}'   # expect nothing
```

That last line is because `timeout` signals the Compose CLI, not the container:
`--rm` normally still cleans up, but a stray `…-caddy-run-…` holding the log
volume is worth ten seconds to rule out. `docker rm -f <name>` if one is there.

> **If it said `bind: permission denied`, do not give up on the change yet —
> there is a second mechanism, and this step is free to repeat.** Docker's
> `cap_add` cannot reach a non-root process on its own, but a **file** capability
> on the binary can, and `no-new-privileges` does not stop it here: commoncap
> only takes a capability away when the exec _gains_ one, and with `cap_add` the
> caller already holds `NET_BIND_SERVICE` in its permitted set, so nothing is
> gained. **UNVERIFIED** — that is kernel-source reasoning, and whether
> `/usr/bin/caddy` carries the file capability at all was never checked; there is
> no Docker on the machine this was written on.
>
> Test it the same way you tested the first mechanism. In
> `infra/compose/docker-compose.prod.yml`, on the `caddy` service, add
> `cap_add: [NET_BIND_SERVICE]` back beside `cap_drop: [ALL]`, leave `user:` and
> `sysctls:` alone, `dc build caddy`, and **re-run this step**. Nothing is
> recreated by a rehearsal, so a second failure costs nothing either.
>
> - It binds → keep that line, and note in the commit that the bind is carried by
>   a file capability rather than the sysctl. The end state is one capability
>   instead of none: worse than the shipped design, far better than uid 0.
>   `dc exec caddy grep Cap /proc/1/status` will show `CapEff` non-zero, which is
>   how you tell the two apart later.
> - It still does not bind → this change cannot be completed on this box.
>   `git reset --hard <the-commit-before>`, leave the edge on uid 0, and say so.
>   Nothing has been recreated at any point.
>
> If you want the reason rather than the result:
> `docker run --rm --entrypoint sh ghcr.io/libriant/libriant-caddy:"$IMAGE_TAG" -c 'getcap /usr/bin/caddy'`
> — but `getcap` may not be in the image, and an empty answer there proves
> nothing. The rehearsal is the real test.

**6. Deploy (as `deploy`).**

**Look first at what else is about to ship.** Step 1 moved the checkout to
`origin/main`, and this is a full deploy: every service is rebuilt and
`--force-recreate`d, not just the edge. If the box was several commits behind,
those commits go out too, in the same window, and the build is 10–20 minutes.

```bash
cd /srv/libriant/app
# Every image is tagged with the 12-char short SHA of the commit it was built
# from, so the running tag IS the commit the box is on.
docker ps --filter label=com.docker.compose.project=libriant \
          --filter label=com.docker.compose.service=api --format '{{.Image}}'
git log --oneline <that-sha>..HEAD
```

If that is only the edge commit, take the normal path:

```bash
bash scripts/deploy-on-host.sh --no-fetch
```

`--no-fetch` because step 1 already synced, and because it keeps the script from
rewriting itself underneath a running bash. The `caddy-validate` stage is a real
container from the real service definition, so it reads the origin key **and
opens the access log** as uid 1000 (`caddy validate` provisions the logging app,
which creates the file) — a missed step 3 or step 4 stops the deploy **before**
anything is recreated. UNVERIFIED: that last claim about the log is read from
Caddy's source, not run.

> **If it is more than the edge commit and you do not want the rest tonight,**
> convert only the edge instead — this change touches one service:
>
> ```bash
> dc up -d --force-recreate --no-deps caddy      # step 2 already built it
> ```
>
> Two seconds, no prune, no full-stack restart, and the images the rollback
> depends on stay on disk. The cost is a **mixed** box: the checkout is now ahead
> of the running `api` / `web` / `worker` images, so the next `dc up -d` that
> touches them will look for images that do not exist yet and try to pull from
> GHCR, which publishes nothing. Follow it with a full
> `bash scripts/deploy-on-host.sh --no-fetch` in daylight, and go to step 7
> either way.

**7. Verify.**

```bash
dc exec caddy id                       # uid=1000 gid=0(root)
dc exec caddy grep Cap /proc/1/status  # CapPrm/CapEff must be 0000000000000000
curl -si http://localhost/healthz | head -1
curl -sk --resolve libriant.com:443:127.0.0.1 -o /dev/null -w '%{http_code}\n' https://libriant.com/
curl -sk --resolve app.libriant.com:443:127.0.0.1 -o /dev/null -w '%{http_code}\n' https://app.libriant.com/
curl -sk --resolve admin.libriant.com:443:127.0.0.1 -o /dev/null -w '%{http_code}\n' https://admin.libriant.com/
```

All three HTTPS hosts must answer. A `000` is a TLS failure, which on this change
means the key: check step 3 again.

**If it does not come up.**

**Do not roll back through `deploy-on-host.sh`.** That is the instinct and it is
wrong here — and note that the copy of the script you would be running is the
**old** one, restored by the `git reset`, not the one in this commit. Two
independent reasons, both of which bite while the site is dark:

- Its preflight is the old gate — `0:600 | 0:400` — and the key is now `640`. It
  dies before it does anything.
- Its `prune` stage runs **before** the `--skip-build` guard:
  `docker image prune -af --filter 'until=72h'` removes _tagged_ images that no
  container is using. After the failed forward deploy's `--force-recreate` the
  previous containers are gone, so if the previous deploy was more than three
  days ago **the prune deletes the very images you are rolling back to** — and
  `--skip-build` then falls through to pulling from GHCR, where nothing has ever
  been published. You would be down for a 10–20 minute rebuild. (The version of
  the script in _this_ commit skips the prune entirely under `--skip-build`, for
  exactly this reason. That does not help you: the rollback checkout brings the
  old one back.)

This change touches exactly one service, so roll back exactly one service.

**First**, because it has to happen before a uid-0 Caddy starts again: anything
the uid-1000 Caddy created under `/data` or in the log volume is owned by `1000`
at mode `600`, and a uid-0 Caddy has `cap_drop: [ALL]` — no `CAP_DAC_OVERRIDE`
to read it back.

```bash
sudo chown -R 0:0 /mnt/libriant/caddy
for v in libriant_caddy_config libriant_caddy_logs; do
  sudo chown -R 0:0 "$(sudo docker volume inspect -f '{{ .Mountpoint }}' "$v")"
done
```

**Then** put the previous edge back. Check the image is actually there before you
rely on it:

```bash
docker images --format '{{.Repository}}:{{.Tag}}' | grep libriant-caddy   # pick the previous sha
cd /srv/libriant/app && git reset --hard <previous-sha>
```

```bash
exec bash -l          # again: IMAGE_TAG follows the checkout
```

```bash
dc up -d --force-recreate --no-deps caddy
curl -si http://localhost/healthz | head -1
curl -sk --resolve libriant.com:443:127.0.0.1 -o /dev/null -w '%{http_code}\n' https://libriant.com/
```

No prune, no build, no validate, no 180-second health gate, and nothing but the
edge is recreated: a two-second blip instead of a full-stack restart. The old
compose file came back with the checkout, so that container is uid 0 with
`cap_add: [NET_BIND_SERVICE]` again.

The permissions from steps 3 and 4 do **not** need reverting for Caddy itself —
`640` and `775` keep root's own read and write, which is all the uid-0 edge ever
used. They **do** stop the old `deploy-on-host.sh` from running: if you are
staying on the old commit and want a normal deploy again, `sudo chmod 600
/mnt/libriant/caddy/origin/origin.key` clears its gate. That is a refused deploy,
not an outage — do it in daylight, not now.

### 3.7c The non-root edge — attempted, reverted, and why

**Caddy runs as uid 0. `supply-chain-07` is open.** Six places in this document
used to send you here for a conversion procedure. There is no procedure, because
the conversion does not work and nobody established why.

**What was tried.** `user: '1000:0'` on the caddy service, with
`net.ipv4.ip_unprivileged_port_start=0` supplying the bind instead of a
capability. It produced, on every container built from that image:

```
exec /usr/bin/caddy: operation not permitted
```

The container reaches `Created` and dies. The deploy's `caddy validate` stage hit
it first and reported **"Caddyfile is invalid"** about a file that was fine — the
throwaway container never read it. On the deploy that got past validation, the
edge crash-looped and **the site went down**.

**Three diagnoses, all wrong, all reached by reading rather than running:**

1. That `no_new_privs` blanket-suppresses file capabilities. It does not.
2. That commoncap's downgrade path (`is_setid || __cap_gained`) explained it. It
   does not fire here — with `cap_add` the capability is already in permitted, so
   nothing is gained.
3. That the image's file capability on `/usr/bin/caddy` was the cause. Settled on
   the box, against the image the deploy actually built:

```
$ docker run --rm --user 0:0 --entrypoint sh <the built caddy image> \
    -c 'getcap /usr/bin/caddy; ls -ln /usr/bin/caddy'
-rwxr-xr-x    1 0        0         48521378 /usr/bin/caddy
```

No capability. World-executable. Root-owned. And it still refused to exec as uid 1000. **Whatever the cause is, it is none of the above.**

**What was kept.** `cap_add: [NET_BIND_SERVICE]` is gone and has not come back:
the edge now runs as root with an **empty capability set**, binding 80/443
through the unprivileged-port sysctl. That is strictly better than the one
capability it used to hold, and it is proven — it is what is serving.

**If you pick this up.** Start from a throwaway container and the fact above, not
from a theory:

```bash
docker run --rm --user 1000:0 --security-opt no-new-privileges:true \
  --entrypoint sh <the built caddy image> -c 'id; /usr/bin/caddy version'
```

No published ports, nothing recreated, and it answers in a second what two
evenings of reasoning did not. If `sh` itself execs but `caddy` does not, the
difference is in the binary or its path; if neither execs, it is the runtime.

**Is it worth it?** Caddy must read the origin private key at any uid, so an RCE
in Caddy yields the Cloudflare Full-strict key either way. The process is already
`cap_drop: [ALL]` and `no-new-privileges`. What remains is post-RCE escalation
and container-escape surface — real defence in depth, no CVE forcing it. It has
cost one outage. Do not attempt it on a live edge again without settling the
exec failure in a throwaway container first.

### 3.8 Deploy

**Installer steps:** `dchelper`, then `deploy`.

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
>
> **If `caddy` exits at start with `permission denied` on
> `/var/log/caddy/access.log` or `/data`,** its two boot-disk volumes were
> created root-owned instead of inheriting the image's group-writable
> directories, and the edge runs as uid 1000 in group 0. Nothing else is wrong;
> fix the volumes and bring it back:
>
> ```bash
> for v in libriant_caddy_config libriant_caddy_logs; do
>   mp="$(sudo docker volume inspect -f '{{ .Mountpoint }}' "$v")"
>   sudo chown -R 0:0 "$mp" && sudo chmod -R g+rwX "$mp"
> done
> dc up -d --force-recreate caddy
> ```

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
   `docker builder prune -f --filter 'until=72h'`, both `|| true` — **only when a
   build is going to happen**. Under `--skip-build` the prune is skipped: `-a`
   removes tagged images no container is using, which on a rollback is the
   previous release's images, and there is nothing to reclaim ahead of a build
   that is not running.
6. `dc build` — 10–20 min cold. Budget ~15–20 GB in `/var/lib/docker`
   (**UNVERIFIED on this box**; measured on the dead machine).
7. `caddy validate` in a throwaway container, **before** anything is recreated.
8. `dc up -d --remove-orphans --force-recreate`, dumping the last 200 lines of
   migrate logs on failure.
9. `dc exec caddy caddy reload`, falling back to recreating caddy.
10. A 180-second local health gate.
11. The **monitoring stack** — a separate compose project, `libriant-monitoring`,
    started last, after the app is already healthy, so a monitoring problem
    never rolls a working application back. It `promtool check rules`
    `infra/monitoring/alerts.yml`, requires `infra/monitoring/alertmanager.yml`
    to exist, and turns the `alerting` profile on **only** when that file no
    longer contains `[PLACEHOLDER` (comments stripped first). Then `up -d`, and
    ten seconds later it asserts `prometheus` and `node-exporter` are still
    running. It can still fail the deploy — it carries five `die` calls — and
    when the profile stays off it prints a red **ALERTS ARE NOT BEING
    DELIVERED** banner, which is the state this box is in today (§7.3).

The health gate — step 10 — polls **six** signals every 5 s for 180 s:
`http://localhost/healthz` == 200,
`curl -sk --resolve libriant.com:443:127.0.0.1 https://libriant.com/` == 200, and
Docker health `healthy` for api, web, worker **and `pgbouncer-probe`**. It
touches no public DNS, and on timeout **it does not roll back**.

The sixth is `boot-and-config-15`'s. Every control-plane query goes through the
pooler, and that sidecar runs `psql -c 'select 1'` **through** pgbouncer — the
only probe that can tell "the pooler answers" from "the pooler can reach
Postgres". `pg_isready`, the probe it replaced, is satisfied by pgbouncer's own
startup-packet reply and stayed green with the backend gone.

**Good looks like** — these are the script's literal strings:

```
▸ Healthy: origin + marketing site + api + web + worker + pooler path
<dc ps table>
   … deploy_monitoring runs here — see below …
Deployed a1b2c3d4e5f6. This box is not in DNS yet, so nothing is public.
Point DNS at it only when you want it live — docs/RUNBOOK.md.
```

Those lines are **not contiguous on a real run.** `deploy_monitoring` is called
between the `dc ps` table and the `Deployed` line (`deploy-on-host.sh:352-356`),
and it emits `promtool check rules` output, its own `mon ps` table, and — while
`alertmanager.yml` still carries `[PLACEHOLDER]` receivers, which today it does
— the red `ALERTS ARE NOT BEING DELIVERED.` banner (§7.3). Screens of output
between the two strings is the normal case, not a sign the deploy stalled.

While it is still waiting you get one line every 5 s in the other shape —
`waiting… edge=200 site=000 api=starting web=starting worker=starting pooler=starting`.
That line is the _pending_ form, not the success form; the run has only
succeeded when you see `▸ Healthy:` and the `Deployed <tag>` line. On timeout
the failure names all six: `stack did not become healthy within 180s (edge=… site=… api=… web=… worker=… pooler=…)`.

`install-server.sh`'s `deploy` step gates its own skip-when-satisfied check on
**five of these six** — `satisfied_deploy()` in `scripts/install-server.sh`
requires `docker` on `PATH`, `api`, `web`, `worker` and `pgbouncer-probe` all
`healthy`, and `http://localhost/healthz == 200`. That is every container health
plus the plaintext edge. It does **not** run the marketing-site HTTPS probe —
the `site=` term, `curl -sk --resolve libriant.com:443:127.0.0.1 https://libriant.com/`
(`scripts/deploy-on-host.sh:325`). The comment above that function
(the comment above `satisfied_deploy()`) says it checks "THE SAME SIX SIGNALS … not three of
them"; it means it, and it is one short. Trust the function, not its comment.

> **A deploy that timed out on `site=` alone reads as satisfied.** Every
> container is healthy, `/healthz` answers, and so `--status` reports `deploy`
> as done and a resume prints `ok   already satisfied — skipping` for a deploy
> that actually died at its own gate. That is the one failure this check cannot
> see, and it is not hypothetical: `site=` is the term that fails when the
> origin certificate is missing or the `libriant.com` vhost is misconfigured,
> which is exactly the state a first install is in before §3.7 is finished.
> Before you believe a skipped `deploy`, run the `site=` curl yourself — it is
> in §5.7 — or re-run the deploy with `--force`.

**But do not over-read it.** `web=healthy` is the constant healthcheck: a wrong
`API_INTERNAL_URL` or a broken `app` network passes the gate green while every
page renders an error. `api=healthy` and `worker=healthy` are real.

### 3.9 Post-deploy checks the script does not do

**Installer step:** `verify`, also reachable on its own as
`sudo bash install-server.sh --verify-only`.

```bash
dc ps
dc logs migrate | tail -40
```

Read the migrate log properly. Only two steps are **fatal**: control-plane
`db:migrate:deploy` and `db:seed` — and, since the findings below, so are the
three steps this table used to call best-effort:

| Step              | Now                | Why it changed                                                                                                                                                                                                    |
| ----------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ingest:help`     | **FATAL**          | launch-readiness-15. A deploy shipping no help articles looked exactly like one that shipped them, while the site sells in-app help as one of only four support mechanisms.                                       |
| `tenant:migrate`  | **FATAL**          | boot-and-config-04. The one-shot exited 0, `service_completed_successfully` was satisfied, and api + worker started against tenant databases that never got the migration.                                        |
| `admin:bootstrap` | **FATAL when set** | Runs only when `ADMIN_BOOTSTRAP_EMAIL` and `ADMIN_BOOTSTRAP_PASSWORD` are both non-empty. If they are unset it still logs and exits 0 — which is the one remaining way to get a green deploy nobody can log into. |

**Do not grep for `skipped (non-fatal)`.** `prod-bootstrap.sh` no longer emits
it from any step, so a search returns nothing on a broken deploy exactly as it
does on a healthy one — which reads as reassurance and is not. (The only place
the string survives in this repository is `install-server.sh`, which keeps a
defensive grep for it precisely so a reintroduction is caught.) What is worth
reading for is `ADMIN_BOOTSTRAP_* not set - skipping` — the case above that
exits 0 — and `[bootstrap] FATAL`, which is what the other five now emit.
`scripts/install-server.sh` checks for both.

Then prove the things nothing else proves:

```bash
# uploads are writable by the container user
dc exec -T api sh -c 'touch /srv/libriant/storage/.probe && rm /srv/libriant/storage/.probe && echo STORAGE-OK'

# the web → api hop, which no healthcheck crosses
dc exec -T web sh -c 'wget -qO- http://api:3001/healthz' && echo WEB-TO-API-OK

# a real page, not a static probe
curl -sk --resolve libriant.com:443:127.0.0.1 -o /dev/null -w '%{http_code}\n' https://libriant.com/pricing

# the help centre. `ingest:help` is FATAL now (launch-readiness-15), so a deploy
# that failed to ingest stops — but a deploy that ingested into a control plane
# somebody has since archived is a different failure, and an empty help centre
# is indistinguishable from a working one until a librarian goes looking: the
# app renders "no articles" rather than an error, and the site sells in-app help
# as one of four support mechanisms. This query is the only thing that fails on
# an empty corpus, so do not skip it.
dc exec -T postgres psql -U libriant -d libriant_control -tAc \
  "SELECT count(*) FILTER (WHERE locale = 'el'), count(*) FILTER (WHERE locale = 'en')
     FROM help_articles WHERE \"archivedAt\" IS NULL" \
  | awk -F'|' '{ if ($1 >= 4 && $2 >= 4) print "HELP-OK el=" $1 " en=" $2;
                 else { print "HELP-MISSING el=" $1 " en=" $2; exit 1 } }'
```

`HELP-MISSING` is repaired by re-running the ingest — it upserts, so running it
again is free:

```bash
dc run --rm --no-deps migrate sh -lc "cd /app && pnpm ingest:help"
```

> The `count(*) FILTER` form is not decoration. The obvious version —
> `SELECT locale, count(*) … GROUP BY locale` piped to a comparison — returns
> **no rows at all** when the table is empty, so the check prints nothing and
> exits 0 on exactly the failure it exists to catch. Verified both ways against
> a control plane on 2026-08-27: populated → `HELP-OK el=4 en=4`, exit 0;
> everything archived → `HELP-MISSING el=0 en=0`, exit 1.
>
> **Four articles per language is the whole corpus** (getting-started,
> adding-members, lending-books, reservations). There is nothing on returning a
> copy, fines, importing a file, exporting data, staff and roles, or the desktop
> app. Every one of those gaps arrives as an e-mail to you, so the check above
> proves the help centre is _installed_, not that it is _sufficient_.

Good looks like: `STORAGE-OK`, `WEB-TO-API-OK`, `200`, `HELP-OK el=4 en=4`.

> `STORAGE-OK` proves the **directory** is writable by uid 1000. It does not
> prove uploads work — and for a long time they did not: `data-integrity-01`, now
> closed, made every file upload return HTTP 500 in the launch configuration,
> because the unlimited-plan sentinel scaled up to a byte ceiling ~1024× the
> `int8` maximum and Postgres refused the reservation with SQLSTATE 22003. Do not
> conclude from a green storage probe that a librarian can attach a cover image.
> The only proof is attaching one (§9.9).
>
> **The script has not caught up with the fix.** `--verify-only` closes with a
> banner calling `data-integrity-01` a BLOCKER that makes "every file upload
> return HTTP 500 in the launch configuration" (the banner at the end of `step_verify()`).
> That banner is **stale** — the finding is closed, capped at `INT8_MAX` in
> `apps/api/src/storage/storage.service.ts:90`. Do not treat it as a live
> blocker or go hunting for a bug that is fixed. The banner's actual point — a
> green `STORAGE-OK` is not a working upload — still stands, which is why it has
> not simply been deleted. UNVERIFIED: nobody has attached a real cover image on
> a real host to confirm the fix end to end (unknowns register #22).

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

**Installer step:** `backup`.

Nothing in the deploy path installs it, and nothing warns it is missing. Do it
now, in the same sitting. §8.2 — or `sudo bash install-server.sh --only backup`,
which walks the encryption and dead-man's-switch decisions `backup.sh` now
refuses to run without, writes the cron, runs `--preflight`, runs the backup
once and reads the result.

---

## 4. Configuration

### 4.1 How configuration actually reaches a container

Three layers, and one rule that explains most surprises:

```
/srv/libriant/.env.prod
        │  set -a; . /srv/libriant/.env.prod; set +a       (deploy-on-host.sh:136)
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

**Five** categories, not three, and knowing which is which saves an hour. The
old three-way split had no home for the variables Compose consumes without ever
handing them to a process, which is where the Postgres and Redis tuning knobs
live — so they read as "never injected", i.e. as dead, when they are the most
live settings in the file.

| Category                                                                                                                           | Effect of editing `.env.prod`                                                                                                                                                                                                                                                                                         |
| ---------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1. Pass-through** — named in `x-app-env` or a service `environment:` block                                                       | Works. Restart the affected containers.                                                                                                                                                                                                                                                                               |
| **2. Compose-consumed** — image tags, `mem_limit`/`cpus`, published ports, Postgres and Redis server flags, the volume device path | Works, but the value never becomes an environment variable inside any container — `docker exec … env` will not show it. Verify it at the thing it configures (§4.2c, §4.2d).                                                                                                                                          |
| **3. Compose literals** — hard-coded in the compose file                                                                           | **Silently ignored.** `NODE_ENV`, `CONTROL_DATABASE_URL`, `REDIS_URL`, `PUBLIC_APP_URL`, `TENANT_PATH_PREFIX`, `SESSION_COOKIE_SECURE`, `STORAGE_ROOT`, `ASSETS_ROOT`, `LOCALES_ROOT`, `BILLING_RETURN_URL`, `BCRYPT_COST`, `PG_SUPERUSER_URL`, `API_INTERNAL_URL`, `NEXT_TELEMETRY_DISABLED`, `PORT`, `WORKER_PORT`. |
| **4. Host-script-only** — never touched by Compose, read by a script that sources the file itself                                  | Works. `RCLONE_REMOTE`, `BACKUP_KEEP_DAYS` and the whole `BACKUP_*` family are here: the nightly cron line does its own `set -a; . /srv/libriant/.env.prod; set +a` and then runs `backup.sh` on the **host**, not in a container.                                                                                    |
| **5. Never injected** — the app reads them, nothing passes them                                                                    | **Silently ignored.** The code default always wins. This set is bigger than it looks and now includes three data-retention periods the template invites you to fill in (§4.2f).                                                                                                                                       |

The never-injected set, in full, so you stop trying. Twenty come from
`config/env.ts`:
`ADMIN_COOKIE_NAME`, `ADMIN_MFA_REQUIRED`, `ADMIN_SESSION_TTL_SEC`,
`BILLING_GRACE_PERIOD_DAYS`, `EMAIL_MAX_ATTEMPTS`, `IMPERSONATION_COOKIE_NAME`,
`LOGIN_LOCKOUT_MS`, `MAX_FAILED_LOGINS`, `SESSION_ABSOLUTE_MAX_TTL_SEC`,
`SESSION_COOKIE_NAME`, `SESSION_REMEMBER_TTL_SEC`, `SESSION_TTL_SEC`,
`STORAGE_MAX_UPLOAD_BYTES`, `STORAGE_SIGNED_TTL_SEC`, `SUPPORT_KEY_TTL_SEC`,
`SUPPORT_SESSION_TTL_SEC`, `TENANT_CACHE_TTL_SEC`, `TENANT_CLIENT_CACHE_SIZE`,
`TENANT_CLIENT_IDLE_MS`, `RATE_LIMIT_DISABLED`.

Nine more are read straight off `process.env` by the modules that own them, and
are just as unreachable:
`TRUSTED_PROXY_CIDRS`, `SIGNUP_MAX_CONCURRENT_PROVISIONING`, `TENANT_DB_POOL_MAX`,
`PG_RESERVED_CONNECTIONS`, `LEGAL_ARCHIVE_ROOT`, `CONTROL_AUDIT_RETENTION_DAYS`,
`EMAIL_OUTBOX_BODY_RETENTION_DAYS`, `SUPPORT_ATTEMPT_RETENTION_DAYS`, and
`ADMIN_BOOTSTRAP_NAME` / `ADMIN_BOOTSTRAP_ROLE` (the migrate container gets
`ADMIN_BOOTSTRAP_EMAIL` and `_PASSWORD` and nothing else).

(`RATE_LIMIT_DISABLED` being unreachable is a _safety_ property, and there are two
further in-code guards: `main.ts` refuses to boot in production if it is set to
the literal `true`, and the signup admission control ignores it unless
`NODE_ENV` is something other than `production`.)

Changing any never-injected value means **editing the compose file**, which means
a commit — `deploy-on-host.sh` will `git reset --hard` a host-local edit away.

**`bool()` no longer fails soft, and this reversed since the last edition.**
`true`, `1`, `yes`, `on` are true; `false`, `0`, `no`, `off` are false; both
lists are matched after `.toLowerCase().trim()`, so `True` and `TRUE ` are fine.
**Anything else throws and the process does not start** —

```
Env var BILLING_ENABLED must be one of true, 1, yes, on, false, 0, no, off — got "enabled".
```

That is boot-and-config-10: the old parser returned false for everything it did
not recognise, so `BILLING_ENABLED=enabled` and `BILLING_ENABLED=y` both meant
"the whole product is free" with nothing logged. Two flags go through it:
`BILLING_ENABLED` and `ADMIN_MFA_REQUIRED`.

> **Caddy does not use `bool()`.** `MAINTENANCE_HARD` is matched by Caddy
> against the literal string `true` (`@hard_maint vars {$MAINTENANCE_HARD:false} "true"`
> in `infra/caddy/Caddyfile`). `MAINTENANCE_HARD=1`, `=yes` and `=TRUE` are all
> silently **off**, and unlike the app they do not fail loudly — you get a
> perfectly healthy stack that ignored the switch you thought you flipped.

### 4.2 Hard requirements

**Eight** keys are `${VAR:?}` at the **compose** layer. A missing one aborts
`docker compose up` before any container is created, and the message ends with
the text the compose file writes after the `:?`:

| Key                    | What compose says when it is missing                            |
| ---------------------- | --------------------------------------------------------------- |
| `POSTGRES_PASSWORD`    | `POSTGRES_PASSWORD is required`                                 |
| `HASH_PEPPER`          | `HASH_PEPPER is required in production`                         |
| `SESSION_SECRET`       | `SESSION_SECRET is required in production`                      |
| `ADMIN_SESSION_SECRET` | `ADMIN_SESSION_SECRET is required`                              |
| `IMPERSONATION_SECRET` | `IMPERSONATION_SECRET is required`                              |
| `MFA_MASTER_KEY`       | `MFA_MASTER_KEY is required`                                    |
| `TENANT_DB_MASTER_KEY` | `TENANT_DB_MASTER_KEY is required`                              |
| `PUBLIC_HOST`          | `PUBLIC_HOST is required (the app host, e.g. app.libriant.com)` |

`PUBLIC_HOST` joined the list with boot-and-config-09 and is referenced from
five places (`PUBLIC_APP_URL`, `BILLING_RETURN_URL`, the caddy block, and the web
container's `NEXT_PUBLIC_API_URL` + `PUBLIC_APP_URL`). `POSTGRES_PASSWORD` is
`:?` three times over — `postgres`, `pgbouncer` and the `pgbouncer-probe`
sidecar. UNVERIFIED: the wrapper text Compose puts around those messages. There
is no Docker on the workstation this was written on, and the exact envelope is
not quoted anywhere in the repository; what **is** verified is that the variable
is named and the sentence above is appended.

An eighth lives on the monitoring overlay, which both deploy paths bring up:
`GRAFANA_ADMIN_PASSWORD`, as
`${GRAFANA_ADMIN_PASSWORD:?set GRAFANA_ADMIN_PASSWORD (scripts/ensure-env.sh generates one)}`.
`ensure-env.sh` generates it (`ensure_rand GRAFANA_ADMIN_PASSWORD 24`), so this
only bites a `.env.prod` assembled by hand — and it fails the **monitoring**
step, after the app is already up, which is why it reads as a puzzle.

Beyond compose, the API validates at boot:

- `MFA_MASTER_KEY` against `/^[0-9a-fA-F]{64}$/`. A typo exits the process with
  `Env var MFA_MASTER_KEY must be 64 hex characters (a 32-byte key).`
- `HASH_PEPPER` ≥ 32 characters; `SESSION_SECRET`, `ADMIN_SESSION_SECRET`,
  `IMPERSONATION_SECRET`, `STORAGE_SIGNING_SECRET` ≥ 24. Short ones exit with
  `Env var <KEY> is too short — needs at least <n> characters.` The length bar
  is skipped under `NODE_ENV=test` and the whole check is skipped under
  `development`, which is why a fixture secret works locally and not here.
- `NODE_ENV` against the allow-list `development`, `production`, `test`.
  `staging`, `prod` and `Production` are **configuration errors**, not modes —
  boot-and-config-03 / tenant-isolation-06. Four production-only protections key
  on the exact string, and a bare cast let all four switch off on a box that
  looked correctly configured.
- Four infrastructure values are `required()` outside development, with a dev
  fallback only: `CONTROL_DATABASE_URL`, `REDIS_URL`, `STORAGE_ROOT`,
  `PG_SUPERUSER_URL`. All four are compose literals here, so you cannot get this
  wrong from `.env.prod` — boot-and-config-07 is the story of `PG_SUPERUSER_URL`
  unset booting fully green, because nothing on the startup or readiness path
  touches it, and first surfacing as a tenant signup running `CREATE DATABASE`
  against `localhost` with guessable credentials.

**`STORAGE_SIGNING_SECRET` must not be a copy of `SESSION_SECRET`.** Under
`NODE_ENV=production` the API refuses to boot when the two hold the same value:

```
Error: STORAGE_SIGNING_SECRET and SESSION_SECRET hold the same value — refusing
to boot. They are deliberately different keys so a leaked storage-signing secret
cannot be turned into a session-forgery oracle, or the reverse. Generate a
distinct value for STORAGE_SIGNING_SECRET (`openssl rand -hex 32`).
```

You see it as `api` and `worker` restart-looping while `postgres`, `redis` and
`caddy` stay up — `caddy` depends on them only with `condition: service_started`,
deliberately, so the marketing vhost keeps serving normally while the app and
admin vhosts answer 502. What the deploy tells you is one line —
`stack did not become healthy within 180s (edge=… site=… api=… web=… worker=… pooler=…)`
— followed by `dc ps`. `api` and `worker` will read `missing`, because
`svc_health` resolves the container id with `docker ps -q` and a restarting
container is not in that list. **It prints no container logs**, so the sentence
naming the variable is never on your screen. `dc logs api | tail -30` is where
it is.

The reason is `GET /_files/signed`, the one storage route with no guard at all:
the token alone picks both the tenant and the object, so one key covering both
session forgery and anonymous cross-tenant file reads is exactly the oracle the
separation exists to prevent. `scripts/ensure-env.sh` generates the two
independently (`ensure_rand STORAGE_SIGNING_SECRET 32`), so the ordinary deploy
never trips this — a **hand-edited** `.env.prod` is what does. Note the shape of
the check: it is an equality test on the resolved values, so it also fires when
you paste the same freshly-generated string into both, which is the copy-paste
tenant-isolation-06 was written about.

Note that `.env.prod.example` claims to document every key, holds **37**, and
omits `HASH_PEPPER` — one of the seven compose hard-requires — along with
`APPLY_NOTIFY_TO`, `COMPOSE_PROJECT_NAME`, `LIBRIANT_DATA_ROOT`,
`EDGE_BIND_IPV4`, `PG_MAX_CONNECTIONS`, `GRAFANA_ADMIN_PASSWORD`,
`ADMIN_BOOTSTRAP_NAME`/`ROLE`, the eight `*_MEM_LIMIT`/`*_CPUS` pairs in the
prod file and the five more on the monitoring overlay, and — the omission an
owner is most likely to be bitten by — **every one of the `BACKUP_*` encryption
keys** (§4.2e). And `pnpm secrets audit` will report a healthy env file that
compose then refuses to start, because its registry is fourteen keys and does
not include `HASH_PEPPER`, `RESEND_API_KEY`, `DESKTOP_RELEASE_TOKEN` or
`GRAFANA_ADMIN_PASSWORD`.

### 4.2a Every variable, and who actually reads it

This is the whole surface. `.env.prod.example` is not a second opinion — where
the two disagree, the rows below say so and the file is wrong.

**Legend for "Reaches":** _app_ = injected into `api`/`worker`/`migrate`;
_web_ = injected into the `web` container only; _caddy_ = the Caddy container
only; _compose_ = consumed by Compose to shape infrastructure, never an env var
anywhere; _host_ = read by a script running on the host; _nothing_ = read by
code that never receives it.

#### The eight that must be right, or nothing starts

| Variable               | Reaches         | What it is                                                                                                  | If it is wrong                                                                                                                                                                | Lost forever?    |
| ---------------------- | --------------- | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `POSTGRES_PASSWORD`    | app, compose    | The `libriant` role's password. Applied at initdb and never again.                                          | Every connection fails auth. See §4.4 and the `ensure-env.sh` guard below.                                                                                                    | **Yes**          |
| `SESSION_SECRET`       | app             | HMAC key for library-user session JWTs. ≥ 24 chars.                                                         | Boot refusal if absent/short; every user logged out if changed.                                                                                                               | No               |
| `ADMIN_SESSION_SECRET` | app             | HMAC key for platform-admin session JWTs. Deliberately distinct.                                            | Same, for `admin.libriant.com`.                                                                                                                                               | No               |
| `IMPERSONATION_SECRET` | app             | HMAC key for support-impersonation JWTs. Distinct again.                                                    | Same, for live support sessions.                                                                                                                                              | No               |
| `MFA_MASTER_KEY`       | app             | 64 hex chars. AES-256-GCM key over admin TOTP secrets at rest.                                              | Boot refusal on a non-hex/short value; orphans every enrolment if changed.                                                                                                    | **Yes**          |
| `TENANT_DB_MASTER_KEY` | app             | 64 hex chars. AES-256-GCM key over each library's own Postgres password. Must differ from `MFA_MASTER_KEY`. | Boot refusal on a non-hex/short value, or when it equals `MFA_MASTER_KEY`. Changing it 500s every library until `pnpm tenant:rotate-db-creds --all` re-seals them — see §4.4. | No, but see §4.4 |
| `HASH_PEPPER`          | app             | Peppers the IP hash behind the `/apply` throttle. ≥ 32 chars.                                               | Boot refusal. Changing it resets the throttle history, nothing worse.                                                                                                         | No               |
| `PUBLIC_HOST`          | app, web, caddy | **The app host** (`app.libriant.com`), not the apex.                                                        | Compose aborts. Wrong-but-set is worse: see §4.6.                                                                                                                             | No               |

#### Secrets and credentials that are not compose-required

| Variable                   | Reaches | What it is                                                                                         | If it is wrong / missing                                                                                                   | Lost forever? |
| -------------------------- | ------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------- |
| `STORAGE_SIGNING_SECRET`   | app     | HMAC key for `GET /_files/signed` tokens. Passed through as `${…:-}` — empty at the compose layer. | Empty ⇒ `Missing required env var: STORAGE_SIGNING_SECRET` in production. Equal to `SESSION_SECRET` ⇒ boot refusal (§4.2). | No            |
| `GRAFANA_ADMIN_PASSWORD`   | —       | Grafana's `admin` login. `${…:?}` on the monitoring overlay.                                       | The monitoring step of the deploy fails, after the app is already up.                                                      | No            |
| `ADMIN_BOOTSTRAP_EMAIL`    | migrate | First platform admin. Left blank ⇒ admin creation skipped.                                         | Nothing is created and `prod-bootstrap.sh` prints `[bootstrap] ADMIN_BOOTSTRAP_* not set - skipping admin creation`.       | No            |
| `ADMIN_BOOTSTRAP_PASSWORD` | migrate | Plaintext, bcrypt-hashed before insert. Written single-quoted by `ensure-env.sh`.                  | **Re-applied on every deploy while it is present.** That is the only admin password reset there is — §4.5.                 | No            |
| `ADMIN_BOOTSTRAP_NAME`     | nothing | Optional; defaults to `Libriant Owner`.                                                            | Never injected. Set it in the `dc run` invocation, not in `.env.prod`.                                                     | No            |
| `ADMIN_BOOTSTRAP_ROLE`     | nothing | Optional; `owner` \| `support`, defaults to `owner`.                                               | Never injected. Same.                                                                                                      | No            |
| `STRIPE_API_KEY`           | app     | `sk_live_…`. Only meaningful with `STRIPE_DRIVER=real`.                                            | With `real` and no key, the real driver throws at construction and the API will not start.                                 | No            |
| `STRIPE_WEBHOOK_SECRET`    | app     | `whsec_…`. Same condition.                                                                         | Same.                                                                                                                      | No            |
| `SMTP_URL`                 | app     | `smtp://user:pass@host:587`. Required by `EMAIL_DRIVER=smtp`.                                      | `EMAIL_DRIVER=smtp requires SMTP_URL (e.g. smtp://user:pass@host:587).` — thrown at driver construction.                   | No            |
| `RESEND_API_KEY`           | app     | `re_…`. Required by `EMAIL_DRIVER=resend`.                                                         | `EMAIL_DRIVER=resend requires RESEND_API_KEY (re_...).`                                                                    | No            |
| `DESKTOP_RELEASE_TOKEN`    | app     | GitHub PAT, `Contents: Read-only` on the release repo.                                             | **The in-panel desktop download 404s**, because the repo is private. Nothing else breaks, and nothing warns.               | No            |

#### Hosts, drivers and behaviour

| Variable               | Reaches         | Default if unset                                                    | What it does                                                                                                                                                                                                                         |
| ---------------------- | --------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `PUBLIC_APEX_DOMAIN`   | app             | compose `libriant.com`; code `localhost`                            | Tenant-subdomain resolution, the CSRF Origin allow-list, and the derivation of `EMAIL_FROM`, `APPLY_NOTIFY_TO` and `ADMIN_HOST`. Not cookie scope.                                                                                   |
| `SITE_HOST`            | app, caddy      | `libriant.com` in both                                              | The marketing vhost. Lower-cased by the app.                                                                                                                                                                                         |
| `ADMIN_HOST`           | app, web, caddy | `admin.libriant.com`                                                | Excluded from tenant resolution; the only Origin allowed for state-changing `/admin/*`; the web app 404s `/admin` on any other host.                                                                                                 |
| `ACME_EMAIL`           | caddy           | `ops@libriant.com`                                                  | **Dead.** All four live vhosts `import cloudflare_origin`, which serves a file certificate. No ACME order is ever placed.                                                                                                            |
| `MAINTENANCE_HARD`     | caddy           | `false`                                                             | Edge takeover on the app and admin vhosts only — the marketing vhost deliberately does not import it. Matches the literal `true` and nothing else.                                                                                   |
| `EMAIL_FROM`           | app             | `Libriant <no-reply@${PUBLIC_APEX_DOMAIN}>`                         | The `From:` envelope. From the **apex**. `.env.prod.example` and the JSDoc in `config/env.ts` both say `PUBLIC_HOST`; both are wrong.                                                                                                |
| `EMAIL_REPLY_TO`       | app             | none                                                                | Optional `Reply-To:`.                                                                                                                                                                                                                |
| `APPLY_NOTIFY_TO`      | app             | `info@libriant.com` (compose) / `info@${PUBLIC_APEX_DOMAIN}` (code) | Where marketing-form applications are notified. Absent from the template **and** from `ensure-env.sh`, so you would never see it.                                                                                                    |
| `EMAIL_DRIVER`         | app             | passed through **unset**                                            | `console` \| `smtp` \| `resend`. Unset in production resolves to `smtp`, which then refuses to boot without `SMTP_URL` — that fail-fast is deliberate and `ensure-env.sh` fills it with `console` before you ever meet it. See §4.3. |
| `STRIPE_DRIVER`        | app             | `none`                                                              | `real` \| `none` (aliases `off`, `disabled`) \| `fake`. An unrecognised value **throws**. See §4.3.                                                                                                                                  |
| `BILLING_ENABLED`      | app             | `false`                                                             | Env value is only the fallback; the `platform_settings` DB row wins. See §4.3.                                                                                                                                                       |
| `DESKTOP_RELEASE_REPO` | app             | `CyberSystema/libriant`                                             | Where `desktop-v*` installers are published.                                                                                                                                                                                         |

#### Compose-consumed — real, and invisible to `docker exec … env`

| Variable                 | Default in compose | What it shapes                                                                                                                                                                                                                                                                                         |
| ------------------------ | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `IMAGE_OWNER`            | `libriant`         | The `ghcr.io/<owner>/libriant-*` namespace. Irrelevant on the manual build path; matters only if you pull.                                                                                                                                                                                             |
| `IMAGE_TAG`              | `latest`           | Which image tag runs. **`deploy-on-host.sh` exports the git SHA over whatever the file says**, deliberately and after sourcing. Editing it in `.env.prod` to roll back does not work — §6.1.                                                                                                           |
| `LIBRIANT_DATA_ROOT`     | `/mnt/libriant`    | The bind device for `pg_data`, `redis_data`, `storage`, `caddy`. Also re-exported by `deploy-on-host.sh` — set it in the **shell**, not the file.                                                                                                                                                      |
| `COMPOSE_PROJECT_NAME`   | `libriant`         | Container and volume name prefix. Also re-exported by `deploy-on-host.sh`.                                                                                                                                                                                                                             |
| `EDGE_BIND_IPV4`         | `0.0.0.0`          | The host address Caddy's 80/443 publish on. **IPv4 on purpose** — authn-authz-01. Changing it is one of four changes that must be made together; read the note above `ports:` first.                                                                                                                   |
| `PG_MAX_CONNECTIONS`     | `200`              | Postgres `max_connections` **and** the number the API/worker plan their tenant pools against. boot-and-config-02 made it one variable; do not re-split it.                                                                                                                                             |
| `PG_STATEMENT_TIMEOUT`   | `60s`              | Postgres server-level `statement_timeout`. §4.2c.                                                                                                                                                                                                                                                      |
| `PG_IDLE_TX_TIMEOUT`     | `120s`             | Postgres `idle_in_transaction_session_timeout`. §4.2c.                                                                                                                                                                                                                                                 |
| `REDIS_MAXMEMORY`        | `320mb`            | Redis `--maxmemory`, with `--maxmemory-policy noeviction`. §4.2d. **The template ships `384mb`, which is not the same number.**                                                                                                                                                                        |
| `*_MEM_LIMIT` / `*_CPUS` | see below          | Per-container caps. `CADDY` 256m/1, `API` 1g/1.5, `WEB` 768m/1, `WORKER` 1g/1, `PG` 2g/2, `PGBOUNCER` 256m/0.5, `PGBOUNCER_PROBE` 128m/0.25, `REDIS` 512m/1. On the monitoring overlay: `PROM` 512m/0.5, `NODE_EXPORTER` 128m/0.25, `ALERTMANAGER` 128m/0.25, `CADVISOR` 256m/0.5, `GRAFANA` 384m/0.5. |
| `PROM_RETENTION_SIZE`    | `2GB`              | Prometheus TSDB size cap.                                                                                                                                                                                                                                                                              |
| `LIBRIANT_APP_NETWORK`   | `libriant_app`     | The external network the monitoring stack joins.                                                                                                                                                                                                                                                       |

#### Host-script-only

These never touch Compose. They work because the cron line and the deploy script
source `.env.prod` into their own shell. Full treatment in §8; here is what they
are.

| Variable                       | Read by                               | What it does                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------ | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `API_INSTANCES`                | `tenant-pool-budget.ts`               | How many `api` containers hold tenant connections at once. Default **1**, because `dc up -d --force-recreate` is stop-then-start. **Set it if you ever scale out** — at the shipped numbers a second instance puts the fleet 62 connections over `max_connections`, and the worker's boot line is where that is reported (`fleet connections: …; OVER BUDGET: …`). |
| `RCLONE_REMOTE`                | `backup.sh`                           | The off-site destination. **Unset makes the nightly exit non-zero on purpose** unless `BACKUP_ALLOW_LOCAL_ONLY=1`.                                                                                                                                                                                                                                                 |
| `BACKUP_KEEP_DAYS`             | `backup.sh`                           | Local and remote retention. Default 14.                                                                                                                                                                                                                                                                                                                            |
| `BACKUP_ROOT`                  | `backup.sh`                           | Default `/srv/libriant/backups` — the **boot disk**. `install-server.sh` writes the cron line with `BACKUP_ROOT=<data root>/backups` inline, which beats anything the env file says.                                                                                                                                                                               |
| `BACKUP_AGE_RECIPIENT`         | `_lib/backup-crypt.sh`                | An `age1…` **public** key. The preferred mode, because the matching identity stays off this host. §4.2e.                                                                                                                                                                                                                                                           |
| `BACKUP_AGE_RECIPIENTS_FILE`   | `_lib/backup-crypt.sh`                | A file of recipients, one per line, `#` comments allowed. Alternative to the above.                                                                                                                                                                                                                                                                                |
| `BACKUP_AGE_IDENTITY_FILE`     | `_lib/backup-crypt.sh` (restore only) | The **secret** half. Needed to decrypt. Must not live on the app host.                                                                                                                                                                                                                                                                                             |
| `BACKUP_GPG_PASSPHRASE_FILE`   | `_lib/backup-crypt.sh`                | Path to a non-empty, readable file holding a passphrase. The fallback mode.                                                                                                                                                                                                                                                                                        |
| `BACKUP_ALLOW_PLAINTEXT`       | `_lib/backup-crypt.sh`                | `1` = a deliberate unencrypted backup. Marks every run degraded, and **aborts outright if `RCLONE_REMOTE` is also set**.                                                                                                                                                                                                                                           |
| `BACKUP_ALLOW_LOCAL_ONLY`      | `backup.sh`                           | `1` = "I know there is no off-site copy". Turns the nightly failure into a warning.                                                                                                                                                                                                                                                                                |
| `BACKUP_HEARTBEAT_URL`         | `backup.sh`                           | External dead-man's switch. The only alert that survives losing this host.                                                                                                                                                                                                                                                                                         |
| `BACKUP_TEXTFILE_DIR`          | `backup.sh`                           | Where the node-exporter textfile metrics are written. Default `/var/lib/node_exporter/textfile`.                                                                                                                                                                                                                                                                   |
| `BACKUP_ALLOW_NO_STORAGE`      | `backup.sh`                           | `1` = proceed with no resolvable storage directory. Do not set it to make an error go away.                                                                                                                                                                                                                                                                        |
| `BACKUP_ALLOW_OFFHOST_TENANTS` | `backup.sh`                           | `1` = proceed when a tenant's database is not on this host.                                                                                                                                                                                                                                                                                                        |

#### Read by the app, injected by nothing

The code default is what runs. Listed in §4.1; the ones you are most likely to
want and cannot have from `.env.prod`:

| Variable                                            | Code default                                        | Why you might reach for it                                                                                                                                            |
| --------------------------------------------------- | --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ADMIN_MFA_REQUIRED`                                | `true` outside development                          | You cannot turn admin MFA off from the env file. §4.5a.                                                                                                               |
| `MAX_FAILED_LOGINS` / `LOGIN_LOCKOUT_MS`            | 5 / 900000 ms                                       | The lockout in §4.5b.                                                                                                                                                 |
| `SESSION_TTL_SEC` / `_REMEMBER_` / `_ABSOLUTE_MAX_` | 7 d / 30 d / 90 d                                   | Session lifetimes.                                                                                                                                                    |
| `TENANT_CLIENT_CACHE_SIZE` / `TENANT_DB_POOL_MAX`   | 50 / 5                                              | The tenant connection budget. `PG_MAX_CONNECTIONS` **is** injected and is the lever that works.                                                                       |
| `PG_RESERVED_CONNECTIONS`                           | 30                                                  | Same budget.                                                                                                                                                          |
| `TRUSTED_PROXY_CIDRS`                               | the private ranges + loopback + link-local          | Narrowing this to the Caddy container alone is a real hardening step, and it needs a compose edit. A malformed value throws at boot, not on the first request.        |
| `SIGNUP_MAX_CONCURRENT_PROVISIONING`                | 16                                                  | The unauthenticated-signup admission control. A non-positive-integer value logs `[auth] SIGNUP_MAX_CONCURRENT_PROVISIONING="…" is not a positive integer — using 16.` |
| `LEGAL_ARCHIVE_ROOT`                                | `<repo>/docs/legal/accepted`, copied into the image | Only override it in a test.                                                                                                                                           |
| `STORAGE_MAX_UPLOAD_BYTES`                          | 25 MiB                                              | Per-request ceiling; the real quota is per plan.                                                                                                                      |

### 4.2b Checking what a container actually got

The env file is not evidence. The container is.

```bash
dc exec api sh -lc 'printenv | sort' | grep -E 'PUBLIC_HOST|PUBLIC_APP_URL|EMAIL_DRIVER|STRIPE_DRIVER|PG_MAX_CONNECTIONS'
```

Good looks like: **four lines, and `PUBLIC_HOST` is not one of them.** You get
`PUBLIC_APP_URL`, `EMAIL_DRIVER`, `STRIPE_DRIVER` and `PG_MAX_CONNECTIONS` —
all four are named in `x-app-env` (`docker-compose.prod.yml:58`, `:104`, `:92`,
`:129`) and the `api` service's `environment:` is `<<: *app-env` plus
`PORT: '3001'` and nothing else (`:358-360`).

`PUBLIC_HOST` is absent from a **perfectly healthy** box, and that is the whole
lesson of this section. It is a `${VAR:?}` hard requirement (§4.2), it is the
most load-bearing name in the file — and the only service that receives it as a
key is `caddy` (`:277`). Everywhere else Compose _consumes_ it to derive
something and hands the app only the derived value: `PUBLIC_APP_URL` and
`BILLING_RETURN_URL` in `x-app-env` (`:58`, `:95`), `NEXT_PUBLIC_API_URL` and
`PUBLIC_APP_URL` on `web` (`:421-422`). That is category 2 of §4.1 in the flesh.
Do not go looking for it in `api` and conclude the deploy is broken.

A variable you set in `.env.prod` and cannot find here is in category 2, 3 or 5
of §4.1 — and only for 3 and 5 does editing the file again fail to change
anything. For category 2, verify it at the thing it configures (§4.2c, §4.2d),
never at `printenv`.

For duplicates — the shell keeps the **last** assignment, and `ensure-env.sh`'s
own reader keeps the **first**, so a duplicated key is a genuine disagreement
between the script and the deploy:

```bash
grep -oE '^[A-Za-z_][A-Za-z0-9_]*=' /srv/libriant/.env.prod | sort | uniq -d
```

Good looks like: no output.

### 4.2c The Postgres timeouts, and what is exempt

performance-14. Nothing anywhere bounded a tenant query. A runaway — a lock wait
nobody notices, a plan that flips to a sequential scan after a bad `ANALYZE` —
held one of that library's five pool slots for as long as it liked, and five of
them wedged the library completely with no recovery short of an operator running
`pg_terminate_backend` by hand.

Both are passed to the `postgres` container as server flags, not in a connection
string, because the per-tenant URL is written into `tenants.db_url` at signup: a
change made there would apply to libraries provisioned afterwards and to no
existing one.

| Variable               | Default | Postgres setting                      |
| ---------------------- | ------- | ------------------------------------- |
| `PG_STATEMENT_TIMEOUT` | `60s`   | `statement_timeout`                   |
| `PG_IDLE_TX_TIMEOUT`   | `120s`  | `idle_in_transaction_session_timeout` |

60s and not 30s because the longest legitimate single statement the product
issues is the export worker's, and its author already picked 60s as the line
between slow and broken (`STATEMENT_TIMEOUT_MS` in
`apps/api/src/export/export-processors.ts`). Nothing a librarian waits on in a
browser survives a tenth of that. There is deliberately **no `lock_timeout`**: a
statement blocked on a lock is still a running statement, so `statement_timeout`
already bounds it, and a separate `lock_timeout` would abort a migration waiting
legitimately behind a long read.

Confirm the server really has them:

```bash
dc exec postgres psql -U libriant -d libriant_control -c 'SHOW statement_timeout;'
```

Good looks like: `1min`. Postgres normalises `60s`, so a literal `60s` back is
not what you are waiting for. `SHOW idle_in_transaction_session_timeout;` gives
`2min`.

**What this deliberately does not kill — checked, not assumed:**

- **Backups and restores.** `pg_dump`/`pg_dumpall` set `statement_timeout = 0` on
  their own connection **and write it into the dump prologue**, so `backup.sh`,
  `restore.sh`, `dr-drill.sh` and the export worker's `pg_dump` are exempt by
  construction — nothing in our scripts has to remember to do it. Measured
  against a cluster running these flags: `pg_dump` exit 0, and the dump opens
  with `SET statement_timeout = 0; SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;`, restore exit 0.
- **Migrations.** Prisma runs each migration file in one session, so a migration
  expected to run long must **open with `SET statement_timeout = 0;`**. There is
  no other hook — the migrate container gets the same server.
- **Imports.** `statement_timeout` is per STATEMENT. The import engine commits
  one record per transaction out of a handful of small writes, so a two-hour
  import of a 400k-record catalogue is never one statement, and it never sits
  idle inside a transaction either.

> **Your own `psql` session is not exempt.** A reindex, a `VACUUM FULL`, a
> one-off `UPDATE` across a large table: 60 seconds and Postgres cancels it, and
> what you see is `ERROR: canceling statement due to statement timeout` in the
> middle of an incident. Open the session with
> `PGOPTIONS='-c statement_timeout=0' psql …` — verified to reach the server
> both through libpq and through the app's own Prisma/pg adapter. Raise
> `PG_STATEMENT_TIMEOUT` for a maintenance window rather than removing it.

### 4.2d `REDIS_MAXMEMORY` moves with three other numbers

reliability-18. Redis had a 512 MB cgroup ceiling and no `maxmemory`, so it grew
until the kernel OOM-killed it — a full outage rather than an eviction. Worse,
the compose file carried `--maxmemory-policy allkeys-lru` with no `--maxmemory`
above a comment explaining that eviction must never drop a live BullMQ job key:
a policy is inert without a limit, so the line configured nothing while reading
like a protection, and the policy it named was the exact behaviour the comment
said would lose jobs.

It is now `--maxmemory ${REDIS_MAXMEMORY:-320mb} --maxmemory-policy noeviction`.
With `noeviction` Redis never drops a key; at the ceiling it refuses **writes**
with an OOM error the app sees and logs, while reads and the existing queues
keep working. A Redis that dies is not a degraded cache here, it is a 100 %-500
API.

Four numbers, and they must agree:

| Where                                                         | Value                                                            |
| ------------------------------------------------------------- | ---------------------------------------------------------------- |
| `REDIS_MEM_LIMIT` (compose `mem_limit`)                       | `512m`                                                           |
| `REDIS_MAXMEMORY` (compose default)                           | `320mb`                                                          |
| `LibriantRedisMemoryHigh` (`infra/monitoring/alerts.yml`)     | `libriant_redis_used_memory_bytes > 234881024` — 70 % of 320 MiB |
| `LibriantRedisMemoryCritical` (`infra/monitoring/alerts.yml`) | `libriant_redis_used_memory_bytes > 301989888` — 90 % of 320 MiB |

The two alert numbers are **absolute bytes, hard-coded**, because nothing
exports Redis's own `maxmemory` as a metric. `alerts.yml` says so in its own
comment: _"If `REDIS_MAXMEMORY` moves in compose, both move here."_ Raising
`REDIS_MEM_LIMIT` alone leaves Redis refusing writes with the RAM unused;
raising `REDIS_MAXMEMORY` alone puts the OOM-killer back in charge; moving
either without the alerts leaves you with a warning that no longer means what
its own summary text says. For scale: the audited instance carrying 50 seeded
tenants plus BullMQ used 1.4 MB.

> **The template and the compose default do not agree today.**
> `.env.prod.example` ships `REDIS_MAXMEMORY=384mb`; the compose fallback is
> `320mb`; the alert thresholds are 70 % and 90 % **of 320 MiB**. `ensure-env.sh`
> copies every template line whose key is absent from `.env.prod`, so any host
> provisioned or re-run since that line was added has **384 MiB**, and on that
> host `LibriantRedisMemoryHigh` fires at 58 % and `LibriantRedisMemoryCritical`
> at 75 % — both earlier than their own summaries claim, and 384 MiB of a 512 MiB
> cgroup leaves less headroom for the AOF-rewrite fork than the 320 the compose
> comment reasons about. Read the real value off the running server before you
> trust either file. (The percentages assume Redis reads `mb` as MiB.
> UNVERIFIED by execution here — there is no Redis on the workstation this was
> written on — but it is the arithmetic `alerts.yml` itself does, "234881024 is
> 70% of 320 MiB", so the repository is at least self-consistent about it.)

```bash
dc exec redis redis-cli config get maxmemory maxmemory-policy
```

Good looks like: four lines — `maxmemory`, the byte count, `maxmemory-policy`,
`noeviction`. `402653184` means the template's 384 MiB is in force;
`335544320` means the compose default of 320 MiB is. `0` means **no ceiling at
all** and you are back in reliability-18.

### 4.2e Backup encryption: the keys that are not in the template

This is the variable-reference view. **§8.1a is the decision** — which mode to
choose, how to generate the key, where it must and must not live, and what a
lost key costs. Read that before you set any of these.

`scripts/_lib/backup-crypt.sh` resolves exactly one of three modes, and
**refuses to run with none of them**. This is why a freshly installed nightly
can abort before the first byte, every night, in a log nobody reads.

| Mode   | Set                                                                            | Restore needs                                                                      |
| ------ | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| `age`  | `BACKUP_AGE_RECIPIENT` (an `age1…` public key) or `BACKUP_AGE_RECIPIENTS_FILE` | `BACKUP_AGE_IDENTITY_FILE` — **the secret half, which must not live on this host** |
| `gpg`  | `BACKUP_GPG_PASSPHRASE_FILE` (a path to a non-empty, readable file)            | the same file                                                                      |
| `none` | `BACKUP_ALLOW_PLAINTEXT=1`                                                     | nothing                                                                            |

With none of them set, `backup.sh` prints

```
backup-crypt: NO ENCRYPTION CONFIGURED.
              The DPA we ask municipalities to sign says backups are encrypted,
              and a plaintext pg_dumpall is the entire member registry of every
              library on this host. Set ONE of:
```

and exits 1. Setting **two** is also refused — "two half-configured schemes are
how a backup ends up encrypted to a key nobody kept."

Four things worth knowing before you choose:

- **`age` is preferred precisely because `BACKUP_AGE_IDENTITY_FILE` stays off
  this host.** A host compromise then cannot open yesterday's off-site copy.
  `install-server.sh` refuses an `AGE-SECRET-KEY…` pasted into the recipient
  prompt for that reason.
- **`BACKUP_AGE_RECIPIENT` set without the `age` binary installed aborts every
  run.** So does a `BACKUP_GPG_PASSPHRASE_FILE` that root can read and the cron
  user cannot — the cron runs as `deploy`, and testing readability as root
  proves nothing.
- **`BACKUP_ALLOW_PLAINTEXT=1` together with `RCLONE_REMOTE` is a hard abort**,
  not a warning: `ABORT: BACKUP_ALLOW_PLAINTEXT=1 with RCLONE_REMOTE set.` A
  plaintext dump of every member registry on a third-party storage box is the
  exposure the DPA rules out. Plaintext is permitted only local-only, and it
  marks every run degraded.
- **`BACKUP_AGE_IDENTITY_FILE` belongs in §4.4's irrecoverable list.** Lose it
  and every encrypted archive you hold is a file nobody can open. It is the one
  Libriant secret that is deliberately _not_ on this machine, so it is also the
  one no backup of this machine contains.

> `KEY=` is not the same as absent, and this cost someone a night.
> `ensure-env.sh` copies every key from `.env.prod.example` that is missing from
> your file, several of them **with an empty value**. An older writer treated
> `BACKUP_AGE_RECIPIENT=` as "already set — left alone" and threw the operator's
> typed answer away, while the backup's own detection (which reads the value)
> correctly said "not configured". The result was a cron the operator watched
> being installed and a `backup.sh` that aborted nightly. `install-server.sh`'s
> writer now treats an empty value as absent and fills it in place. If you edit
> by hand, check the **value**, not the presence of the line.

### 4.2f Retention: five keys in the template, three that are real, none that reach a container

performance-07 / privacy-legal-05. The retention sweep is written, registered
and runs nightly, and every limb it governs is off until somebody publishes a
period. That is deliberate — how long Libriant keeps each of these is a decision
for the Privacy Policy §6 table, not for an engineer. But the template's five
blank lines invite an owner to answer it there, and **three of the five would
have no effect if they did, and two of them do not exist at all.**

| Template key                       | Actually read from the environment?                                    | Floor  | Reaches a container? |
| ---------------------------------- | ---------------------------------------------------------------------- | ------ | -------------------- |
| `CONTROL_AUDIT_RETENTION_DAYS`     | yes, by `retention.job.ts`                                             | 1 day  | **No**               |
| `EMAIL_OUTBOX_BODY_RETENTION_DAYS` | yes                                                                    | 2 days | **No**               |
| `SUPPORT_ATTEMPT_RETENTION_DAYS`   | yes                                                                    | 1 day  | **No**               |
| `STRIPE_PAYLOAD_RETENTION_DAYS`    | **no** — a hard-coded `30` in `retention.job.ts`                       | —      | No                   |
| `APPLICATION_RETENTION_MONTHS`     | **no** — a hard-coded `12`, and the published applicant notice says 12 | —      | No                   |

None of the five is named anywhere in `docker-compose.prod.yml`, so all five sit
in category 5 of §4.1: put a number in `.env.prod`, restart, and the sweep still
reports the limb as unconfigured. To turn one on today you have to add it to the
`x-app-env` block, which is a commit — `deploy-on-host.sh` will `git reset
--hard` a host-local edit away.

**§8.6 is the other half of this** — what each limb actually deletes, why the
floors are what they are, and why it is in the backup chapter (every row the
sweep does not delete is in tonight's backup, and in every backup after it,
forever). This section is only about whether the key reaches a process.

The floors are refusals, not clamps: a value below the floor is logged and the
limb is skipped entirely, because a retention job acting on a value it does not
understand is the one way it can do more damage than not running at all.

```
refusing to enforce EMAIL_OUTBOX_BODY_RETENTION_DAYS="0": it must be a whole number of days, at least 2. Nothing was deleted for that limb.
```

The email-body floor is 2 days rather than 1 because it is derived: the longest
one-time link the system mints is the 24-hour e-mail-verification token, plus a
day because the cutoff is measured from `createdAt`. With `EMAIL_DRIVER=console`
the admin outbox **is** the delivery mechanism (§4.3a), so blanking a body early
strands the person it was written for.

Two rows are never swept whatever the period says: control-plane audit actions
`tenant.legal_accepted` and `tenant.deleted`. They are the Art. 7(1) evidence and
the deletion record — one row per library, and the ones a regulator actually asks
for.

What the sweep says about these three when nothing is configured, which is
today — these are the **last three clauses of a single-line message**, not three
lines. `retention.job.ts:304-326` builds six clauses in a fixed order and joins
them with `'; '`; the three below are clauses 4, 5 and 6, and `applications:`,
`stripe payloads:` and `audit_log:` come first. §8.6 quotes the whole line:

```
… ; control audit_log: not configured (CONTROL_AUDIT_RETENTION_DAYS unset — Privacy Policy §6); email bodies: not configured (EMAIL_OUTBOX_BODY_RETENTION_DAYS unset — Privacy Policy §6); support attempts: not configured (SUPPORT_ATTEMPT_RETENTION_DAYS unset — Privacy Policy §6)
```

Good looks like: those three clauses present, in that order, at the end of one
line. Grepping for `email bodies:` on a line of its own finds nothing and does
not mean the sweep truncated — it means you are looking for the wrong shape. It
means the sweep ran and honestly reported that nobody has published a period,
not that it failed. What it also means is that **the control database grows
forever**, so these are not optional so much as unanswered.

### 4.2g Configured, and decorative

Things the panel or the catalogue will happily let you set, that change nothing.

- **`api_access_enabled`, `custom_subdomain_enabled`, `priority_support`** —
  three plan features. launch-readiness-16 forced all three to `false` on every
  plan, in a data migration, because the website says in writing that none of
  them exists: `/en/security` — _"No. There is no programming interface"_ —
  and `/en/about` — _"we do not sell tiers of support"_. A custom subdomain
  cannot be served at all: the `*.{$PUBLIC_APEX_DOMAIN}` vhost in
  `infra/caddy/Caddyfile` is commented out end to end and would need a DNS-01
  wildcard certificate nobody has provisioned. The keys stay in the catalogue and
  the admin plan editor still lists them, so the day one is built it is one
  `UPDATE` away from being true. **Setting any of them to `true` today makes the
  admin panel say something the product cannot do**, which is what the finding
  costs: the admin who opens `/admin/plans` while a librarian is on the phone and
  reads "API access: yes" off a Municipal plan.
- **`ACME_EMAIL`** — every vhost serves a file certificate; no ACME order is ever
  placed.
- **`IMAGE_TAG` and `COMPOSE_PROJECT_NAME` in `.env.prod`** — `deploy-on-host.sh`
  exports over both, after sourcing, on purpose.
- **`STRIPE_PAYLOAD_RETENTION_DAYS`, `APPLICATION_RETENTION_MONTHS`** — §4.2f.
- **`RATE_LIMIT_DISABLED`** — decorative on purpose, three times over (§4.1).

### 4.3 The production landmines

| Variable           | Value now | What it actually does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Blocker               |
| ------------------ | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| `STRIPE_DRIVER`    | `none`    | Fixed 2026-08-24. Three postures now: `real`, `disabled` (the shipped default — no driver is constructed, billing operations refuse, and `POST /webhooks/stripe` answers 503 before reading a byte) and `fake`, which only exists for a declared `development`/`test` NODE_ENV. A legacy `.env.prod` still saying `fake` DOWNGRADES to `disabled` with a loud error rather than refusing to boot. The one configuration refused outright is `BILLING_ENABLED=true` with no driver that can transact. | `billing-02` — closed |
| `EMAIL_DRIVER`     | `console` | Nothing is delivered — there is no Resend key, and that is expected for this launch. It is **no longer a dead end**: an owner admin can recover any account from the panel. See §4.3a. Do NOT go looking in `docker logs api`; the body is withheld under `NODE_ENV=production`.                                                                                                                                                                                                                     | `launch-readiness-01` |
| `BILLING_ENABLED`  | `false`   | Not authoritative. `PlatformSettingsService` reads a `platform_settings` DB row and only falls back to the env value when the row is absent; the owner-only admin **Subscriptions** toggle writes that row. Enforcement-on **is** now cross-validated against the driver, on both paths — see the driver table below the box. Read §4.3c before you touch it.                                                                                                                                        | `billing-04`          |
| `MAINTENANCE_HARD` | `false`   | Caddy-only edge takeover. **UNVERIFIED whether it works at all** — see §9.10.                                                                                                                                                                                                                                                                                                                                                                                                                        | —                     |

**`STRIPE_DRIVER` is resolved by `apps/api/src/billing/stripe-driver-kind.ts`,
not by `config/env.ts`.** `AppEnv.stripeDriver` is still typed `'real' | 'fake'`
and would report `real` for `STRIPE_DRIVER=none` in production; nothing in the
current source consumes it any more. The authority reads the raw variable,
deliberately, because `loadEnv()` defaults an unset `NODE_ENV` to `development`
and deciding "may this host have the fake driver?" from that value means an
operator can obtain the fake driver simply by not setting `NODE_ENV`.

| `STRIPE_DRIVER`             | Result                                                                                                                                                                                                                                                                    |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `real`                      | Stripe API. The real driver's constructor throws without both keys.                                                                                                                                                                                                       |
| `none` / `off` / `disabled` | No driver. Every billing action refuses; `POST /webhooks/stripe` answers 503.                                                                                                                                                                                             |
| `fake`                      | Only with a **raw** `NODE_ENV` of `development` or `test`. Anywhere else it downgrades to `disabled` with an error naming the fix — a downgrade rather than a refusal, so the hosts provisioned with `fake` before the fix do not crash-loop on the deploy that ships it. |
| unset                       | `real` if both Stripe keys are present (the operator plainly intends to charge and forgot the switch), otherwise `disabled` — or `fake` on a raw dev/test box.                                                                                                            |
| anything else               | **Throws.** `STRIPE_DRIVER="…" is not a recognised value.`                                                                                                                                                                                                                |

There is exactly one hard refusal, and it is at boot:

```
BILLING_ENABLED is on but no Stripe driver is available (STRIPE_DRIVER=none, NODE_ENV=production) — refusing to start. Plan and quota enforcement would gate every library with no way to purchase. Set STRIPE_DRIVER=real with STRIPE_API_KEY + STRIPE_WEBHOOK_SECRET, or turn BILLING_ENABLED off.
```

The admin-panel path is guarded separately and refuses with
`Cannot enable subscriptions while STRIPE_DRIVER resolves to "disabled"`, so
`billing-02`'s "nothing cross-validates enforcement-on against the driver" no
longer holds on either path.

**`EMAIL_DRIVER=console` announces itself at boot now**, at `error` level, in a
box — `launch-readiness-01`. It used to warn only per-send, in the middle of
ordinary traffic, so an operator could bring the platform up, watch it come up
clean, and not learn that no mail leaves the box until a librarian phoned. The
banner names `https://<ADMIN_HOST>/en/admin/emails` and
`…/en/admin/account-recovery`. Bodies are still withheld from the log because
they carry one-time links.

`ensure-env.sh` writes `EMAIL_DRIVER=console` only when the key is **empty or
absent**, and when it does it prints its own five-line warning rather than one
quiet `set EMAIL_DRIVER=console` among thirty others (`boot-and-config-05`). The
compose file still passes `EMAIL_DRIVER` through unset so that a forgetful
operator would meet `env.ts`'s fail-fast; `ensure-env.sh` fills the gap before
they get there. The two files no longer assert opposite policies — one chooses
the launch posture, the other refuses to choose for you.

`STRIPE_DRIVER=fake` is the one value `ensure-env.sh` **actively rewrites**, on
every run, printing
`migrated STRIPE_DRIVER=fake -> none (the stand-in driver is dev/test only)`.
Everything else it writes is `ensure_default`, which only fills a blank — so a
value you set by hand survives every subsequent deploy.

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
> - `billing-02` — **closed.** `STRIPE_DRIVER=fake` can no longer be in force on
>   this box (it downgrades to `disabled`), the API refuses to boot with
>   `BILLING_ENABLED=true` and no driver that can transact, and the admin toggle
>   refuses separately. See the driver table below.
> - `billing-03` — **closed.** A plan change no longer opens a second Stripe
>   subscription: `stripe-real.driver.ts` updates the live one in place, an
>   in-flight Checkout session is expired before a second one can be opened, and
>   `billing.duplicate-purchase.spec.ts` pins the window the in-flight marker
>   cannot close. This is what `checkout.session.completed` is doing in §4.3b's
>   event table.
> - **`BLOCKER billing-04`** — still open. There is **no VAT anywhere in the
>   billing path**: nothing in `apps/api/src/billing/` sets `automatic_tax`,
>   collects a tax id or collects an address. A Greek public library cannot book
>   the receipt, and roughly 24% of every euro collected is unaccounted for.
>   Blocks the first paying customer, and it is the only one of the three left.
>
> `billing-04` is why a public launch on the free offer is legitimate and taking
> money is not.
>
> **§4.3b** is what you run before the toggle — the two pre-flight checks the
> old go-live document asked for in words and gave no way to perform — and
> **§4.3c** is the screen that answers both of them plus the one they missed.

### 4.3b Before you flip subscriptions on: the two checks, and the commands that perform them

Both of these used to be sentences with no way to carry them out. That is worse
than an unwritten step: a reader ticks them off.

**1. Is any library already over the cap it is about to be enforced against?**

While `BILLING_ENABLED` is false every effective limit is the unlimited
sentinel, so a library can spend twelve free months growing past a Starter cap
with nothing to stop it. The flip makes those caps bite at once, and the first
thing the library hears is a 402 in the middle of accessioning a delivery.

```bash
# Owner or support session on the ADMIN host.
# Note the /lbr-api prefix: on the admin vhost Caddy only routes the API under
# `handle_path /lbr-api/*` and sends everything else to Next, so the bare path
# reaches the web app and 404s. Same convention as the system-mode calls below.
curl -s -b "$ADMIN_COOKIE" https://<ADMIN_HOST>/lbr-api/admin/plan-usage/over-cap | jq
```

It counts every **active** library against its **contracted** plan — deliberately
not the effective one, which before the flip is unlimited for everybody and
would make the check unable to fail — using the same counters `QuotaInterceptor`
refuses on, so the answer is about the refusal a librarian will actually meet.

```json
{
  "checkedAt": "2026-08-26T20:52:57.049Z",
  "billingEnabled": false,
  "tenantsChecked": 136,
  "ok": false,
  "overCap": [
    {
      "slug": "…",
      "name": "…",
      "plan": "starter",
      "breaches": [{ "feature": "staff_seats", "limit": 3, "used": 4 }]
    }
  ],
  "unreadable": []
}
```

Go ahead only on `"ok": true`. `ok` is false while **either** list is non-empty:
a library whose database could not be read lands in `unreadable`, because "we
could not look" must not be reported as "nothing found". A library that IS over
needs a plan change, an override, or a conversation — before the switch, not
after. The report costs one `COUNT(*)` per int feature per library and walks
tenants one at a time; on a fleet of a few hundred it takes seconds, and it is
not something to leave on a dashboard refreshing.

The same numbers are now on the library's own **Plan & billing** page, so a
librarian who is refused can see what they are up against instead of only the
sentence in the 402.

**2. Is Stripe actually wired, or does it only look wired?**

`POST /webhooks/stripe` answers **200 to every event type it recognises the
signature of**, including the ones it does nothing with. Sending a test event
from the Stripe dashboard and seeing a green tick therefore proves the URL
resolves and the signing secret matches — and nothing at all about whether the
events that provision a subscription are subscribed. Driven against a running
API: ten event types, six handled and four not, all ten returned `200` and all
ten landed in `stripe_webhook_events` with `processedAt` set and `error` NULL.
The only trace of the four that were dropped is a `logger.debug` line, and the
production log level never emits it.

**Subscribe the endpoint to exactly these six.** Anything less and libraries pay
while nothing provisions; the list is `dispatch()` in
`apps/api/src/billing/stripe-webhook.controller.ts`.

| Event                           | What it does here                                                                              |
| ------------------------------- | ---------------------------------------------------------------------------------------------- |
| `checkout.session.completed`    | Spends the tenant's outstanding Checkout session — the duplicate-purchase guard (`billing-03`) |
| `customer.subscription.created` | Provisions the plan                                                                            |
| `customer.subscription.updated` | Plan changes, cancellations, past-due transitions                                              |
| `customer.subscription.deleted` | Ends the subscription                                                                          |
| `invoice.payment_succeeded`     | Extends `paidUntil`, clears grace                                                              |
| `invoice.payment_failed`        | Opens the grace window                                                                         |

Ask Stripe what it is really subscribed to, rather than reading it off the
dashboard:

```bash
WANT='["checkout.session.completed","customer.subscription.created",
       "customer.subscription.updated","customer.subscription.deleted",
       "invoice.payment_succeeded","invoice.payment_failed"]'
curl -s https://api.stripe.com/v1/webhook_endpoints -u "$STRIPE_SECRET_KEY:" \
  | jq --argjson want "$WANT" '.data[]
      | select(.url | endswith("/webhooks/stripe"))
      | {url, status, missing: ($want - .enabled_events)}'
```

`missing` must be `[]`. An endpoint subscribed to `checkout.session.completed`
alone passes the dashboard's own test-event check and provisions nothing.

**And save a Customer Portal configuration.** `billingPortal.sessions.create`
is called with no `configuration` id, so Stripe uses the account default — and
in live mode there is no default until one has been saved in the dashboard
(Settings → Billing → Customer portal). Until then the **Open portal** button
500s for every library, on first use, which is the day a card is declined.

```bash
curl -s https://api.stripe.com/v1/billing_portal/configurations \
  -u "$STRIPE_SECRET_KEY:" | jq '[.data[] | select(.is_default and .active)] | length'
```

Must be `>= 1`. Both curls need a live secret key and reach Stripe, so they are
the operator's to run on the box — they were not executed while writing this.

**After the first real subscription, confirm each event type has actually
arrived.** This one needs nothing but the database, and it is the check that
would have caught a wrong subscription list:

```bash
dc exec -T postgres psql -U libriant -d libriant_control -c "
SELECT want.type, count(e.id) AS seen,
       count(e.id) FILTER (WHERE e.\"processedAt\" IS NOT NULL) AS processed,
       max(e.\"receivedAt\") AS last_seen
  FROM (VALUES ('checkout.session.completed'),
               ('customer.subscription.created'),
               ('customer.subscription.updated'),
               ('customer.subscription.deleted'),
               ('invoice.payment_succeeded'),
               ('invoice.payment_failed')) AS want(type)
  LEFT JOIN stripe_webhook_events e ON e.type = want.type
 GROUP BY want.type ORDER BY seen, want.type;"
```

A `seen` of 0 on `customer.subscription.created` after a library has paid means
the endpoint is not subscribed to it. `deleted` and `payment_failed` legitimately
stay at 0 until something is cancelled or a card is declined.

### 4.3c The price catalogue, and the screen that says whether this host can charge

Both of the checks in §4.3b used to be sentences with no command. There is now a
third problem they did not cover, and it is the one that silently bills the wrong
number: **nothing in the product ever compared `plans.stripePriceId` /
`plans.stripeAnnualPriceId` against Stripe.** The go-live check an operator was
told to run asked whether `hasStripeAnnualPrice` was true — computed as
`!!plan.stripeAnnualPriceId`, which is true for every `price_seed_*` placeholder
the seed writes. The one mechanical safeguard reported success on exactly the
unconfigured database it existed to catch. (`billing-10`;
`apps/api/src/billing/billing-catalog.controller.ts:12-25`.)

**Read `/admin/plans` before you open Subscriptions.** Both `/admin/plans` and
`/admin/plans/:slug` call `GET /admin/billing/price-catalogue` on every visit and
render the verdict — a per-plan "reconciled / N problems" column, and the problems
in full (`apps/web/app/[locale]/admin/(authed)/plans/page.tsx:41`,
`plans/[slug]/page.tsx:71`). Nobody has to remember a curl. The curl still works
and is still the thing to script:

```bash
# Owner session on the ADMIN host. Note the /lbr-api prefix — same reason as §4.3b:
# on the admin vhost Caddy routes the API only under `handle_path /lbr-api/*`
# (infra/caddy/Caddyfile:404), so the bare /admin/billing/... path reaches Next and 404s.
curl -s -b "$ADMIN_COOKIE" https://<ADMIN_HOST>/lbr-api/admin/billing/price-catalogue | jq
```

Owner-role only (`@AdminRoles('owner')`, `billing-catalog.controller.ts:40`). It
costs one Stripe `prices.retrieve` per **distinct** id in the catalogue, memoised,
so a duplicated id is one call.

Good looks like: `"ok": true`. `ok` is `rows.every(r => r.problems.length === 0)`
(`billing.service.ts:2165`). For every active plan it asks Stripe about both price
ids and reports `problems[]` in plain language when:

- Stripe has never heard of the Price — `Stripe has no Price price_… (monthly) — Checkout would fail on it` (`plan-price-check.ts:114`);
- the Price is archived, or its currency disagrees with the plan;
- its **integer minor-unit** amount disagrees with the plan's;
- its recurring interval does not match the column it is stored in — a monthly
  Price in the annual column is what bills €39 a month to a library that clicked
  "390 € a year";
- the id is a seeded placeholder — `the monthly price id "price_seed_community" is a seeded placeholder, not a Stripe …` (`plan-price-check.ts:87`);
- the same id appears in both columns, which Postgres accepts because both unique
  indexes are satisfied.

> **On a host where `STRIPE_DRIVER` is anything but `real`, there is no
> "unverified" verdict — every configured id comes back as a PROBLEM, worded for
> the driver.** Under `disabled` the lookup errors and you get
> `Stripe could not be asked about the monthly price price_…`
> (`plan-price-check.ts:111`); under the in-memory stand-in you get
> `Stripe has no Price …`. `.ok` is `false` either way.
> That is the honest answer and it is not a pass. Do not read a red catalogue on a
> `disabled` host as "the catalogue is broken".

**Whether this host can charge at all is on the same response** (`billing-14`).
`subscriptionsStatus()` had returned `stripeReady` for a long time with a comment
saying the admin UI could warn about it, and **no page in `apps/web` read it** — so
an operator on a host that cannot charge saw a completely normal admin panel and
learned the truth when the Subscriptions toggle threw at them. The catalogue
response now also carries `stripeReady`, `billingEnabled`,
`subscriptionsCanBeEnabled` and a plain-language `blockReason`, resolved from the
same live `STRIPE_DRIVER` posture `setBillingEnabled` consults — so the banner
**predicts** the refusal rather than merely correlating with it
(`billing.service.ts:2146-2164`). `/admin/plans` renders it as a blocking banner:

| State                                     | Banner                                                                           |
| ----------------------------------------- | -------------------------------------------------------------------------------- |
| Subscriptions **off**, nothing can charge | Warning naming `STRIPE_DRIVER`, saying the master switch will refuse.            |
| Subscriptions **on**, nothing can charge  | Critical — every library is gated behind a purchase this server cannot complete. |

`blockReason` is the literal sentence the operator reads, and it ends with the fix:
_"Set STRIPE_DRIVER=real with STRIPE_API_KEY + STRIPE_WEBHOOK_SECRET and restart the
API."_ (`billing.service.ts:2152-2157`.)

> **The Subscriptions page itself still has no banner, and that is the screen the
> decision is made on.** `apps/web/app/[locale]/admin/(authed)/subscriptions/`
> renders only `billingEnabled`, `source` and `awaitingChoice`; neither `page.tsx`
> nor `SubscriptionsToggle.tsx` reads `stripeReady` or `blockReason` (verified by
> grep, 2026-08-28). Until that lands, **open `/admin/plans` first, every time**,
> and treat its banner as the gate. The toggle will refuse anyway — it just refuses
> after you have clicked it.

**A seeded placeholder is not "configured" anywhere.** `isUsableStripePriceId`
reads a `price_seed_*` id as false, so the library's own plan card renders "not
available yet" instead of a Subscribe button Stripe would answer with
`No such price`, and `POST /t/:slug/billing/checkout` refuses the same ids
server-side — hiding the button is not the only guard.

**The bad price id is now refused at write time, not reported afterwards.** Round 1
of this fix was the endpoint above and nothing else, and it was refuted for the
right reason: `PATCH /admin/plans/:slug` still accepted
`{"stripeAnnualPriceId":"price_monthly_39"}`, and the audit reported it — but only
if somebody ran the audit. `PlanPriceWriteInterceptor` is registered by
`BillingModule` as an `APP_INTERCEPTOR` (`billing.module.ts:52`), so it runs on the
real route after the admin guards, checks the row the PATCH would produce, and
answers **400** before anything is stored. It refuses:

- an id that is not a Stripe Price id (`prod_…`, an empty string, one with
  copy-paste whitespace);
- a `price_seed_*` placeholder being written back in;
- the same id in both columns, or an id that already backs another plan;
- a Price Stripe has never heard of, an archived one, one in the wrong currency,
  one whose integer minor-unit amount differs from the plan's, one whose interval
  does not match the column;
- an amount or currency edit that would leave an already-configured Price charging
  the old number;
- and **any** price id on a host where `STRIPE_DRIVER` is not `real`, because a
  price id this server cannot check is a price id it cannot charge with.

It costs nothing on a PATCH that carries no price id and no amount, and it touches
no other route. Proof it is mounted rather than merely written:
`apps/api/test/integration/admin-plan-price-write.spec.ts` boots the real app and
sends the refutation's own request over HTTP.

**Two facts that follow, and neither is a bug you should try to fix at 3am:**

- **Starter must keep a fake price id.** `plans_stripe_price_matches_mode` forces
  it — `CHECK (("billingMode" = 'stripe' AND "stripePriceId" IS NOT NULL) OR ("billingMode" = 'manual' AND "stripePriceId" IS NULL AND "stripeAnnualPriceId" IS NULL))`
  (`packages/db-control/prisma/migrations/20260822140000_repricing/migration.sql:36-42`).
  So `UPDATE plans SET "stripePriceId"=NULL WHERE slug='starter'` is rejected with
  SQLSTATE `23514`. The catalogue therefore reports Starter's placeholder as a
  **note, not a problem**: nothing can buy a free plan, the id is never read, and
  counting it would make `.ok` permanently false — which is how a check becomes one
  nobody reads. Clearing it through the admin API returns a 400 that names the
  constraint instead of a Prisma 500. Letting Starter be honest needs a migration
  relaxing that constraint for `monthlyPriceCents = 0`; do not attempt it during an
  incident.
- **A library on a contract cannot change its own plan.** `billingMode='manual'` is
  an operator decision (§6.6). Both self-serve routes refuse to move such a library:
  `POST /billing/select` (`billing.service.ts:469`) and `POST /billing/checkout`
  (`:572`) answer 400 and point at us, and the billing page shows "contact us" on
  every card instead of a switch button. The one thing they may do is **confirm**
  the plan they are already on, which stamps `planSelectedAt` and changes nothing
  else — without that, a contract library held by the forced plan chooser would have
  no way out at all.

> **One more consequence of the toggle, and it has no other symptom.** Once
> subscriptions are on, `getDesktopAccess` refuses any plan with
> `monthlyPriceCents <= 0`. A library parked on a zero-priced private plan loses
> the desktop app the moment the toggle flips, with nothing else changing. Check
> the plan's price, not its name.

### 4.4 Secrets: what breaks if you lose or rotate each one

**Irrecoverable if lost — nothing on disk or in any backup can regenerate them:**

| Secret                    | Consequence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MFA_MASTER_KEY`          | The only decryptor of stored admin TOTP secrets. Losing it orphans every enrolment, and MFA is mandatory in production. It is **no longer a lock-out**: §4.5a un-enrols an admin without decrypting anything, and single-use recovery codes are accepted at admin sign-in. Classified rotation: _never_ — a rotation still orphans every enrolment, it just no longer strands you.                                                                                                                                                                                                                  |
| `POSTGRES_PASSWORD`       | Postgres applies it only at initdb. Once the cluster exists, the value in `.env.prod` must match `pg_authid` or every connection fails auth. Classified rotation: _never_ — changing it needs a coordinated `ALTER ROLE libriant PASSWORD …`.                                                                                                                                                                                                                                                                                                                                                       |
| origin cert + key         | `deploy-on-host.sh` says it outright: _no backup contains it_. A missing pair fails the deploy at `caddy validate` with the misleading message `Caddyfile is invalid`.                                                                                                                                                                                                                                                                                                                                                                                                                              |
| the backup age identity   | The `AGE-SECRET-KEY-1…` half of `BACKUP_AGE_RECIPIENT`, held in the password manager and deliberately **not** on this host. It is the only decryptor of every `.age` artefact — local dailies, off-site dailies, Storage Box snapshots. Lose it and every backup you hold is permanently unreadable, with no escrow and no support path; the host is holding a public key and cannot help. Classified rotation: _forward only_ — a new recipient encrypts tomorrow's backups, it does not re-encrypt yesterday's, so keep the old identity for at least `BACKUP_KEEP_DAYS` after any change. §8.1a. |
| the backup gpg passphrase | The contents of `BACKUP_GPG_PASSPHRASE_FILE`, if you chose the fallback mode instead. Same consequence, with the aggravation that the file sits on the same disk as the ciphertext — so it defends the off-site leg and nothing else. §8.1a.                                                                                                                                                                                                                                                                                                                                                        |

**Three of these five rows are not in `.env.prod` at all**, so a copy of
`.env.prod` — which is itself not in any backup — would not save you: the origin
key pair, the age identity, and the _contents_ of the gpg passphrase file
(`.env.prod` holds only the path). The last two are alternatives — you chose one
encryption mode in §8.1a — so in practice it is **two things** you must hold
elsewhere: the origin pair, and whichever backup key you picked. Both live in
the password manager, and both block a **recovery** rather than an ordinary day
— which is exactly why nobody notices they are missing until the night they are
needed.

**Recoverable but disruptive:**

| Secret                   | Rotating it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SESSION_SECRET`         | Logs out every library user.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `ADMIN_SESSION_SECRET`   | Logs out all platform admins.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `IMPERSONATION_SECRET`   | Kills live support sessions.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `STORAGE_SIGNING_SECRET` | 403s every outstanding signed download link until reissued. Rotate it to a value that is **not** `SESSION_SECRET` — the API refuses to boot if they match (§4.2).                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `HASH_PEPPER`            | Resets the application-form IP throttle history.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `TENANT_DB_MASTER_KEY`   | Seals every library's own Postgres password. Rotating the key alone takes the **whole fleet down** at the next API restart — every `tenant_db_credentials` row is still sealed under the old one, and `runtimeDbUrl` fails closed rather than falling back to the superuser url. It is recoverable, and the recovery is a real procedure: change the value, then run `pnpm tenant:rotate-db-creds --all` **before** restarting the API (it re-issues and re-seals every password under the key that is now current). Must never equal `MFA_MASTER_KEY` — the API refuses to boot if they match. |

Rotation procedure: edit `/srv/libriant/.env.prod`, update the password manager
**first**, then `dc up -d` to recreate the affected containers. `ensure-env.sh`
will not undo it — `ensure_rand` and `ensure_default` only fill blanks, so a
value you write by hand survives every subsequent deploy. The one exception is
`STRIPE_DRIVER=fake`, which it actively rewrites to `none` on every run (§4.3).

`pnpm secrets` exists but **cannot be run on this box**: the host has no Node
toolchain, and the `migrate` container — the only place `scripts/` is mounted —
does not mount `/srv/libriant/.env.prod`. Rotation here is hand-editing. Its
registry is also only fourteen keys — `SESSION_SECRET`, `ADMIN_SESSION_SECRET`,
`IMPERSONATION_SECRET`, `STORAGE_SIGNING_SECRET`, `MFA_MASTER_KEY`,
`POSTGRES_PASSWORD`, `ADMIN_BOOTSTRAP_EMAIL`, `ADMIN_BOOTSTRAP_PASSWORD`,
`STRIPE_API_KEY`, `STRIPE_WEBHOOK_SECRET`, `SMTP_URL`, `BACKUP_HEARTBEAT_URL`,
`DEPLOY_SSH_KEY`, `DEPLOY_KNOWN_HOSTS` — so `HASH_PEPPER`, `RESEND_API_KEY`,
`DESKTOP_RELEASE_TOKEN`, `GRAFANA_ADMIN_PASSWORD` and every other `BACKUP_*` key
are outside it. A clean `secrets audit` is not a statement about them.

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

Since `launch-readiness-13`, every run of this script also prints the roster of
active admins and shouts if there is only one owner. Read that output.

### 4.5a The lost authenticator — getting back into the admin panel

`ADMIN_MFA_REQUIRED` defaults to on in production, so `admin.libriant.com`
refuses a correct password without a code from the authenticator. That surface
is where library edit-requests are approved, plans are set, billing is flipped,
support access is granted and the applications CSV is served. **One lost or
wiped phone used to end that access permanently**: `/admin/mfa/*` all sit behind
a live admin session, `EMAIL_DRIVER=console` delivers nothing, and re-running
`bootstrap-admin.ts` deliberately does not touch the second factor.

There are now three ways back, in order of preference. Only the first two
require you to have prepared.

#### Before you need it — do these now

1. **Hold recovery codes.** Enrolling issues ten single-use codes; a
   pre-existing enrolment can be given a set from the box without proving
   anything to the browser:

   ```bash
   dc run --rm --no-deps \
     -e ADMIN_BOOTSTRAP_EMAIL=owner@libriant.com \
     -e ADMIN_BOOTSTRAP_ISSUE_RECOVERY_CODES=owner@libriant.com \
     migrate sh -lc 'cd /app && pnpm admin:bootstrap'
   ```

   Ten `ABCDE-FGHJK-MNPQR-STVWX` codes are printed **once**. Put them in the
   password manager beside `MFA_MASTER_KEY` and clear the terminal — until used,
   each is as good as the authenticator. Re-running this invalidates the
   previous set.

2. **Keep a second owner admin, on a different device.** The server handbook
   already says to keep two SSH keys authorized; the same argument applies to
   the surface you use to respond to an incident, and never did.

   ```bash
   dc run --rm --no-deps \
     -e ADMIN_BOOTSTRAP_EMAIL=second-owner@libriant.com \
     -e ADMIN_BOOTSTRAP_PASSWORD='<a fresh 20+ char passphrase>' \
     -e ADMIN_BOOTSTRAP_ROLE=owner \
     migrate sh -lc 'cd /app && pnpm admin:bootstrap'
   ```

   Then sign in as that admin on the second device and enrol its authenticator.
   Store both TOTP seeds and both recovery-code sets.

#### On the day — signing in with a recovery code

At the admin sign-in, send a code in place of the six-digit one. It is consumed
on use; a wrong or already-used code counts as a failed attempt and can trip the
lockout, so do not guess.

#### On the day — no codes, no second admin

The reset below is the last resort and the reason a lost phone is no longer
terminal. **It decrypts nothing**, so it works even if `MFA_MASTER_KEY` has been
lost or rotated. It leaves the password alone.

1. Un-enrol the second factor. The value **must** be that admin's own email — a
   bare `1` is refused, so a stray variable cannot disarm MFA by accident.

   ```bash
   dc run --rm --no-deps \
     -e ADMIN_BOOTSTRAP_EMAIL=owner@libriant.com \
     -e ADMIN_BOOTSTRAP_RESET_MFA=owner@libriant.com \
     migrate sh -lc 'cd /app && pnpm admin:bootstrap'
   ```

   Good looks like `Reset the second factor for owner@libriant.com. The password
is UNCHANGED.` followed by the admin roster.

2. Open `https://admin.libriant.com` and sign in with the email and password.
   No code is asked for.
3. The console refuses every page except the enrolment screen. Enrol the new
   authenticator **now** — that is the guard doing its job, not a fault.
4. Store the new TOTP seed and the freshly issued recovery codes.
5. Verify: `dc logs api | grep -i mfa`, and confirm in the admin panel that the
   account shows MFA enabled.

What the reset does, so nothing is a surprise:

|                                  |                                                                                                                                                                                                            |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mfaEnabled`                     | → `false`; the stored ciphertext is overwritten with fresh random bytes (the columns are `NOT NULL`)                                                                                                       |
| recovery codes                   | deleted — a set printed against a factor that no longer exists must not remain a bypass                                                                                                                    |
| `sessionsValidAfter`             | stamped, rounded up to the next whole second, so **every** live admin cookie for that account dies, including one on the lost handset. A sign-in completing inside that same second is refused once; retry |
| `passwordHash`                   | **untouched**                                                                                                                                                                                              |
| `failedAttempts` / `lockedUntil` | cleared                                                                                                                                                                                                    |
| `audit_log`                      | one `admin.mfa.reset_by_operator` row, so an out-of-band reset is never invisible                                                                                                                          |

> **Do not put `ADMIN_BOOTSTRAP_RESET_MFA` or
> `ADMIN_BOOTSTRAP_ISSUE_RECOVERY_CODES` in `.env.prod`.** `prod-bootstrap.sh`
> runs `pnpm admin:bootstrap` on **every deploy** — this is the same footgun
> §4.5 describes for `ADMIN_BOOTSTRAP_PASSWORD`, except here it would silently
> disarm the second factor, or reprint and invalidate the recovery codes, on
> every deploy forever. Pass them with `-e` as above, one shot, and they are
> never written to disk.

#### If even that is unavailable

Straight SQL against the control plane, which is what the two commands above do:

```sql
-- un-enrol; the columns are NOT NULL, so overwrite rather than NULL them
UPDATE admin_users
   SET "mfaEnabled" = false,
       "mfaSecretCipher" = gen_random_bytes(32),
       "mfaNonce" = gen_random_bytes(12),
       "mfaKeyId" = 'reset',
       "sessionsValidAfter" = date_trunc('second', now()) + interval '1 second',
       "failedAttempts" = 0,
       "lockedUntil" = NULL
 WHERE email = 'owner@libriant.com';
DELETE FROM platform_settings WHERE key = 'admin.mfa.recovery:' || (
  SELECT id FROM admin_users WHERE email = 'owner@libriant.com');
```

Prefer the script: it writes the audit row, it refuses a mis-aimed reset, and it
tells you afterwards how many owner admins you have left.

### 4.5b Freezing — and un-freezing — a library account

`users.lockedUntil` is now read on the tenant sign-in path (`authn-authz-10`),
which it was not before. Two consequences worth knowing:

- **Freezing an account by hand works.** `UPDATE users SET "lockedUntil" =
now() + interval '1 hour' WHERE email = '…';` refuses that account's sign-ins
  for the hour, correct password included, and no distinct message is returned
  (a "locked" message is an account-existence oracle).
- **Five wrong passwords now leave a durable lock too**, expiring after
  `LOGIN_LOCKOUT_MS`. It is scoped to the address that armed it while Redis
  still remembers, so an attacker cannot lock a librarian out of their own
  connection — but if Redis has been flushed or restarted, the scope marker is
  gone with it and the lock applies to every address until it expires. That is
  deliberate: a Redis outage is exactly when the account has no other
  protection.

To release either, by hand:

```sql
UPDATE users SET "lockedUntil" = NULL, "failedLogins" = 0
 WHERE "tenantId" = '<tenant id>' AND email = '…';
```

A successful sign-in does the same thing by itself.

### 4.6 Host-shaped variables worth knowing

| Variable                 | Value                | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------ | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PUBLIC_HOST`            | `app.libriant.com`   | The **app** host, not the apex. The compose file used to default it to `libriant.com` in `x-app-env` and `app.libriant.com` in the caddy block — an internal contradiction that would have pointed the browser's API base at the marketing vhost, which has no `/lbr-api/*` handler. boot-and-config-09 removed both defaults: every site is now `${PUBLIC_HOST:?}`, so an unset value fails compose loudly instead of resolving to whichever block happened to be read. It is one of the seven hard requirements in §4.2. `ensure-env.sh` sets it before compose runs on both deploy paths, so this is belt and braces rather than a change of behaviour. |
| `PUBLIC_APEX_DOMAIN`     | `libriant.com`       | Drives tenant-subdomain resolution and the CSRF Origin allow-list, and derives `EMAIL_FROM`, `APPLY_NOTIFY_TO` and the fallback `ADMIN_HOST`. **Does not drive cookie scope** — cookies carry no `Domain` and use the `__Host-` prefix, which forbids it.                                                                                                                                                                                                                                                                                                                                                                                                  |
| `ADMIN_HOST`             | `admin.libriant.com` | Load-bearing three times: excluded from tenant-subdomain resolution, the only Origin allowed for state-changing `/admin/*`, and the web app 404s `/admin` on any other host. Injected into `api`/`worker`/`migrate`, into `web` separately, and into `caddy`; lower-cased by the app.                                                                                                                                                                                                                                                                                                                                                                      |
| `SITE_HOST`              | `libriant.com`       | Marketing vhost. No `/lbr-api/*` handler, on purpose, and deliberately not covered by `MAINTENANCE_HARD`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `EMAIL_FROM`             | derived              | Defaults to `Libriant <no-reply@${PUBLIC_APEX_DOMAIN}>` — from the **apex**, not `PUBLIC_HOST`. `.env.prod.example` says otherwise and so does the JSDoc on `emailFrom` in `config/env.ts`; both are wrong.                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `ACME_EMAIL`             | `ops@libriant.com`   | **Dead configuration.** All four live vhosts `import cloudflare_origin`, which serves `/etc/caddy/origin/origin.{crt,key}`, so no ACME order is ever placed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `EDGE_BIND_IPV4`         | `0.0.0.0`            | The host address Caddy's 80, 443 and 443/udp are published on. IPv4-only **on purpose**: a wildcard publish also binds `[::]`, and because no compose network sets `enable_ipv6` a v6 connection is then relayed by Docker's userland proxy from the bridge gateway — which made every v6 client look private to the edge and handed them a fresh rate-limit bucket per forged header (authn-authz-01). Absent from `.env.prod.example`; written by `ensure-env.sh`. Changing it is one of four changes that must be made together.                                                                                                                        |
| `PG_MAX_CONNECTIONS`     | `200`                | boot-and-config-02. Postgres's `max_connections` **and** the number the API and worker plan their tenant pools against, from one variable. It used to be written twice — a literal in the postgres `command:` and a hard-coded 200 in `tenant-pool-budget.ts` — with nothing keeping them equal, so an operator who raised the server's ceiling got no extra capacity and one who lowered it got a budget that overspends the server. Absent from the template.                                                                                                                                                                                            |
| `LIBRIANT_DATA_ROOT`     | `/mnt/libriant`      | Setting it in `.env.prod` **does nothing** — `deploy-on-host.sh` resolves it from the shell env and re-exports over whatever the file said. To relocate data, `export LIBRIANT_DATA_ROOT=… ` in the shell before invoking the script. The same is true of `IMAGE_TAG` and `COMPOSE_PROJECT_NAME`.                                                                                                                                                                                                                                                                                                                                                          |
| `IMAGE_OWNER`            | absent               | Irrelevant on the manual path. Compose falls back to `${IMAGE_OWNER:-libriant}` for local image tags. It matters only if you ever pull. `ensure-env.sh` deliberately never writes it from the template, because the template ships the placeholder `your-github-owner`.                                                                                                                                                                                                                                                                                                                                                                                    |
| `APPLY_NOTIFY_TO`        | `info@libriant.com`  | Where marketing-form applications are notified. Interpolated by compose but absent from the template and from `ensure-env.sh`, so you would never see it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `GRAFANA_ADMIN_PASSWORD` | generated            | Grafana's `admin` login, which reaches every metric this fleet produces. `${…:?}` on the monitoring overlay — a `.env.prod` assembled by hand fails the monitoring step of the deploy on a key nobody was ever asked for. `ensure-env.sh` generates it so that cannot happen.                                                                                                                                                                                                                                                                                                                                                                              |

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

**522, not 000.** Every one of the five deleted documents said the apex "returns
000", because every one of them probed with `--max-time 5`. A 522 specifically means Cloudflare
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

Do not start this until the box is proven healthy locally (§3.8, §3.9) and the
origin lockdown is applied and verified from outside (§3.2c). DNS is the **last**
step.

0. **Re-derive §5.1's table before you touch anything.** It is a measurement
   taken on 2026-08-23, not a description of the zone; a record can be added or
   repointed in the dashboard between then and the morning you do this, and the
   whole point of step 5 is that it is one change made with the current state in
   front of you.

   ```bash
   for h in libriant.com www.libriant.com app.libriant.com admin.libriant.com _dmarc.libriant.com; do
     printf '%-28s %s\n' "$h" "$(dig +short "$h" A | tr '\n' ' ')"
   done
   ```

   The one every superseded document got wrong is `admin`: it **exists** and is
   a repoint, not a create. Leaving it on the released Hetzner address while the
   zone is anything other than Full (strict) means the host that serves the
   admin login proxies to whoever Hetzner gives that IP to next — under a name
   the origin certificate covers and that HSTS `includeSubDomains` has already
   pinned to HTTPS in every browser that has visited the apex. Step 3 is what
   stands between those two facts, which is why it comes before step 5.

1. **Create the Origin CA certificate** for `libriant.com` **and**
   `*.libriant.com`. Store both PEMs in the password manager — nothing backs
   them up.
2. **Place them on the box** at `/mnt/libriant/caddy/origin/`, then
   `sudo chown root:root` both and `chmod 640` **both** — the key as well as the
   cert. The ownership matters as much as the mode (see §3.7b): Caddy runs as
   uid 1000 in group 0 with no capabilities, so it reads the key **as a member of
   group 0**, and `600` makes every HTTPS vhost fail to load its certificate. The
   deploy refuses to run without the files, and refuses again if the key is not
   `0:0` at 640 or 440. **Do not "tidy" the key back to `600`** — an older copy of
   this instruction said to, and on a converted box that is a delayed outage: it
   breaks nothing until the next reload, recreate or reboot.
3. **Set the zone SSL/TLS mode to Full (strict)** and confirm Always Use HTTPS —
   _before_ any record moves. **UNVERIFIED**: the current mode.
4. **Deploy and prove health locally**, still with zero DNS changes:
   `curl -sk --resolve libriant.com:443:127.0.0.1 https://libriant.com/pricing`.
5. **Then, in one Cloudflare change:**

   | Type | Name    | Content         | Proxy                                                                                      |
   | ---- | ------- | --------------- | ------------------------------------------------------------------------------------------ |
   | A    | `@`     | `195.201.13.95` | **Proxied**                                                                                |
   | A    | `app`   | `195.201.13.95` | **Proxied**                                                                                |
   | A    | `admin` | `195.201.13.95` | **Proxied**                                                                                |
   | A    | `www`   | `195.201.13.95` | **Proxied** — or a Cloudflare redirect rule instead. Pick one; do not leave it unresolved. |

   > **A records only. Do not create `AAAA` records for the origin.** An earlier
   > version of this table listed four of them, and it was wrong: Caddy's ports
   > are published on `${EDGE_BIND_IPV4:-0.0.0.0}`, which is IPv4-only on
   > purpose, so there is **no `[::]` listener on 80 or 443**. An `AAAA` record
   > tells Cloudflare to try a v6 origin that refuses the SYN, and you get a
   > **522 on the v6 path** while the v4 path looks perfect — an intermittent
   > outage that depends on which family Cloudflare happens to pick.
   >
   > Visitors still reach Cloudflare over IPv6; only the Cloudflare→origin hop is
   > v4, and the compose file says so in the comment above `ports:`.
   >
   > Going dual-stack properly is **four changes made together**, and any one of
   > them alone reopens `authn-authz-01`: `enable_ipv6: true` on the `edge`
   > network, `"ip6tables": true` in `/etc/docker/daemon.json`, `EDGE_BIND_IPV4`
   > changed back to a dual-stack publish by hand, and
   > `prod-bootstrap.sh --firewall-only --allow-ipv6` re-run. Only then the AAAA
   > records. **UNVERIFIED — nobody has done this.**

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
| Add an `AAAA` record for the origin  | Cloudflare tries a v6 origin that has no listener on 80/443 → **522 on the v6 path only**, intermittently, while every v4 check passes. See step 5.                                                                                                       |

### 5.4a Cloudflare dashboard settings that must stay OFF

The site ships **zero JavaScript** and the edge sends
`Content-Security-Policy: … script-src 'none' …`. That is not a preference: it is
what makes the stored-XSS class structurally impossible on pages an anonymous
visitor can reach, it is pinned by `pnpm check:caddy`, and `input-and-files-04`
is the finding that put it there.

Several Cloudflare features work by **injecting a script into the response after
it leaves the origin**. Under this CSP the browser blocks them, so the feature
does not work — and the failure is silent, or worse, misleading.

| Setting                              | Where                | State   | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------ | -------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Email Address Obfuscation**        | Scrape Shield        | **OFF** | Rewrote every `mailto:` into `[email protected]` plus a decoder script. The CSP blocked the decoder, so the address never decoded **for anyone** — and clicking it landed on Cloudflare's page saying _"you must enable JavaScript"_, which is wrong twice: JavaScript was enabled, and the CSP was the blocker. It hid `privacy@libriant.com` in the footer of the legal pages — the data-controller contact GDPR Art. 13 requires to be _provided_. Turned off 2026-09-03. |
| **Rocket Loader**                    | Speed → Optimization | **OFF** | Same mechanism: it rewrites and defers scripts. There are none to defer, so it can only add.                                                                                                                                                                                                                                                                                                                                                                                 |
| **Auto Minify / any HTML rewriting** | Speed                | **OFF** | Anything that edits the HTML after the origin can only diverge from what the build emits and what the tests read.                                                                                                                                                                                                                                                                                                                                                            |

**This class of bug is invisible from the repository.** `pnpm --filter @libriant/site build` emits zero `<script>` tags — verified — and every check runs against the origin. The injection happens at the edge, so the only thing that sees it is a request to the live site:

```bash
curl -sS https://libriant.com/ | grep -c '<script'
```

**Good looks like: 0 or 1.** One is Cloudflare's challenge-platform beacon
(`window.__CF$cv$params`), which arrives with Bot Fight Mode and the managed
challenge detections. It is inert here — the CSP blocks it like the rest — and it
is not worth disabling bot protection to remove ~450 bytes of dead markup. Any
_other_ script on that page is a Cloudflare feature somebody switched on, and it
is not working; find it in the dashboard rather than in this repository.

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

This is not pedantry — it is a live bug in `.github/workflows/deploy.yml:417`,
whose health gate uses the `-H 'Host:'` form, reports `site=000` for 150 s on a
perfectly healthy stack, fails the deploy and fires the automatic rollback. The
deleted server handbook had the same defect with `openssl s_client -connect
localhost:443` and no `-servername` (`docs/server-handbook.md:683`, deleted
2026-08-28 — `git log --follow -p -- docs/server-handbook.md`).

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
# If git could not answer, that expression is the bare string "-dirty" and every
# 'dc up' fails on a manifest pull. Read the tag off the running api container
# instead — the same advice this section gives for a checkout that has moved.
case "$IMAGE_TAG" in
  ''|-dirty) IMAGE_TAG="$(docker inspect -f '{{.Config.Image}}' libriant-api-1 2>/dev/null | sed 's/.*://')" ;;
esac
# If BOTH sources came up empty, say so at login rather than export "" and let
# compose resolve an image reference with no tag at all. A login shell must not
# exit, so this warns; §3.9's own check fails the run for it.
case "$IMAGE_TAG" in
  ''|latest)
    printf '%s\n' "libriant: IMAGE_TAG is empty or 'latest' — 'dc up'/'dc run' will fail on a" >&2
    printf '%s\n' "         manifest pull. git could not answer and no libriant-api-1 is running." >&2
    printf '%s\n' "         See docs/RUNBOOK.md §6.1." >&2 ;;
esac
export IMAGE_TAG
dc() { ( cd /srv/libriant/app && docker compose \
  -f infra/compose/docker-compose.prod.yml \
  -f infra/compose/docker-compose.volume.yml "$@" ); }
EOF
exec bash -l
echo "IMAGE_TAG=$IMAGE_TAG"
dc config >/dev/null && echo DC-OK
docker images --format '{{.Repository}}:{{.Tag}}' | grep "libriant-api:$IMAGE_TAG"
```

`install-server.sh`'s `dchelper` step writes this block, as a marked region it
can upsert. The **executable content is identical**; the two comment paragraphs
are worded differently there, so a `diff` against the file on the box will show
comment lines and nothing that runs. If you type it by hand, type all of it — the two `case`
statements are the difference between a bad tag and a broken stack.

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

**Then run §3.9 again**, or `sudo bash install-server.sh --verify-only`, which is
the same probes. It is not a first-deploy-only list: `prod-bootstrap.sh` runs on
_every_ deploy, and the checks that go green nowhere else — the storage write,
the web→api hop from inside the network, a real page, the help-centre census —
are the same on the tenth deploy as on the first. The four commands take under a
minute and one of them can fail.

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

> **Prove `pnpm` runs in that image before you rely on it.** This is where
> `supply-chain-06` used to bite (§3.0), and although the cause is gone the
> cheapest possible check is one line:
> `dc run --rm --no-deps migrate sh -lc 'pnpm --version'` → expect `11.22.0`.
> Note this needs a valid `IMAGE_TAG`: `dc run` **creates** a container, so it is
> one of the commands §6.1's warning is about.

### 6.5 Migrations

Control-plane migrations run automatically in the `migrate` one-shot on **every**
`dc up -d`, and they are **fatal**. You do not run them by hand. (Appendix C of
the old deployment doc claims the opposite; it is wrong.)

**Tenant** migrations used to be the dangerous half — `prod-bootstrap.sh` ran
them best-effort and swallowed failure, so a green deploy could leave live
libraries on an old schema while `service_completed_successfully` was satisfied.
`boot-and-config-04` made them **fatal**, so a deploy that reaches `▸ Healthy:`
has migrated every tenant it could see. Read the log anyway after a deploy that
touches the tenant schema, because "could see" is doing work: a tenant that was
archived or unreachable at that moment is not in the batch.

```bash
dc logs migrate | grep -i -E 'tenant:migrate|\[bootstrap\] FATAL'
```

(Do **not** grep for `skipped (non-fatal)`. No step emits it any more, so it
returns nothing on a broken deploy exactly as it does on a healthy one — §3.9.)

If anything is missing, fan out by hand:

```bash
dc run --rm --no-deps migrate sh -lc 'cd /app && pnpm tenant:migrate --concurrency=4'
# or a subset:
dc run --rm --no-deps migrate sh -lc 'cd /app && pnpm tenant:migrate --only=slug-a,slug-b'
```

Individual tenant failures do not stop the batch; the command exits non-zero at
the end. Good looks like: exit 0 and every tenant reported migrated.

### 6.6 Adding a tenant

```bash
# NOTE: no `--` before the flags. pnpm forwards it to the script, node's
# parseArgs treats it as the positional terminator, and EVERY flag after it
# is discarded — the run exits 1 with "missing required flag(s)". Verified on
# pnpm 9.15.4 and on 11.22.0, the pinned one. The same mistake in
# `pnpm tenant:migrate -- --dry-run` is worse: the flag is dropped, the dry run
# becomes a real one, and it migrates every tenant on the box.
dc run --rm --no-deps migrate sh -lc "cd /app && pnpm tenant:create \
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

#### Putting an existing library on a contract

`tenant:create --billing-mode=manual --paid-until=<+12mo>` above is how a **new**
library is provisioned onto the founding offer. For a library that signed itself
up before you got to it, there is an admin route. Use it — do **not** hand-write
`UPDATE subscriptions SET "billingMode" = 'manual'`, because that `UPDATE` is
unaudited and this is not.

```bash
# Owner session on the ADMIN host. tenantId, not slug.
curl -s -b "$ADMIN_COOKIE" -X POST \
  -H 'content-type: application/json' \
  -d '{"planSlug":"municipal","billingModeOverride":"manual"}' \
  https://<ADMIN_HOST>/lbr-api/admin/billing/tenants/<TENANT_ID>/set-plan | jq
```

`billingModeOverride` accepts **only** `'manual'`. There is no override in the
other direction, because putting a library onto Stripe billing means creating a
Stripe subscription, which is a checkout and not a flag. It travels through the
same owner-only guard as every other plan change and writes the same audit row,
with `overrodeBillingMode: true` on it.

Why it exists: the founding offer is twelve months of Municipal at no charge, and
Municipal is a `stripe` plan — so moving a tenant onto it set
`billingMode: 'stripe'`, and `applyManualPayment` then refused the paid-until
date the offer is made of (_"Manual paid-until only applies to manually-billed
plans"_). The advertised offer could not be granted through the product at all
(`launch-readiness-02`).

Then set the date, which is a **separate** call and is the half that writes the
audit row and invalidates the plan cache:

```bash
curl -s -b "$ADMIN_COOKIE" -X POST -H 'content-type: application/json' \
  -d '{"paidUntil":"2027-08-28T00:00:00.000Z"}' \
  https://<ADMIN_HOST>/lbr-api/admin/billing/tenants/<TENANT_ID>/set-paid-until | jq
```

Good looks like: `status` flips to `active` and `graceUntil` clears.

> **Nothing warns anyone before `paidUntil` lapses, and the drop is instant.** No
> scheduled job reads the column — none of the eleven in `apps/api/src/jobs/`
> mentions it. And the drop is not "eventually": the effective-plan query carries
> `AND (s."billingMode" <> 'manual' OR s."paidUntil" IS NULL OR s."paidUntil" > NOW() …)`,
> and the plan cache TTL is clamped to the soonest of
> `{override expiry, graceUntil, paidUntil}` — so at the second the date passes,
> the library falls through to the conservative `plan_features` defaults, which
> is effectively Starter. Mid-morning, mid-accession, with no email and no
> banner. The one-month-ahead contact the published offer terms promise is a
> calendar entry or it does not happen. Put every contract library's `paidUntil`
> in your calendar the day you set it.
>
> This bites only once subscriptions are on: while `BILLING_ENABLED` is false
> every limit on every tenant is the unlimited sentinel. Which is exactly why
> §4.3b's over-cap check reads the **contracted** plan and not the effective one.

**Relocating a tenant off-box silently stops all backups.** `backup.sh` aborts
the whole nightly run if any tenant's `dbUrl` host is not
`postgres`/`pgbouncer`/`localhost`/`127.0.0.1`, unless
`BACKUP_ALLOW_OFFHOST_TENANTS=1`. If you ever run `pnpm tenant:relocate` (see
§10.3 for the flags it refuses to run without), fix the cron in the same sitting.

### 6.7 The rhythm

Everything below is **Berlin time**.

**First, once — none of this exists yet:**

- [ ] backup encryption decided and a key held off-host (§8.1a)
- [ ] backup cron (§8.2) and a verified first backup
- [ ] off-site remote (`RCLONE_REMOTE`) — see the caveats in §8.1
- [ ] `BACKUP_HEARTBEAT_URL` (§8.1b) — today it is the only channel that reaches
      a person
- [ ] real receivers in `infra/monitoring/alertmanager.yml`, then a deploy (§7.3)
- [ ] the origin lockdown applied, installed as a boot unit, and proved from
      outside over both address families (§3.2c)
- [ ] origin-certificate expiry in your calendar
- [ ] `unattended-upgrades` and `fail2ban` active (§3.2d)

**Weekly, ~10 minutes:**

```bash
uptime; free -h; df -h / /mnt/libriant; cat /proc/mdstat
dc ps
docker system df
ls -lh /mnt/libriant/backups/ | tail -5
tail -30 /var/log/libriant/backup.log
cat /var/lib/node_exporter/textfile/libriant_backup.prom   # the metric, not the log
dc run --rm --no-deps migrate sh -lc 'cd /app && pnpm tsx scripts/fleet-report.ts'
```

Good looks like:

| Signal                 | Good                                                                  | Act                                        |
| ---------------------- | --------------------------------------------------------------------- | ------------------------------------------ |
| `/proc/mdstat`         | `[UU]` on both arrays                                                 | anything else → §9                         |
| load average           | < 4.0 (4 cores / 8 threads)                                           | > 8 sustained                              |
| `free -h` available    | > 40 GiB of 62                                                        | < 8 GiB                                    |
| swap used              | 0                                                                     | any sustained use                          |
| `df -h /`              | < 60% of 79 G                                                         | > 80% → §9.5                               |
| `df -h /mnt/libriant`  | < 60% of 246 G                                                        | > 70% → §10.1                              |
| `dc ps`                | 8 × `Up (healthy)`; `migrate` `Exited (0)`                            | any `unhealthy`, `Restarting` or `Created` |
| backups                | a directory for last night, 4 files                                   | missing → §8                               |
| `libriant_backup.prom` | `libriant_backup_last_success_timestamp_seconds` within the last 36 h | older, or absent → §8.1b                   |
| PG connections         | < 150 of 200                                                          | > 160                                      |
| PG cache hit ratio     | > 0.95 (the alert threshold)                                          | below                                      |

Note `migrate` showing `Exited (0)` is **correct**, not a fault.

**Monthly:**

- Origin certificate: `sudo openssl x509 -in /mnt/libriant/caddy/origin/origin.crt -noout -checkend 2592000 -dates`
  → good looks like `Certificate will not expire`.
- External scan from your laptop: `nmap -Pn -p 22,80,443,5432,6379 195.201.13.95`
  and the `-6` equivalent → 22 open; 80 and 443 **filtered** once the origin
  lockdown is in place (§3.2c); nothing else, ever.
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

| Thing                     | State                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Prometheus, node-exporter | Started by **every deploy** — `scripts/deploy-on-host.sh` and the `Bring up the monitoring stack` step in `deploy.yml` both compose `infra/monitoring/docker-compose.monitoring.yml`, then assert both containers are still running ten seconds later.                                                                                                                                                                                                                                                                       |
| Grafana, cAdvisor         | Behind `profiles: ['dashboards']`, which **no deploy path passes**. Opt in deliberately for a diagnosis with `--profile dashboards`. No alert rule reads a cAdvisor metric, and Prometheus labels that target `optional: 'true'` so `TargetDown` does not page about it while it is off.                                                                                                                                                                                                                                     |
| Alertmanager              | Exists, behind `profiles: ['alerting']`. The deploy passes that profile **only when `alertmanager.yml` carries no `[PLACEHOLDER]` receiver** — so today it does not start, and the deploy prints the red `ALERTS ARE NOT BEING DELIVERED.` banner instead (`deploy-on-host.sh:242-253`; the CI workflow emits `ALERTING=off` for the same state, `.github/workflows/deploy.yml:602`, and this box does not use that path). Fill in the two receiver URLs and the next deploy starts it.                                      |
| Alert rules               | 32, including a 5xx **ratio**, a per-route error rate and a p95 **latency** rule, backup freshness/encryption/exit-code, e-mail-outbox dead letters, per-queue consumer liveness and per-sweep failure, Redis memory, and a `Watchdog` dead-man's switch routed to its own receiver. `pnpm check:alerts` reads the declarations in `apps/api/src/observability/metrics.registry.ts` and proves BOTH directions: every `libriant_*` a rule names is declared and emitted, and every metric declared `alert: true` has a rule. |
| Grafana dashboards        | **Zero.** Provisioning contains one datasource file and nothing else.                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Grafana contact points    | **Zero.**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Error tracker / APM       | **None.** No Sentry, no OTel, nothing. The only durable record of an exception is container stdout.                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Uptime monitor            | **None.** Nothing in the repo names a provider, an endpoint or an on-call address.                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Caddy metrics             | **None** — `admin off`, no `metrics` directive. The only publicly exposed component exports nothing.                                                                                                                                                                                                                                                                                                                                                                                                                         |

**What reaches a human today: nothing.** Prometheus evaluates all 32 rules on
every scrape and they are visible at `/alerts` over an SSH tunnel; Alertmanager
is not running, so none of them wakes anybody up. Detection time for any outage
is _until you next look_, which the weekly rhythm sets at seven days. The one
exception is `BACKUP_HEARTBEAT_URL`, which is an external service and does not
depend on anything on this box (§8.1b) — which is why §7.3 puts it first.

The 32, by group, for when delivery exists:

| Group                    | Rules                                                                                                                                                                                                                                                                          |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Reachability             | `TargetDown`, `LibriantApiDown`, `LibriantWorkerDown`                                                                                                                                                                                                                          |
| Host                     | `HostLowMemory`, `HostSwapping`, `HostDiskFilling` (<15% free 15 m), `HostDiskCritical` (<7% free 5 m), `HostHighCPU`                                                                                                                                                          |
| Postgres / Redis         | `LibriantPgConnectionsHigh`, `LibriantPgConnectionsCritical`, `LibriantPgCacheHitLow` (<0.95), `LibriantRedisMemoryHigh`, `…MemoryCritical`                                                                                                                                    |
| Application errors       | `LibriantApi5xxRate` (>5% of requests, 5 m), `LibriantApiRouteErrors` (one route, 10 m), `LibriantApiLatencyHigh` (p95 > 2 s, 15 m)                                                                                                                                            |
| Mail that was never sent | `LibriantEmailOutboxDeadLetters`, `LibriantEmailOutboxStalled`, `LibriantEmailOutboxCensusMissing`                                                                                                                                                                             |
| Worker                   | `LibriantWorkerConsumerDown` (per queue), `LibriantWorkerQueueWedged` (6 h without going idle), `LibriantScheduledJobFailing`, `LibriantScheduledJobNotRunning` — all added in 2.0 phase 5, when the both-directions check found the metrics behind them emitted and unalerted |
| Backup                   | the seven in §8.1b                                                                                                                                                                                                                                                             |
| Alerting itself          | `Watchdog`                                                                                                                                                                                                                                                                     |

The Postgres and Redis ones read `libriant_pg_*` / `libriant_redis_*` gauges from
the API's own `/metrics`, so they work without the commented-out exporters. The
Redis thresholds are **absolute byte counts** derived from `REDIS_MAXMEMORY`;
move that and you must move them (§4.2d).

`HostSwapping` is guarded by `SwapTotal > 0`; this box has 8 GiB of swap, so the
guard is satisfied and the rule is live. Note its actual trigger is **swap more
than 50% used for 10 minutes** — 4 GiB — which is far past the point the weekly
sweep's "any sustained swap use" would have you act. The rule is a backstop, not
an early warning.

The API's `/metrics` exposes the eight gauges it always did — uptime, build info,
tenants by status, storage bytes, PG connections / max / cache hit ratio, Redis
memory — **and, since `HttpMetricsMiddleware`, a request counter
(`libriant_api_requests_total`, labelled by route and status) and a latency
histogram (`libriant_api_request_duration_seconds`)**, which is what the three
application-error rules above sit on. (The e-mail-outbox gauges are on the WORKER's `/metrics`, not the API's — the
census runs in the worker process. This paragraph said otherwise until 2.0
phase 5, which is a five-minute detour at 03:00 for anyone curling the wrong
container.)
The worker exposes uptime, running jobs per queue, a per-queue
`libriant_worker_consumer_up`, and per-job `libriant_worker_job_last_ok` /
`_last_run_timestamp_seconds` / `_count` — a job that has never run in this
process emits **nothing at all** rather than a fabricated 1 or 0, so pair the
first two in any rule you write.

> Until 2.0 phase 5 the three `libriant_worker_job_*` gauges reached **no
> scrape**. `renderScheduledJobMetrics()` was written, exported, unit-tested and
> documented — including in this section — and `worker.ts` never called it. This
> paragraph described them as exposed for three months while Prometheus had
> never seen one. `check:alerts` now fails the build on a declared metric no
> emitter writes, and `worker-surface.spec.ts` fails on a worker metric the
> exposition omits.

Gauges are TTL-cached 15 s and isolated with `Promise.allSettled`, so a
_missing_ gauge means that subsystem failed, not that the API is down.

### 7.2 The monitoring stack (started by every deploy)

This section used to describe the stack as optional and told you to generate a
`GRAFANA_ADMIN_PASSWORD` into a separate `/srv/libriant/.env.monitoring`. Both
are now wrong: the deploy brings Prometheus and node-exporter up on every run,
and `scripts/ensure-env.sh` generates the Grafana password into `.env.prod`
alongside everything else. A second file would hold a password Compose never
reads, and you would be locked out of a Grafana you thought you had configured.

Nothing to do by hand. To look at it, or to bring up the opt-in half:

```bash
cd /srv/libriant/app
set -a; . /srv/libriant/.env.prod; set +a            # export, or compose cannot see it
MON="-p libriant-monitoring -f infra/monitoring/docker-compose.monitoring.yml"

docker compose $MON ps                                # what the deploy started
docker compose $MON --profile dashboards up -d        # add Grafana + cAdvisor, for a diagnosis
docker run --rm --network libriant_app curlimages/curl -s -o /dev/null -w '%{http_code}\n' http://api:3001/metrics
grep '^GRAFANA_ADMIN_PASSWORD=' /srv/libriant/.env.prod   # log in once, then store it
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

- **Every monitoring service now declares `mem_limit` and `cpus`** — Prometheus
  512m/0.5, node-exporter 128m/0.25, Alertmanager 128m/0.25, cAdvisor 256m/0.5,
  Grafana 384m/0.5, plus `PROM_RETENTION_SIZE=2GB` on the TSDB. All are
  overridable from `.env.prod` (§10.2) and none is in the template. This section
  used to say the opposite; it was true when it was written.
- The five image pins are by **tag, not digest**, and date from 2024/early-2025.
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

`backup.sh` pings it **three** times per run — `/start` at the top, the bare URL
on a clean success, and `/fail` with the last 9000 bytes of the run log as the
body on any other exit. So it covers both failures that matter: a backup that
**stops happening** (the check goes red when the ping stops) and a backup that
**runs and fails** (you get the tail of the log, in the notification, without an
SSH session at 03:00). Nothing needs adding to the cron line for that any more.

This is the **only alerting channel on this box that survives losing this box**,
and today it is the only one that reaches a person at all — read §8.1b before you
decide it is optional.

Good looks like: the check turns green tomorrow morning and stays green.

**2. An off-box uptime check (after cutover only — the box is not in DNS).**

Point it at a URL that **traverses to the app**, never at `/healthz`:

- `https://app.libriant.com/` → Caddy → web:3000
- `https://libriant.com/pricing` → the marketing file server

Expect 200. If Cloudflare's Bot Fight Mode returns 403, add a WAF custom rule
skipping that path — otherwise the monitor is silently useless.

**3. Delivery for the 32 rules that already exist.**

Nothing needs to be added to the compose file and nothing needs uncommenting.
Alertmanager is already a service and Prometheus's `alerting:` block is already
live, pointed at `alertmanager:9093`. The service sits behind the `alerting`
compose profile, and `deploy-on-host.sh` turns that profile on **by itself** the
moment `infra/monitoring/alertmanager.yml` no longer contains a `[PLACEHOLDER`
(comments stripped first, so the file's own explanation of what a placeholder is
does not keep it off). So:

1. Put a real destination in **both** receivers in
   `infra/monitoring/alertmanager.yml`. **Use a webhook-style receiver** (ntfy,
   Telegram, a Slack webhook): Alertmanager's SMTP is separate from the app's
   `EMAIL_DRIVER`, and with no mail provider configured an e-mail receiver does
   not work. The second receiver is the `Watchdog` route — the dead-man's switch
   for alerting itself — and it should go somewhere different from the first, or
   it cannot tell you that the first one is broken.
2. Commit it. It is a tracked file, and `deploy-on-host.sh` runs `git reset
--hard`, so a host-local edit is destroyed on the next deploy.
3. Deploy. The run validates the file with `amtool check-config` before starting
   anything, and prints
   `▸ Alerting is live: Prometheus is evaluating alerts.yml and Alertmanager is delivering it`
   instead of the red banner.

Until that lands, every deploy prints **ALERTS ARE NOT BEING DELIVERED** in red
and names `BackupNeverRan` in it, and you should not use the word "page" about
anything in this system.

**[PLACEHOLDER: the two alert destinations the owner chooses — the primary
receiver, and a different one for `Watchdog`.]**

### 7.4 The health surfaces that lie

Know these before you trust a dashboard:

| Surface                        | Lie                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `https://<any host>/healthz`   | Static 200 from Caddy. Green through a total outage. Still the most contagious wrong idea in this system.                                                                                                                                                                                                                                                                               |
| caddy container health         | Hits its own static `:80` probe. Cannot go red while the process lives.                                                                                                                                                                                                                                                                                                                 |
| `web` `/api/healthz`           | A constant `{status:'ok'}` that touches nothing. It is **not** the container's healthcheck any more (that is `/api/readyz`, which does cross to the API) — but it is still there, and probing it by hand proves nothing.                                                                                                                                                                |
| `libriant_worker_jobs_total`   | Referenced in the code's types. Does not exist. Use `libriant_worker_job_last_ok` and `libriant_worker_job_last_run_timestamp_seconds`, and pair them: a job that has never run in this process emits no series at all.                                                                                                                                                                 |
| worker `/healthz` `queues`     | `running` used to mean "the start promise resolved once", including for a consumer whose BullMQ worker had since died. It now reports `starting` / `failed` / `running` / `stopped` — `failed` is a consumer whose `start()` rejected, which a null handle alone could not tell from "still booting" — and `/readyz` carries a `down: [{queue, purpose}]` array naming what is missing. |
| a green `dc ps` after a deploy | It says the containers are up. It says nothing about whether `ingest:help` ingested into a corpus somebody has since archived, whether uploads work, or whether the origin certificate expires next week. That is what §3.9 is for, on every deploy.                                                                                                                                    |

Three surfaces this table used to list have been fixed, and are named here so
nobody re-derives the old fear from an old memory:

- **`web` container health** is real now (`boot-and-config-08`): it fetches
  `${API_INTERNAL_URL}/readyz` and 503s on failure, so a wrong `API_INTERNAL_URL`
  or a broken `app` network fails the deploy gate instead of passing it green.
- **`pgbouncer` container health** was removed and replaced by the
  `pgbouncer-probe` sidecar, which runs a real statement through the pooler
  (`boot-and-config-15`, §2). The deploy gate asserts it.
- **`scheduledLastResults`** now carries the handler's own `counts` verbatim and
  computes `ok` from the failure keys in them, so a sweep where every tenant
  failed reports `ok: false` with `FAILED — tenantsFailed=49` in the message. It
  also distinguishes "this run broke" from "there is a backlog nobody has
  cleared", because an alert that is always firing gets silenced and a silenced
  alert is the same blindness from the other side.

One thing still has no operator surface at all: **abandoned e-mail-outbox rows
per tenant**. The fleet-wide count does — `LibriantEmailOutboxDeadLetters` fires
on `> 0`, because one abandoned password reset is one person locked out — but
finding out _whose_ is SQL. Dormant while `EMAIL_DRIVER=console`.

> **`reliability-01` — closed, and worth knowing about because the shape recurs.**
> `sendMemberNotifications()` used to construct a fresh `RedisService` and issue
> its first Redis `GET` microseconds later. The client is built with
> `enableOfflineQueue: false`, so a command issued while the socket is still
> `connecting` rejects **synchronously** — every tenant fell into the catch on
> every hourly tick, the whole sweep drained in microseconds, and `/healthz`
> reported `{"member-notifications":{"ok":true}}` while it happened. Measured at
> the time: `tenantsScanned: 49, tenantsFailed: 49`. Due-soon reminders, overdue
> notices and hold-ready notifications reached nobody, for as long as the product
> had existed.
>
> Both halves are fixed. The jobs take the runner's long-lived client out of
> their context and `await redis.ready()` when they must make their own, and the
> reporting no longer discards `counts`. `stripe-retry.job.ts` had the identical
> defect and the identical fix.
>
> **UNVERIFIED that reminders are actually arriving**, and they are not: with
> `EMAIL_DRIVER=console` the sweep now writes rows into `email_outbox` that
> nothing delivers (`launch-readiness-01`). The job works; the last hop does not.
> Do not tell a library that reminders are being sent.

---

## 8. Backup and restore

### 8.1 What is and is not backed up

`scripts/backup.sh` writes four artefacts to `$BACKUP_ROOT/$(date +%Y%m%d)/`:

| File                                  | Contents                                                                                                                                                                                                |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `postgres.sql.gz`**`{.age\|.gpg}`**   | `pg_dumpall --clean --if-exists` of the **whole cluster** — `libriant_control`, every `tenant_*` database, and all globals including role SCRAM verifiers. Restored with `psql -f`, never `pg_restore`. |
| `storage.tar.gz`**`{.age\|.gpg}`**    | the uploads tree                                                                                                                                                                                        |
| `caddy-logs.tar.gz`**`{.age\|.gpg}`** | best-effort; **never read by `restore.sh`**                                                                                                                                                             |
| `manifest.txt`                        | plaintext, on purpose: host, completed_at, image_tag, **encryption**, **encryption_key_id**, storage_dir, keep_days, and one line per artefact with its byte size and its **sha256**                    |

**The suffix is not cosmetic.** Every artefact but the manifest carries `.age`
or `.gpg` unless you deliberately chose plaintext (§8.1a). An operator globbing
for the literal `postgres.sql.gz` on an encrypted day finds nothing, concludes
the backup did not run, and is wrong. The manifest is left unencrypted because
during a recovery you need to know **which key opens the archives** before you
have the key.

`pg_dumpall` runs **inside** the postgres container, so no client is needed on the
host and version skew cannot occur for the nightly.

**A day is atomic and re-running it is safe.** Everything lands under
`$BACKUP_ROOT/YYYYMMDD/` and a second run on the same day overwrites in place, so
a missed cron plus a manual catch-up is not a problem. The local prune runs
**first**, on directories older than `BACKUP_KEEP_DAYS` by mtime; the off-site
push runs last and is verified before anything remote is pruned — push, verify,
prune, in that order and never any other, because pruning before verifying is how
one bad night plus one good prune becomes no backup at all.

**Not backed up, at all:**

|                                      | Why it matters                                                                                                                                                                                                                                      |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/srv/libriant/.env.prod`            | Deliberate — a stolen backup would otherwise be total compromise. It also means the secrets are irrecoverable from backups. Note that the `pg_dumpall` globals carry only the SCRAM _verifier_ for the `libriant` role, not the plaintext password. |
| the origin certificate + key         | `caddy_data` is never touched. In the password manager only. Blocks the deploy if lost.                                                                                                                                                             |
| `caddy_config`                       | —                                                                                                                                                                                                                                                   |
| **Redis** (`redis_data`, appendonly) | The BullMQ queues, rate-limit counters and idempotency keys. In-flight jobs are lost on a restore.                                                                                                                                                  |
| WAL / PITR                           | **There is no WAL archiving and no point-in-time recovery.** RPO is the cron interval: **up to 24 hours of loss.**                                                                                                                                  |

**Retention.** Local: `BACKUP_KEEP_DAYS` (14), pruned at the start of each run.
Off-site: the same window — after a **verified** push, `backup.sh` runs
`rclone delete --min-age ${BACKUP_KEEP_DAYS}d` against the remote, lists every
file it is about to remove into the run log, and then `rmdirs --leave-root` to
clear the empty day directories. If that delete fails the run is marked
**degraded** and says so: _"the remote retention delete failed — off-site copies
are NOT ageing out."_ That closes the half of `privacy-legal-02` that made an
Art. 17 erasure never propagate off-site.

> **`privacy-legal-02` — closed, and this is what closed it.** This section used
> to open "No artefact is encrypted, anywhere, and the off-site copy is never
> pruned", against a DPA that promises _"regular encrypted backups"_ and a
> privacy notice that promises deleted copies _"age out of backups"_ on a 14-day
> cycle. Both halves are now true of the code: `backup.sh` **refuses to run**
> without an encryption decision (§8.1a), and the off-site copy is pruned to the
> same window (above).
>
> The reason it mattered is unchanged and worth keeping in front of you when you
> choose a mode: a `pg_dumpall` from this host is the complete member registry of
> every library on it, and the Caddy access log is tarred into the same archive —
> password-reset and email-verification URLs used to carry their raw token in the
> query string through a JSON access log with no URI filter, so **the backup
> contained live account-takeover tokens**. The access log now drops the `?token=`
> value (§4.3a), and the archive is encrypted; neither on its own would have been
> enough.
>
> What is still owed: key management recorded in DPA Annex II.
> **[PLACEHOLDER: the key-custody statement the owner files in DPA Annex II —
> who holds the age identity, where, and who else can reach it.]**

### 8.1a Encryption — the decision `backup.sh` will not make for you

`backup.sh` **refuses to start** without an encryption decision. There is no
default and there is deliberately no fallback: a silent fallback to plaintext is
the defect the whole file exists to remove (`scripts/_lib/backup-crypt.sh:83-87`).
With nothing set you get this, before a single byte is dumped:

```
backup-crypt: NO ENCRYPTION CONFIGURED.
              The DPA we ask municipalities to sign says backups are encrypted,
              and a plaintext pg_dumpall is the entire member registry of every
              library on this host. Set ONE of:
                BACKUP_AGE_RECIPIENT=age1...        (preferred: key stays off-host)
                BACKUP_GPG_PASSPHRASE_FILE=/path    (fallback: passphrase on-host)
              or BACKUP_ALLOW_PLAINTEXT=1 to take a deliberate local-only,
              unencrypted backup (which may NOT be pushed off-site).
[…] ABORT: backup encryption is not configured (see the message above).
```

Exit 1. **No backup was taken.** This is `privacy-legal-02`, and the reason is
in `backup-crypt.sh`'s header: a `pg_dumpall` from this host is the complete
member registry of every library on it — names, dates of birth, home addresses,
phone numbers, staff notes and the loan history of named children, school
libraries included — and the Art. 28 DPA a municipal committee files says
"regular **encrypted** backups".

The three modes, resolved by `backup_crypt_mode`:

| Mode   | Set                                                          | Artefact suffix | Who can decrypt                                |
| ------ | ------------------------------------------------------------ | --------------- | ---------------------------------------------- |
| `age`  | `BACKUP_AGE_RECIPIENT` or `BACKUP_AGE_RECIPIENTS_FILE`       | `.age`          | whoever holds the identity — **not this host** |
| `gpg`  | `BACKUP_GPG_PASSPHRASE_FILE` (a file holding the passphrase) | `.gpg`          | anyone who can read that file on this host     |
| `none` | `BACKUP_ALLOW_PLAINTEXT=1`                                   | none            | everyone                                       |

Set exactly one. Setting an age recipient **and** a gpg passphrase file is
refused, by name, for a reason worth repeating:

```
backup-crypt: both an age recipient and a gpg passphrase file are set.
              Pick one — two half-configured schemes are how a backup ends up
              encrypted to a key nobody kept. Unset the one you do not use.
```

**Why `age` and not `gpg`.** Encrypting on the app host does not protect you
against an attacker who owns the app host — they have the live database anyway,
and anyone selling this as "encryption at rest protects the server" is wrong.
What it protects is **the copy that leaves**: the Storage Box, its snapshots, a
stolen rclone credential, a mis-set permission on the remote, and the backup file
an operator copies onto a laptop during an incident. In `age` mode the host holds
only the recipient — a public key — so a host compromise cannot open yesterday's
off-site copy. In `gpg` mode the passphrase file sits on the same disk as the
ciphertext, so it defends the off-site leg and nothing else. `gpg` is the
fallback for a host where `age` cannot be installed.

**The age model, in the order you must do it.**

1. **Generate the keypair off this host.** On your laptop, never over SSH, never
   in a shell whose history is on the box:

   ```bash
   age-keygen -o libriant-backup-identity.txt
   ```

   The file it writes contains the identity, the secret half, one line beginning
   `AGE-SECRET-KEY-1`. It also prints the matching recipient — one lowercase
   line beginning `age1`, between 50 and 80 characters
   (`is_age_recipient()` in `scripts/install-server.sh` is what validates it). UNVERIFIED: `age`
   is not installed in this repository's environment and nothing in the tree
   invokes `age-keygen`, so the exact wording of its stdout has not been
   observed here; the two key prefixes have been, in the installer's validators.

2. **The `age1…` recipient goes on the box**, into `/srv/libriant/.env.prod` as
   `BACKUP_AGE_RECIPIENT`. That is the whole of what the host ever needs.

3. **The `AGE-SECRET-KEY-1…` identity goes into the password manager and
   nowhere else.** Not in `.env.prod`. Not in `/root`. Not in the repository.
   Not in a Cloudflare-fronted paste. The installer refuses it if you paste it:
   `is_age_identity` matches `AGE-SECRET-KEY-*` and dies with _"That is an age
   IDENTITY (the SECRET half). Putting it on this host defeats the point"_
   (`is_age_identity()` and its call site in `configure_backup_env()`).

4. **A restore needs `BACKUP_AGE_IDENTITY_FILE`** pointing at that file, fetched
   from the password manager onto whatever machine is doing the recovery, and
   deleted afterwards.

> **Lose the identity and every encrypted backup you hold is permanently
> unreadable.** There is no recovery, no escrow, no support path and nothing on
> the host that helps: the host is holding a public key. The local dailies, the
> off-site dailies and the Storage Box snapshots all become 14 days of noise
> simultaneously. This belongs in the §4.4 irrecoverable table and it is now in
> it. If the thought of one password-manager entry standing between you and
> every library's data is uncomfortable, that is the correct reaction —
> `BACKUP_AGE_RECIPIENT` accepts several recipients, comma- or space-separated
> (`backup-crypt.sh:200-211`), and the second one should be an escrow key held
> by a different person in a different place. Losing the single key is the most
> common way an encrypted backup dies.

**Plaintext, and what it costs.** `BACKUP_ALLOW_PLAINTEXT=1` is a real option
for a host with no off-site leg, and the script says what it thinks of it:

```
[…] WARN: artefacts are NOT encrypted (BACKUP_ALLOW_PLAINTEXT=1). The DPA says they are.
```

It also sets `degraded=1`, which makes the run exit **1** at the end however well
it went, fires the `/fail` heartbeat, and holds `libriant_backup_encrypted` at 0
so the `BackupNotEncrypted` rule stays firing (`infra/monitoring/alerts.yml:296`).
Combining it with an off-site remote is refused outright:

```
[…] ABORT: BACKUP_ALLOW_PLAINTEXT=1 with RCLONE_REMOTE set.
[…]        That would put a plaintext dump of every member registry on a third-party
[…]        storage box, which is the exact exposure the DPA rules out. Configure
[…]        BACKUP_AGE_RECIPIENT (preferred) or BACKUP_GPG_PASSPHRASE_FILE.
```

**Check the decision without touching data.** `--preflight` runs every
configuration gate and exits before the dump.

> **On a host that has never taken a backup, this command exits 1 and prints
> nothing at all.** Not a warning, not an error — zero bytes, exit 1. The
> installer's `dirs` step creates `/var/lib/node_exporter/textfile` but never
> seeds a metric file in it, so on a fresh box the directory is empty and
> `obs_init` dies on its last line under `set -e`. Seed it once, first:
>
> ```bash
> sudo -u deploy touch /var/lib/node_exporter/textfile/libriant_backup.prom
> ```
>
> Then run the block below and you get the three-line output. §8.1b is the full
> diagnosis; you do not need it to get past this, you need the `touch`.
> Reproduced on this developer machine on 2026-08-28: fresh directory → exit 1,
> no output; after the `touch`, the identical command → `preflight OK`, exit 0.

```bash
set -a; . /srv/libriant/.env.prod; set +a
BACKUP_ROOT=/mnt/libriant/backups STORAGE_DIR=/mnt/libriant/storage \
  BACKUP_TEXTFILE_DIR=/var/lib/node_exporter/textfile \
  COMPOSE_FILE=/srv/libriant/app/infra/compose/docker-compose.prod.yml \
  bash /srv/libriant/app/scripts/backup.sh --preflight
```

Good looks like, for gpg:

```
[…] encryption: gpg (key gpg:sha256-16:2d72c1a8b7c9d3c8)
[…] preflight OK — encryption gpg, storage /mnt/libriant/storage, remote <unset>
[…]                dead man's switch: textfile=yes heartbeat=no
```

Those sixteen hex characters are derived from **your** passphrase file; the value
above came from a throwaway one. For `age` the id is the recipient itself, in
full — a public key is safe to write down. Expect one extra line in age mode:

```
[…] note: this host cannot decrypt its own backups (the identity is held off-host).
[…]       Encryption is proven; decryption is proven only by the quarterly drill.
```

That is the correct production posture, not a fault. Say it out loud anyway,
because it means the only proof of decryptability you will ever get is §8.5 run
with the real identity.

> `--preflight` exits **0** in plaintext mode. It runs the gates, not the
> verdict: `degraded` is only judged at the end of a real run, long after
> preflight has returned. A green preflight does not promise a green nightly.

**What `backup-crypt.sh` does that is genuinely reassuring.** An encrypted
archive nobody can open is not a backup, it is a slower way to lose the data, so:

- `backup_crypt_selftest` runs a **full round trip on a canary before the real
  dump**, and asserts the plaintext canary is _not_ present in the ciphertext
  (`backup-crypt.sh:265-297`). A key misconfigured in January must not be
  discovered in July.
- Every artefact is checked after it is written. Where the host can decrypt
  (gpg, or age with an identity present) `backup_crypt_verify_gz` decrypts it
  and runs `gzip -t` through the result, catching a wrong key and a truncated
  write in one pass. Where it cannot (age, production), `backup.sh:358-360`
  asserts the first 64 bytes contain `age-encryption.org` and discards the file
  if not.
- The **manifest is deliberately not encrypted** and records which key opens the
  archives, because during a recovery you need to know that _before_ you have
  the key. `backup.sh:414-431` writes `host`, `completed_at`, `image_tag`,
  `encryption`, `encryption_key_id`, `storage_dir`, `keep_days`, and then one
  line per artefact with its byte size and its **sha256** — so the off-site copy
  can be verified independently of rclone, and a silently corrupted transfer is
  provable after the fact.

> **The restore half of that promise does not exist yet.**
> `backup-crypt.sh`'s header states that "every artefact set records a truncated
> key id in the manifest, and restore.sh checks the key you supplied against it
> BEFORE it drops a single database". The first half is true. The second is not:
> `scripts/restore.sh` never sources `_lib/backup-crypt.sh`, reads the manifest
> nowhere, and hard-codes the **plaintext** artefact names — so handed an `age`
> or `gpg` day it would die with `no postgres.sql.gz in <dir>`. It does not get
> that far, because it exits 127 on its second statement (§8.3, which carries the
> reproduction).
>
> So the recovery you have today is by hand: fetch the day, decrypt it yourself
> with `age -d -i <identity>` or `gpg --decrypt`, and drive
> `_lib/pg-restore-filter.sh`'s preamble and filter into `psql` the way
> `restore.sh` means to. **Prove that path in a drill (§8.5) before you need it,
> not during.**

### 8.1b The dead man's switch — `backup.sh` refuses to run without one

The second gate. `backup.sh` requires **at least one of two channels**, and the
reasoning in `_lib/backup-observability.sh:1-42` is the clearest statement of the
problem in the tree: the script aborts on **fifteen** distinct conditions —
count the `ABORT:` lines in `backup.sh` yourself, the two file headers say
"eight" and "six" and both are behind the code — and every one of them used to
write only a line into a log nobody reads, so the three states
that actually matter were all silent — the cron was never installed, the run
aborts every night, the run succeeds with no off-site copy. That is
`reliability-09`, and the fix has to detect a backup that **did not happen**,
which a failure notification structurally cannot do.

With neither channel available:

```
backup: NO DEAD MAN'S SWITCH.
        Neither BACKUP_HEARTBEAT_URL nor a writable BACKUP_TEXTFILE_DIR
        (/var/lib/node_exporter/textfile) is available, so a backup that stops happening
        would be discovered only when a restore is needed. Set one:
          BACKUP_HEARTBEAT_URL=https://hc-ping.com/<uuid>   (external, survives host loss)
          sudo install -d -o deploy -g deploy /var/lib/node_exporter/textfile
```

**Channel 1 — the node-exporter textfile metric.** `backup.sh` writes
`$BACKUP_TEXTFILE_DIR/libriant_backup.prom` (default
`/var/lib/node_exporter/textfile`) atomically, from the `finish` EXIT trap — so
on every exit path reached after that trap is installed at `backup.sh:215`,
which is all fifteen aborts but **not** the one in the second blockquote below.
A failed run must leave evidence that it ran and failed, or `absent()` cannot
tell it apart from a cron that was never installed. On a failed run the previous `last_success` value is carried forward
on purpose, so `time() - last_success` keeps growing instead of resetting to now.

The wiring is real, and both halves of it are needed:
`infra/monitoring/docker-compose.monitoring.yml:105` gives node-exporter
`--collector.textfile.directory=/var/lib/node_exporter/textfile`, and line 108
bind-mounts `/var/lib/node_exporter/textfile` into the container read-only.
Without the flag the file would be written every night and scraped by nothing.

Seven rules in `infra/monitoring/alerts.yml` consume it:

| Alert                        | Expression                                                                    | Severity | For |
| ---------------------------- | ----------------------------------------------------------------------------- | -------- | --- |
| `BackupNeverRan`             | `absent(libriant_backup_last_success_timestamp_seconds)`                      | critical | 30m |
| `BackupAborted`              | `libriant_backup_last_exit_code != 0 and libriant_backup_degraded == 0`       | critical | 15m |
| `BackupStale`                | `time() - libriant_backup_last_success_timestamp_seconds > 36 * 3600`         | critical | 15m |
| `BackupOffsiteStale`         | `time() - libriant_backup_offsite_last_success_timestamp_seconds > 36 * 3600` | critical | 15m |
| `BackupNotEncrypted`         | `libriant_backup_encrypted == 0`                                              | critical | 15m |
| `BackupDegraded`             | `libriant_backup_degraded == 1`                                               | warning  | 1h  |
| `BackupOffsiteNotConfigured` | `libriant_backup_offsite_configured == 0`                                     | warning  | 6h  |

`absent()` is the point of the first one, and the reason the metric exists at
`BackupAborted` is the one that says it TONIGHT, and its second clause is not a
refinement. Everything else here waits 36 hours or for the metric to vanish, so
a run that aborted at 02:15 was first mentioned a day and a half later with a
second failed night already behind it. But `libriant_backup_last_exit_code` is
also non-zero for a run that FINISHED and merely broke a promise — most
commonly `RCLONE_REMOTE` unset, which `.env.prod.example` ships blank and which
this runbook says makes the nightly exit non-zero on purpose. Without
`and libriant_backup_degraded == 0` the rule would page **critical every night
on a default install**, which is how an alert channel gets muted before it has
ever said anything true. The two states the script itself distinguishes get the
two treatments they deserve: degraded-but-finished is `BackupDegraded` at
warning, and aborted-with-nothing-produced is this.

A note on all: a rule written as `time() - metric > threshold` evaluates to nothing on a
host that has never taken a backup, which is precisely the fresh-deploy case.
36 hours on the two staleness rules means one missed night alerts and one late
run does not — the cron is 02:15.

**Channel 2 — `BACKUP_HEARTBEAT_URL`.** The healthchecks.io convention, three
pings per run (`_lib/backup-observability.sh:124-144`):

| When                      | URL          | Body                               |
| ------------------------- | ------------ | ---------------------------------- |
| top of the run            | `$URL/start` | —                                  |
| success, and not degraded | `$URL`       | —                                  |
| any other exit            | `$URL/fail`  | the last 9000 bytes of the run log |

The tail of the log as the `/fail` body is what turns "the backup failed" into
"the backup failed because the storage dir moved", without an SSH session at
03:00. A ping is never fatal — a heartbeat provider having a bad day must not
fail a backup that worked; it logs `WARN: heartbeat ping failed (the backup
itself was fine)` and carries on. `obs_init` strips trailing slashes from the
URL before use, because `$url//fail` is a 404 that `curl -f` reports as a failed
ping: a broken alarm that looks like a broken backup.

> **Today, channel 1 detects and delivers to nobody.**
> `infra/monitoring/alertmanager.yml` still carries `[PLACEHOLDER]` in both
> receiver URLs (lines 73 and 81), Alertmanager refuses to start on an
> unparseable webhook URL, and the service is therefore held behind the
> `alerting` compose profile and is not started
> (`docker-compose.monitoring.yml:135`). Prometheus is up, its `alerting:` block
> is live (`prometheus.yml:20-23`), and it evaluates all 32 rules — they are
> visible at `/alerts` and they reach no human being. Every deploy prints the
> red banner `ALERTS ARE NOT BEING DELIVERED.` and names `BackupNeverRan` in it
> (`deploy-on-host.sh:242-253`). **So `BACKUP_HEARTBEAT_URL` is the only channel that
> currently reaches a person, and it is not optional in practice.** Set it in
> `/srv/libriant/.env.prod` before you walk away from a new host. Note it is
> absent from `.env.prod.example`, and `scripts/secrets.ts:292-304` catalogues
> it as `requirement: 'optional'` and describes it as "pinged after a successful
> backup" — that description predates the `/start` and `/fail` pings and is
> wrong.

> **The first nightly run on a fresh host exits 1, silently, and stays that
> way.** `obs_init` ends with `[ -f "$_OBS_TEXTFILE" ] && _OBS_PREV="$(cat …)"`
> (`_lib/backup-observability.sh:68`). When the textfile directory exists and is
> writable but holds no `libriant_backup.prom` — exactly what
> `install-server.sh` leaves behind, since it creates the directory
> (line 3338/4212) and nothing seeds the file — that test is the function's last
> command and its **return status is 1**. `obs_init` is called at
> `backup.sh:144` as a simple command under `set -euo pipefail`, so the script
> exits there: before `trap finish EXIT` is installed at line 215, before the
> `/start` ping at 217, before any log line. No metric is written, no heartbeat
> is sent, `/var/log/libriant/backup.log` gains **nothing at all**, and because
> the `.prom` file is only ever written by the trap that was never installed,
> tomorrow night is identical. Forever.
>
> Reproduced here against `scripts/backup.sh` on 2026-08-28, under bash 3.2.57;
> the `set -e` rule involved is a function call returning non-zero as a simple
> command, which behaves identically under the bash 5 on the box, but that has
> not been executed here — UNVERIFIED on Ubuntu.
>
> Until it is fixed in `backup-observability.sh`, seed the file once, as the
> account the cron runs as:
>
> ```bash
> sudo -u deploy touch /var/lib/node_exporter/textfile/libriant_backup.prom
> ```
>
> An empty `.prom` parses to zero metrics, `BackupNeverRan` keeps firing until a
> real run overwrites it, and the next invocation gets past `obs_init`.
> Verified: the same command that exits 1 with no output before the `touch`
> prints `preflight OK` after it.
>
> The reason you may not have noticed is that `install-server.sh --only backup`
> offers to run the backup once by hand and then checks the result, so an
> interactive install dies loudly on this. Read that `die`
> (the "exited N and wrote NO database dump" branch at the end of `step_backup()`)
> carefully: its last cause **does** name "the
> encryption / dead-man's-switch gates above them" — but on this failure that
> gate never ran, so the message it points you at is not in the log, and you go
> looking for an abort that was never printed. Note also that on the
> `--only backup` path a failed `--preflight` is a `warn` plus _"Continue to the
> real run anyway?"_ (`:4288-4290`), not a die; the die fires only if you say
> yes and no dump lands. An operator who declined that prompt gets the silent
> version.

### 8.2 Installing the nightly backup

**Nothing in the deploy path installs this.** Not `deploy-on-host.sh`, not any
compose file, not CI. And nothing warns you it is missing. `install-server.sh`'s
`backup` step is the only thing in this repository that does it, which is why
that step exists (§3.10).

Settle §8.1a and §8.1b **first**. `backup.sh` refuses to start without an
encryption decision and without a dead man's switch, so a cron installed before
those two answers is a cron that fails every night.

There are two cron lines in the repo and one of them is wrong — the header
comment in `backup.sh` sets no `BACKUP_ROOT` and would write to
`/srv/libriant/backups` on the **boot disk**. Use exactly this one, which is what
`install-server.sh` writes:

```bash
sudo tee /etc/cron.d/libriant-backup >/dev/null <<'EOF'
# Libriant nightly backup — 02:15 HOST time (docs/RUNBOOK.md §8.2).
# BACKUP_ROOT is explicit on purpose: it cannot be set from .env.prod
# (ensure-env.sh never writes it and the compose layer never reads it), and
# backup.sh's own default is the boot disk.
SHELL=/bin/bash
MAILTO=""
15 2 * * * deploy bash -lc 'set -a; . /srv/libriant/.env.prod; set +a; BACKUP_ROOT=/mnt/libriant/backups STORAGE_DIR=/mnt/libriant/storage COMPOSE_FILE=/srv/libriant/app/infra/compose/docker-compose.prod.yml BACKUP_TEXTFILE_DIR=/var/lib/node_exporter/textfile /srv/libriant/app/scripts/backup.sh >> /var/log/libriant/backup.log 2>&1'
EOF
sudo chmod 644 /etc/cron.d/libriant-backup
```

Two lines in there postdate the version this section used to carry, and both
matter:

- **`MAILTO=""`.** cron mails every line of output to the crontab user by
  default. With `EMAIL_DRIVER=console` and no MTA on the box that mail goes
  nowhere, or fills a spool nobody reads.
- **`BACKUP_TEXTFILE_DIR`.** `backup.sh` refuses to run when it has neither a
  writable textfile directory nor `BACKUP_HEARTBEAT_URL` (§8.1b), and the default
  path is not writable by `deploy` unless something created it — §3.5's
  `install -d -m 755 -o deploy /var/lib/node_exporter/textfile`.

`STORAGE_DIR` is stated explicitly even though `backup.sh` can usually resolve
the uploads directory itself (it asks Docker for the bind **source**, not the
mountpoint). "Usually" is doing a lot of work in a line that runs unattended at
02:15.

**02:15 is host time**, and the host is on Europe/Berlin (§1). Change the zone
and this window moves with it.

Then check the configuration without touching data, and only then run it for
real:

```bash
set -a; . /srv/libriant/.env.prod; set +a
BACKUP_ROOT=/mnt/libriant/backups STORAGE_DIR=/mnt/libriant/storage \
  COMPOSE_FILE=/srv/libriant/app/infra/compose/docker-compose.prod.yml \
  BACKUP_TEXTFILE_DIR=/var/lib/node_exporter/textfile \
  bash /srv/libriant/app/scripts/backup.sh --preflight

set -a; . /srv/libriant/.env.prod; set +a
BACKUP_ROOT=/mnt/libriant/backups STORAGE_DIR=/mnt/libriant/storage \
  COMPOSE_FILE=/srv/libriant/app/infra/compose/docker-compose.prod.yml \
  BACKUP_TEXTFILE_DIR=/var/lib/node_exporter/textfile \
  bash /srv/libriant/app/scripts/backup.sh
ls -lh /mnt/libriant/backups/$(date +%Y%m%d)/
```

Good looks like: `preflight OK` on the first, then four files — three artefacts
carrying the suffix your mode implies plus `manifest.txt` — with the Postgres
artefact comfortably over 1 KiB, exit 0, and no
`WARN: RCLONE_REMOTE unset` if you have configured off-site.

> **`BACKUP_ROOT` cannot be set from `.env.prod`** — `ensure-env.sh` never writes
> it and the compose layer never reads it. It exists only in this cron line and
> in whatever you type by hand. The script's default is the boot disk. Carry the
> full env prefix on **every** manual invocation, every time.
> `backup.sh --print-cron` with no prefix bakes the boot-disk default straight
> into the line it prints; do not paste that one.

**`backup.sh` has fifteen abort paths, not the five this section used to list.**
Count them with `grep -c 'ABORT:' scripts/backup.sh`; the two file headers say
"eight" and "six" and both are behind the code. Two of them stop the run before
the first byte and are the ones a new host meets: **no encryption configured**
(§8.1a) and **no dead man's switch** (§8.1b). The rest are the ones that stop a
run that had already started: the control-DB tenant query failing; an off-host
tenant (unless `BACKUP_ALLOW_OFFHOST_TENANTS=1`); `rclone` missing or the remote
judged unsafe; an unresolvable `STORAGE_DIR` (unless `BACKUP_ALLOW_NO_STORAGE=1`);
a `postgres.sql.gz` under 1024 bytes; an artefact that fails its decrypt-and-gzip
check, or that does not begin with `age-encryption.org` where it must; the
encryption self-test; and the off-site copy failing or not matching.

An abort is not silent any more — that is what §8.1b's two channels are for — but
neither channel wakes anybody up on its own today. Read §8.1b before you decide
which one you are relying on.

### 8.3 Restoring

**Destructive. It drops and recreates every database.** Requires `--yes`.

> **`restore.sh` does not run today. Read this before you need it, not during.**
> Line 44 calls `storage_resolve_dir`; the library that defines it is sourced at
> line 51. Under `set -euo pipefail` the script therefore dies on its second
> statement, with any arguments, on any host:
>
> ```
> $ bash /srv/libriant/app/scripts/restore.sh
> /srv/libriant/app/scripts/restore.sh: line 44: storage_resolve_dir: command not found
> ```
>
> Exit 127. Reproduced in this repository on 2026-08-28. Nothing is touched — it
> fails before it decides anything — so it is not dangerous, it is simply
> unavailable.
>
> There is a second, independent gap behind it: `restore.sh` never sources
> `_lib/backup-crypt.sh`, never reads the manifest, and hard-codes the
> **plaintext** artefact names. Handed an `age` or `gpg` day it would die with
> `no postgres.sql.gz in <dir>`. `backup-crypt.sh`'s own header claims restore
> checks the supplied key against the manifest's key id "before it drops a single
> database"; the manifest half is true, the restore half is not written yet.
>
> **Treat the rest of §8.3 as a description of intent and a map of the hazards,
> not as a procedure.** → **The procedure you actually run is [§8.3a](#83a-the-restore-you-actually-have-today), and it is
> written out in full.** Read the rest of this section first if you have the
> minutes — the three traps under "Three things that will bite on a rebuilt
> host" apply to the manual path exactly as they would have to the script — but
> if you do not, §8.3a repeats them as a checklist. Prove that path in a drill
> (§8.5) before you need it.

The command it is meant to be:

```bash
set -a; . /srv/libriant/.env.prod; set +a
BACKUP_ROOT=/mnt/libriant/backups \
STORAGE_DIR=/mnt/libriant/storage \
COMPOSE_FILE=/srv/libriant/app/infra/compose/docker-compose.prod.yml \
  bash /srv/libriant/app/scripts/restore.sh 20260823 --yes
```

> **`STORAGE_DIR` is no longer the trap it was, and the old warning here was
> wrong.** `reliability-05` — "restore.sh defaults `STORAGE_DIR` to the
> in-container path, recovers zero uploads and tells you it succeeded" — is
> closed in code: `restore.sh:44` calls the same `storage_resolve_dir` that
> `backup.sh` uses (docker volume inspect for the bind **source**, correct while
> the app containers are stopped), asserts the directory is visible to the
> container, counts the files in the archive before unpacking and **refuses** if
> fewer land. An explicit `STORAGE_DIR=` still wins, for the operator who knows
> better, and the line above still carries it — belt and braces, and one less
> thing to remember at 4am.

What it does, in order — this is the 2026-08-22 fix and it is worth knowing:

1. Resolve the day directory, require `postgres.sql.gz`, require `--yes`.
2. `gunzip -t` **both** archives before touching anything. **Plaintext only**:
   there is no decrypt step anywhere in the file, which is the second gap above.
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

> **Watch what the EXIT trap brings back.** It runs `dc up -d api worker web`,
> which re-runs the `migrate` one-shot `api` gates on — fine now that
> `supply-chain-06` is closed (§3.0), and still the slowest part of the recovery.
> The fallback path `dc start api worker web` does **not** start dependencies, so
> `pgbouncer`, which the script stopped, would stay down on that branch. Check
> `dc ps` afterwards rather than trusting "restore complete".

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

### 8.3a The restore you actually have today

This is `restore.sh`'s own sequence with the two broken statements removed and
the decrypt step it never had put in. Every function named here is real: all
three libraries source cleanly on their own, with no side effects, and
`type -t` reports each as a function (run here, 2026-08-28).

> **UNVERIFIED end to end.** No restore has ever completed on a real host, with
> real artefacts, in any mode. What has been executed here is the sourcing, the
> filter and the preamble against a synthetic `pg_dumpall` prologue (output
> below is that run). Everything else is `restore.sh`'s own statements, in its
> own order. This is unknowns register #23, and with #12 (real RTO) it is the
> most expensive unknown in this document: the value of every backup taken so
> far rests on a path nobody has walked.

**Work as `deploy`, in `/srv/libriant/app`, with `dc` from §6.1 defined.**

**0. Load the libraries.** All three, before anything else. This is the step
`restore.sh` gets wrong.

```bash
cd /srv/libriant/app
. scripts/_lib/pg-restore-filter.sh    # pg_restore_filter_count, pg_restore_filter, pg_restore_preamble
. scripts/_lib/storage-archive.sh      # storage_resolve_dir, storage_archive_file_count, storage_untar_into
. scripts/_lib/backup-crypt.sh         # backup_crypt_decrypt
set -a; . /srv/libriant/.env.prod; set +a
DAY=/mnt/libriant/backups/20260823     # the day you are restoring
PG_ROLE=libriant
```

**1. Decrypt into a working copy.** The artefacts carry the suffix of the mode
they were written in — `.age`, `.gpg`, or nothing (`backup_crypt_ext`,
`backup-crypt.sh:147-152`). `manifest.txt` is always plaintext; read it first
and check its key id against the key you hold, because that is the difference
between "wrong key" and "corrupt archive".

```bash
cat "$DAY/manifest.txt"
ls -la "$DAY"

# age mode — the identity comes from the password manager, NOT from this host:
export BACKUP_AGE_IDENTITY_FILE=/path/to/identity.txt
backup_crypt_decrypt age "$DAY/postgres.sql.gz.age" > /tmp/postgres.sql.gz
backup_crypt_decrypt age "$DAY/storage.tar.gz.age"  > /tmp/storage.tar.gz

# gpg mode instead:
#   export BACKUP_GPG_PASSPHRASE_FILE=/path/to/passphrase
#   backup_crypt_decrypt gpg "$DAY/postgres.sql.gz.gpg" > /tmp/postgres.sql.gz
# plaintext mode: the files are already named postgres.sql.gz / storage.tar.gz.
```

`backup_crypt_decrypt` refuses with a named message rather than a silent empty
file when the identity variable is unset or unreadable
(`backup-crypt.sh:228-248`). Then prove the plaintext is intact **before** you
drop anything:

```bash
gunzip -t /tmp/postgres.sql.gz && echo GZIP-OK
```

**2. The count assertion. This is the one that stands between a restore and a
wiped cluster — do not skip it and do not "fix" it by proceeding.**

```bash
gunzip -c /tmp/postgres.sql.gz | pg_restore_filter_count "$PG_ROLE"
```

**It must print exactly `2`.** Two is one `DROP ROLE` plus one `CREATE ROLE` in
the globals prologue. Any other number means the filter's patterns no longer
match this dump's wording — and a filter that matches nothing removes nothing,
so the restore would issue the full `DROP DATABASE` wave and _then_ abort on the
self-role statements, leaving you with no databases and no restore. That is not
theoretical: it was reproduced as psql exit 3 with zero databases remaining
(`_lib/pg-restore-filter.sh:10-16`). If it prints anything but 2, **stop**, and
read the prologue yourself: `gunzip -c /tmp/postgres.sql.gz | sed -n '1,60p'`.

Verified here on a synthetic prologue: `count=2`, the filter removed the `DROP
ROLE`/`CREATE ROLE` pair, **kept** the `ALTER ROLE … PASSWORD` line (that is
deliberate — it restores the role's password hash), and stopped at `\connect`,
leaving a `CREATE ROLE libriant;` that appeared _after_ the boundary untouched.
That scope guard is why the filter is safe to run over a whole dump.

**3. Stop everything that holds a connection.** Postgres refuses to drop a
database with sessions on it, and `pgbouncer` pools connections to
`libriant_control`, so it must go too. Postgres itself stays up.

```bash
dc stop api worker web pgbouncer
dc exec -T postgres psql -U "$PG_ROLE" -d postgres -v ON_ERROR_STOP=0 -c \
  "SELECT pg_terminate_backend(pid) FROM pg_stat_activity
   WHERE datname IS NOT NULL AND datname <> 'template0' AND pid <> pg_backend_pid();"
```

> **A `psql -d postgres` you left open to watch the restore is the likeliest
> session in the building**, and it is fatal late rather than early: the dump
> drops `postgres` and `template1` with a bare `DROP DATABASE` near the end, so
> one lingering session there aborts the restore _after_ every tenant database
> is already gone. Terminate everything, then close your own extra shells.

**4. Restore, preamble first.** The preamble is not optional — it is what makes
the `template1` drop survivable on a rebuilt host, and what resets the role
attributes `pg_dumpall` omits.

```bash
{ pg_restore_preamble "$PG_ROLE"
  gunzip -c /tmp/postgres.sql.gz | pg_restore_filter "$PG_ROLE"
} | dc exec -T postgres psql -U "$PG_ROLE" -d postgres -v ON_ERROR_STOP=1
```

The preamble is three statements, and you can print them first to see exactly
what you are about to send:

```
UPDATE pg_catalog.pg_database SET datistemplate = false WHERE datname = 'template1';
ALTER ROLE "libriant" RESET ALL;
ALTER ROLE "libriant" WITH CONNECTION LIMIT -1 VALID UNTIL 'infinity';
```

**5. The uploads.** Resolve the directory the way `backup.sh` does — never type
`/srv/libriant/storage`, which is the **in-container** path and the whole of
`reliability-05`:

```bash
STORAGE_DIR="$(storage_resolve_dir "${COMPOSE_PROJECT_NAME:-libriant}" "")"
echo "$STORAGE_DIR"        # expect /mnt/libriant/storage
storage_assert_visible_to_containers "$STORAGE_DIR" || echo "REFUSE — containers cannot see this path"

want="$(tar -tzf /tmp/storage.tar.gz | storage_archive_file_count)"
echo "archive holds $want file(s)"
storage_untar_into "$STORAGE_DIR" "$want" < /tmp/storage.tar.gz
```

Note the two stream shapes, and do not swap them: `storage_archive_file_count`
reads tar's **listing** on stdin, `storage_untar_into` reads the **gzipped
stream**. Getting either backwards produces a confident count of zero or an
untar of nothing — both of which look exactly like the bug this counting exists
to prevent (`_lib/storage-archive.sh:175-181`). `storage_untar_into` moves any
existing tree aside into `$STORAGE_DIR/.pre-restore.<timestamp>/` rather than
deleting it, then **fails** if fewer files land than the archive holds.

**6. Bring it back and check.** Nothing here has an EXIT trap, so this is on you:

```bash
dc up -d api worker web pgbouncer
dc ps
```

Then §3.9's probes, and §6.6's tenant count against the control plane.

**The three hazards from §8.3 apply unchanged**, and two of them will not
announce themselves:

1. **`template1`** — handled by the preamble in step 4. Skip the preamble on a
   rebuilt host and you get `cannot drop a template database`, after the drop
   wave.
2. **The restore overwrites the target's superuser password with the source's
   hash.** After a cross-host restore the freshly minted `POSTGRES_PASSWORD` in
   the new `.env.prod` is **wrong**; the correct value is the password-manager
   entry for the **source** host. Set it before you deploy, and see the
   `ensure-env.sh` guard warning at the end of §8.3.
3. **`ALTER ROLE` only overlays** — the preamble's `RESET ALL` and explicit
   `CONNECTION LIMIT -1 VALID UNTIL 'infinity'` are what stop target-side drift
   surviving a "successful" restore and surfacing weeks later as
   `password authentication failed`.

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
2. **Decrypt it with the real key**, on a machine that is not this host, using
   the identity out of the password manager. In `age` mode this is the **only**
   proof of decryptability you will ever get — the production host deliberately
   cannot decrypt its own backups and says so on every run (§8.1a). Check the
   artefact's sha256 against `manifest.txt` while you are there.
3. On a throwaway host, or a second cluster on this one, restore it with the
   **full** env prefix and `time` it. Record the Postgres leg and the storage
   untar separately. Until `restore.sh` is fixed (§8.3) this leg is by hand —
   **follow §8.3a step by step**, which is the same sequence written out with
   the two broken statements removed. Doing it by hand once is the point of a
   drill, and this drill is currently the only way §8.3a will ever be proven
   (unknowns register #23).
4. Verify: control-plane tenant count matches tenant database count; each
   `tenant_*` DB has 4/4 extensions; a spot-checked cover image actually opens.
5. Prove the off-site leg by pulling a day back down from `RCLONE_REMOTE` and
   restoring **that** copy, not the local one.
6. Write down the wall-clock. That number is your RTO.

Two drill hazards: an aborted `dr-drill.sh` leaves the shared role with
`statement_timeout=1s` and `CONNECTION LIMIT 7` (the EXIT trap restores only the
password), which later shows up as _"canceling statement due to statement
timeout"_ and _"too many connections for role"_ pointing nowhere near a shell
script that exited hours earlier. And `restore.sh` must never be pointed at
production to "test" it.

### 8.6 The other retention — the control database, and the five names that govern it

`BACKUP_KEEP_DAYS` (§8.1) is how long an **archive** lives. This is a different
thing with a confusingly similar name: how long the **data inside the running
control database** lives before the nightly `retention-sweep` deletes it. (§4.2f
is the configuration half — which of the five names is really a variable, and why
none of them reaches a container as written.) It is
in this chapter because every row it does not delete is in tonight's backup, and
in every backup after that, forever.

The sweep is real and registered — `apps/api/src/jobs/registry.ts:110-113`,
`intervalMs: 24 * 60 * 60_000`, running in the **worker**. It is
`privacy-legal-05` / GDPR Art. 5(1)(e), and it is the only thing in the product
that deletes personal data on age. Every limb is age-bounded and idempotent:
running it twice changes nothing the second time.

Five names appear in `.env.prod.example` lines 149-153 under
`# --- retention (performance-07 / privacy-legal-05) ---`. **Only three of them
are variables.**

| Name                               | Reads env? | Floor  | What it deletes                                                                                                                                                                                                                                                                                                                               | Shipped              |
| ---------------------------------- | ---------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| `CONTROL_AUDIT_RETENTION_DAYS`     | yes        | 1 day  | Rows in the control-plane `audit_log` older than N days, batched 5 000 × 40 per tick. Skips `tenant.legal_accepted` and `tenant.deleted` **forever** — the Art. 7(1) consent evidence and the one deletion event you most need to prove.                                                                                                      | unset — no-op        |
| `EMAIL_OUTBOX_BODY_RETENTION_DAYS` | yes        | 2 days | The `bodyMarkdown` of `email_outbox` rows older than N days, and only where `status` is `delivered` or `dead`, replaced with `_(Body removed by the retention sweep.)_`. **The row stays**: `idempotencyKey` is the dedup ledger, and deleting rows would make the hourly job re-send every overdue notice it has ever sent, to real patrons. | unset — no-op        |
| `SUPPORT_ATTEMPT_RETENTION_DAYS`   | yes        | 1 day  | Rows in `support_redemption_attempts` older than N days — one per support-key redemption attempt, each carrying the admin's IP.                                                                                                                                                                                                               | unset — no-op        |
| `STRIPE_PAYLOAD_RETENTION_DAYS`    | **no**     | —      | Hard-coded `30` (`retention.job.ts:544`). Blanks `payloadJson` to `'{}'` on **processed** `stripe_webhook_events` older than 30 days; the ~100-byte row stays because `processedAt` is the durable replay guard.                                                                                                                              | 30 days, always on   |
| `APPLICATION_RETENTION_MONTHS`     | **no**     | —      | Hard-coded `12` (`retention.job.ts:103`). Deletes non-`accepted` site applications 12 months after `reviewedAt` (or `createdAt`), **and** the admin notification in `email_outbox` that restates the same applicant's name, e-mail and phone.                                                                                                 | 12 months, always on |

The two bottom rows are exported TypeScript constants, not `process.env` reads.
Putting a number next to them in `.env.prod` changes nothing, anywhere, and
nothing warns you. `APPLICATION_RETENTION_MONTHS = 12` is published on
libriant.com — `apps/site/content/privacy.en.md:76` and `privacy.el.md:80`, §5
_"How long we keep it"_, both say the details go at the latest **12 months**
after we have been in touch — so it is not a tunable at all: change the number
and you have changed what applicants were told, in two languages, on a public
page.

The three that _are_ variables floor themselves and refuse anything else. A
value that is not a whole number of days, or is below the floor, is logged and
the limb is treated as unconfigured — a retention job acting on a value it does
not understand can do more damage than one that never runs:

```
refusing to enforce CONTROL_AUDIT_RETENTION_DAYS="0": it must be a whole number of days, at least 1. Nothing was deleted for that limb.
```

`EMAIL_OUTBOX_BODY_RETENTION_DAYS`'s floor of 2 is computed, not chosen:
`ceil(LONGEST_ONE_TIME_LINK_TTL_SEC / 86400) + 1`, where the longest one-time
link is the 24-hour e-mail verification token
(`apps/api/src/auth/one-time-link-ttl.ts`). With `EMAIL_DRIVER=console` — what
this box runs — the admin outbox **is** the delivery channel, so the body of the
message is the only copy of a reset link that exists. Blanking it early strands
the librarian it was written for.

**In the shipped configuration every configurable limb is off, and the control
database grows without bound.** The sweep says so on every run rather than
reporting a clean zero; this is what the `retention-sweep` message looks like
today, in full:

```
applications: 0 deleted past 12 months; stripe payloads: 0 pruned past 30 days; audit_log: 0 row(s) across 0 tenant(s); control audit_log: not configured (CONTROL_AUDIT_RETENTION_DAYS unset — Privacy Policy §6); email bodies: not configured (EMAIL_OUTBOX_BODY_RETENTION_DAYS unset — Privacy Policy §6); support attempts: not configured (SUPPORT_ATTEMPT_RETENTION_DAYS unset — Privacy Policy §6)
```

That is by design, and the design is honest about whose decision it is: how long
Libriant keeps an audit row, a sent e-mail body or an operator's IP address is a
**Privacy Policy §6** question — that is §6 _"How long we keep data"_ of the
tenant-facing policy in `locales/{en,el}/legal/privacy.md`, not §5 of the
marketing-site one — and it still holds four bracketed placeholders: `[30]` days
of post-termination export, a `[14]`-day backup cycle, `[up to 5–10]` years of
billing records, `[a limited period, e.g. 90 days]` of security logs. An engineer
inventing those numbers is how a library's records get deleted on a schedule
nobody agreed to. The owner must supply them:
`[PLACEHOLDER: the retention period, in days, the owner publishes in Privacy
Policy §6 for the control-plane audit log]`, `[PLACEHOLDER: … for sent e-mail
bodies, at least 2]`, `[PLACEHOLDER: … for support redemption attempts]`.

> **Setting them in `.env.prod` is not enough, and this is the trap.** The
> worker's environment is `x-app-env` in
> `infra/compose/docker-compose.prod.yml`, and that block carries its own
> warning: _"Compose only injects variables referenced in this block, so an
> unlisted .env.prod key is silently dropped"_ (the A5-01 note, added after
> `RESEND_API_KEY` was lost the same way). None of
> `CONTROL_AUDIT_RETENTION_DAYS`, `EMAIL_OUTBOX_BODY_RETENTION_DAYS` or
> `SUPPORT_ATTEMPT_RETENTION_DAYS` appears anywhere under `infra/` — grep the
> tree and you get zero hits outside `apps/api`, the test, and
> `.env.prod.example`. There is no `env_file:` on any service. So a number
> written into `.env.prod` today never reaches the process that would act on it,
> the sweep keeps printing "not configured", and the only visible symptom is
> that nothing changes.
>
> Turning a limb on is therefore **two edits in one commit**: the number in
> `/srv/libriant/.env.prod`, and a matching
> `CONTROL_AUDIT_RETENTION_DAYS: ${CONTROL_AUDIT_RETENTION_DAYS:-}` line in
> `x-app-env`. Then `dc up -d api worker` to recreate the containers, and read
> the next run's message — the limb must stop saying "not configured" before you
> believe anything was deleted. Nothing in `.env.prod.example` mentions the
> second edit; it presents the three keys as if filling them in were the whole
> job.

**Good looks like**, once §6 is filled in and both edits are deployed — the
`retention-sweep` message with no "not configured" clause left in it:

```
applications: 0 deleted past 12 months; stripe payloads: 0 pruned past 30 days; audit_log: 0 row(s) across N tenant(s); control audit_log: 0 past 365 days; email bodies: 0 past 30 days; support attempts: 0 past 90 days
```

(The numbers after "past" are whatever the owner published; the zeros are what a
steady state looks like on a young host.) One caveat that is not a fault: the
per-tenant `audit_log` limb reads `audit_log_retention_days` through
`EffectivePlanService`, and `retention.job.ts`'s header states that with
subscriptions off — `BILLING_ENABLED` defaults to `false` in `x-app-env`, which
is what this box runs — every integer feature resolves to the `UNLIMITED_INT`
sentinel. Retention is **lifted**, not zero;
the job skips those tenants and reports `N tenant(s) on unlimited retention —
nothing to enforce`. Deleting a library's audit history while the product tells
them their retention is unlimited would be the same class of bug as not deleting
at all.

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
| Someone outside has to be told       | [9.11](#911-telling-the-libraries)      |

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

For a 522, from the box — these are the checks that mean something:

```bash
dc ps caddy
curl -s -o /dev/null -w '%{http_code}\n' http://localhost/healthz   # expect 200
sudo ss -tlnp | grep -E ':(80|443)'
sudo bash /srv/libriant/app/scripts/prod-bootstrap.sh --firewall-status
```

> **Do not start with `nmap` from your laptop, and do not read `open` as good.**
> Once §3.2c's `firewall` step has run, the origin drops everything that is not
> a Cloudflare range — so from your laptop `nmap -Pn -p 22,80,443 195.201.13.95`
> **should** report 22 open and 80/443 **filtered**, on both address families,
> and that is the _healthy_ state. `filtered` here is not evidence of a fault.
> `open` on 80/443 means the lockdown is **not** applied, which is a different
> problem (an exposed origin) and never the cause of a 522.

**Fix**, in the order these actually occur:

- Caddy not running → `dc up -d caddy`, then `dc logs --tail=100 caddy`.
- `curl` to `localhost/healthz` does not return 200 → the edge itself is broken,
  not the network. §9.2.
- **Everything above is healthy, the lockdown is applied, and it was working
  yesterday → the Cloudflare range list has drifted.** This is the failure
  §3.2c warns about and it presents as _a 522 with a perfectly healthy stack
  behind it_: Cloudflare added an egress range, your DROP rule does not know it,
  and the origin now refuses the very traffic the edge is sending. Check
  <https://www.cloudflare.com/ips> against **all three** places that carry the
  list (§3.2c's table — the two `Caddyfile` snippets and `prod-bootstrap.sh`)
  before touching anything else. Updating the Caddyfile and forgetting the
  script produces exactly this.
- `--firewall-status` reports the chain exists but the jump is in only one
  parent → an interrupted lockdown run. The script inserts into both `INPUT`
  and `DOCKER-USER`; a partial state is §3.2c's territory.
- Origin healthy, lockdown correct, ranges current → the fault is
  Cloudflare-side: check the record still points at `195.201.13.95` and is
  proxied, and check SSL/TLS mode (§5.4).
- **A 522 on the v6 path only, while every v4 check passes** → somebody created
  an `AAAA` record. There must not be one; the origin publishes on IPv4 only
  (§5.4 step 5).

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

**This used to be the worst failure mode in the system, and it did not look like
Redis.** `boot-and-config-01` / `reliability-02`: `SystemModeMiddleware` runs on
`forRoutes('*')` and its `ALWAYS_PASS` branch awaited `resolveGlobal()` → a Redis
`GET` with `enableOfflineQueue: false`, and `readCache`/`writeCache` had no
catch. Every route returned 500 — including `/healthz`, `/readyz`, `/metrics`,
and the `/admin/system-mode` recovery lever itself.

**It is closed, and the rule it was closed with is worth carrying:**

- a **cache** that cannot be read is a **miss** — read through to the source,
  which is still reachable, and do not fail the request;
- a **store** that cannot be written must **fail**, loudly and by name — Redis is
  where a password-reset token actually lives, so a swallowed write means a link
  that can never be redeemed, which is worse than an error.

So expect a Redis outage to be **degraded, not fatal**: pages render, sign-in
still works, rate limiting and system mode fall back to their last known values,
and anything that mints a token refuses with a named error. The first fix for
this was refuted once, because the middleware and the tenant resolver had been
made resilient while five other services still called `redis.client` bare, so:
**if a Redis outage does take the site down, that is a regression, and the shape
to look for is a bare `redis.client` call on a request path.**

**Confirm.**

```bash
dc ps redis
dc exec -T redis redis-cli ping        # expect PONG
dc logs --tail=100 redis
dc logs --since 10m api | grep -i 'degraded\|Stream isn'"'"'t writeable'
```

**Fix.**

```bash
dc up -d redis
dc exec -T redis redis-cli ping
```

Recovery is automatic ~2 seconds after Redis returns. No restart of api or worker
is needed, no data is lost. If Redis was OOM-killed, see §9.6; if its data volume
is corrupt, `dc stop redis && sudo mv /mnt/libriant/redis/appendonlydir{,.bad} && dc up -d redis`
— you lose queued jobs and rate-limit counters, not durable data.

**During the outage the in-app maintenance lever still answers**, because
`/admin/system-mode/*` is in `ALWAYS_PASS` and that branch degrades rather than
throwing. What it cannot do is _persist_ a new window if the write leg needs
Redis, so read the response rather than assuming. If you need a takeover that
touches nothing behind Caddy, that is `MAINTENANCE_HARD` — and see §9.10 about
whether it fires at all.

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

**The usual cause used to be the export worker, and `performance-01` closed
it.** It buffered every row of every table in memory **before** the row-count
check, so one table alone reached RSS 1462 MB against `WORKER_MEM_LIMIT=1g`. The
export now refuses an oversized run **before a single row is read** — using
`reltuples` and `pg_table_size` out of `pg_class`, which is an estimate that
costs no scan and no allocation — and then streams with a cursor whose batch
targets **8 MiB of row payload**, deriving the row count from what the previous
FETCH actually measured. A fixed row count is not a memory bound; the tenant
schema has unbounded `text` columns, so the tenant, not the constant, decided how
much memory 5,000 rows was.

It still matters that **every queue consumer lives in one process**: whatever
kills the worker takes down the email outbox, the imports and all the cron sweeps
for **every** tenant with it. BullMQ's stalled checker re-runs the job once and
then fails it — two kills, not a loop.

**Fix now.**

```bash
dc up -d worker
docker inspect --format '{{.State.Health.Status}}' libriant-worker-1
```

Then find what was running. Raising `WORKER_MEM_LIMIT` in `.env.prod` (§10.2)
buys headroom on a 62 GiB box and is cheap; with the buffer bounded, a worker
that is still being OOM-killed is telling you about something new, so read
`dmesg` for what was actually resident rather than assuming exports.

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

| Failure                                                                                                                                                             | Meaning                                                                                                                                                                                                           | Fix                                                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `is not a git checkout` / `.env.prod is missing` / `$DATA_ROOT/x is missing`                                                                                        | preflight                                                                                                                                                                                                         | §3.5–3.7                                                                                                      |
| `origin certificate missing`                                                                                                                                        | preflight                                                                                                                                                                                                         | §3.7b                                                                                                         |
| `dc build` exit 137                                                                                                                                                 | OOM                                                                                                                                                                                                               | build one service at a time                                                                                   |
| `dc build` fails in the site build                                                                                                                                  | a `[PLACEHOLDER]` in `apps/site/site.config.json`                                                                                                                                                                 | fix the config; this fails the **Caddy image**, not just a page                                               |
| `Caddyfile is invalid`                                                                                                                                              | usually **not** the Caddyfile — the origin cert is missing, and `validate` provisions file certificates                                                                                                           | §3.7b                                                                                                         |
| `permission denied … docker daemon socket`                                                                                                                          | `deploy` is not effectively in the `docker` group                                                                                                                                                                 | §3.4                                                                                                          |
| migrate log ends in `[bootstrap] FATAL: control-plane migration failed … P3009`                                                                                     | a real failed migration or drift. (This used to be `supply-chain-06` masquerading as P3009; corepack is gone, so take the P3009 at face value now — but scroll up anyway and read the first error, not the last.) | `dc run --rm --no-deps migrate sh -lc 'cd /app && pnpm prisma migrate status'` and resolve before redeploying |
| migrate log ends in `[bootstrap] FATAL: help-centre ingest failed` / `… one or more tenant databases did not migrate` / `… could not create/verify the first admin` | all three are **fatal** now (`launch-readiness-15`, `boot-and-config-04`)                                                                                                                                         | §3.9's table                                                                                                  |
| deploy dies **after** `▸ Healthy:`                                                                                                                                  | the monitoring stack — step 11. `alerts.yml` did not parse, `alertmanager.yml` is missing or invalid, or prometheus/node-exporter was not running ten seconds after `up -d`                                       | read the message; it names which. The app is up and unaffected.                                               |
| gate times out at 180 s with api unhealthy                                                                                                                          | app-level                                                                                                                                                                                                         | §9.2                                                                                                          |

**Rollback:** `bash scripts/deploy-on-host.sh --ref <previous-sha>`. Get the sha
from `git -C /srv/libriant/app log --oneline -10`.

### 9.8 Certificate expired or wrong

**Symptom:** Cloudflare **526** on every host, all at once, with no deploy and no
code change. The deploy only `test -f`s the two files, so a green deploy proves
nothing about validity.

**Confirm.**

```bash
sudo openssl x509 -in /mnt/libriant/caddy/origin/origin.crt -noout -subject -issuer -dates -ext subjectAltName
sudo openssl x509 -in /mnt/libriant/caddy/origin/origin.crt -noout -checkend 0 && echo VALID || echo EXPIRED
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
| uploads 500                                                                       | not tenant-specific — see below                                                            |

> **`data-integrity-01` — closed, and it is the first thing to rule out if
> uploads 500 for everybody.** With subscriptions off every int limit resolves to
> the unlimited sentinel, whose byte ceiling was ~1024× the `int8` maximum;
> Prisma bound it into the quota reservation as an `int8` and Postgres refused
> the statement with SQLSTATE 22003, so every cover, member photo, logo and MARC
> upload came back as an opaque 500. There is now always a real ceiling — on the
> unlimited path simply what the column can hold — and a second guard behind it.
> If uploads 500 again, look for SQLSTATE 22003 in the api log first: the failure
> is a **configuration**-wide one, not a tenant's.

### 9.10 The customer-facing levers

The product ships three. **The incident docs it replaces never mention any of
them.** Each has a caveat you need before you pull it.

**9.10a System mode (the normal lever).** Owner-only, in the admin panel at
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

> **Two things that used to make this lever unusable, and are now fixed. Both
> are worth knowing, because both failure shapes recur.**
>
> 1. **A Redis outage no longer 500s the lever** (`boot-and-config-01`, §9.3).
>    `/admin/system-mode/*` is in `ALWAYS_PASS` and that branch degrades to the
>    last known mode rather than throwing.
> 2. **Signed-in tenant users see the takeover screen** (`frontend-03`). The
>    tenant layout used to resolve `currentSystemMode` and `currentImpersonation`
>    in one `Promise.all`; the always-pass list does not cover
>    `/support/impersonation/me`, so that probe 503s during a maintenance window
>    and the combined promise rejected before the takeover branch could be
>    evaluated — every signed-in librarian got a crash instead of the page. System
>    mode now resolves first, on its own, and the impersonation probe fails soft
>    to `null`.
>
> **UNVERIFIED end to end**: nobody has opened a real maintenance window against
> a running stack and watched what a signed-in librarian sees. Do it on a calm
> afternoon with one tenant, not during an incident.

**9.10b `MAINTENANCE_HARD` (the edge fallback).** Caddy-only, meant to survive a
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

**9.10c Announcements.** A banner pushed to tenants, managed at
`/admin/announcements` (`POST /admin/announcements`, `POST /admin/announcements/:id/expire`,
`GET /admin/announcements/:id/stats`), with per-tenant tag targeting. Use this
for planned work and for the "we're back" message. Users can dismiss and
acknowledge.

**9.10d What you cannot do.** `EMAIL_DRIVER=console` means the platform sends
**nothing** — no incident mail, no status update, no password reset. Every
customer communication is you, from a personal mailbox, by hand. Plan for that.

**Breach notification.** The DPA commits to notifying controllers of a
personal-data breach _"without undue delay"_, with the clock running from
awareness. If an incident involves unauthorised access to member data — including
children's — that clock is legal, not operational. Write down the time you became
aware, in the first minutes, before you start fixing. **Then go to
[§9.11c](#911-telling-the-libraries)**, which is what that sentence actually
requires you to do, to whom, and with what in the message.

### 9.11 Telling the libraries

§9.10 is the levers. This is the part that is not a lever: deciding that a human
outside this building has to be told, working out who, and saying it. It is
written down because the first customer-visible incident will otherwise be
improvised at an inconvenient hour by the one person who is also fixing the
fault — and because the DPA makes one of these decisions legally timed rather
than a matter of taste.

**Everything below is you, from your own mailbox.** `EMAIL_DRIVER=console`: the
platform composes mail and delivers none of it (§9.10d). Nothing here may be
left to the product to send.

#### 9.11a Does anyone have to be told?

| Situation                                                                   | Tell them | How                                            |
| --------------------------------------------------------------------------- | --------- | ---------------------------------------------- |
| Under 15 minutes, outside opening hours, nothing lost                       | No        | Note it in the incident log; move on           |
| Any window you opened on purpose (`read_only`, `maintenance`, planned work) | Yes       | Announcement banner first, then e-mail if long |
| Any outage during opening hours that a librarian could have noticed         | Yes       | E-mail, same day, from your own mailbox        |
| Data lost, restored from backup, or rolled back                             | Yes       | E-mail, naming what was lost and what was not  |
| Unauthorised access to, or disclosure of, personal data                     | Yes       | §9.11c — the clock is legal, start it first    |

Greek public libraries open in the morning. An outage at 03:00 that is fixed by
07:00 is an incident-log entry; the same outage at 10:00 is an e-mail.

#### 9.11b Who, and where their addresses are

There is no mailing list. The addresses are rows in the control plane, and this
is how you get them out:

```bash
dc exec -T postgres psql -U libriant -d libriant_control -c "
SELECT t.slug, t.name, t.\"primaryEmail\", t.\"publicPhone\",
       string_agg(u.email, ', ' ORDER BY u.email) FILTER (WHERE u.role = 'owner') AS owner_logins
  FROM tenants t
  LEFT JOIN users u ON u.\"tenantId\" = t.id AND u.status = 'active'
 WHERE t.\"archivedAt\" IS NULL
 GROUP BY t.id
 ORDER BY t.\"createdAt\";"
```

`primaryEmail` is the library's contact address as given at signup;
`owner_logins` are the people who can actually sign in. Write to both — the
first is often a shared departmental mailbox nobody reads on a Saturday.

**Keep a copy off the box.** If the machine is the thing that is down, this
query cannot be run. Export it after each new library is provisioned and keep it
where you can reach it from a phone.

#### 9.11c Personal-data breach — the one with a clock

The DPA we sign with every library says, in full
(`locales/{en,el}/legal/dpa.md` §10):

> We will notify you **without undue delay** after becoming aware of a
> personal-data breach affecting Controller Personal Data, with the information
> available to help you meet your Article 33/34 obligations, and we will take
> reasonable steps to mitigate it.

Read that carefully, because it is not a 72-hour commitment and it is not
vaguer than one:

- **The clock starts at _awareness_, not at confirmation.** Write down the
  wall-clock time you first suspected it, in the incident log, before you start
  fixing anything. That timestamp is the only evidence of when the clock
  started, and reconstructing it afterwards is not evidence.
- **The deadline is "without undue delay", which we owe to the library — not
  72 hours, which the library owes to the authority.** They are the controller;
  under Art. 33(1) they have 72 hours from _their_ awareness to notify the
  Hellenic DPA, and their awareness starts when we tell them. Anything from us
  that eats their 72 hours is undue delay by definition. Treat the practical
  bar as hours.
- **Say it even while you are unsure.** The DPA promises "the information
  available", not a finished investigation. A first message that says what is
  known, what is not, and when the next update comes is compliant; silence
  until you have the full picture is not.

What the message must carry — this is Art. 33(3), which our DPA points at, not
a wish-list:

1. what happened, in plain words, and which of their data it touched
   (catalogue, members, loans, staff accounts, files);
2. the categories and approximate number of data subjects and records — an
   estimate said to be an estimate is fine, a guess presented as a count is not;
3. the likely consequences for the people in that data;
4. what we have done and are doing, and any step they should take;
5. a contact point for follow-up. **[PLACEHOLDER: the data-protection contact
   address the DPA's §13 promises — `locales/*/legal/dpa.md` still carries
   `[DPO EMAIL]` / `[CONTACT EMAIL]` and the libraries are entitled to a real
   one before they sign.]**

**`BLOCKER privacy-legal-01`** lives here. `pnpm check:legal` passes — it only
proves no author-facing text escapes into the rendered pages — and then prints
the register of unfilled brackets, which today is dozens across both locales:
the registered entity, its address and VAT number, the DPO and contact
addresses, the liability cap, the sub-processor list, the retention periods
§8.6 needs. Until that register is empty and counsel has reviewed the result,
**the legal pages must not go live and no library may be asked to sign the
DPA.** Run it and read the list:

```bash
pnpm check:legal
```

If members' data is involved, remember whose it is: for their members the
library is the controller and we are the processor. We do not contact their
members. They do, and we give them what they need to do it.

#### 9.11d The holding message

Send this before you know the cause. Fill in the four blanks, send it, and do
not wait for a fifth.

> **Θέμα: Libriant — διακοπή λειτουργίας, ενημέρωση**
>
> Καλησπέρα σας,
>
> Το Libriant [δεν είναι διαθέσιμο / λειτουργεί με περιορισμούς] από τις
> [ώρα]. Το πρόβλημα αφορά [τι δεν δουλεύει· τι εξακολουθεί να δουλεύει].
>
> Τα δεδομένα σας δεν έχουν χαθεί. [Αν κάτι χάθηκε, πείτε το εδώ αντί για αυτή
> τη φράση — και πείτε ακριβώς τι.]
>
> Δουλεύω πάνω του τώρα. Θα σας στείλω νεότερη ενημέρωση μέχρι τις [ώρα, το
> πολύ δύο ώρες από τώρα], ακόμη κι αν δεν έχει λυθεί.
>
> [όνομα, τηλέφωνο]

English, for a library that corresponds in English:

> **Subject: Libriant — service interruption, update**
>
> Libriant has been [unavailable / running with limits] since [time]. The part
> that is affected is [what is not working; what still works].
>
> Your data has not been lost. [If something was lost, say that here instead —
> and say exactly what.]
>
> I am working on it now, and I will send another update by [time, at most two
> hours from now] whether or not it is fixed.

Two rules, and they are the whole point of having a template: **the next-update
time is a promise you keep even when there is no progress**, and **never write
"your data is safe" until you have checked that it is.**

#### 9.11e Afterwards

Within a working day of the fix: one more message saying what happened, what was
affected, and what changed so it does not happen again. Same recipients, no
jargon, no "an issue was experienced" — this is five libraries who chose an
unproven product from one person, and the honest note is the entire difference
between a bad morning and a lost customer.

Then write it up in `docs/` next to this runbook while the detail is fresh, and
add the symptom to §9's index if it is not there.

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

Eight pairs on the app stack, all interpolated by compose from `.env.prod`, all
**undocumented in the template** — add them yourself:

```
CADDY_MEM_LIMIT=256m           CADDY_CPUS=1
API_MEM_LIMIT=1g               API_CPUS=1.5
WEB_MEM_LIMIT=768m             WEB_CPUS=1
WORKER_MEM_LIMIT=1g            WORKER_CPUS=1
PG_MEM_LIMIT=2g                PG_CPUS=2
PGBOUNCER_MEM_LIMIT=256m       PGBOUNCER_CPUS=0.5
PGBOUNCER_PROBE_MEM_LIMIT=128m PGBOUNCER_PROBE_CPUS=0.25
REDIS_MEM_LIMIT=512m           REDIS_CPUS=1
```

Five more live on the monitoring overlay — `PROM_MEM_LIMIT=512m` / `PROM_CPUS=0.5`,
`NODE_EXPORTER_*` 128m/0.25, `ALERTMANAGER_*` 128m/0.25, `CADVISOR_*` 256m/0.5,
`GRAFANA_*` 384m/0.5 — plus `PROM_RETENTION_SIZE=2GB` for the TSDB.

Defaults on the app stack total **5.875 GiB** against 62 GiB, and **8.25 cpus**
against 8 threads. Memory is nowhere near the ceiling; CPU is slightly
over-committed at the caps, which is fine (they are limits, not reservations) but
means a busy Postgres and a busy build compete.

Raise when:

| Signal                                         | Change                                                                                                                                                                                                                                                              |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| worker OOM-killed (§9.6)                       | `WORKER_MEM_LIMIT=3g`. `performance-01` bounded the export buffer, so a kill now means something else — read `dmesg` before you raise anything.                                                                                                                     |
| Postgres cache hit ratio < 0.95 sustained      | `PG_MEM_LIMIT=8g` **and** actual Postgres tuning                                                                                                                                                                                                                    |
| `next build` exit 137                          | not a cap — that is the host; build one service at a time                                                                                                                                                                                                           |
| Redis memory climbing toward `REDIS_MAXMEMORY` | raise **four numbers together**, never one: `REDIS_MEM_LIMIT`, `REDIS_MAXMEMORY`, and both `LibriantRedisMemory*` thresholds in `alerts.yml`, which are absolute byte counts. §4.2d. Measured at 50 seeded tenants: 1.4 MB — a long-horizon risk, not a launch one. |

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

Two flags the earlier version of this section did not name, and without which
the commands it printed do not run at all:

```bash
# Move. --allow-remote is what makes it willing to touch a cluster that is not
# on this box; without it every production run stops at
#   refusing to run against a non-local cluster: --to-db-url destination
#   resolves to host "cell-02.lan".
CONTROL_DATABASE_URL=… REDIS_URL=… pnpm tenant:relocate \
  --tenant=<slug> --to-db-url='postgresql://libriant:<pw>@cell-02.lan:5432/' \
  --to-cell=cell-02 --allow-remote --dry-run

# Then the same line without --dry-run. Then, once the new home has served
# real traffic, delete the old database. --yes is a second consent, separate
# from --allow-remote: without it the run prints the host and the database name
# and refuses.
CONTROL_DATABASE_URL=… REDIS_URL=… pnpm tenant:relocate \
  --tenant=<slug> --drop-source --allow-remote --yes
```

**Moving a tenant's files is a second, separate operation.**
`tenant-relocate.ts` moves the database and rewrites `tenants.db_url`; it does
not touch `tenants.storage_url`. Covers, member photos and branding stay exactly
where they were.

```bash
CONTROL_DATABASE_URL=… REDIS_URL=… pnpm storage:migrate \
  --tenant=<slug> \
  --to-storage-url='file:///mnt/libriant-2/storage/<tenant-id>' \
  --dry-run
```

Same env prefix and the same reason as `tenant:relocate` — without
`CONTROL_DATABASE_URL` it dies with `Error: CONTROL_DATABASE_URL is not set`
before doing anything.

It has the same lifecycle: it opens a per-tenant `read_only` window,
`rsync -a --delete`s source→destination, verifies with a second `rsync` in
dry-run/itemize mode that the two are identical, updates `storage_url`, busts the
`TenantResolver` Redis cache (the storage URL is baked into `TenantContext`),
then closes the window. A failure leaves the window **open** so a human
can investigate while librarians see a clean 503-with-explanation rather than
500s or stale reads.

**`file://` → `file://` only.** Any other scheme dies immediately and cleanly
with `only file://→file:// is implemented today. Got s3://… → file://…`. The
wiring for `s3://` and `smb://` is in place; the per-scheme sync command is not.
Do not plan a storage-backend swap around this script today.

And do NOT write `pnpm tenant:relocate -- --tenant=…`. pnpm 11 forwards that
literal `--` to the script, where `node:util#parseArgs` reads it as the
end-of-options marker and discards every flag after it: the run dies with
`missing required flag(s): --tenant`. The same mistake in `pnpm tenant:migrate
-- --dry-run` is worse — the flag is dropped, the dry run becomes a real one,
and it migrates every tenant on the box.

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

|                              |                                                                                                                                                                                                                           |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Checkout                     | `/srv/libriant/app`                                                                                                                                                                                                       |
| **This runbook, on the box** | `/srv/libriant/app/docs/RUNBOOK.md` — but only after §3.6's `checkout` (step 9 of 16). Before that, the only copy is the one on your laptop; §3's "Getting the script onto a box with no checkout" is the same situation. |
| Secrets                      | `/srv/libriant/.env.prod` (600 deploy:deploy)                                                                                                                                                                             |
| Secrets, on-volume copy      | `/mnt/libriant/env/.env.prod` (700 dir; the first recovery source)                                                                                                                                                        |
| Data root                    | `/mnt/libriant` (`vg0-data`, 250 GiB)                                                                                                                                                                                     |
| Postgres / Redis / uploads   | `/mnt/libriant/{postgres,redis,storage}`                                                                                                                                                                                  |
| Origin cert                  | `/mnt/libriant/caddy/origin/{origin.crt,origin.key}`                                                                                                                                                                      |
| Backups                      | `/mnt/libriant/backups/YYYYMMDD/`                                                                                                                                                                                         |
| Backup log                   | `/var/log/libriant/backup.log` (rotated by nothing; kilobytes/year)                                                                                                                                                       |
| Backup metric                | `/var/lib/node_exporter/textfile/libriant_backup.prom` (§8.1b)                                                                                                                                                            |
| Backup cron                  | `/etc/cron.d/libriant-backup` (§8.2)                                                                                                                                                                                      |
| Installer state + log        | `/var/lib/libriant-install/` (0700 root; `install.log` at 0600)                                                                                                                                                           |
| Container logs               | `dc logs` — json-file on the **boot disk**                                                                                                                                                                                |
| Caddy access log             | inside `caddy_logs`, on the **boot disk**                                                                                                                                                                                 |

### Commands

```bash
# provisioning / verification (root; the script is self-contained)
sudo bash /srv/libriant/app/scripts/install-server.sh --status        # what is done
sudo bash /srv/libriant/app/scripts/install-server.sh --verify-only   # read-only checks
sudo bash /srv/libriant/app/scripts/install-server.sh --from <step>   # resume

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
sudo openssl x509 -in /mnt/libriant/caddy/origin/origin.crt -noout -checkend 2592000 -dates

# backup  (env prefix is NOT optional)
set -a; . /srv/libriant/.env.prod; set +a
BACKUP_ROOT=/mnt/libriant/backups STORAGE_DIR=/mnt/libriant/storage \
  COMPOSE_FILE=/srv/libriant/app/infra/compose/docker-compose.prod.yml \
  BACKUP_TEXTFILE_DIR=/var/lib/node_exporter/textfile \
  bash scripts/backup.sh --preflight        # config gates only, no data touched
BACKUP_ROOT=/mnt/libriant/backups STORAGE_DIR=/mnt/libriant/storage \
  COMPOSE_FILE=/srv/libriant/app/infra/compose/docker-compose.prod.yml \
  BACKUP_TEXTFILE_DIR=/var/lib/node_exporter/textfile \
  bash scripts/backup.sh
cat /var/lib/node_exporter/textfile/libriant_backup.prom

# restore — scripts/restore.sh EXITS 127 BEFORE DOING ANYTHING TODAY.
#   The working path is §8.3a, by hand. Load the libraries FIRST:
#     . scripts/_lib/pg-restore-filter.sh; . scripts/_lib/storage-archive.sh
#     . scripts/_lib/backup-crypt.sh
#   Then decrypt, and DO NOT SKIP the count assertion — it must print exactly 2:
#     gunzip -c /tmp/postgres.sql.gz | pg_restore_filter_count libriant

# grow the data volume (online)
sudo vgs && sudo lvextend -L +50G /dev/vg0/data && sudo resize2fs /dev/mapper/vg0-data

# external truth (from your laptop, never from the box)
nmap -Pn -p 22,80,443,5432,6379 195.201.13.95
nmap -6 -Pn -p 22,80,443 2a01:4f8:13b:ac8::2
```

### Six things to remember

1. `/healthz` is a **static 200 from Caddy** on every host. It proves nothing.
2. Docker **does not restart an unhealthy container**, and `dc stop` + reboot
   leaves the stack down. `dc up -d`.
3. `deploy-on-host.sh` runs **`git reset --hard`**. Host-local edits to tracked
   files are gone.
4. **Carry the full env prefix on every backup invocation** — `BACKUP_ROOT` is
   not in `.env.prod` and the script's own default is the boot disk.
5. `MFA_MASTER_KEY`, `POSTGRES_PASSWORD`, the origin cert **and the backup key**
   are in no backup. The password manager is the only copy — and losing the
   backup key makes every backup you hold unreadable.
6. **The origin has no `AAAA` records, on purpose.** Adding one gives you a 522
   on the v6 path only, intermittently. §5.4.

---

## Appendix — the unknowns register

Things nobody has measured. Each is flagged inline where you would use it; this
is the list to work through on a calm afternoon.

This is **not** the complete set. The recon that produced this document recorded
88 unknowns across seven areas; the 21 below are the ones that sit under an
instruction someone will actually follow. The full register is the `unknowns`
arrays in `docs/runbook-rewrite-2026-08-23/RECON.json`.

| #   | Unknown                                                                                                                                                                                                                                           | How to settle it                                                                                                                                                 |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Does the corepack fix actually make `migrate` pass end to end?                                                                                                                                                                                    | §3.0 build probe with `--network none`                                                                                                                           |
| 2   | Caddy directive order — does `/lbr-api/*` really win over the catch-all?                                                                                                                                                                          | §2, `caddy adapt`                                                                                                                                                |
| 3   | Does `MAINTENANCE_HARD` fire at all, or is the `vars` matcher dead?                                                                                                                                                                               | §9.10b, `caddy adapt` with the flag on                                                                                                                           |
| 4   | Does the origin lockdown actually hold? It has never run on a live box, and a wrong range list takes the site down.                                                                                                                               | §3.2c, then the external `nmap` over both families                                                                                                               |
| 5   | Did initdb really record `el-GR` ICU collation? It is asserted once, on the first run, and cannot be changed afterwards without a full reindex.                                                                                                   | `dc exec postgres psql -U libriant -d libriant_control -c "SHOW lc_collate; SELECT datcollate, daticulocale FROM pg_database WHERE datname='libriant_control';"` |
| 6   | Which Postgres client major do the api/worker images carry? A 17/18 client emits `SET transaction_timeout = 0;` which 16 rejects — it would break the customer-facing SQL export the way it once broke restore.                                   | `dc run --rm --no-deps --entrypoint sh api -c 'pg_dump --version; psql --version'`                                                                               |
| 7   | Does Docker's apt repo publish a suite for Ubuntu 26.04?                                                                                                                                                                                          | §3.3                                                                                                                                                             |
| 8   | What IP do the `@` and `admin` records actually point at?                                                                                                                                                                                         | Cloudflare dashboard → DNS                                                                                                                                       |
| 9   | Zone SSL/TLS mode, Always Use HTTPS source, Bot Fight Mode, security level                                                                                                                                                                        | Cloudflare dashboard / API                                                                                                                                       |
| 10  | Does an Origin CA cert for `libriant.com, *.libriant.com` already exist? Is it in the password manager?                                                                                                                                           | Cloudflare → SSL/TLS → Origin Server                                                                                                                             |
| 11  | Does `docker volume inspect libriant_storage` report the bind target or the `/var/lib/docker` path — and does the bind persist while api/worker are stopped (i.e. during a restore)?                                                              | §8, `findmnt` before and after `dc stop api worker`                                                                                                              |
| 12  | Real RTO, at production data volume                                                                                                                                                                                                               | §8.5 drill                                                                                                                                                       |
| 13  | `next build` peak memory and `/var/lib/docker` growth on this box                                                                                                                                                                                 | `docker system df` after the first cold build                                                                                                                    |
| 14  | Does the web container's baked-asset fallback resolve inside the Next.js server bundle? Nothing checks it — `/api/healthz` does not read assets.                                                                                                  | `dc exec -T web sh -c 'ls -l /app/assets/manifest.json /app/locales/el/common.json'`                                                                             |
| 15  | Do the four monitoring image pins still work on this host's cgroup version?                                                                                                                                                                       | §7.2                                                                                                                                                             |
| 16  | Does `DEPLOY_KNOWN_HOSTS` still pin the dead box?                                                                                                                                                                                                 | `gh secret list`, then `ssh-keyscan` compared out-of-band against the Hetzner console                                                                            |
| 17  | Does `scripts/install-server.sh` work against a real Ubuntu box? Its own logic is exercised (`--self-test` → `195 passed, 0 failed`, on a developer machine, 2026-08-28); **the box is not.**                                                     | §3 — run it, in tmux, with a second SSH session open                                                                                                             |
| 18  | Is `age` installable with `apt-get install -y age` on Ubuntu 26.04? The installer runs it and dies if `age` is still missing afterwards.                                                                                                          | `apt-cache policy age` on the box                                                                                                                                |
| 19  | Does fail2ban's `sshd` jail start on Ubuntu 26.04?                                                                                                                                                                                                | `fail2ban-client status sshd`                                                                                                                                    |
| 20  | Does node-exporter's textfile collector accept an **empty** `libriant_backup.prom` without raising `node_textfile_scrape_error`? §8.1b's workaround creates one.                                                                                  | `curl -s localhost:9100/metrics \| grep node_textfile_scrape_error`                                                                                              |
| 21  | Does a signed-in librarian actually see the takeover screen during a maintenance window (`frontend-03`'s fix)?                                                                                                                                    | §9.10a, one tenant, on a calm afternoon                                                                                                                          |
| 22  | Does a file upload actually succeed end to end? `data-integrity-01` is closed in code (`storage.service.ts:90`), but no cover image has ever been attached on a real host, and `--verify-only` still prints a stale BLOCKER banner for it (§3.9). | Attach a cover image to one book as a librarian, on one tenant                                                                                                   |
| 23  | Does the §8.3a manual restore work end to end, against real artefacts, in the mode this host actually uses? The libraries source and the filter/preamble were exercised here on a synthetic prologue; nothing else has been run.                  | §8.5's drill, with the real identity, on a scratch box                                                                                                           |

---

## How this document was built and checked

Written 2026-08-23, then fact-checked against its sources on the same day, then
extended on 2026-08-28. This section exists so the next operator knows exactly
how much of the document is load-bearing evidence and how much is still
inference.

**What the 2026-08-28 pass did.** It folded in `scripts/install-server.sh`
(committed 2026-08-28, five days after this document was written, and mentioned
here exactly once before that pass), added the complete `.env.prod` variable
reference (§4.2a–§4.2g), backup encryption and the dead man's switch
(§8.1a/§8.1b), control-database retention (§8.6), the price catalogue and the
`stripeReady` banner (§4.3c), putting an existing library on a contract (§6.6),
the fourth layer of the origin lockdown and the boot unit for it (§3.2c), and
moving a tenant's files (§10.3). It then **deleted the five documents this one
replaced** — `deployment-hetzner`, `server-handbook`, `cutover-three-hosts`,
`deploy-from-the-server`, `billing-go-live` — after confirming their surviving
facts are here, and trimmed `README.md`'s server-operations block down to
developer material. Every claim added in that pass was read out of the file it
lives in, and the things that could be executed on a developer machine were
(`install-server.sh --self-test`, `--status`, `--list-steps`; `backup.sh
--preflight` in three configurations; `restore.sh`).

The remediation waves of 2026-08-24 onward also closed nine of the twelve
blockers, and the 2026-08-28 pass corrected every place this document still
described them as open: `supply-chain-06` (§3.0, fixed in the repo and unproven
on a box), `boot-and-config-01` (§9.3), `reliability-01` (§7.4),
`data-integrity-01` (§3.9, §9.9), `billing-02` and `billing-03` (§4.3),
`privacy-legal-02` (§8.1), `performance-01` (§9.6) and `frontend-03` (§9.10).
Three remain open: `launch-readiness-01`, `privacy-legal-01`, `billing-04`.

**Dangling citations, deliberately left.**
`docs/audit/**` and `docs/runbook-rewrite-2026-08-23/RECON.json` cite the five
deleted documents by path about twenty times. Those are **dated evidence
records** describing the documents as they were on the day of the audit;
rewriting them would falsify the record. A citation that leads nowhere in those
files is expected — the content is in git history.

### Sources

| Source                                                                  | What it supplied                                                                                                                                                                                                                                                                                  |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/runbook-rewrite-2026-08-23/HOST-FACTS.md`                         | Every hardware, storage, network and installed-package claim in §1, §9.5, §10.1 and §10.3. Measured on the box on 2026-08-23.                                                                                                                                                                     |
| `docs/runbook-rewrite-2026-08-23/RECON.json`                            | 323 verified facts across seven areas (stack-topology, first-deploy, env-and-secrets, dns-tls, backup-dr, day2-ops, monitoring-incident), each carrying a `file:line` or the command that produced it. Also the 122 recorded errors in the documents this one replaces, and 88 recorded unknowns. |
| `docs/audit/pre-release-2026-08-23/BLOCKERS.json` and `FINAL-REPORT.md` | The twelve blockers as they stood on 2026-08-23 (nine blocking public launch, two the first paying customer, one scale). **Nine are now closed** — the status here is re-derived from the code, not from that file, which is a dated record and was not edited.                                   |
| The repository itself                                                   | Every command, path, port, image tag and default was read out of the file it lives in, not from RECON's summary of it.                                                                                                                                                                            |

### What was verified, and how

- **Hardware.** Every number in §1 was compared line by line with HOST-FACTS.
  All match: 62 GiB RAM, 8 GiB swap, 80 GiB `/`, 250 GiB `/mnt/libriant`
  (79 G / 246 G as `df` reports them), 137.81 GiB unallocated in `vg0`,
  2 × 476.9 GB NVMe in RAID1, kernel 7.0.0-30-generic, `enp0s31f6`,
  `2a01:4f8:13b:ac8::2/64`, `git` 2.53.0 / `curl` 8.18.0 / `ufw` 0.36.2. **No
  invented numbers survive.** In particular the dead box's "64 GB DDR4" appears
  nowhere.
- **Compose and Caddy.** Read directly: all nine services, their healthchecks
  and exact intervals, the three network tiers and `internal: true` on `data`,
  the six named volumes and the four the overlay rebinds, all eight
  `mem_limit`/`cpus` pairs (summing to 6016 MiB and 8.25 cpus), the `json-file`
  50m × 5 logging anchor, `restart: unless-stopped` vs `migrate`'s
  `restart: 'no'`, the four vhosts, the `(maintenance_check)` and
  `(maintenance_takeover)` snippets, and the `tls` line that rules out ACME.
  Re-read on 2026-08-28, which is where the ninth service (`pgbouncer-probe`),
  the explicit IPv4 publish, the Postgres timeouts and the Redis `maxmemory`
  came from.
- **Scripts.** `deploy-on-host.sh`, `ensure-env.sh`, `prod-bootstrap.sh`,
  `backup.sh`, `restore.sh`, `install-server.sh`, `_lib/backup-crypt.sh`,
  `_lib/backup-observability.sh` and `bootstrap-admin.ts` were read end to end.
  The deploy order in §3.8, the fifteen backup abort paths, the restore sequence
  in §8.3 and the 12-character admin-password minimum all come from the code.
  Two script defects documented here were **reproduced**, not inferred:
  `restore.sh` exiting 127 at line 44 (§8.3), and `obs_init` exiting 1 silently
  on a fresh host (§8.1b).
- **Env categories.** Now a five-way split (§4.1), re-derived on 2026-08-28
  against the `x-app-env` block, every service `environment:` block, and the
  monitoring overlay. The **seven** `${VAR:?}` hard-requires were confirmed at
  their compose lines, and the eighth (`GRAFANA_ADMIN_PASSWORD`) on the
  monitoring overlay. The claim that none of the five retention keys reaches a
  container was established by `grep` over all of `infra/` returning zero hits
  and no `env_file:` on any service.
- **Citations.** All seven `file:line` references were opened. Two were off and
  are corrected here: the SNI-broken CI health check is
  `.github/workflows/deploy.yml:417` (cited as `:373` and then as `:375`; both
  are comment lines, and `:417` is the `site=` assignment itself. Line 434 of
  the same block already uses `--resolve` correctly, which is what makes the
  precise line worth having), and the `openssl s_client` defect was at `docs/server-handbook.md:683`
  (was `:681`). The other five — `package.json:6`, `apps/api/Dockerfile:30`,
  `apps/web/Dockerfile:9`, `infra/caddy/Dockerfile:16` and
  `docs/deploy-from-the-server.md:113` — were exact. The two that point into
  deleted files are marked as such where they appear; read them with
  `git log --follow -p -- docs/<name>.md`. A further eleven unnumbered claims
  (Grafana's `127.0.0.1:3300`, the alert-rule names, the API gauges,
  `admin_users`, the four `postgres-init.sql` extensions, the
  `tenant:slug:<slug>` Redis key, and others) were confirmed in the repo.
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
images (it is three); the `HostSwapping` threshold, which is 50% of swap for 10
minutes and is a backstop rather than an early warning; the missing
`--filter until=72h` on the builder prune; the two citation line numbers; and the
unstated `IMAGE_OWNER` prompt in `ensure-env.sh`.

The 2026-08-28 pass corrected a further set, each of which would have read as a
different fault at 3am: the health gate polls **six** signals and not five, and
both of its literal strings carry the sixth; the deploy has an **eleventh** step
(the monitoring stack) that runs after the health gate and can fail the deploy;
`ensure_rand K 32` is `openssl rand -hex 32`, i.e. **64 hex characters**, not 32,
and `GRAFANA_ADMIN_PASSWORD` was missing from §3.7a's list entirely; §3.5 did not
create `/var/lib/node_exporter/textfile`, without which the nightly backup
refuses to run; the backup has **fifteen** abort paths, not five; the origin has
**no AAAA records** while §5.4 told you to create four; there are **nine**
compose services, not eight; `web`'s healthcheck is real now and `pgbouncer` has
none; and `restore.sh`'s central `STORAGE_DIR` warning described a trap that has
been closed while missing that the script does not execute at all.

Every blocker that touches an instruction is flagged **at the instruction**, not
only in a table: `billing-04` at the `BILLING_ENABLED` row in §4.3,
`launch-readiness-01` at §4.3a and §6.6, `privacy-legal-01` at §9.11c. The nine
that have since been closed are flagged there too, and say so — because an
operator who remembers a blocker and finds no mention of it assumes the document
is stale, and an operator who finds the old warning still standing acts on it.

One instruction was found to be **not executable as written and was rewritten
rather than trimmed**: "log into the admin panel once, over the local resolve,
and enrol MFA" (§3.9). A browser cannot be given `--resolve`; a `/etc/hosts`
entry reaches an origin serving a Cloudflare Origin CA certificate no browser
trusts; and the apex's `includeSubDomains` HSTS pin — probably already in your
browser — makes that error non-bypassable. §3.9 now names the two real options
and gives the from-the-box check that _is_ possible.

**The 2026-08-28 review pass.** Two independent reviews were run against the
consolidated document and their findings applied here. Fourteen corrections, of
which four were commands whose stated result an operator would not have got:

1. **§4.2b's own example contradicted its own lesson.** It grepped for
   `PUBLIC_HOST` in the `api` container and called four lines a pass.
   `PUBLIC_HOST` is a key only on `caddy` (`docker-compose.prod.yml:277`);
   `api` is `<<: *app-env` plus `PORT` and nothing else. The section whose job
   is teaching "injected" from "consumed" was demonstrating the failure and
   calling it success. Now it names the absence and explains it.
2. **§8.1a's `--preflight` recipe exits 1 with no output on a fresh box** —
   reproduced here, twice. `obs_init` dies under `set -e` when the textfile
   directory holds no `.prom`, which is exactly the state `install-server.sh`'s
   `dirs` step leaves. The `touch` workaround now sits above the block that
   needs it, not only in §8.1b below it.
3. **§8.3 had no commands.** It proved `restore.sh` is dead and then said the
   real path "is by hand", naming none of the four functions that hand requires.
   §8.3a now writes the whole pipeline out, with the count assertion in bold.
4. **§9.1's 522 triage read backwards once the origin lockdown is on.** It told
   you to `nmap` from your laptop and treated `filtered` as a fault — after
   §3.2c, `filtered` is the healthy answer — and it had no entry at all for the
   drifted Cloudflare range list, which is the cause §3.2c says produces a 522
   with a healthy stack behind it. Both fixed.

Also corrected: `satisfied_deploy()` checks five of the six health signals, not
six (the script's own comment claims six and is wrong); `install-server.sh`
exits 0 or 1 and never a count or 90; four modes run without root, not two; the
`ALERTS ARE NOT BEING DELIVERED.` banner is the host deploy's, while `ALERTING=off`
is the CI workflow's; a §3.2c scan that promised "22 open" did not scan port 22;
§4.2f quoted three clauses of a one-line message as though they were three
lines; the `-H 'Host:'` defect is at `deploy.yml:417`, not `:375`; §3.2d now
lists all ten packages so "four more" was wrong; §8.1b overstated the installer's
`die`; §4.4 miscounted its own five rows; the `dirs` assertion checks six parents,
not `caddy/origin`; and two blockquotes had lost their `>` continuation.

Rejected, after checking: the claim that `apps/site/content/privacy.en.md:76` was
the wrong line for the "12 months" sentence. It is the right line, in both
locales (`privacy.el.md:80`).

Three things outside the runbook were fixed because leaving them would have
recreated the drift this consolidation exists to end:
`docs/runbook-rewrite-2026-08-23/HOST-FACTS.md:45` told the reader to add `AAAA`
records, which §5.4 forbids and which produces a v6-only 522 — the measurement
stands, the inference is marked superseded;
`marketing/campaigns/launch-offer/reply-playbook.md` said the job registry has
ten entries (it has eleven) and now states that §6.6 is authoritative where they
disagree.

**Navigation.** The document had no table of contents at 5,500+ lines, and its
lettered sub-parts (`§3.2c`, `§9.10a`, `§9.11c`) were headed `**c. …**` — so
searching for the number an operator was sent to found only references, never the
target. There is now a "Where to look" index with a symptom-to-section router,
and every lettered sub-part carries its own number the way §9.4b already did.

### What remains unverified

Nothing in this document has been executed on 195.201.13.95. It has never been
deployed to, and this pass did not change that.

- **The whole of §3 is untested end to end**, by hand and by script.
  `scripts/install-server.sh --self-test` printed `195 passed, 0 failed` on a
  developer machine on 2026-08-28 — that exercises its parsers, its lockout
  counter, its PEM and certificate checks, the `--firewall-status` verdict, and
  the cron line and `dc` block it writes. It does not exercise a box.
- **The origin lockdown has never run on a live box**, and it inserts a DROP at
  `INPUT` position 1. Run it with a second SSH session open.
- The 23 items in the appendix, all of which are flagged inline where they
  matter. Chief among them: whether the corepack fix actually makes `migrate`
  pass, whether Caddy's directive order puts `/lbr-api/*` ahead of the
  catch-all, whether `MAINTENANCE_HARD`'s `vars` matcher fires at all, whether
  Docker's apt repo publishes a suite for Ubuntu 26.04, and the four Cloudflare
  dashboard settings nobody has read.
- **RTO is unknown, and the restore path is worse than unknown.** No restore has
  ever run to completion on a real host, CI proves the Postgres restore stream
  and nothing else, and `scripts/restore.sh` exits 127 before doing anything
  (§8.3). The recovery you have today is by hand, and it is now written out in
  full in §8.3a — but **§8.3a itself has never been run end to end.** What was
  executed for it on 2026-08-28 was: the three libraries source cleanly and
  every function it names is defined; `pg_restore_filter_count` returns exactly
  `2` on a synthetic `pg_dumpall` prologue; and `pg_restore_filter` removes the
  self-role pair, keeps the `ALTER ROLE … PASSWORD` line, and stops at
  `\connect`. Nothing was run against a real artefact, in any encryption mode,
  against a real cluster. That is unknowns register #23.
- **Decryptability is unproven.** In `age` mode the production host deliberately
  cannot decrypt its own backups. Encryption is proven on every run by a canary
  round trip; decryption is proven only by §8.5's drill, run with the real
  identity, which has never been done.
- The build-cost figures in §3.8 (10–20 min, ~15–20 GB of `/var/lib/docker`)
  were measured on the dead machine and are marked UNVERIFIED where they appear.
- Correctness of this document's _reasoning_ about code it read but did not run
  — the `IMAGE_TAG` and `--remove-orphans` hazards above are read-and-inferred,
  not reproduced on a box. Both are cheap to confirm on the first deploy; do so.
