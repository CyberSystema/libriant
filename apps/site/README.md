# @libriant/site — the public libriant.com site

_A **[CyberSystema](https://cybersystema.com)** product._

A standalone Greek marketing site that runs entirely on Cloudflare's free tier and
needs **no server**. It introduces Libriant and collects applications for the
launch offer — a free first year for the first five libraries.

It exists because the product's own Next.js landing page needs the full stack
(API, Postgres, Redis) to run, and that stack is not deployed yet. Rather than
duplicate the message, this site **reads the app's own Greek copy** from
`locales/el/landing.json` at build time — so the two cannot drift apart, and when
the real server comes up the app's landing page takes over the apex saying exactly
the same thing.

```
apps/site/
  site.config.json     ⚠️ FILL THIS IN — identity, offer, spots remaining
  build.ts             generator: landing.json + brand + markdown → dist/
  src/shell.ts         stylesheet + masthead + footer (shared with the Worker)
  src/pages.ts         page bodies + the application form
  src/worker.ts        POST /apply, GET /applications.csv, asset serving
  src/schema.sql       D1 tables
  content/*.md         privacy notice + programme terms (Greek)
  public/              favicon
  dist/                generated — gitignored
```

## How it hangs together

Every request goes through the Worker (`run_worker_first: true`), which serves
static pages from the Assets binding and stamps security headers on the way out.
Only two routes have real logic:

| Route                           | Behaviour                                                                                                                               |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /apply`                   | validate → honeypot → Turnstile (if configured) → rate-limit → **insert into D1** → notify by email (best-effort) → 303 to `/thank-you` |
| `GET /applications.csv?token=…` | everything received, as CSV with a UTF-8 BOM so Excel opens the Greek correctly                                                         |

**The D1 insert is the commit point.** The notification email is best-effort on
top of it. If Email Sending is not enabled yet, or a send fails, the row is
already safe and the applicant still gets their confirmation page — no
application is ever lost to a mail problem. Rows with `notified = 0` are the ones
that never produced an email.

Visitors without JavaScript get a fully working form: a failed submission
re-renders the real page with inline Greek errors and their own answers intact,
because `src/pages.ts` is shared between the generator and the Worker.

## Local development

```bash
pnpm --filter @libriant/site exec wrangler d1 execute libriant-applications --local --file ./src/schema.sql
pnpm --filter @libriant/site dev
```

Then open <http://localhost:8787>. Local D1 is a real SQLite file under
`.wrangler/state` — no Cloudflare account needed for any of this.

For the local `EXPORT_TOKEN`, create `apps/site/.dev.vars` (gitignored):

```
EXPORT_TOKEN=some-local-token
```

Inspect what the form stored:

```bash
pnpm --filter @libriant/site exec wrangler d1 execute libriant-applications --local --command "SELECT * FROM applications"
```

## The placeholder gate

`pnpm build` **refuses to emit** while `site.config.json` contains any
`[SQUARE BRACKET]` placeholder, and prints exactly which ones. This is deliberate:
those values are printed in the page footer and the privacy notice, where GDPR
Art. 13 requires the data controller to be identifiable. A page reading
"Υπεύθυνος επεξεργασίας: [ΤΟ ΠΛΗΡΕΣ ΟΝΟΜΑ ΣΑΣ]" would destroy exactly the
credibility this site exists to build.

`pnpm build:draft` builds anyway and stamps a loud red banner on every page, so a
draft can never be mistaken for something publishable. **`pnpm dev` uses the draft
build**, so the gate never blocks local work (or the repo-wide `pnpm dev`, which
runs every app's dev server together). Only `pnpm deploy` runs the strict build —
publishing is the thing worth gating.

## Keeping "the first 10" true

`offer.spotsRemaining` in `site.config.json` drives the counter on the page. When
you accept a library, decrement it and redeploy. At `0` the form is automatically
replaced by a waiting-list message. A scarcity claim has to actually be true.

---

## Deploying

### 1. Fill in `site.config.json`

At minimum `identity.controllerName` and `identity.city`. Then confirm the build
passes the gate:

```bash
pnpm --filter @libriant/site build
```

### 2. Log in to Cloudflare

```bash
pnpm --filter @libriant/site exec wrangler login
```

### 3. Create the database, in the EU

```bash
pnpm --filter @libriant/site exec wrangler d1 create libriant-applications --location weur
```

Paste the printed `database_id` into `wrangler.jsonc`, then create the tables:

```bash
pnpm --filter @libriant/site exec wrangler d1 execute libriant-applications --remote --file ./src/schema.sql
```

### 4. Set the export token

```bash
pnpm --filter @libriant/site exec wrangler secret put EXPORT_TOKEN
```

Use a long random value (`openssl rand -hex 24`) and keep it in your password
manager. Without it, `/applications.csv` returns 404 to everyone — including you.

### 5. Deploy and check the workers.dev URL

```bash
pnpm --filter @libriant/site deploy
```

Open the printed `…workers.dev` URL and submit a real test application. Confirm
the row lands in D1 before pointing the real domain at it.

### 6. Take over libriant.com

The apex and `admin.libriant.com` currently have **proxied A records pointing at
the deleted Hetzner server**, so both time out — which is worse than a blank page
for anyone checking you out. In the Cloudflare dashboard → `libriant.com` → DNS:

1. **Delete** the stale `A` records for `libriant.com` and `admin.libriant.com`.
   (`admin` comes back when the real server does — see `docs/deployment-hetzner.md`.)
2. Uncomment the `routes` block in `wrangler.jsonc` and redeploy. Cloudflare
   creates the records for `libriant.com` and `www.libriant.com` itself.

### 7. Add DMARC (do this regardless — it helps the email campaign)

`libriant.com` already has iCloud Custom Email Domain configured correctly: MX to
iCloud, a valid SPF record, and a published DKIM key. The one thing missing is
DMARC. Add a TXT record:

| Name     | Value                                                   |
| -------- | ------------------------------------------------------- |
| `_dmarc` | `v=DMARC1; p=none; rua=mailto:dmarc@libriant.com; fo=1` |

`p=none` is monitor-only — it changes nothing about delivery, it just lets you
see who is sending as your domain, and its presence improves how receiving
servers score your mail.

---

## Optional extras

### Turnstile (bot protection on the form)

Without it the form still has a honeypot and a per-IP rate limit, which stops
naive scrapers. Turnstile stops the rest.

1. Cloudflare dashboard → Turnstile → add a widget for `libriant.com`.
2. Put the **site key** into `site.config.json` → `site.turnstileSiteKey`.
3. `wrangler secret put TURNSTILE_SECRET` with the secret key.
4. Rebuild and redeploy.

The Worker only enforces Turnstile when `TURNSTILE_SECRET` is set, so the two
halves can be enabled independently without breaking the form.

### Notification email

Cloudflare **Email Sending** is a different product from Email Routing: it only
adds SPF/DKIM records for _outbound_ mail and does **not** touch your MX records,
so your iCloud mailbox on `libriant.com` keeps working untouched.

```bash
pnpm --filter @libriant/site exec wrangler email sending enable libriant.com
pnpm --filter @libriant/site exec wrangler email sending dns get libriant.com
```

> **⚠️ Merge the SPF record — do not add a second one.** A domain may have exactly
> one `v=spf1` TXT record; two is a permanent error that would break your iCloud
> sending too. Your existing record is `v=spf1 include:icloud.com ~all` — the
> merged result should keep both includes in a single record, e.g.
> `v=spf1 include:icloud.com include:<what wrangler prints> ~all`.

Then uncomment the `send_email` block in `wrangler.jsonc` and redeploy.

Until you do this, applications still commit to D1 and you read them at
`/applications.csv?token=…` — only the push notification is missing.

---

## When the real server comes up

`docs/deployment-hetzner.md` Part 7 already puts the app behind Cloudflare's proxy
with a **Cloudflare Origin Certificate** rather than Let's Encrypt, so the cutover
is a DNS target swap with no ACME challenge to fight over:

1. Point `libriant.com` at the Hetzner box per that runbook.
2. The app's own Next.js landing page — same copy, same brand — takes over the apex.
3. Export the applications and import them as tenants:
   ```bash
   pnpm --filter @libriant/site exec wrangler d1 execute libriant-applications --remote \
     --command "SELECT * FROM applications ORDER BY created_at"
   ```
4. For each accepted library: `pnpm tenant:create`, then in the admin UI assign the
   **Municipal** plan with `billingMode = manual` and set **paid-until** to
   +12 months. The free year then expires on its own —
   `apps/api/src/plans/effective-plan.service.ts` already gates manual
   subscriptions on `paidUntil > NOW()`. No code change is needed to honour the
   offer.

This Worker can then be retired, or kept on a subdomain as a status page.

## A note on the legal pages

`content/privacy.el.md` and `content/programme-terms.el.md` are **purpose-written
for this site only** — they cover the application form, nothing else. They are
deliberately _not_ the product's legal suite in `locales/el/legal/`, which still
has ~67 unfilled placeholders and is flagged in `locales/legal-README.md` as
drafts pending counsel review.

They are written carefully and narrowly, but they are not legal advice. Have them
reviewed together with the rest of the legal layer before the pilot scales.
