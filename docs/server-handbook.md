# CyberSystema-1 — Server Handbook

Everything about the machine, and everything you do to it after it is running.

**This is not the install guide.** [`deployment-hetzner.md`](deployment-hetzner.md)
takes bare metal to a serving stack, once. This handbook is _day two onward_:
what the hardware is, how to look after it, and what to do when something breaks
at an inconvenient hour. Where the two overlap, the runbook is the authority on
**building** and this handbook is the authority on **operating**.

Read Part 1 and Part 9 now, while nothing is wrong. The rest is reference.

---

## Contents

| #                                           | Part                    | Read it when                        |
| ------------------------------------------- | ----------------------- | ----------------------------------- |
| [1](#part-1--the-machine)                   | The machine             | Now, once                           |
| [2](#part-2--getting-in)                    | Getting in              | Locked out, or setting up a laptop  |
| [3](#part-3--the-disks)                     | The disks               | Growing, or a drive is unhappy      |
| [4](#part-4--what-actually-runs-on-the-box) | What runs on the box    | Orienting yourself                  |
| [5](#part-5--the-rhythm)                    | The rhythm              | Now, once — then it's a calendar    |
| [6](#part-6--the-health-sweep)              | The health sweep        | Weekly, and before every risky move |
| [7](#part-7--monitoring--alerting)          | Monitoring & alerting   | Setting up watchfulness             |
| [8](#part-8--backups-you-can-actually-use)  | Backups                 | Now, once — then quarterly          |
| [9](#part-9--when-it-breaks)                | **When it breaks**      | The bad day. Symptom-indexed.       |
| [10](#part-10--procedures)                  | Procedures              | Doing a specific job                |
| [11](#part-11--hosting-your-other-projects) | Hosting other projects  | Adding project #2                   |
| [12](#part-12--the-security-model)          | The security model      | Before exposing anything new        |
| [13](#part-13--capacity-and-the-ceilings)   | Capacity & the ceilings | Deciding whether to grow or move    |
| [14](#part-14--quick-reference)             | Quick reference         | Constantly                          |

---

## Part 1 — The machine

A Hetzner **dedicated** server bought from the Server Auction (_Serverbörse_).
Dedicated, not cloud — which is the single most important fact in this document,
because it changes what is possible in almost every direction.

| Item        | Value                                                         |
| ----------- | ------------------------------------------------------------- |
| Hostname    | `CyberSystema-1`                                              |
| CPU         | Intel Xeon **E3-1275 v6** — 4 cores / 8 threads, Kaby Lake    |
| RAM         | **64 GB DDR4 ECC**                                            |
| Disks       | 2 × 512 GB Samsung **SM961** NVMe (`MZVKW512HMJP-00000`, MLC) |
| Redundancy  | **RAID 1** (mdadm software mirror) + **LVM** on top           |
| OS          | Ubuntu **26.04 LTS**                                          |
| Location    | Falkenstein / Helsinki — confirm yours in Robot               |
| Price       | ~**€82.71/month** incl. VAT, €0 setup                         |
| Traffic     | Unlimited, 1 Gbit/s                                           |
| Managed via | Hetzner **Robot** (_not_ Cloud Console, _not_ `hcloud`)       |

### The three facts that follow from "dedicated"

**1. You cannot resize it. Ever.** There is no "upgrade to the next size" button.
4 cores and 64 GB are permanent for the life of this contract. Growing means
ordering a _different_ server and migrating to it (§13). Plan capacity as a
fixed budget you spend, not a dial you turn.

**2. Reinstalling formats the drives.** On Hetzner _Cloud_, a rebuild can leave
an attached volume intact. Here, `installimage` writes over the disks it is
pointed at. There is no volume to survive it. **Your backups are your only
recovery** — see §8, and take that sentence literally.

**3. Hardware failure is a support ticket, not an API call.** A dying disk means
Robot → Support, a technician, and a scheduled swap window. The RAID 1 mirror is
what buys you the time to schedule it calmly instead of at 3am.

### The disks deserve a specific warning

Both NVMe drives came from the same production batch — the serial numbers are 36
apart:

```
S316NX0J409527
S316NX0J409563
```

Same batch, same age, same workload, same wear curve. RAID 1 protects you
beautifully against _one_ drive failing at random; it protects you much less
than you'd hope against two drives that were always going to wear out at the
same time. This is not a reason to panic — SM961 is MLC, which is far more
durable than modern TLC/QLC consumer drives — but it is a reason to **actually
watch the wear indicator** (§6) instead of assuming the mirror has you covered,
and to keep offsite backups current (§8).

---

## Part 2 — Getting in

### Normal access

```sh
ssh deploy@libriant.com          # or the bare IP
```

Key-based only. Password authentication and direct root login are both disabled
(runbook Part 5). You escalate with `sudo` once inside.

Keep at least **two** keys authorized — your laptop and a backup key stored in
your password manager. A single key on a single laptop is one spilled coffee
away from a KVM session.

### The escalation ladder

When normal SSH fails, work down this list. Each rung is slower and more
expensive than the one above it, so don't skip ahead.

| Rung            | Use it for                                 | Cost                 |
| --------------- | ------------------------------------------ | -------------------- |
| **SSH**         | Everything normal                          | Free                 |
| **Rescue**      | Broken boot, full disk, fsck, data rescue  | Free                 |
| **vKVM**        | Firewall lockout — boots _your_ OS in a VM | Free                 |
| **KVM Console** | BIOS, boot menu, "nothing works at all"    | Free 3h, then billed |

### Rescue System

A minimal Linux that boots **entirely in RAM** and never touches your drives.
Safe to boot even when you only want to copy one file off.

Robot → your server → _Rescue_ → Linux, 64-bit, select your key → _Activate_.
Then Robot → _Reset_ → _Execute an automatic hardware reset_.

**Three gotchas, all of which will bite you exactly once:**

- Activation is armed for **one boot only**. Use it or re-arm it.
- It **disarms after 60 minutes** if you never reboot.
- The rescue system has a **different SSH host key**, so you get a loud
  `REMOTE HOST IDENTIFICATION HAS CHANGED` warning. Compare the fingerprint
  Robot shows you, then `ssh-keygen -R <ip>`. Rescue also listens on port **222**.

Mounting your data from rescue is in §10.4 — and it has a step everyone forgets.

### If you lock yourself out with the firewall

This is the single most likely way to lose access, and it has a specific answer:
**vKVM**. It boots your installed OS inside a virtualised environment with
console access, so you can edit `ufw` rules and reboot normally. Robot → your
server → the vKVM option. Rescue would also work but drops you outside your OS;
vKVM keeps you inside it, which is what you want for a rules mistake.

---

## Part 3 — The disks

### The layout

```
nvme0n1 ─┐
         ├─ md0 (RAID 1) ─→ /boot                         1 GiB   ext3
nvme1n1 ─┘
         └─ md1 (RAID 1) ─→ vg0 (LVM volume group)      ~475 GiB
                             ├─ swap                        8 GiB  swap
                             ├─ root  →  /                 80 GiB  ext4
                             ├─ data  →  /mnt/libriant     250 GiB ext4
                             └─ (unallocated)            ~137 GiB  ← deliberate
```

Confirm it any time with:

```sh
lsblk
cat /proc/mdstat
vgs && lvs
df -h /  /mnt/libriant
```

### Why it is shaped like this

**RAID 1** because a dedicated box has no live-migration escape hatch: if a disk
dies without a mirror, you are down until a technician physically visits.

**LVM on top of the RAID** because the hardware cannot be upgraded. LVM is the
only flexibility this machine has left — it lets you move space between volumes
without a reinstall, and gives you snapshots as a rollback point before risky
operations (§10.2).

**~137 GiB left unallocated on purpose.** This is not wasted space; it is the
reserve. Space sitting free in the VG can be given to whichever volume actually
turns out to need it. Space already committed to the wrong volume cannot easily
be taken back (ext4 shrinking requires unmounting and is genuinely risky). Grow
into the reserve as you learn the real usage; never carve it up in advance.

**Separate `/` and `/mnt/libriant`** so that runaway uploads or backups fill a
data volume and stop, rather than filling the root filesystem and taking the
whole operating system down with them. This separation is doing real work — see
the trap in §8.

---

## Part 4 — What actually runs on the box

### The stack

Docker Compose, from `/srv/libriant/app`, using two overlaid files.

| Service     | Role                                   | Exposed        |
| ----------- | -------------------------------------- | -------------- |
| `caddy`     | TLS termination, reverse proxy         | **80 / 443**   |
| `web`       | Next.js frontend                       | internal :3000 |
| `api`       | Backend API                            | internal :3001 |
| `worker`    | Background jobs                        | internal :3002 |
| `postgres`  | Database                               | internal :5432 |
| `pgbouncer` | Connection pooling                     | internal       |
| `redis`     | Cache / queues                         | internal :6379 |
| `migrate`   | One-shot; runs to completion on deploy | —              |

Three Docker networks isolate the tiers: **`edge`** (caddy only), **`app`**, and
**`data`**. Uploads live in the `storage` volume.

Only ports **80** and **443** are public. Everything else is reachable only from
inside the Compose networks. See §12 for why that is less automatic than it
sounds.

### The `dc` helper

Set up in runbook Part 6 and sourced from `~/.bashrc`. It is just Compose with
both files pre-supplied — use it for everything:

```sh
dc ps                  # what's up, what's restarting
dc logs -f api         # follow one service
dc restart api         # bounce one service
dc stop                # graceful drain (do this before a reboot)
dc up -d               # start / recreate
```

### Deploys

**Push to `main` → GitHub Actions builds, pushes to GHCR, SSHes in, and deploys.**
Migrations run automatically as the one-shot `migrate` service before `api` and
`worker` start. You do not run migrations by hand.

> **The trap:** CI runs `git reset --hard`. Any host-local edit to a **tracked**
> file — tuning the `postgres` command in the compose file, say — is silently
> destroyed on the next deploy. Put customisations in `.env.prod` or an untracked
> override file, never in a tracked one.

Break-glass manual deploy:

```sh
cd /srv/libriant/app && git pull
dc pull && dc up -d --remove-orphans
```

---

## Part 5 — The rhythm

Most server disasters are the slow, boring kind: a disk that filled up over
eleven weeks, a backup that stopped working in March and was noticed in
September. The rhythm exists to catch those while they are still boring.

| When          | Do                                                                      |
| ------------- | ----------------------------------------------------------------------- |
| **Automatic** | Nightly backup (02:15), unattended security upgrades, Livepatch         |
| **Weekly**    | The health sweep (§6). Two minutes.                                     |
| **Monthly**   | `sudo apt update && sudo apt full-upgrade`; reboot if a kernel landed   |
| **Quarterly** | **Restore drill** (§8). Check NVMe wear trend. Review disk growth rate. |
| **Yearly**    | Rotate secrets; re-read this document; sanity-check the Robot contract  |

### Patching without fear

Ubuntu Pro is free for up to 5 machines and gives you **Livepatch**, which
applies kernel security fixes **without a reboot**:

```sh
pro attach <token>            # from https://ubuntu.com/pro/dashboard
pro enable livepatch
pro status
```

On a single box with no failover, this is the difference between patching
promptly and postponing kernel CVEs because a reboot means downtime. Livepatch
covers the kernel; you still reboot occasionally to move onto the new kernel
properly, but you choose when.

Unattended upgrades handle userspace security patches. Check they are actually
running — this is a classic silent failure:

```sh
systemctl status unattended-upgrades
grep -c "" /var/log/unattended-upgrades/unattended-upgrades.log
```

### Rebooting properly

```sh
dc stop                        # drain the app cleanly first
sudo reboot
```

After it comes back, run the health sweep. Confirm `/proc/mdstat` reads `[UU]`
and every container is `Up`, not `Restarting`.

---

## Part 6 — The health sweep

Two minutes, weekly. Also run it before anything risky and after anything
unexpected.

```sh
uptime                                     # load: sustained >8.0 is real trouble
free -h                                    # available should stay well clear of 0
df -h / /mnt/libriant                      # both under 80%
cat /proc/mdstat                           # MUST read [UU]
vgs                                        # how much reserve is left
dc ps                                      # all Up; nothing Restarting
ls -lh /mnt/libriant/backups/$(date +%Y%m%d)/   # last night's backup exists
```

NVMe wear — the number that matters most on this particular machine:

```sh
sudo smartctl -A /dev/nvme0n1 | grep -iE 'percentage_used|data_units_written|media_errors'
sudo smartctl -A /dev/nvme1n1 | grep -iE 'percentage_used|data_units_written|media_errors'
```

### What good looks like

| Signal                 | Healthy | Look into it     | Act now       |
| ---------------------- | ------- | ---------------- | ------------- |
| Load average (4C/8T)   | < 4.0   | 4–8              | > 8 sustained |
| Memory available       | > 8 GB  | 2–8 GB           | < 2 GB        |
| Swap in use            | ~0      | any steady usage | growing       |
| `/` used               | < 70%   | 70–85%           | > 85%         |
| `/mnt/libriant`        | < 70%   | 70–85%           | > 85%         |
| `/proc/mdstat`         | `[UU]`  | resyncing        | `[U_]`        |
| NVMe `percentage_used` | < 50%   | 50–80%           | > 80%         |
| `media_errors`         | 0       | any              | rising        |

**On the two drives specifically:** compare their `percentage_used` to each
other. Same-batch drives wearing identically is expected; what you want to catch
is one of them pulling ahead, or `media_errors` appearing on either. Log the
numbers quarterly so you have a trend rather than a single reading.

---

## Part 7 — Monitoring & alerting

The repo ships a monitoring stack at
[`infra/monitoring/`](../infra/monitoring/): **Prometheus** (v3.1.0),
**node-exporter**, **cAdvisor**, and **Grafana OSS**.

```sh
cd /srv/libriant/app
docker compose -f infra/monitoring/docker-compose.monitoring.yml up -d
```

Grafana must **not** be exposed publicly. Reach it over an SSH tunnel:

```sh
ssh -L 3000:localhost:3000 deploy@libriant.com
# then open http://localhost:3000 on your laptop
```

Alert rules live in [`infra/monitoring/alerts.yml`](../infra/monitoring/alerts.yml)
and already cover the things that actually page you:

`TargetDown` · `LibriantApiDown` · `HostLowMemory` · `HostSwapping` ·
`HostDiskFilling` · `HostDiskCritical` · `HostHighCPU` ·
`LibriantPgConnectionsHigh` · `LibriantPgConnectionsCritical` ·
`LibriantPgCacheHitLow`

**Prometheus does not deliver alerts by itself.** Without Alertmanager wired to
a real destination, the rules fire into a dashboard nobody is looking at. Until
you configure that, treat the weekly sweep (§6) as your alerting system, and be
honest with yourself that it is.

Two alerts specific to this hardware are worth adding, since node-exporter
already provides the metrics: **RAID degraded** (`node_md_disks{state="failed"}`)
and **NVMe wear** — neither is covered by the shipped rules.

---

## Part 8 — Backups you can actually use

> On this machine, backups are not a safety net alongside other recovery options.
> They **are** the recovery option. Everything in this section deserves more
> care than it feels like it deserves.

### What runs

`scripts/backup.sh` nightly at 02:15 via `/etc/cron.d/libriant-backup`: dumps all
databases with `pg_dumpall`, tars the uploads, snapshots the Caddy log, prunes
dailies older than `BACKUP_KEEP_DAYS` (default 14), and optionally `rclone`s the
result offsite.

### The `BACKUP_ROOT` trap

`backup.sh` defaults `BACKUP_ROOT` to **`/srv/libriant/backups`**, which is on
the **80 GiB root volume**. Left at the default, backups slowly fill `/` and
eventually take down the operating system — the exact failure the split layout
in §3 exists to prevent.

**`BACKUP_ROOT` must be `/mnt/libriant/backups`.** The cron entry and the
runbook both set it explicitly. If you ever invoke `backup.sh` by hand, set it
by hand too:

```sh
COMPOSE_FILE=/srv/libriant/app/infra/compose/docker-compose.prod.yml \
BACKUP_ROOT=/mnt/libriant/backups \
  /srv/libriant/app/scripts/backup.sh
```

### Offsite

A local backup does not survive the loss of the machine, and the machine is the
thing most likely to be lost. Hetzner **Storage Box** (BX11 is cheap) via
`rclone`, with `RCLONE_REMOTE=storagebox:libriant-backups` in `.env.prod`.

### What is deliberately NOT backed up

**`.env.prod` is excluded on purpose.** It holds every secret; a backup archive
containing it turns a stolen backup into a total compromise. It lives in your
**password manager** and nowhere else. If you rebuild from nothing, you restore
data from backup and secrets from the password manager — two different places,
by design.

### Restoring

```sh
COMPOSE_FILE=/srv/libriant/app/infra/compose/docker-compose.prod.yml \
BACKUP_ROOT=/mnt/libriant/backups \
STORAGE_DIR=/mnt/libriant/storage \
  /srv/libriant/app/scripts/restore.sh <YYYYMMDD> --yes
```

`--yes` is mandatory. The script DROPs and recreates **every** database including
per-tenant ones, so it refuses to run on a typo. It also stops api/worker/web and
terminates open connections before the DROP wave, restores under
`ON_ERROR_STOP=1`, and moves the existing uploads aside into
`.pre-restore.<timestamp>/` rather than merging into them.

### The drill — quarterly, non-negotiable

An untested backup is a belief, not a backup. Once a quarter, restore last
night's backup onto a **throwaway** host (a small Hetzner Cloud VM, destroyed
afterwards) and verify:

1. The restore completes without error.
2. Control-plane row counts match production.
3. Each tenant database exists **and has its extensions**.
4. A file from the uploads tarball opens correctly.

Write down how long it took. That number — not an aspiration — is your real RTO.

---

## Part 9 — When it breaks

Symptom-indexed. Start with the symptom you can see.

### 9.1 The site is down

```sh
dc ps                        # is anything Restarting or Exited?
dc logs --tail=100 caddy
dc logs --tail=100 api
curl -I https://libriant.com/healthz
```

Work outward: is it the app, the box, or the network?

- **Containers up, `/healthz` fine locally but not externally** → Cloudflare or
  DNS, not the server. Check the Cloudflare dashboard; check the origin
  certificate has not expired.
- **A container restart-looping** → read its logs. Nine times in ten it is a bad
  env var after a deploy, or postgres not ready yet.
- **Nothing responds, SSH fine** → check §9.2 and §9.3 first; a full disk or OOM
  presents as "everything is broken".
- **SSH itself does not answer** → §2, escalation ladder.

### 9.2 Disk full

The most common real outage cause on a small server.

```sh
df -h                                        # which volume?
sudo du -xh --max-depth=1 / | sort -rh | head -20
sudo du -xh --max-depth=1 /mnt/libriant | sort -rh | head -20
docker system df                             # Docker is usually the culprit
```

If `/` is full, the usual suspects in order: Docker images and build cache,
journal logs, backups that landed in the wrong place (§8).

```sh
docker system prune -a --volumes         # ⚠ read the prompt; --volumes is real
sudo journalctl --vacuum-size=200M
```

> Never `prune --volumes` without confirming the `storage` and postgres volumes
> are in use by running containers. `docker volume ls` first.

If `/mnt/libriant` is full and the growth is legitimate, extend it from the
reserve — §10.1.

### 9.3 Out of memory

```sh
free -h
dmesg -T | grep -i 'killed process'      # did the OOM killer fire?
dc stats --no-stream                     # which container is eating it?
```

64 GB is a lot; genuine exhaustion usually means a leak or a runaway query, not
legitimate growth. Check `LibriantPgConnectionsHigh` — a connection leak through
pgbouncer is the classic cause. Restart the offending service, then find the
leak rather than scheduling a nightly restart.

`vm.swappiness=10` is set so the box prefers reclaiming cache over swapping.
Steady swap usage means real pressure, not tuning — investigate it.

### 9.4 High CPU

With 4 cores, load average 8 means every thread is saturated.

```sh
uptime
top -o %CPU
dc stats --no-stream
```

If it is postgres, find the query:

```sh
dc exec postgres psql -U postgres -c \
  "SELECT pid, now()-query_start AS dur, state, left(query,80) FROM pg_stat_activity
   WHERE state <> 'idle' ORDER BY dur DESC LIMIT 10;"
```

A single unindexed query on a growing tenant table is the usual answer. Fix the
index; do not fix the symptom.

### 9.5 RAID degraded — `[U_]`

```sh
cat /proc/mdstat
sudo mdadm --detail /dev/md1
sudo smartctl -a /dev/nvme0n1
sudo smartctl -a /dev/nvme1n1
```

**Order of operations, and it matters:**

1. **Do not reboot.** A degraded array plus a reboot is how a survivable
   incident becomes a restore.
2. **Take a fresh backup immediately**, and get it offsite. You are now running
   without redundancy.
3. Identify which drive failed and confirm with SMART.
4. **Then** open a Robot ticket → _Support_, including the full `/proc/mdstat`
   and `mdadm --detail` output.
5. After Hetzner swaps the drive, partition the replacement to match and re-add
   it. Let the resync finish — watch `/proc/mdstat` — before considering it
   resolved.

The mirror is carrying you the whole time. That is exactly what it is for: it
converts an emergency into a scheduled maintenance window. Use the calm.

### 9.6 Postgres will not start

```sh
dc logs --tail=200 postgres
```

- **"database system was not properly shut down"** → normal recovery, let it
  finish.
- **Disk full** → §9.2. Postgres refuses to start with no room, and this is by
  far the most common cause.
- **Corruption after an unclean stop** → restore (§8). Do not experiment on the
  live data directory; snapshot it first (§10.2) if you want to try anything.

### 9.7 TLS / certificate problems

The stack uses a **Cloudflare Origin Certificate**, not Let's Encrypt — so there
is no ACME renewal to fail, but there _is_ a fixed expiry date to diarise.

```sh
dc logs caddy | grep -i 'tls\|certificate'
echo | openssl s_client -connect localhost:443 2>/dev/null | openssl x509 -noout -dates
```

Origin certs are long-lived (up to 15 years). Cloudflare's edge certificate
renews itself. If browsers report an error but the origin cert is valid, the
problem is at Cloudflare — check the SSL/TLS mode is **Full (strict)**.

### 9.8 Locked out by the firewall

You changed `ufw` and lost SSH. → **vKVM** (§2). Boot in, fix the rules, reboot.

Prevention, for next time — this pattern has saved many people:

```sh
sudo ufw allow 22/tcp        # BEFORE any deny/default change
# and when doing something genuinely risky, arm a dead-man's switch:
sudo shutdown -r +10         # reboot in 10 min unless you cancel
# ... make the change, confirm you still have access, then:
sudo shutdown -c
```

### 9.9 A deploy broke production

```sh
cd /srv/libriant/app
git log --oneline -5
git checkout <last-good-sha>
dc pull && dc up -d
```

**Migrations do not roll back.** If the bad deploy migrated the schema, code
rollback alone will not save you — you are into restore territory (§8). This is
the argument for taking an LVM snapshot before a migration you are unsure of
(§10.2).

---

## Part 10 — Procedures

### 10.1 Grow a volume from the reserve

The reserve exists for exactly this. Both steps are **online** — no unmount, no
downtime — because ext4 grows live.

```sh
vgs                                          # confirm free space exists
sudo lvextend -L +50G -r /dev/vg0/data       # -r resizes the filesystem too
df -h /mnt/libriant
```

Use `-L +50G` (add 50 GiB), not `-L 50G` (set to 50 GiB — which would try to
shrink). Grow in increments you have a reason for; the reserve is finite and
unallocated space keeps its options open.

**Shrinking is a different animal**: it requires unmounting and carries real
risk of data loss. Treat every extension as permanent.

### 10.2 Snapshot before something risky

Your rollback point for migrations, major upgrades, and experiments.

```sh
sudo lvcreate -L 20G -s -n data_snap /dev/vg0/data     # create
# ... do the risky thing ...

sudo lvremove /dev/vg0/data_snap                       # happy path: discard
# OR, to roll back:
sudo lvconvert --merge /dev/vg0/data_snap              # takes effect on unmount/reboot
```

Three things to know: a snapshot fills as the origin changes and is **discarded
automatically if it fills**, so size it for the expected churn; it costs write
performance while it exists; and it is **not a backup** — it lives on the same
disks and dies with them. Delete snapshots promptly.

### 10.3 Rotate a secret

1. Change the value in **`.env.prod`** on the server (never in a tracked file).
2. Update your **password manager** in the same sitting — `.env.prod` is not
   backed up, so the password manager is the only durable copy.
3. `dc up -d` to recreate the affected containers.
4. `dc logs -f api` and confirm it came back healthy.

### 10.4 Mount your data from rescue

The recipe with the forgotten step. Also in the runbook Part 17.

```sh
mdadm --assemble --scan          # bring the mirror up
cat /proc/mdstat                 # [UU] good; [U_] degraded but readable

vgchange -ay                     # ← WITHOUT THIS, NOTHING APPEARS
lvs                              # root, data, swap should now be listed

mkdir -p /mnt/old
mount /dev/vg0/root /mnt/old
mount /dev/vg0/data /mnt/old/mnt/libriant
```

Without `vgchange -ay` the logical volumes never materialise as devices, and it
looks precisely as though your data is gone. It is not — the volume group is
inactive. Unmount in reverse order before rebooting.

### 10.5 Rebuild the box from nothing

The full-loss path. Assumes backups are offsite and secrets are in your password
manager.

1. Robot → Rescue → `installimage` with the exact config in runbook Part 2
   (`SWRAID 1`, `SWRAIDLEVEL 1`, the LVM layout).
2. Confirm `[UU]` in `/proc/mdstat` and the LVs in `lvs`.
3. Runbook Part 5 — base setup, `ufw`, Ubuntu Pro, SSH hardening.
4. Runbook Part 6 — clone the code, restore `.env.prod` **from your password
   manager**.
5. Pull backups down from the Storage Box.
6. `restore.sh <date> --yes` (§8).
7. Runbook Part 7 — DNS / TLS.
8. Verify against the health sweep (§6) and the restore-drill checklist (§8).

Be honest about the RTO: this is **hours**, not minutes, and the number you
should quote is the one you measured in your last drill — not the one you hope
for.

### 10.6 Postgres tuning for 64 GB

Set in `.env.prod` or an untracked compose override — never a tracked file (§4):

```
shared_buffers=8GB
effective_cache_size=24GB
work_mem=32MB
maintenance_work_mem=1GB
```

`work_mem` is **per sort operation, per connection** — a high value multiplied by
many concurrent connections is a classic route to §9.3. Raise it deliberately.

---

## Part 11 — Hosting your other projects

The reason for buying a dedicated box was to run more than Libriant on it. That
works, with discipline — and the discipline is what stops project #2 from taking
down project #1.

**Rules that keep the neighbours honest:**

1. **One Compose project per application**, each in its own directory under
   `/srv/`, each with its own networks. Never join a new project to Libriant's
   `data` network.
2. **Set resource limits on everything new.** An unlimited container on a 4-core
   box can starve the others:
   ```yaml
   deploy:
     resources:
       limits: { cpus: '1.0', memory: 2G }
   ```
3. **One reverse proxy.** Caddy already owns 80/443. New projects get a vhost in
   the Caddyfile and an internal port — they must not bind 80/443 themselves.
4. **Give each project its own LV** from the reserve, so one project filling its
   disk cannot take down another. This is the reserve's second job.
5. **Separate postgres instances**, or at minimum separate databases with
   separate roles. Shared credentials across projects means one compromise is
   every compromise.
6. **Back up every project.** `backup.sh` knows about Libriant only. A new
   project without a backup path is an outage waiting for a reason.

**Budget honestly.** 4 cores and 64 GB is generous for RAM and tight for CPU.
Libriant's postgres alone will happily use 8 GB. Track the total in §13 rather
than discovering the ceiling during someone's busy morning.

---

## Part 12 — The security model

### What is exposed

| Port    | Service | Reachable from         |
| ------- | ------- | ---------------------- |
| 22      | SSH     | Key-only, no root      |
| 80, 443 | Caddy   | Cloudflare ranges only |

Everything else — postgres, redis, the app services — listens only on internal
Docker networks.

### The Docker/ufw trap

**This is the single most dangerous thing about this setup, and it is invisible.**

Docker manipulates `iptables` directly and inserts its rules **ahead of ufw's
chains**. A container published with `-p 5432:5432` is reachable from the public
internet **even though `ufw status` shows the port as denied**. ufw will lie to
you with a straight face.

Two defences, use both:

1. **Never publish a port you don't mean to expose.** Bind to localhost when you
   need host access: `-p 127.0.0.1:5432:5432`.
2. **Verify from outside**, because that is the only check that cannot be fooled:
   ```sh
   nmap -Pn -p 22,80,443,5432,6379 <your-server-ip>     # run from your laptop
   ```
   Anything open beyond 22/80/443 is a finding. Re-run this after every change
   that touches ports.

### Hardening checklist

- [ ] SSH: key-only, root login disabled, ≥2 authorized keys
- [ ] `ufw` default deny inbound; 80/443 restricted to Cloudflare ranges
- [ ] `nmap` from outside confirms only the intended ports (see above)
- [ ] Unattended-upgrades running **and verified in its log**
- [ ] Ubuntu Pro attached, Livepatch enabled
- [ ] `fail2ban` on the SSH jail
- [ ] `.env.prod` is `chmod 600`, owned by `deploy`, not in git, not in backups
- [ ] Grafana reachable only via SSH tunnel, never published
- [ ] Cloudflare SSL/TLS mode is **Full (strict)**
- [ ] Origin certificate expiry is in your calendar

---

## Part 13 — Capacity and the ceilings

Two permanent limits, neither of which can be raised on this contract:

**4 cores / 8 threads.** The one you will hit first. Sustained load average
above 8 means saturation, and there is no bigger CPU to move to.

**~475 GiB of mirrored storage.** Generous for a library catalogue — text and
metadata are small — but uploads and backups both grow monotonically. The
reserve (§3) is your buffer, and it is spent, not renewed.

RAM is unlikely to be the constraint. 64 GB is a lot for this workload.

### Signals it is time to move

- Load average routinely > 6 at normal traffic
- `vgs` free space below ~30 GiB with growth continuing
- Postgres cache hit ratio persistently low despite tuning (`LibriantPgCacheHitLow`)
- NVMe `percentage_used` above 80% on either drive
- The box is doing so much that a reboot is genuinely frightening

### Moving to a bigger server

There is no in-place upgrade. The move is: order the new box, build it from the
runbook, restore into it, cut DNS over, cancel the old one. **The restore drill
is the rehearsal for this** — a team that has drilled restores can migrate in an
evening; a team that has not will discover every problem live.

Hetzner contracts are month-to-month: Robot → _Cancellation_. Cancel only after
the new box has served real traffic for a few days, and after you have pulled a
final backup.

---

## Part 14 — Quick reference

### Paths

| What        | Where                         |
| ----------- | ----------------------------- |
| Application | `/srv/libriant/app`           |
| Secrets     | `/srv/libriant/.env.prod`     |
| Data volume | `/mnt/libriant`               |
| Backups     | `/mnt/libriant/backups`       |
| Uploads     | `/mnt/libriant/storage`       |
| Logs        | `/var/log/libriant/`          |
| Backup cron | `/etc/cron.d/libriant-backup` |

### Commands

```sh
# stack
dc ps                       dc logs -f api
dc restart api              dc up -d
dc stop                     dc stats --no-stream

# health
uptime                      free -h
df -h / /mnt/libriant       cat /proc/mdstat
vgs && lvs                  docker system df
sudo smartctl -A /dev/nvme0n1 | grep -i percentage_used

# storage
sudo lvextend -L +50G -r /dev/vg0/data
sudo lvcreate -L 20G -s -n data_snap /dev/vg0/data

# backup / restore
COMPOSE_FILE=/srv/libriant/app/infra/compose/docker-compose.prod.yml \
BACKUP_ROOT=/mnt/libriant/backups /srv/libriant/app/scripts/backup.sh

COMPOSE_FILE=/srv/libriant/app/infra/compose/docker-compose.prod.yml \
BACKUP_ROOT=/mnt/libriant/backups STORAGE_DIR=/mnt/libriant/storage \
  /srv/libriant/app/scripts/restore.sh <YYYYMMDD> --yes

# from rescue
mdadm --assemble --scan && vgchange -ay && lvs
```

### Robot

| Task           | Where                                       |
| -------------- | ------------------------------------------- |
| Rescue system  | Robot → server → _Rescue_, then _Reset_     |
| Hardware reset | Robot → server → _Reset_                    |
| KVM console    | Robot → server → _Support_ → Remote Console |
| Report a disk  | Robot → _Support_ (attach `/proc/mdstat`)   |
| Reverse DNS    | Robot → _IPs_ → edit rDNS                   |
| Cancel         | Robot → _Cancellation_ (month-to-month)     |

### The five things worth memorising

1. **Backups are the only recovery.** There is no snapshot to roll back to.
2. **`vgchange -ay`** — or your data looks gone from rescue when it is not.
3. **`ufw` lies about Docker-published ports.** Verify with `nmap` from outside.
4. **Never reboot a degraded array** before taking a fresh backup.
5. **CI `git reset --hard`s the repo.** Host-local edits to tracked files die.

---

**Related:** [`deployment-hetzner.md`](deployment-hetzner.md) — building the box
from bare metal. This document assumes it has already been followed.
