# Libriant pre-release audit — final report

Commit `7c2e2b0`. Twelve dimensions, 209 raw findings, 196 surviving adversarial
verification, 14 rated blocker. Written for one person choosing a launch date.

---

## 1. Verdict

**Not yet — and the reason is not the code.** As it stands the stack does not
finish its first deploy: the `migrate` one-shot exits 1 before touching the
database and every other container is gated on it (`supply-chain-06`). Behind
that are eleven more distinct blockers, and one of them — no registered legal
entity in any of the fourteen legal documents — is not something you can code
your way past.

The 14 blocker-rated findings are **12 distinct defects**. Ten are code or
configuration fixes; realistically **8–12 working days** of focused work,
several of them one-liners. The other two (legal identity, VAT) are gated on
registering the company and getting an ΑΦΜ, and no amount of engineering
shortens them.

**Shortest path to yes:**

1. **Today, before any code:** start the company registration. It gates
   `privacy-legal-01` (no Art. 28 processor identity, no Art. 13 controller
   identity, no P.D. 131/2003 provider identification) and `billing-04` (no VAT
   anywhere in the billing path), it takes weeks of elapsed time you cannot
   compress, and it is the only item on this list that is pure waiting. Book
   the Greek data-protection counsel review at the same time.
2. **In parallel, two weeks of engineering** on the ten code blockers, in the
   order in §4.
3. **Do not shorten this with a "quiet pilot".** Every target customer is a
   public body. From the first member record, you are a processor of patron
   data — including children's — and there is no lawful processor arrangement
   until a named entity signs one. A closed pilot with a paper contract solves
   the clickwrap problem but not the *no counterparty exists* problem.

Engineering can be ready roughly two weeks from now. The launch date is
whatever date the entity registration and counsel review land on, and that is
the date to work backwards from.

---

## 2. Blockers

Two pairs of blocker-rated findings are the same defect seen through two
lenses, so **the 14 blocker ratings are 12 distinct defects**:

- `data-integrity-01` + `input-and-files-01` — the same `MAX_SAFE_INTEGER`
  upload overflow.
- `authn-authz-01` + `input-and-files-02` — the same spoofable client-IP source.

A third defect is found twice but rated at blocker weight only once:
`boot-and-config-01` (blocker) and `reliability-02` (high) are the same Redis
fragility. The two verifiers downgraded independently and for their own reasons
— the reliability verifier cut it to high because the outage is bounded and
self-correcting (it measured full recovery within ~2 s of Redis returning, no
data loss, no wedged process), not because the boot-and-config entry already
carried it. Either way it is one fix, and the higher rating governs.

Ordered by how bad the first hour of production is. Items 8, 10 and 12 are hard
gates regardless of where they sit in that ordering — they do not cause an
outage, they cause an unlawful or unpayable service.

### 1. The stack does not come up at all — `supply-chain-06`

**What breaks.** All three Dockerfiles run `corepack prepare pnpm@9.15.4
--activate`, but corepack always honours the nearest `package.json`
`packageManager` field, which commit `fe0931e` bumped to `pnpm@11.22.0`. The
pin is inert. In the shipped API image only pnpm 9.15.4 was ever written into
`/opt/corepack` (`apps/api/Dockerfile:79` builds `FROM base`, not `deps`), the
directory is root-owned and read-only, and `USER node` (`:97`) runs
`prod-bootstrap.sh:35` → `pnpm db:migrate:deploy` from `/app`. Corepack tries to
cache pnpm 11.22.0, cannot write, and exits 1. `docker-compose.prod.yml:209-211`
gates api, worker and web on `migrate: condition: service_completed_successfully`.

Separately, `apps/web/Dockerfile` sets no `COREPACK_HOME` and its `CMD` is
`pnpm …` as PID 1 — so the web container downloads pnpm from npmjs.org **on
every start** and executes it on the boot path.

**Who notices.** You do, at deploy time, with a corepack cache-permission error
that reads nothing like its cause. No CI job builds or runs these images —
`grep -n 'docker build' .github/workflows/verify.yml` returns nothing — so this
is invisible to every existing check.

**Fix.** Three one-line changes: `corepack prepare pnpm@11.22.0 --activate` in
`apps/api/Dockerfile:30`, `apps/web/Dockerfile:9`, `infra/caddy/Dockerfile:16`;
add `ENV COREPACK_HOME=/opt/corepack` + `chmod -R a+rX` to the web image; add
the `+sha224.<hash>` integrity suffix to `package.json:6`. Then add a CI job
that builds the api image and runs `docker run --rm --user node <img> pnpm
--version`. **Hours.**

### 2. Email is dead and the runbook says otherwise — `launch-readiness-01`

**What breaks.** `ConsoleEmailDriver` computes `isDev = (process.env.NODE_ENV ??
'development') === 'development'` (`console-driver.ts:21`). Production sets
`NODE_ENV=production` in both `apps/api/Dockerfile:83` and
`docker-compose.prod.yml:35,240`, so the driver logs `NOT delivering "<subject>"
to <addr> (body withheld)` and marks the outbox row delivered. Nothing is sent
and the token appears nowhere an operator would look.

Three flows have no completion path: password reset, email verification, and —
because `EmailVerifiedGuard` sits on `POST /t/:slug/staff`
(`staff.controller.ts:51`) — adding a second librarian. Verified live: `SIGNUP
201` / `OWNER emailVerifiedAt=null` / `INVITE-STAFF 403
{"code":"email_verification_required"}`. The owner is therefore the only user
that can ever exist, and the owner has no self-service recovery (the working
temp-password path, `staff.service.ts:114-132`, only applies to staff members
who cannot be created). `docs/deploy-from-the-server.md:113` tells the operator
the reset link is in `docker logs api`. It is not.

**Who notices.** The first librarian who signs up, within the first hour.
Signup → invite a colleague is the core onboarding path of a library product and
it terminates in a 403.

**Fix.** Provision Resend, set `EMAIL_DRIVER=resend` + `EMAIL_FROM`, and publish
the DNS from `launch-readiness-04` (SPF currently authorises iCloud only; there
is no DMARC record). If you launch on console anyway: an owner-only endpoint
that force-verifies a tenant user and returns a one-time reset link in the HTTP
response, an admin "Emails" page rendering `email_outbox.bodyMarkdown`, and a
correction to `docs/deploy-from-the-server.md:113`. **Days** (mostly DNS
propagation and the Resend account).

### 3. Every file upload 500s in the launch configuration — `data-integrity-01` + `input-and-files-01`

