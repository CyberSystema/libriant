# Deploying from the server

_Libriant is a **[CyberSystema](https://cybersystema.com)** product._

Deploys are **manual and run on the box** as of 2026-08-22. You SSH in and run
one script. GitHub does not deploy: the push trigger is removed from
`deploy.yml`, which is now `workflow_dispatch` only.

```
195.201.13.95     the server            ← deploy target
178.104.32.176    the previous server   ← GONE, see below
```

`ci.yml` still runs the full verify suite on every push, so nothing about
**checking** changed. What is switched off is **shipping**.

---

## What happened to the old box

On 2026-08-22 a push to `main` ran the deploy workflow, which died at its first
SSH:

```
ssh: connect to host 178.104.32.176 port 22: Connection timed out
```

Ports 22 and 443 on that address both time out; the machine is gone. Nothing
was deployed and nothing is half-applied — the failure was at the
`Capture rollback target` step and `Deploy (git sync + compose up)` was skipped.

This also settles a contradiction the repo used to carry: the runbook recorded
`A @ → 178.104.32.176`, the campaign checklist said the apex was dark. The
checklist was right. Today `libriant.com` resolves to Cloudflare and returns
**000** — Cloudflare with no origin behind it — and `app.libriant.com` has no A
record at all.

**Nothing is public right now.** Deploying to the new box does not change that;
it stays private until you point DNS at it.

---

## First deploy on a fresh box

These are the things that will stop a first deploy dead. The script checks all
of them and refuses with the real cause, but doing them in order is faster than
being told off five times.

### 1. Docker, a `deploy` user, and the checkout

Follow **Parts 1–4 of [deployment-hetzner.md](deployment-hetzner.md)** for host
hardening, Docker, the `deploy` user, and the LVM layout. Then:

```bash
sudo mkdir -p /srv/libriant
sudo git clone https://github.com/CyberSystema/libriant.git /srv/libriant/app
sudo chown -R deploy:deploy /srv/libriant
```

### 2. Data directories — all five

```bash
sudo mkdir -p /mnt/libriant/{postgres,redis,storage,caddy,backups}
```

The compose volume overlay bind-mounts the first four by absolute path. Docker's
local driver does **not** create a missing path; it fails with a message naming
a volume rather than the directory.

```bash
sudo chown -R 1000:1000 /mnt/libriant/storage
```

The api and worker run as uid 1000 and write uploads there. A bind-mounted
directory keeps the host's ownership — Docker will not chown it for you. Skip
this and the stack comes up perfectly healthy and then throws `EACCES` the first
time a librarian uploads a cover, because `/readyz` checks Postgres and Redis
and never touches storage.

### 3. The Cloudflare origin certificate

```
/mnt/libriant/caddy/origin/origin.crt
/mnt/libriant/caddy/origin/origin.key
```

Every HTTPS vhost imports `tls /etc/caddy/origin/origin.{crt,key}`. Caddy loads
file certificates while provisioning a config, and `caddy validate` provisions —
so a missing cert fails the deploy at the **validation** step and reports that
the Caddyfile is invalid when the Caddyfile is fine.

These PEMs live in the password manager. **No backup contains them** — see
[deployment-hetzner.md](deployment-hetzner.md) Part 7.

### 4. `.env.prod` — run it interactively, once

```bash
bash scripts/ensure-env.sh /srv/libriant/.env.prod
```

**Without `--auto`, exactly once.** The deploy script runs it with `--auto` on
every run, which generates missing secrets but never prompts. The two values
only a human can supply are `IMAGE_OWNER` and the first admin login
(`ADMIN_BOOTSTRAP_EMAIL` / `ADMIN_BOOTSTRAP_PASSWORD`). Leave them blank and you
get a green deploy you cannot log into — `prod-bootstrap.sh` prints
`ADMIN_BOOTSTRAP_* not set - skipping admin creation` and carries on. The deploy
script warns if the email is empty.

Two values to set deliberately while you are in there:

- `EMAIL_DRIVER=console` for now. It is what `ensure-env.sh` writes, and it is
  the right value until there is a Resend key — but be aware it writes
  password-reset links into `docker logs api`. Move to `resend` before real
  librarians have accounts.
- `PUBLIC_HOST`, `SITE_HOST`, `PUBLIC_APEX_DOMAIN` — see
  [cutover-three-hosts.md](cutover-three-hosts.md) Step 4. Getting
  `PUBLIC_APEX_DOMAIN` and `PUBLIC_HOST` confused is the single most likely way
  to break the three-host layout.

---

## Deploying

```bash
ssh deploy@195.201.13.95
cd /srv/libriant/app
bash scripts/deploy-on-host.sh
```

That is the whole thing. It runs the same sequence as the CI workflow, in the
same order, with one deliberate difference: it **builds** the images here
instead of pulling them from GHCR, because nothing publishes to GHCR while
deploys are manual.

|                   |                                        |
| ----------------- | -------------------------------------- |
| `--ref <git-ref>` | what to deploy (default `origin/main`) |
| `--no-fetch`      | deploy the working tree as-is          |
| `--skip-build`    | reuse the images already on the box    |
| `--dry-run`       | print what would happen and stop       |

Start with `--dry-run`. It runs every precondition check and prints the commit
and image tag without touching the running stack.

### What it does

1. `git fetch` + `git reset --hard` to the ref. **Host-local edits to tracked
   files are discarded** — that is deliberate, and identical to CI. Anything
   that must persist belongs in `.env.prod`, which is untracked.
2. Computes `IMAGE_TAG` as the 12-character short SHA, with `-dirty` appended
   when the tree does not match. That suffix is load-bearing: it says out loud
   that the image corresponds to no commit anyone can check out, so never roll
   back "to" one.
3. `ensure-env.sh --auto`, then sources `.env.prod`. The tag is exported
   **after** sourcing, because the env file ships `IMAGE_TAG=latest` and would
   otherwise silently overwrite it.
4. Prunes images and build cache older than 72h. Every deploy makes new
   SHA-tagged images; unpruned they fill the disk, which has broken a deploy at
   the seed step with `ENOSPC`.
5. `docker compose build`.
6. **Validates the Caddyfile before anything is recreated.** Two vhosts claiming
   one hostname is an adapter error, and without this the sequence is: `up -d`
   succeeds, `caddy reload` fails, the fallback recreate crash-loops, and every
   host goes dark.
7. `up -d --force-recreate`, then a graceful `caddy reload`.
8. Waits up to 180s for the edge, the marketing site, and the api/web/worker
   container health checks.

### The health gate is local on purpose

It checks `http://localhost/healthz` and the marketing site
via `--resolve libriant.com:443:127.0.0.1`, plus each container's own
`/readyz`-backed health check. It deliberately checks **nothing through public
DNS** — this box is not in DNS, so anything public would fail on a stack that
is serving perfectly.

> The `--resolve` form matters. `curl -H 'Host: libriant.com' https://localhost/`
> looks equivalent and is not: curl takes SNI from the URL, so that offers SNI
> `localhost`, which the origin certificate does not cover, and the server
> aborts the handshake. `-k` disables client-side verification; it does not fix
> SNI. The CI workflow still has the `-H` form and would misreport for the same
> reason if it is ever re-enabled.

### If the build is killed with exit 137

That is the OOM killer, and `next build` is what triggers it — it peaks around
1.8 GB with no heap cap, and its worker count scales with core count rather than
memory. Check `free -g` and `swapon --show`. Either add swap, or build one
service at a time:

```bash
docker compose $FILES build web
docker compose $FILES build api
docker compose $FILES build caddy
```

Budget 10–20 minutes and ~15–20 GB of `/var/lib/docker` for a cold first build.

### Do not `docker compose pull`

Several older docs suggest it. Today it would appear to work — the build job of
the failed 2026-08-22 run did publish images to GHCR before the deploy step
died — and would quietly pin the box to whatever commit that build carried,
which is not what you are deploying. Build locally.

---

## Going public, later

Deploying does not expose anything. When you want it live, follow
[cutover-three-hosts.md](cutover-three-hosts.md): add the DNS records pointing
at `195.201.13.95`, prove TLS, and only then repoint the apex.

Read that page first regardless — the cutover ends every session (the
`__Host-` cookie prefix makes it unavoidable, and the fix you would reach for is
worse than the problem) and breaks every installed PWA.

---

## Turning GitHub deploys back on

Restore the `push:` block in `.github/workflows/deploy.yml` — the exact stanza
is written out in the comment above `on:`. Two things must be true first:

1. **`DEPLOY_KNOWN_HOSTS` is still pinned to the dead box's SSH host keys.**
   `StrictHostKeyChecking=yes` will refuse the new server. Re-key it:
   `ssh-keyscan 195.201.13.95`, compare the fingerprint out-of-band against the
   Hetzner console, then update the secret. Do not skip the comparison — that
   pin is the only thing standing between the deploy key and a MITM.
2. The deploy user's authorized key must accept the CI key.

`fleet.yml`'s `health_host`, `project` and `cell_id` are informational — the
workflow reads only `name`, `user` and `ssh`.
