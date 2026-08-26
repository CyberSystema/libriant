# Superseded — see [RUNBOOK.md](RUNBOOK.md)

This was switching subscriptions on. It has been replaced, in full, by **[docs/RUNBOOK.md](RUNBOOK.md)** —
specifically §4.3 (the configuration landmines) and the billing blockers in §0.

**Do not follow the old version.** It was written for a server that no longer
exists and for CI-driven deploys that are switched off. A pre-release audit on
2026-08-23 found **122 incorrect statements** across these five documents — not
stale in tone, wrong in ways that mislead during an incident. Three that recurred:

- `/healthz` on the public hosts was presented as an "is the app up" check. It is
  a static `200` answered by Caddy before any proxying, and stays green through a
  total outage.
- Every capacity threshold described the previous machine, unverified.
- The Grafana tunnel named the wrong port.

The replacement is built from the current machine's **measured** facts
(`docs/runbook-rewrite-2026-08-23/HOST-FACTS.md`) and 323 cited findings
(`RECON.json`), and it flags at each instruction where an audit blocker means the
step cannot succeed yet.

The original 131 lines remain in git history:

```bash
git log --follow -p -- docs/billing-go-live.md
```

---

## One instruction from the old version, named because it travelled

The superseded text said, of the launch cohort:

> Founding-offer libraries must be on `billingMode = manual` with `paidUntil`
> twelve months out.

That sentence was repeated into the campaign runbook, and as written it could
not be carried out. `billingMode` is **not settable on its own** anywhere in the
running product: every write to `subscriptions.billingMode` in the API copies it
from the chosen plan (`billing.service.ts:337`, `:738`, `:1138`;
`auth/signup.service.ts:181`), and the only plan whose mode is `manual` is
`on-prem-enterprise` — a private plan with `monthlyPriceCents = 0` and
1,000,000,000 on every limit. Following the instruction through the admin panel
therefore meant putting a founding library on caps we never offered and, once
subscriptions are switched on, taking away the desktop app the offer includes
(`getDesktopAccess` refuses any plan priced at or below zero,
`billing.service.ts:288-290`).

The one thing that _can_ set it is `scripts/tenant-create.ts`, which takes
`--billing-mode` and `--paid-until` directly and is therefore where the founding
offer has to be provisioned. Verified against the audit control plane: creating a
tenant with `--plan=municipal --billing-mode=manual --paid-until=<+12mo>` yields
`plan=municipal, billingMode=manual, status=active, paidUntil=<the date>` with
`monthlyPriceCents=7900`, which is the configuration the offer describes.

**The executable procedure lives in
[`marketing/campaigns/launch-offer/reply-playbook.md`](../marketing/campaigns/launch-offer/reply-playbook.md),
under "Provisioning an accepted library".** It also records the two things the
code cannot do — convert an already-signed-up library to manual billing, and
warn anyone before `paidUntil` lapses — rather than describing them as if it
could. Do not re-derive the procedure from this document; it is superseded.

---

## The Verify step this file used to end with was vacuous (billing-10)

The superseded text closed by asking the operator to confirm
`hasStripeAnnualPrice: true` for each paid plan. That check could not fail.
`hasStripePrice` / `hasStripeAnnualPrice` were computed as
`!!plan.stripePriceId`, and the seed writes a `price_seed_*` placeholder into
every paid plan — it has to, because the `plans_stripe_price_matches_mode`
CHECK constraint refuses a `billingMode='stripe'` plan with a null price id.
The audit executed it against a completely unconfigured control plane and got
`true` for all five plans.

Two things changed in the software, and one of them replaces the instruction:

1. `hasStripePrice` now means "could actually buy something" — a
   `price_seed_*` id reads as **false**, so the plan card renders "not
   available yet" instead of a Subscribe button that Stripe answers with
   `No such price`. `POST /t/:slug/billing/checkout` refuses the same ids
   server-side, so hiding the button is not the only guard.

2. There is a real reconciliation, and it can fail:

   ```bash
   # Owner session required; run against the ADMIN host.
   curl -s -b "$ADMIN_COOKIE" https://<ADMIN_HOST>/admin/billing/price-catalogue | jq
   ```

   For every active plan it asks Stripe about both price ids and reports
   `problems[]` in plain language when the Price is missing or archived, when
   its currency or its **integer minor-unit amount** disagrees with the plan,
   when the interval does not match the column it is stored in (a monthly
   Price in the annual column is what bills €39 a month to a library that
   clicked "390 € a year"), and when the same id appears in both columns —
   which Postgres accepts, because both unique indexes are satisfied.

   Go live only when `.ok` is `true`. On a host with `STRIPE_DRIVER` anything
   but `real` there is no "unverified" verdict — every configured id comes back
   as a PROBLEM, worded for the driver: `Stripe has no Price price_…` under the
   in-memory stand-in, `Stripe could not be asked about the monthly price
price_…` under `disabled`. `.ok` is `false` either way, which is the honest
   answer and not a pass.

## What refuses a bad price id now, and where you will see it (billing-10)

Round 1 of this fix was the endpoint above and nothing else, and it was refuted
for the right reason: `PATCH /admin/plans/:slug` still accepted
`{"stripeAnnualPriceId":"price_monthly_39"}`. The audit reported it afterwards —
but only if somebody ran the audit. Two things changed.

