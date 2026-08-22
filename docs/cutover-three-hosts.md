# Cutover — moving the app to `app.libriant.com`

_Libriant is a **[CyberSystema](https://cybersystema.com)** product._

Everything now runs on the Hetzner server. This is the one-time sequence that
moves the app off the apex so the marketing site can have it.

```
libriant.com        the marketing site  ← new occupant of the apex
app.libriant.com    the app             ← PUBLIC_HOST
admin.libriant.com  the admin panel     ← unchanged
```

**Read the whole page before starting.** Two steps below are irreversible from
the visitor's side, and one of them logs everybody out.

---

## Before you touch anything

### Every session will end. This is correct and cannot be avoided.

The session cookies are written as `__Host-libriant_session`,
`__Host-libriant_admin` and `__Host-libriant_imp`
([cookie.service.ts](../apps/api/src/auth/cookie.service.ts)). The `__Host-`
prefix is a browser rule: such a cookie is host-only and is never sent to a
different hostname. Moving the app to `app.libriant.com` therefore ends every
session at the moment of the cutover.

**Do not "fix" this by adding `domain: '.libriant.com'`.** It would require
dropping the `__Host-` prefix, and it would broadcast the session bearer token
to the marketing site and to every future tenant subdomain. The forced re-login
is the cheaper problem by a wide margin. Cut over outside desk hours and tell
people it is coming.

### Installed PWAs will open the marketing site

Every install was made against `libriant.com` with `scope: '/'`
([manifest.ts](../apps/web/app/manifest.ts)). After the cutover that scope
serves the marketing site. There is no manifest-level migration: the icon has
to be removed and re-added from `app.libriant.com`.

### Desktop installs need the update first

`apps/desktop` cancels any navigation to an origin other than the one it is
configured for, so a redirect does **not** rescue an old install — it gives it a
dead window. And builds are unsigned, so auto-update is off.

**Release the desktop build that points at `app.libriant.com` before you cut
over.** For installs already out there, the manual escape is Connection → set
the server URL, or `LIBRIANT_APP_URL` on managed machines.

---

## Step 1 — Find out whether the apex is actually live

The repo contradicts itself here and cannot settle it: the deployment runbook
records `A @ → 178.104.32.176`, while the campaign checklist says the apex
points at a server that was deleted and times out.

```bash
dig +short libriant.com
curl -sS -o /dev/null -w '%{http_code}\n' --max-time 5 https://libriant.com/
```

This decides whether you are scheduling an outage window or not. If the apex is
already dark, the cutover costs nothing and can happen at any time.

## Step 2 — Add the `app` record, and prove TLS before anything depends on it

Cloudflare → DNS → `A app` → the host IP → **proxied**.

No new certificate is needed. The origin certificate covers
`libriant.com, *.libriant.com`, which includes `app.`, `admin.` and `www.`.

> **`*.libriant.com` does not cover `*.app.libriant.com`.** That is a further
> reason to keep tenant subdomains at `<slug>.libriant.com` rather than nesting
> them under the app host.

Verify before proceeding. HSTS with `includeSubDomains; preload` is already
asserted from the apex, so `app.libriant.com` must present a valid certificate
on its very first request — a browser that meets a bad one will refuse, and will
keep refusing.

```bash
curl -sSI https://app.libriant.com/healthz | head -1     # after step 4
```

## Step 3 — Decide `www`

Either a proxied `A www` (Caddy has a `www.` block that redirects to the apex),
or a Cloudflare redirect rule. Pick one; do not leave it unresolved.

## Step 4 — Edit `/srv/libriant/.env.prod` by hand

**Changing the repo defaults does nothing to a provisioned host.**
`ensure-env.sh` never overwrites a value that already exists — that is what
makes it safe to re-run, and it is why this step is manual.

```sh
PUBLIC_HOST=app.libriant.com
SITE_HOST=libriant.com
PUBLIC_APEX_DOMAIN=libriant.com
HASH_PEPPER=<openssl rand -hex 32>
```

`PUBLIC_APEX_DOMAIN` is no longer the same thing as `PUBLIC_HOST`. It is the
registrable domain that tenant subdomain resolution and the CSRF origin check
key off. Getting these two confused is the single most likely way to break this
cutover.

> **Check `EMAIL_DRIVER=console` is literally present in the file.** Compose
> passes it through unset by default, and an unset value defaults to `smtp` in
> production — whose driver fails at boot without `SMTP_URL`. The api and worker
> would crash-loop, and the cause would not be obvious. Set `EMAIL_FROM`
> explicitly too, rather than relying on the apex-derived default.

## Step 5 — Deploy

Push to `main`. The deploy now:

1. builds three images — api, web, and the edge (Caddy with the marketing site
   baked in),
2. **validates the Caddyfile before recreating anything**, so a vhost collision
   aborts the deploy instead of taking all three hosts dark,
3. recreates the stack,
4. waits for the origin, the marketing site and all three app containers.

## Step 6 — Update the Stripe webhook endpoint

Stripe Dashboard → Developers → Webhooks → change the endpoint to
`https://app.libriant.com/webhooks/stripe`. The signing secret does not change.

Impact is deferred today (`BILLING_ENABLED=false`, `STRIPE_DRIVER=fake`), but
Stripe retries for about three days and then drops the event, so this must be
done before billing is switched on. Send a test event and confirm a 200 in
`dc logs api`.

## Step 7 — Repoint uptime monitors

Both of these answer 200 after the cutover, so choose deliberately rather than
by accident:

- `libriant.com/healthz` — the marketing site is up. Says nothing about the app.
- `app.libriant.com/healthz` — the app is up.

Watch both if you can. They now fail independently, which is the point.

---

## Verify

**The marketing site**

```bash
curl -sS -o /dev/null -w '%{http_code}\n' https://libriant.com/          # 200
curl -sS -o /dev/null -w '%{http_code}\n' https://libriant.com/en/       # 200
curl -sS -o /dev/null -w '%{http_code}\n' https://libriant.com/pricing   # 200
curl -sS -o /dev/null -w '%{http_code}\n' https://libriant.com/nope      # 404, branded
curl -sSI https://libriant.com/ | grep -i content-security-policy        # script-src 'none'
```

**The app**

```bash
curl -sS -o /dev/null -w '%{http_code}\n' https://app.libriant.com/healthz
curl -sS -o /dev/null -w '%{http_code}\n' https://admin.libriant.com/admin/login
```

Then sign in through a browser, walk a tenant, and confirm the admin panel
loads. Expect to be logged out first — see the top of this page.

**The form, which is the commercially important one**

Submit a real application at `https://libriant.com/#apply`, then:

```bash
dc exec -T postgres psql -U libriant -d libriant_control \
  -c 'select id, "libraryName", "createdAt" from applications order by "createdAt" desc limit 1;'
```

A row must be there. Also submit a deliberately incomplete form and confirm you
get the page back with your answers still in the fields — that is the no-JS path
working, and it is easy to break without noticing.

**Old links still work**

```bash
curl -sSI https://libriant.com/login | grep -i location   # → app.libriant.com/login
```

Password-reset and verification emails already in inboxes were built against the
apex, and their tokens are still live.

---

## If it goes wrong

**Marketing site 404s or is blank, app fine.** `SITE_HOST` is unset in
`.env.prod`, so the vhost never matched — or the edge image is stale. Check:

```bash
docker compose $FILES exec caddy ls /srv/libriant/site/index.html
```

**App is down, marketing site fine.** Working as designed. The site is served
from files inside Caddy and does not depend on api or web. Check `dc ps`.

**Everything is down.** The Caddyfile preflight should have prevented this. If
Caddy is crash-looping anyway:

```bash
docker compose $FILES logs --tail=50 caddy
docker compose $FILES run --rm --no-deps --entrypoint caddy caddy \
  validate --config /etc/caddy/Caddyfile --adapter caddyfile
```

**Roll back.** Trigger the deploy workflow manually with an `image_tag` from
before the cutover. The host checks out that commit first, so it gets the old
compose file referencing `caddy:2-alpine`, and the marketing copy rolls back
with the code. Then revert the `.env.prod` host values by hand — the rollback
does not touch that file.

---

## What changed operationally

**Changing marketing copy is now a commit.** There is no Node on the host and no
rebuild command on the box; the site is rendered in CI and shipped inside the
edge image. Do not invent an on-host build step.

**`offer.spotsRemaining` is a commit too.** It used to be a twenty-second
`wrangler deploy`. It is now a full CI run. Plan for that — a stale scarcity
counter is a claim the site makes to every visitor.

**Applications are backed up now.** They live in `libriant_control`, so the
nightly `pg_dumpall` already covers them with no extra wiring. On Cloudflare D1
they were backed up by nothing at all.

**The site is not backed up, and does not need to be.** It is regenerated from
the image on every deploy.