**What breaks.** With subscriptions off, `unlimitedPlan()` substitutes
`Number.MAX_SAFE_INTEGER` for every int feature
(`effective-plan.service.ts:38,110-111`). `StorageService.put` then computes
`BigInt(limitMb) * 1024n * 1024n` = 9444732965739289378816 and binds it as int8
in the atomic reservation at `storage.service.ts:76`. Postgres rejects with
SQLSTATE 22003, outside the try/catch. All four upload entry points funnel
through it: `catalog/covers.controller.ts:61`, `members/photos.controller.ts:59`,
`branding/branding.controller.ts:62`, `storage-demo.controller.ts:92`.

Proved both directions: with billing off, `POST /t/ver-up/storage/covers` → 500;
insert `platform_settings('billing.enabled','true')`, drop the Redis keys, and
the identical upload → 201.

**Who notices.** Every librarian, the first time they add a book cover, a member
photo, or their own logo. It reads as "the product is broken", and turning
billing *on* is what fixes it — the opposite of what anyone would guess.

**Fix.** `const limitBytes = limitMb >= Number.MAX_SAFE_INTEGER ?
9223372036854775807n : BigInt(limitMb) * 1024n * 1024n;`, or skip the
conditional UPDATE entirely when the plan is unlimited. Then fix the reason it
was invisible: `apps/api/test/integration/setup.ts:8` forces `BILLING_ENABLED
||= 'true'`, so the whole suite runs in the opposite configuration from
production. **Hours.**

### 4. A Redis restart is a full-platform outage with no recovery lever — `boot-and-config-01` (+ `reliability-02`)