1. **The write is refused.** `PlanPriceWriteInterceptor` (registered by
   `BillingModule` as an `APP_INTERCEPTOR`, so it runs on the real route after
   the admin guards) checks the row the PATCH would produce and answers 400
   before anything is stored. It refuses:

   - an id that is not a Stripe Price id (`prod_…`, an empty string, one with
     copy-paste whitespace);
   - a `price_seed_*` placeholder being written back in;
   - the same id in both columns, or an id that already backs another plan;
   - a Price Stripe has never heard of, an archived one, one in the wrong
     currency, one whose **integer minor-unit** amount differs from the plan's,
     and one whose recurring interval does not match the column — which is the
     `€39 a month billed to a library that clicked "390 € a year"` case;
   - an amount or currency edit that would leave an already-configured Price
     charging the old number;
   - and a price id on a host where `STRIPE_DRIVER` is not `real`, because a
     price id this server cannot check is a price id it cannot charge with.

   It costs nothing on a PATCH that carries no price id and no amount, and it
   never touches any other route. Proof it is actually mounted rather than
   merely written: `apps/api/test/integration/admin-plan-price-write.spec.ts`
   boots the real app and sends the refutation's own request over HTTP.

2. **The reconciliation is on a screen, not in a runbook.** `/admin/plans` and
   `/admin/plans/:slug` call `GET /admin/billing/price-catalogue` on every visit
   and render the verdict: a per-plan "reconciled / N problems" column, and the
   problems themselves in full. The `curl` above still works and is still the
   thing to script; nobody has to remember it any more.

## Whether this host can charge is now written on the screen (billing-14)

`subscriptionsStatus()` has returned `stripeReady` for a long time, with a
comment saying the admin UI could warn about it, and **no page in `apps/web`
read it**. So an operator on a host that cannot charge saw a completely normal
admin panel and learned the truth when the Subscriptions toggle threw at them.

`GET /admin/billing/price-catalogue` now also returns `stripeReady`,
`billingEnabled`, `subscriptionsCanBeEnabled` and a plain-language
`blockReason`, resolved from the same live `STRIPE_DRIVER` posture
`setBillingEnabled` consults — so the banner predicts the refusal rather than
merely correlating with it. `/admin/plans` renders it as a blocking banner:

- **Subscriptions OFF and nothing can charge** → a warning that names
  `STRIPE_DRIVER` and says the master switch will refuse.
- **Subscriptions ON and nothing can charge** → a critical banner, because
  every library is being gated behind a purchase this server cannot complete.

**Still missing, and it is the screen the decision is made on.** The admin
_Subscriptions_ page (`apps/web/app/[locale]/admin/(authed)/subscriptions/`)
renders only `billingEnabled`, `source` and `awaitingChoice`. It needs the same
banner and a disabled enable-button while `stripeReady` is false. That component
is owned by another package; the exact change is in this package's report under
`out_of_scope_files_needed`. Until it lands, read `/admin/plans` **before** you
open Subscriptions.

## Two steps the superseded version asked for and could not check (billing-15, billing-16)

They are named here because the audit findings point at this file, and because
both were the same failure: an instruction a reader can tick off without having
done anything. **Both now live in [RUNBOOK §4.3b](RUNBOOK.md), with a command
each.**

- Step 3 said _"point the endpoint at `/webhooks/stripe`, send a test event and
  confirm a 200"_, and never said **which events to subscribe to**. That check
  cannot fail: the endpoint answers 200 to every event type whose signature it
  can verify, handled or not. Driven against a running API — ten event types,
  six handled and four not — all ten returned `200` and all ten landed in
  `stripe_webhook_events` with `processedAt` set and `error` NULL. §4.3b lists
  the six the controller acts on and gives the Stripe API call that reports
  which of them the endpoint is actually subscribed to. It also adds the step
  the old document never mentioned at all: **save a Customer Portal
  configuration**, without which `billingPortal.sessions.create` fails and the
  library's "Open portal" button 500s on first use.
- _"Check no existing tenant is already over its cap"_ could not be performed:
  the only usage route was tenant-scoped and 404 in production, and the counters
  live in as many databases as there are libraries, so there was no SQL to hand
  an operator either. `GET /lbr-api/admin/plan-usage/over-cap` on the admin host now answers it for the
  whole fleet, against the CONTRACTED plan — the effective one is unlimited
  before the flip, so asked the ordinary way the check could never fail.

## Two related facts an operator needs, neither of which this document can fix

- **Starter must keep a fake price id.** `plans_stripe_price_matches_mode`
  forces it: `UPDATE plans SET "stripePriceId"=NULL WHERE slug='starter'` is
  rejected with `23514`. The audit therefore reports Starter's placeholder as a
  **note, not a problem** — nothing can buy a free plan, so the id is never
  read, and counting it would make `.ok` permanently false, which is how a
  check becomes one nobody reads. The row still carries a fabricated id that no
  `SELECT` on `plans` can tell from a real one. Letting Starter be honest about
  having no Price needs a migration in `packages/db-control` to relax that
  constraint for `monthlyPriceCents = 0`; the SQL is in this package's report.
  Two things now blunt it in the meantime: nothing in the API treats a
  `price_seed_*` id as configured (`isUsableStripePriceId`), and trying to clear
  it through the admin API returns a 400 that names the constraint instead of
  the Prisma 500 it used to.

- **A library on a contract cannot change its own plan.** `billingMode='manual'`
  is an operator decision — it is how the launch offer is provisioned
  (`scripts/tenant-create.ts --billing-mode=manual --paid-until=<+12mo>`). Both
  self-serve routes now refuse to move such a library: `POST /billing/select`
  and `POST /billing/checkout` answer 400 and point at us, and the billing page
  shows "contact us" on every card instead of a switch button. The one thing
  they may do is CONFIRM the plan they are already on, which stamps
  `planSelectedAt` and changes nothing else — without that, a contract library
  held by the forced plan chooser would have no way out at all.