**What breaks.** `SystemModeMiddleware` is mounted on `'*'`, and its
`ALWAYS_PASS` branch — the one whose comment promises "an operator never locks
themselves out of the lever they need to pull to recover" — still runs `req.systemMode
= await this.modes.resolveGlobal()` before `next()`
(`system-mode.middleware.ts:100`). That reaches a bare `await
this.redis.client.get(key)` (`system-mode.service.ts:232`) on a client built
with `enableOfflineQueue: false` (`redis.service.ts:25`), which rejects
synchronously. Booted with an unreachable `REDIS_URL`: `/healthz` → 500,
`/readyz` → 500, `/admin/system-mode` → 500. Control test with Redis up and
Postgres down: `/healthz` 200, `/readyz` 503 — so Redis is uniquely the total
failure dependency.

`TenantResolverService.readCache` (`tenant-resolver.service.ts:94-96`) has the
identical unguarded call, so a fix confined to system-mode still leaves every
`/t/<slug>/*` request 500ing.

**Who notices.** Every library at once, on an event as routine as a container
restart or an OOM. The operator has no in-band way to declare maintenance or
recover, and no health surface that can distinguish "degraded" from "dead".

**Fix.** Wrap `resolveGlobal()` in `.catch(() => NORMAL_MODE)` inside the
`ALWAYS_PASS` branch — better, do not resolve the mode there at all — and make
`readCache`/`writeCache` fail open in both `SystemModeService` and
`TenantResolverService`, falling through to the control-plane query. Redis
already self-heals once it returns; only the unguarded reads make it fatal.
**Hours.**

### 5. Every rate limit and the brute-force lockout are keyed on a header the attacker sets — `authn-authz-01` + `input-and-files-02`

**What breaks.** `clientIp()` returns `req.headers['x-real-ip']` with no trust
boundary (`client-ip.ts:16-21`), falling back to `req.ip`, which under
`app.set('trust proxy', true)` (`main.ts:36`) is the leftmost `X-Forwarded-For`
entry — also client-supplied. Both spoof vectors were reproduced. Everything
throttling unauthenticated abuse keys on that value: signup, login,
password-reset and email-verify per-IP budgets, the `/apply` cap, the admin
login cap, and the lockout itself (`login:fail:<uid>:<ip>` /
`login:lock:<uid>:<ip>`, `login.service.ts:15-16`).

Live: 25 logins with a fixed `X-Real-IP` → 20×401 then 5×429; the same 25 with a
rotating header → 25×401, zero 429, lockout never fires. The code justifies
trusting the header with a comment claiming the host firewall admits only
Cloudflare ranges. `infra/caddy/Caddyfile` has no `remote_ip` matcher anywhere
in 359 lines and unconditionally does `header_up X-Real-IP
{http.request.header.CF-Connecting-IP}` (`:177`) — it stamps the forgery in for
you. The runbook the operator actually follows,
`docs/deployment-hetzner.md:192-199`, is `ufw allow 80/tcp` + `443/tcp`, open to
the internet; and the same document warns at `:202` that Docker-published ports
bypass ufw, which `docker-compose.prod.yml:135-138` does. The origin IP is in
the repo.

**Who notices.** Nobody, until it matters. There is no working defence against
password guessing against any known account, against admin.libriant.com, or
against `/auth/signup` — and every signup provisions a Postgres database
(`input-and-files-03`), so a flood is a disk-exhaustion vector. Every IP in
`supportSession.ipAddress`, the audit log and the GDPR consent record is
attacker-authored.

**Fix.** Honour `X-Real-IP` only when `req.socket.remoteAddress` is a trusted
proxy (`TRUSTED_PROXY_CIDRS`); replace `trust proxy: true` with an explicit
list. In Caddy, add a `@cf remote_ip <cloudflare ranges>` matcher and set
`X-Real-IP {remote_host}` for anything that does not match. Put the
Cloudflare-range rules in `scripts/prod-bootstrap.sh`, not in a markdown
paragraph, and fix `docs/deployment-hetzner.md:196-197`, which currently tells
the operator to do the opposite. Add a bare-account lockout component with a
higher threshold so IP rotation cannot make it unreachable. Then gate deploys on
an automated check that a forged-header request to the origin IP does not reach
the API. **Days.**

### 6. Anyone on the internet can rewrite any tenant's subscription — `billing-02`

**What breaks.** `FakeStripeDriver` hardcodes `private secret =
'fake-webhook-secret-for-dev'` (`stripe-fake.driver.ts:32`) and nothing outside
tests calls `setSecret()`. `billing.module.ts:22-28` selects the driver on
`STRIPE_DRIVER` alone, and `.env.prod.example:69`, `scripts/ensure-env.sh:100`
and `docker-compose.prod.yml:65` all default it to `fake`. `POST
/webhooks/stripe` is unauthenticated by design, bypasses maintenance mode
(`ALWAYS_PASS`), and allows a missing Origin. Executed end to end: an
unauthenticated POST signed with that literal moved a tenant from
`starter/active/null` to `institutional/active/sub_vfy_forged`, HTTP 200. Wrong
secret → 400.

**Who notices.** Not you — forged rows persist silently and become the truth the
moment billing is enabled. `stripe_webhook_events` also grows without bound.

**Fix.** Make the fake driver throw from its constructor when `nodeEnv !==
'development'`. Extend the `main.ts` boot guard (which already refuses
`RATE_LIMIT_DISABLED` in production) to reject `nodeEnv === 'production' &&
stripeDriver !== 'real'`, and make `PlatformSettingsService.setBillingEnabled`
throw rather than log a warning (`platform-settings.service.ts:60-66`) in that
state — the admin panel can currently flip enforcement on while the fake driver
is serving. **Hours.**

### 7. Member notifications fail for every tenant on every run and report success — `reliability-01`

**What breaks.** `sendMemberNotifications()` constructs a fresh `RedisService`
at `member-notifications.job.ts:138` and the first statement of the per-tenant
loop is a Redis GET (`:188`). With `enableOfflineQueue: false`, a command issued
while the socket is still `connecting` rejects synchronously, so every iteration
throws on its first await and the whole loop drains in microseconds — before the
socket is ready. Against the live control plane with 49 tenants:
`{"tenantsScanned":49,"tenantsFailed":49}` and the message `"49 tenant(s)
scanned; no member reminders due"`. `stripe-retry.job.ts:67` has the same
defect.

**Who notices.** Patrons, weeks later, complaining they were never told a hold
was ready. Due-soon reminders, overdue notices and pickup notifications have
never been sent, for anyone, and `/healthz` says `{"member-notifications":{"ok":true}}`.

**Fix.** Add `RedisService.ready()` awaiting the `ready` event and call it after
line 138 — better, pass the worker's long-lived shared client through
`JobContext` so no job mints its own. Pair with `reliability-07`: the runner
discards `tenantsFailed`, so set `ok: false` when it is non-zero. **Hours.**

### 8. No legal person offers the service — `privacy-legal-01` — HARD GATE

**What breaks.** Terms, Privacy Policy, DPA and Legal Notice all name the
provider as `[COMPANY LEGAL NAME]` at `[REGISTERED ADDRESS]`, GEMI
`[COMPANY REGISTRATION NUMBER / GEMI]`, VAT `[VAT NUMBER]`, DPO `[DPO EMAIL]` —
12 uppercase placeholders in `privacy.md`, 9 in `terms.md`, 9 in
`legal-notice.md`, 4 in `dpa.md`, per locale, across 14 files. Every rendered
page carries a permanent "Draft — pending review by qualified legal counsel"
banner (`legal/[doc]/page.tsx:34-36`), and the markdown's own drafting
blockquote renders too, so the reader sees two. Meanwhile
`apps/site/site.config.json:4` names a *different* controller — the natural
person Νικόλαος Πινάτσης — so libriant.com and app.libriant.com publish
incompatible provider identities.

**Who notices.** The DPO of the first public library that evaluates you. They
open `/legal/dpa`, see a draft banner and an empty party name, and stop the
procurement. Underneath that: GDPR Art. 28(3) requires the processor be
identified, Art. 13(1)(a) the controller, P.D. 131/2003 the legal name, address,
GEMI and VAT. None exist, so from the first member record you process public
library patron data — including children's — with no valid processor
arrangement.

**Fix.** Register the operating entity, fill every placeholder across the 14
files, make `identity.controllerName` the same entity, have Greek/EU
data-protection counsel review, then delete the `legal.draftNotice` string and
both `<Banner>` blocks and bump `LEGAL_VERSION`. Also strip the leading drafting
blockquote in `loadLegalDoc` so an internal note can never render again
(`launch-readiness-07`). **Weeks**, most of it not yours to control.

### 9. One export click kills the entire background tier — `performance-01`

**What breaks.** `readTables()` runs `SELECT * FROM "<name>"` with no LIMIT and
no cursor, pushing whole result sets into a JS array
(`export-processors.ts:384`). The `MAX_EXPORT_ROWS = 2_000_000` guard is
evaluated at `:389`, *after* the table is fully materialised, so it protects
nothing. Measured against an Institutional-sized seed (400k books / 2M loans /
3M audit rows, 1479 MB): `audit_log: 3000000 rows in 4561ms — RSS 1462 MB`. The
worker's limit is `mem_limit: 1g` (`docker-compose.prod.yml:269`) with no
`--max-old-space-size`. One table, one iteration, over the limit.

**Who notices.** Every tenant, because `worker.ts:44-48` runs email, scheduled
jobs, imports, maintenance and export in one process — the OOM takes the outbox
queue and all nine cron sweeps with it. And if the RAM existed, the 2M cap then
aborts the export, so the top-priced tier can never export its own data, which
is both a sold feature and the Art. 20 portability mechanism.

**Who does not notice, yet.** Five small municipal pilot libraries. This is a
scale blocker, not a launch-day one — but it is on a user-triggered button, so
it fires the day one tenant gets large, not on a schedule you choose.

**Fix.** Stream: `pg-cursor` in 10k chunks into
`ExcelJS.stream.xlsx.WorkbookWriter`, or `COPY … TO STDOUT WITH CSV` via
`pg-copy-streams` piped into the archive. Move the row-count check to a
`SELECT reltuples` pre-flight so an oversized export is refused before any
allocation. **Days.**

### 10. Backups are plaintext, never pruned off-site, and the DPA says otherwise — `privacy-legal-02` — HARD GATE

**What breaks.** `scripts/backup.sh` produces `pg_dumpall` `.sql.gz` of the
control DB and every tenant DB plus a tar of the storage volume, with no gpg,
age, openssl or `rclone crypt` step anywhere in the repo. The off-site push is
`rclone copy --quiet "$dest" "$RCLONE_REMOTE/$day"` (`:188`) — `copy`, not
`sync`, into a per-day path, with no `--delete`, no lifecycle rule and no prune
step. Local dailies *are* pruned at `BACKUP_KEEP_DAYS`; off-site dailies
accumulate forever.

**Who notices.** Nobody, until someone obtains the rclone credentials that sit
on the same host, or a storage-box snapshot. What is exposed is plain-text SQL
of every Greek library's complete member registry — name, date of birth, home
address, phone, email, staff notes, and the full named loan/reservation/fine
history including school-library children. `dpa.md:85` (en) promises "regular
**encrypted** backups"; that statement in a binding Art. 28 agreement is untrue.
And because off-site copies are never deleted, an Art. 17 erasure never
propagates, so `privacy.md:77`'s "deleted copies age out of backups" is false in
the deployed design.

**Fix.** Encrypt each artefact before it leaves the box (`age -r` with the key
held off-host, or an `rclone crypt` remote) and document key management in DPA
Annex II. Add remote retention (`rclone delete --min-age ${BACKUP_KEEP_DAYS}d`
or a storage-box lifecycle policy). Prove both in `scripts/dr-drill.sh` — which
today covers only Postgres (`reliability-08`) and whose sibling `restore.sh`
untars uploads into a path that recovers zero files while reporting success
(`reliability-05`). Fix those together. **Days.**

### 11. Every plan change opens a second subscription and abandons the first — `billing-03`

**What breaks.** `startCheckout`'s only guard is `plan.id === sub.planId &&
sub.status === 'active'` (`billing.service.ts:285`). Any other plan goes to
`checkout.sessions.create({ mode:'subscription' })`
(`stripe-real.driver.ts:68-78`), which always creates an *additional*
subscription. The `StripeDriver` interface has no `subscriptions.update` and
`grep -rn proration_behavior apps packages` returns nothing.
`syncStripeSubscription` then overwrites `stripeSubscriptionId`
(`billing.service.ts:617`), erasing the old id, so `cancelAtPeriodEnd` can only
ever reach the newest one.

**Who notices.** The library's finance office, on the second month's statement.
A Community library upgrading to Municipal pays €39 **and** €79, indefinitely;
cancelling in-app stops the new one and leaves the old one billing. Neither the
library nor you can see the orphan — it exists only in Stripe. Chargeback and
refund territory on your first paying customers.

**Fix.** Route plan changes through `stripe.subscriptions.update(id, { items:
[...], proration_behavior: 'create_prorations' })` and let the resulting webhook
sync. Reserve Checkout for the first subscription. Until that lands, return 400
from `startCheckout` whenever `sub.stripeSubscriptionId != null`. **Days** (the
400 is an hour).

### 12. No VAT anywhere in the billing path — `billing-04` — HARD GATE for revenue

**What breaks.** `createCheckoutSession` sets no `automatic_tax`, no
`tax_id_collection`, no `billing_address_collection`
(`stripe-real.driver.ts:65-81`); `customer_update:{name:'auto',address:'auto'}`
is only the companion parameter and collects nothing on its own. The control
plane has `billing_accounts.taxId / taxCountry / addressLine1..country`
(`schema.prisma:574-580`) and no code path writes them — `ensureStripeCustomer`
sets billingEmail and billingName only. A repo-wide grep for `automatic_tax |
tax_id_collection | billing_address_collection` returns zero hits.

**Who notices.** Two separate parties. (a) The municipality's accounting
department, which cannot book a payment without an invoice carrying your ΑΦΜ and
a ΦΠΑ line — the deal stalls *after* the card is entered. (b) AADE: a price
advertised with no VAT statement is treated as VAT-inclusive, so roughly €75 of
a €390 annual sale is owed out of money already booked as revenue, and every
tier is ~19.4% less profitable than the pricing model assumes.

**Fix.** Enable Stripe Tax; set `automatic_tax:{enabled:true}`,
`tax_id_collection:{enabled:true}`, `billing_address_collection:'required'`;
mirror `customer.tax_ids` and the address back into `billing_accounts` on
`customer.updated`. State on the pricing page and the plan cards whether the
figure is πλέον ΦΠΑ or συμπ. ΦΠΑ, and add the step to
`docs/billing-go-live.md`. Gated on having an ΑΦΜ. **Weeks** in elapsed time,
hours of code.

---

## 3. Themes

Four patterns. Fixing the pattern is worth more than fixing the twelve
instances, because each pattern has a tail of mediums behind it and will
generate the next ten.

### A. The launch configuration is the one configuration nobody runs

This is the class the task asked about, and it is the most dangerous one here,
because the test suite is *structurally* incapable of seeing it. Production
means `BILLING_ENABLED=false`, `EMAIL_DRIVER=console`, `NODE_ENV=production`,
`STRIPE_DRIVER=fake`, fresh host. The suite runs the mirror image of all four.

- `apps/api/test/integration/setup.ts:8` forces `BILLING_ENABLED ||= 'true'`.
  The unlimited-plan sentinel that breaks 100% of uploads exists only when it is
  false. **The tests run in the configuration where the bug cannot occur.**
- `ConsoleEmailDriver` branches on `NODE_ENV === 'development'`. Tests are dev;
  production is the other branch, and the other branch withholds the body.
- `FakeStripeDriver`'s hardcoded secret is harmless in tests and is an
  unauthenticated internet write in production.
- No CI job builds or runs the container images at all, which is why the
  corepack defect — the one that stops the deploy dead — was invisible.
- The tail: `frontend-07` (staff locked into a dead-end screen the moment
  `BILLING_ENABLED` flips), `frontend-15` (the email-verification flow is a
  permanent dead end on console), `billing-14` (`stripeReady` is computed and no
  UI reads it, so a fake driver in production is signalled only by a log line),
  `boot-and-config-05` (`ensure-env.sh` writes `EMAIL_DRIVER=console` on every
  deploy, permanently defeating the compose fail-fast added to prevent exactly
  this).

**Fix the pattern:** stand up one CI job that boots the real images from
`.env.prod.example` verbatim — billing off, email console, `NODE_ENV=production`
— and runs a five-step smoke: sign up, verify, upload a cover, invite a staff
member, load the dashboard. Every blocker in this theme dies to that one job.
Then delete the `BILLING_ENABLED ||= 'true'` line and make the integration suite
parameterised over both values.

### B. Controls that exist as prose, not as code

Repeatedly, the thing that makes a defect safe is a sentence rather than a
mechanism, and the sentence is wrong.

- `client-ip.ts:9` says spoofing is impossible because "the host firewall only
  admits Cloudflare's ranges". No such rule exists in
  `scripts/prod-bootstrap.sh` or any compose file; the documented procedure says
  the opposite; and Docker's published ports would bypass it anyway.
- `dpa.md:85` contractually promises encrypted backups. `backup.sh` has no
  encryption step.
- The site and the offer terms promise daily off-server backups. Nothing
  installs the cron and no offsite target is provisioned (`launch-readiness-05`).
- `admin-tenants.controller.ts:29-36` docstrings that support admins must redeem
  a support key before seeing library data. The `@Get(':id')` handler carries no
  role decorator and returns the plaintext superuser URL (`tenant-isolation-01`).
- The offer terms tell the first five libraries the system "passed a full
  security audit" (`launch-readiness-09`). That is not what happened.
- `docs/deploy-from-the-server.md:113` tells the operator where the reset link
  is. It is not there.

**Fix the pattern:** for every claim of a security or availability control, ask
"what executes this?" If the answer is a markdown file or a code comment, it is
not a control. Two immediate consequences: move the Cloudflare-range firewall
into `prod-bootstrap.sh`, and treat every sentence in the DPA, the Privacy
Policy and the offer terms as a test case someone has to make pass before the
document is published.

### C. Failure that reports success, with nobody listening anyway

- `member-notifications` fails 100% of tenants and returns a success-shaped
  result; the runner discards `tenantsFailed` entirely (`reliability-07`), so
  every sweep can be totally broken and green.
- The web container's healthcheck cannot fail while the API is down, and the
  deploy gate trusts it (`boot-and-config-08`).
- `prod-bootstrap.sh` treats tenant-schema migration failure as non-fatal — a
  green deploy can leave live libraries on an old schema (`boot-and-config-04`).
- A Stripe webhook whose durable insert fails still returns 200, so Stripe never
  retries and the event is gone (`billing-08`).
- `/readyz`'s dependency breakdown is re-skinned into a generic envelope by the
  global filter, so it can never say *which* dependency is down
  (`reliability-12`).

And underneath all of it: **no alert reaches a human at all.** Alertmanager is
commented out and the monitoring stack is in no deploy path (`reliability-04`,
`launch-readiness-06`); the API exports no request, error or latency metrics
(`reliability-17`); the backup dead-man's switch is optional and unset
(`reliability-09`); abandoned outbox emails have no surface anywhere
(`reliability-10`). With one operator and no paging, every silent failure above
is silent until a customer emails.

**Fix the pattern:** one Alertmanager receiver the operator reads on a phone,
one external uptime check that does not run on the box being checked, `ok:
false` whenever `tenantsFailed > 0`, and a mandatory backup heartbeat. That is a
day of work and it converts this entire theme from invisible to noisy.

### D. The audit's own precedent: "verified" has a shelf life

`docs/audit/preprod-final-2026-06-21/` certified this codebase — 63 findings,
all addressed. Two months later the DR restore was found to drop every database
and restore none; it had never worked, and its own documented drill would have
caught it on the first attempt. That drill had never been run.

The same shape recurs throughout this audit: `pinWorkerConnLimit()` is a no-op
(`performance-06`), host-header tenant routing is unreachable dead code
(`tenant-isolation-08`), the per-tenant credential model is dead code
(`tenant-isolation-02`), `pnpm rebuild electron` runs nothing because Electron
has no build script, while its comment says it is unblocking one
(`supply-chain-13`), and the DR drill still uses the pre-fix pipeline aimed at
the live cluster (`reliability-06`). Code that has never
executed is not code; it is a comment with syntax highlighting.

**Fix the pattern:** anything load-bearing for recovery gets executed on a
schedule that fails loudly — the DR drill (including storage and the off-site
leg, not just Postgres) in CI or cron, not in the handbook.

---

## 4. Fix order

Effort tags: **h** = under a day, **d** = one to three days, **w** = weeks,
mostly elapsed rather than worked.

### Start today, finish never-mind-when — the long pole

| | | |
|---|---|---|
| Register the operating entity, obtain ΑΦΜ | `privacy-legal-01`, `billing-04` | **w** |
| Engage Greek/EU data-protection counsel; brief them now, not on delivery | `privacy-legal-01` | **w** |
| Provision Resend; publish SPF include, DKIM CNAMEs, `_dmarc` at `p=none` | `launch-readiness-01`, `launch-readiness-04` | **d** + propagation |
| Provision the Hetzner Storage Box and set `RCLONE_REMOTE` | `privacy-legal-02`, `launch-readiness-05` | **h** |

Nothing else is blocked on these, and they are the only items whose clock you do
not control. Kick all four off before writing a line of code.

### Gate 0 — must precede any deploy at all

1. **Corepack / images** — `supply-chain-06`. Three Dockerfile lines, one
   `COREPACK_HOME`, one integrity suffix, plus the CI job that builds the api
   image and runs `pnpm --version` in it. **h.** Do this first; nothing else can
   be validated on a stack that will not start.

### Gate 1 — must precede any public user

Grouped so related fixes land in one change and one test pass.

2. **Redis fragility** (one afternoon, three files) — `boot-and-config-01`,
   `reliability-02`, `reliability-01`, `reliability-16`. Fail-open
   `readCache`/`writeCache` in `SystemModeService` *and*
   `TenantResolverService`; `RedisService.ready()`; pass the shared client
   through `JobContext`; `ok:false` on `tenantsFailed > 0` (`reliability-07`).
   **h–d.**
3. **Launch-configuration defects** — `data-integrity-01`/`input-and-files-01`
   (clamp the byte ceiling), `billing-02` (fake driver throws outside dev + boot
   guard + `setBillingEnabled` throws), `boot-and-config-05` (stop rewriting
   `EMAIL_DRIVER=console`), plus the theme-A CI smoke job and deleting
   `BILLING_ENABLED ||= 'true'` from the integration setup. **d.**
4. **Email** — `launch-readiness-01`. Cut over to Resend once DNS lands. If the
   Resend key still is not available, ship the console escape hatch instead:
   force-verify endpoint, admin outbox viewer, corrected runbook. **d.**
5. **Edge trust and admission control** — `authn-authz-01`/`input-and-files-02`
   (trusted-proxy list in `client-ip.ts`, explicit `trust proxy`, Caddy
   `remote_ip` matcher, ufw rules in `prod-bootstrap.sh`, deploy-time forged-header
   check), `input-and-files-03` (defer `CREATE DATABASE` until email
   verification, or a Turnstile on signup), `authn-authz-03` (unauthenticated
   admin lockout DoS — key on `(adminId, ip)` and stop writing `status='locked'`).
   **d.**
6. **Observability and paging** — `reliability-04`, `launch-readiness-06`,
   `reliability-09`, `reliability-17`, `reliability-12`, plus `reliability-03`
   (session cookies written verbatim into INFO logs — rotate `SESSION_SECRET`
   after fixing). **d.**
7. **Backups that exist and can be restored** — `privacy-legal-02` (encrypt +
   remote prune), `reliability-05` (`restore.sh` recovers zero files and reports
   success), `reliability-06`/`reliability-08` (drill covers storage and the
   off-site leg, and runs on a schedule). **d.** Do not launch on a restore path
   nobody has executed end to end; that is precisely the failure that
   invalidated the June certification.
8. **Legal publication** — `privacy-legal-01`, `launch-readiness-07`,
   `launch-readiness-09` (delete the "passed a full security audit" claim),
   `privacy-legal-11` (disclose support impersonation in the DPA). Code is
   hours; it is blocked on the entity and counsel. **w.**

Also in this gate, cheap and worth doing while you are in the files:
`tenant-isolation-01` (drop `dbUrl`/`storageUrl` from the detail select, add
`@AdminRoles('owner')` — a one-liner), `frontend-03` (the maintenance lever
crashes every signed-in user, so the recovery screen only works for logged-out
visitors), `frontend-01` (no error boundary anywhere; an API failure renders a
bare English 500), `launch-readiness-13` (single admin, TOTP mandatory, no
recovery codes, no second admin — you are one lost phone from being locked out
of your own control plane).

### Gate 2 — must precede the first paying customer

9. `billing-03` — block `startCheckout` when a subscription exists (**h**), then
   move plan changes to `subscriptions.update` (**d**).
10. `billing-04` — Stripe Tax, tax id collection, address collection, VAT
    statement on the pricing page. **d** of code behind **w** of registration.
11. Webhook correctness: `billing-08` (200 on a lost event), `billing-07` (null
    `customer` rewrites an arbitrary tenant — Prisma turns null into `IS NULL`),
    `billing-06` (stale-replay guard inert for the events that matter),
    `billing-05` (`incomplete` grants the paid plan for 7 days, repeatably),
    `billing-09` (`ensureStripeCustomer` races itself). **d.**
12. `billing-01` (Checkout return URLs 404 — missing locale prefix, one line),
    `billing-11`, `billing-12`, `launch-readiness-02` (the founding-offer
    procedure is not mechanically deliverable). **d.**

### Gate 3 — must precede the first ~20 tenants

13. `performance-01` — streaming export. **d.** This one is user-triggered, so
    schedule it as soon as any tenant's catalogue looks real.
14. Indexes and scans: `performance-02` (loans list seq-scans on every
    dashboard load), `performance-04` (member-number generation is quadratic
    under import), `performance-05`, `performance-08`, `performance-12`,
    `performance-13` (el_GR.UTF-8 collation defeats prefix-LIKE btrees). **d.**
15. Connection budget: `performance-06` (`pinWorkerConnLimit` is a no-op; the
    API's ceiling is 250 against `max_connections=200`), `boot-and-config-02`.
    **h.**
16. Retention and erasure: `privacy-legal-05` (no retention period is enforced
    anywhere while the Privacy Policy states them), `privacy-legal-06`
    (reset/verification links stored in cleartext forever in `email_outbox`, not
    redacted in exports, and in the Caddy log that goes into the backups),
    `privacy-legal-03` (erasure is a soft archive; the DPA says otherwise),
    `privacy-legal-04`, `performance-07`. **d–w.** These are contractual
    promises, so they carry a deadline the moment the DPA is signed.
17. Import robustness: `data-integrity-02` (re-importing after a failure
    silently duplicates every row without a natural key, including patrons'
    fines), `data-integrity-03`, `data-integrity-05`, `data-integrity-06`. **d.**

---

## 5. What is fine

This matters as much as §2. Several dimensions were attacked hard and held, and
that is load-bearing for the decision.

**Tenant isolation — no blocker survived, and it was the most aggressively
tested dimension.** Read the caveat at the end of this paragraph before using it
as reassurance. Two tenants were signed up against a live Postgres/Redis,
populated with member PII and stored files, and attacked from each other's
authenticated sessions. Everything held: cross-tenant `GET /t/A/members` with
B's cookie → 403; case-variant path prefix → 400; spoofed `Host` header → the
path slug always wins; percent-encoded slug → 400; storage path traversal
(`..%2f..%2f<other tenant id>`) → 404, rejected by
`LocalDriver.safeResolve:111-120`; cross-tenant export download → 403/404;
idempotency keys are tenant-scoped (`idem:<tenantId>:…`); evicting a tenant's
Prisma client mid-query drains rather than aborting. Background jobs build a
fresh per-tenant context inside the loop. A physically separate database per
library is a real boundary and it is intact.

Two caveats, both material. First, **the probe record above did not survive
verification** — it was raised as `tenant-isolation-09` (info, "attacks that were
executed against the live stack and correctly held") and is one of the 13 raw
entries absent from the `.verified.json` files, so unlike everything else in this
report it was not independently re-run. Nothing contradicts it, and the one piece
of it that *is* corroborated in a verified finding is the storage traversal
defence (`input-and-files-09`: a `../../../../tmp/pwn.png` filename has no effect;
`safeResolve()` refuses any ref containing `..`). Treat the rest as one agent's
executed result, not as a twice-checked one.

Second, the dimension's residue is **seven findings, not four**, and the largest
is not defence-in-depth. `tenant-isolation-01` (high) — any platform admin
session, including the support tier that is supposed to need a library-issued
support key, can `GET /admin/tenants/:id` and read that tenant's plaintext
Postgres superuser URL, with no `SupportSession` and no audit row. It was
downgraded from blocker only because exactly one admin account exists today and
that operator already holds `PG_SUPERUSER_URL` — i.e. it is safe because of an
operational fact, not because of a control, and it stops being safe the day a
second admin is created. It is a one-line fix; do it before that day (§4). The
remaining findings — shared superuser role, the resolver caching `dbUrl`,
`TenantGuard` trusting the JWT `tid`, a 5-minute stale-suspension window, a stale
display name after a rename — are defence-in-depth with no live trigger, and
verification downgraded each one for that reason.

**Frontend — no blocker survived.** 28 findings, all high and below, and every
one is i18n, accessibility or error-state polish rather than a functional break:
English error strings shown to Greek librarians, a toast rendering behind a
modal's top layer, no in-app language switch, contrast failures, duplicate modal
title ids. Read honestly, though: `frontend-29` records that there is **not a
single frontend test in the repository** — 172 TS/TSX files, no vitest config,
no Testing Library, no axe gate. "No blocker in frontend" here means "no blocker
found by reading", which is weaker evidence than the dimensions where things
were executed. Do not read it as the same kind of green.

**Injection, SSRF and file-parsing defences are genuinely solid** — note the
narrower claim: this dimension also produced two of the fourteen blockers (the
upload overflow and the spoofable client IP, both merged above) and one high
(`input-and-files-03`, unauthenticated signup provisioning a Postgres database
per request), so "input handling is fine" is not what the findings say. What is
fine is the injection surface. Every raw-SQL site was reviewed; the three
`$queryRawUnsafe` call sites — `help.service.ts:79`, `effective-plan.service.ts:144`
and `maintenance-processors.ts:149` — all carry constant SQL with bound
parameters (the original finding said there was only one; the verifier re-ran the
grep and found three, all safe), and live probes (`?q='); DROP TABLE users;--`)
returned clean empty results rather than
errors. SSRF: the ISBN lookup is the only user-influenced outbound call, with a
hardcoded host, digits-only input, `redirect:'manual'`, a 5s abort and a 1 MB
cap. CSV formula injection is neutralised on all three CSV-producing paths. XLSX
zip bombs are rejected from the central directory before inflation. A 3 MB body
returns a clean 413, and 20,000 multipart fields a clean 400.

**Boot fails loud where it should.** Twelve misconfigurations were executed
under `NODE_ENV=production` and every one exited 1 with the offending variable
named: six missing secrets, three malformed values, `EMAIL_DRIVER=smtp` without
`SMTP_URL`, `STRIPE_DRIVER=real` without `STRIPE_API_KEY`, and
`RATE_LIMIT_DISABLED=true`. A cross-check found no `env.ts` key missing from the
compose env block.

**Degradation is partly correct, and narrower than the original finding
claimed.** A tenant with an unreachable database fails fast and only for that
tenant, with `/healthz` and `/readyz` still 200. A Postgres outage correctly
fails `/readyz` and the API recovers with no restart. Graceful shutdown is not
blocked by idle keep-alive sockets. But the claim that a Postgres outage leaves
`/healthz` at 200 **is false and the verifier corrected it**: that holds only
while the system-mode blob is warm in Redis. With the cache flushed and Postgres
stopped, `/healthz` returns 500, because `SystemModeMiddleware`'s `ALWAYS_PASS`
branch falls through `resolveGlobal()` to `controlDb.systemModeEvent.findFirst`.
Liveness therefore depends on *both* Redis and Postgres — which widens
`boot-and-config-01`/`reliability-02` rather than bounding it. What genuinely
holds is that neither dependency leaves the process permanently wedged: both
outages self-heal within ~2 s of the dependency returning, so remediation is
"restart the dependency". The fail-open fix is still an afternoon.

**Quota enforcement is sound where it is used.** `enforceWithinTx` takes
`pg_advisory_xact_lock` as the first statement of the caller's transaction and
counts inside it, so count and insert see a serialised view per quota key.
Un-archive re-charges a seat, closing the archive-then-restore bypass.

**Supply chain: the dependency-integrity half is better than most; the CI-trust
half is not.** Set against the good news below is `supply-chain-01` (high, and
not merely tidiness): every third-party GitHub Action is pinned by a mutable tag
— 27 `uses:` references, zero 40-hex SHAs — and those tags include the one handed
`secrets.DEPLOY_SSH_KEY`, the GHCR push token and the desktop code-signing
secrets. Repointing a tag in a repo Libriant does not control executes attacker
code with the production SSH key. There is no Dependabot, no CODEOWNERS and no
action allowlist to compensate. That belongs on the pre-launch list, not in this
section. With that said, everything below is verified sound. Every
lockfile resolution carries a sha512 integrity hash and `--frozen-lockfile`
reproduces byte-for-byte. pnpm 11's minimum-release-age policy is active and has
already rejected a lockfile over two freshly-published transitives — a real
defence against the compromised-publish window. A fork PR cannot reach a secret:
`ci.yml` uses `pull_request` (never `pull_request_target`), passes no `secrets:`,
and declares `permissions: contents: read`. Exactly five packages have install
hooks and all five are explicitly decided in `allowBuilds` — nothing silently
blocked, nothing blanket-approved.

**Privacy work that is right and should not regress.** The application form is a
model of data minimisation — no IP, no country, no user-agent; abuse throttling
via a peppered SHA-256 with a 3600s TTL; consent and the on-screen notice
version persisted as evidence. The marketing site genuinely makes zero
third-party requests (only `libriant.com` and `dpa.gr` appear in the built HTML),
so its "no banner because there is nothing to consent to" claim is true and
independently checkable. No analytics, no Sentry, no Google Fonts anywhere.
Admin MFA is mandatory outside development and enforced at the guard. The
*impersonation* path is genuinely tenant-consented through a bcrypt-hashed,
single-use, expiring key — but read that narrowly: two verified findings reach
the same data without it. `tenant-isolation-01` hands any admin tier the tenant's
plaintext superuser URL, and `privacy-legal-07` (medium) lets an owner-admin
export any library's entire database with no support key, no notice and no
control-plane audit entry. The consent model is well built and is not the only
door. The password-reset token is claimed atomically with `GETDEL` and
invalidates existing sessions.

**The product's flagship claim holds — with a version caveat.** A real tenant
export produced a 37,023-byte plain SQL dump that restored into a fresh database
with `ON_ERROR_STOP=1`, exit 0, 15 tables. That was measured with a
version-matched local `pg_dump` 16.15; the container's client version floats
(`launch-readiness-14`, low — the verifier measured the mismatch symptom as a
non-fatal ERROR line, not an aborted restore), so the deployed path is one step
less proven than the number suggests. Export TTL machinery is complete and the
cleanup job reclaims stuck jobs. The apex service worker correctly
self-unregisters to clean up the old PWA scope — a genuine cutover hazard
already handled. Every long-running service declares a healthcheck, and
`deploy-on-host.sh` validates data directories, the origin certificate, the git
checkout, Docker and the admin email before touching anything.

**The test suites are green on this commit:** 343 unit tests in 47 files, 53
integration tests in 10 files, all passing against live Postgres 16 and Redis.
`verify.yml`, which gates the deploy job, would pass. That is worth stating
plainly alongside §3A: the suite is real and it passes — it just runs in a
different configuration than production does.

---

## 6. Confidence and limits

**Nothing is deployed, so nothing here was tested against real infrastructure.**
The audit ran against a throwaway local Postgres 16 and Redis
(`env/setup-audit-env.sh`) with the real application code booted under
`NODE_ENV=production`. That is much stronger than reading — 13 of the 14
blockers are marked `proved_by: executed`, the exception being `billing-04`,
which is a read-only finding about absent tax parameters. But it leaves specific
things unproven:

- **The deploy path as a whole.** No Hetzner host, no Cloudflare, no real DNS,
  no TLS origin certificate, and **no container image was ever built or run.**
  `supply-chain-06`'s two failure modes were reproduced by replicating the
  conditions locally (a warmed, non-writable `COREPACK_HOME`), not by running
  the actual images. The mechanism is proved; the exact error the operator will
  see is inferred. Everything else about the first real deploy — volume
  ownership, the origin cert, pgbouncer under load, Caddy's config on a real
  domain — is untested by anyone, ever.
- **Real Stripe.** Every billing finding derives from the fake driver, the code,
  and Stripe's documented semantics. `billing-03`'s double-charge is
  read-verified end to end in our own database, but no charge was ever made
  against Stripe. Price ids, tax behaviour, webhook delivery, retry semantics
  and the customer portal are all unexercised.
- **Real email.** Nothing was sent. `launch-readiness-04` is a DNS read, not a
  deliverability test. Whether Resend's DKIM lines up, whether Greek municipal
  mail servers accept the domain, and whether the campaign traffic on the same
  domain hurts transactional reputation — all unknown.
- **Collation.** The audit cluster was `initdb`'d with `--locale=C`; production
  is `el_GR.UTF-8` (`performance-13`). Index selection and sort behaviour for
  Greek text differ, so the performance findings are directionally right and
  numerically optimistic.
- **Load.** The performance work used a 1.5 GB seeded scale database and
  single-process probes. There is no measurement of 20 tenants with 30
  concurrent librarians, which is the number that matters for `performance-06`
  and `boot-and-config-02`.
- **Backup and restore against real targets.** No rclone remote, no storage box,
  no restore into a real host. `reliability-05` (restore recovers zero files and
  reports success) was found by reading path resolution, and given the June
  precedent — a DR restore that dropped every database and had never been run —
  the correct posture is that **the restore path is unproven until someone
  executes it end to end on the real host.**
- **The frontend**, as noted in §5, was reviewed by reading. Zero automated
  coverage exists to corroborate it.

**On the raw files.** The verification pass took 209 raw findings to 196:
**13 rejected, 83 downgraded, and 1 upgraded.** Eight of the original blockers
did not survive at blocker weight. The verifier also corrected outright factual
errors in evidence — the admin list endpoint does *not* leak `dbUrl` (only the
detail route does); the "no firewall exists anywhere in the repo" claim was
false, the firewall exists as prose and fails for a different and better reason;
`failedLogins=40 with lockedUntil NULL` proved nothing because tenant login
never writes that column; export jobs are *not* left running forever, a cleanup
job reaps them.

One place in this report leans on a raw entry that did not survive: the
tenant-isolation attack log in §5 is `tenant-isolation-09`, and it is flagged
there. Every other finding cited anywhere in this document — 73 ids in all —
appears in a `.verified.json` file at the severity used here.

Two implications, and they point in opposite directions.

1. **Do not triage from the raw files.** Roughly 40% of entries are
   over-severe, and at least four carry evidence that does not hold. The
   `.verified.json` files are the ones with corrected reasoning, and each
   carries a `verification` field naming exactly what was re-executed. Use
   those.
2. **The raw files are not an upper bound either.** `supply-chain-06` went
   medium → blocker under verification, and it is the single most consequential
   finding in the audit — the one that stops the deploy before anything else can
   even be observed. An adversarial reviewer found the original rating too
   *low*. One upgrade in 209 is not a pattern, but it is a reminder that
   severity is a judgement about consequence, and consequence is what the
   verifier was actually equipped to test.

**What would raise confidence most, cheaply:** the theme-A smoke job. One CI run
that boots the real images from `.env.prod.example` verbatim and performs signup
→ verify → upload → invite → dashboard would independently catch four of the
twelve blockers and close the largest structural blind spot in the current test
strategy.

---

*Findings: `docs/audit/pre-release-2026-08-23/findings/<dimension>.verified.json`.
Deduped blocker list, machine-readable: `docs/audit/pre-release-2026-08-23/BLOCKERS.json`.*

---

## 7. Fact-check

This report was itself reviewed against the `.verified.json` files by a separate
pass before publication. What was checked, and what changed:

**Blocker accounting — clean.** All 14 blocker-rated findings across the twelve
verified files are `blocker` at the severity claimed here, all 14 are represented
in `BLOCKERS.json` (12 entries, three of them carrying a `merged_ids` sibling),
and none was invented, inflated or silently dropped. The headline arithmetic
holds: 209 raw → 196 verified (13 rejected, 83 downgraded, 1 upgraded), 21 raw
blockers → 14 after verification, so "eight of the original blockers did not
survive at blocker weight" is exact. 13 of the 14 carry `proved_by: executed`;
`billing-04` is the read-only exception, as stated. Every one of the 73 finding
ids cited in this document exists in a verified file.

**Deduplication — correct, one rationale corrected.** `data-integrity-01` +
`input-and-files-01` are the same bigint overflow at the same line, and
`authn-authz-01` + `input-and-files-02` are the same `X-Real-IP` trust boundary;
both merges are genuine, not two defects lumped together. The third pairing
(`boot-and-config-01` + `reliability-02`) is also genuinely one defect, but §2
originally claimed the reliability entry was downgraded "precisely because the
boot-and-config one already carries it". It was not — the verifier downgraded it
on measured grounds (bounded, self-correcting, ~2 s recovery). Rewritten.

**"What is fine" — five overclaims corrected.** This was the weakest section.
(1) The tenant-isolation attack log is `tenant-isolation-09`, one of the 13 raw
entries that did *not* survive verification; it was presented as the report's
strongest reassurance with no such flag, and the dimension's residue was
described as "four residual findings … defence-in-depth" when it is seven,
including `tenant-isolation-01` (high, plaintext superuser URL to any admin
tier, safe today only because exactly one admin account exists). Both now stated.
(2) "The single `$queryRawUnsafe`" repeats an error the verifier explicitly
corrected — there are three call sites, all safe — and "input handling is
genuinely solid" was too broad for a dimension that produced two of the fourteen
blockers; rescoped to the injection surface. (3) "A Postgres outage leaves
`/healthz` at 200" is false and was corrected in verification: with a cold Redis
cache it returns 500, which widens the Redis blocker rather than bounding it.
(4) The supply-chain paragraph said "apart from the corepack defect, better than
most", omitting `supply-chain-01` (high — every third-party Action pinned by a
mutable tag, including the one holding the production SSH key). (5) "Support
access is genuinely tenant-consented" omitted the two verified findings that
reach the same data without a support key. Also: the boot matrix executed twelve
misconfigurations, not eleven, and the flagship-export claim now carries the
verifier's `pg_dump`-version caveat.

**One rejected finding was cited as evidence.** §3D listed "`SupportSessionGuard`
is dead code" among the never-executed-code examples. That is `authn-authz-13`,
rejected in verification. Replaced with `supply-chain-13`, which is verified and
makes the same point.

**Citations — 28 spot-checked against the working tree, 3 wrong.**
`app.set('trust proxy', true)` is `main.ts:36`, not `:35` (fixed here and in
`BLOCKERS.json`); the "regular **encrypted** backups" sentence is
`locales/en/legal/dpa.md:85`, not `:88`; "deleted copies age out of backups" is
`locales/en/legal/privacy.md:77`, not `:85`. The last two are inherited from
`privacy-legal-02`, whose `where` field is wrong in the same way and was left
uncorrected in the findings file. Everything else resolved: `storage.service.ts:76`,
`system-mode.middleware.ts:100`, `client-ip.ts:16-21`, `console-driver.ts:21`,
`staff.controller.ts:51`, `stripe-fake.driver.ts:32`, `member-notifications.job.ts:138`,
`export-processors.ts:384`, `effective-plan.service.ts:38`, the three Dockerfile
corepack lines, `package.json:6`, `Caddyfile:177` (and no `remote_ip` anywhere in
its 359 lines), `docker-compose.prod.yml:35/65/135-138/240/269`, `backup.sh:188`,
`schema.prisma:574-580`, `site.config.json:4`, `platform-settings.service.ts:60-66`,
`prod-bootstrap.sh:35`, `setup.ts:8`, `deploy-from-the-server.md:113`,
`deployment-hetzner.md:192-203`, and the three upload controllers. A handful
resolve 1–3 lines off the exact statement (`billing.service.ts:285` and `:617`,
`docker-compose.prod.yml:209-211`) — close enough to find the code, not worth
renumbering.

**Verdict — supported, and correctly pitched.** "Not yet", with the launch date
set by entity registration rather than by engineering, is what 14 confirmed
blockers plus 33 highs support. It is not softened: nothing in §1 or §4 downplays
a finding the verified files rate higher. It is not harsher either — the two
places where it could have been (treating `performance-01` as a launch-day rather
than a scale blocker, and treating `reliability-02` as a second blocker) are both
handled the way the findings do. The corrections above do not move it; they close
the gap between the verdict and the "what is fine" section that a reader might
otherwise have used to argue themselves out of it.
