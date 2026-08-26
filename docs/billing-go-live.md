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
   but `real` the endpoint reports `driver` accordingly and every row comes
   back unverified; that is the honest answer, not a pass.

Two related facts an operator needs, neither of which this document can fix:

- **Starter must keep a fake price id.** `plans_stripe_price_matches_mode`
  forces it: `UPDATE plans SET "stripePriceId"=NULL WHERE slug='starter'` is
  rejected with `23514`. The audit therefore reports Starter's placeholder as a
  **note, not a problem** — nothing can buy a free plan, so the id is never
  read, and counting it would make `.ok` permanently false, which is how a
  check becomes one nobody reads. The row still carries a fabricated id that no
  `SELECT` on `plans` can tell from a real one. Letting Starter be honest about
  having no Price needs a migration in `packages/db-control` to relax that
  constraint for `monthlyPriceCents = 0`.
- **`PATCH /admin/plans/:slug` still accepts any string** into either price
  column. The audit above catches a bad id after the fact; nothing yet
  refuses it at write time. That change belongs in
  `apps/api/src/admin/admin-plans.controller.ts`.

## Enabling subscriptions from the admin panel now refuses without Stripe (billing-14)

The superseded text told the operator to flip the Subscriptions toggle. That
flip now **throws** unless `STRIPE_DRIVER` resolves to `real` (or the host is a
declared `NODE_ENV=development`/`test` box running the in-memory stand-in), and
the API refuses to boot at all with `BILLING_ENABLED=true` and no driver that
can transact. So "subscriptions enabled while nothing can take a payment" is no
longer reachable in production.

What is still missing is the _warning_: `subscriptionsStatus()` returns
`stripeReady`, and no page reads it, so the admin Subscriptions screen looks
completely normal on a host that cannot charge. The toggle refuses when
pressed, which is the loud half; the quiet half — showing the operator why
before they press it — needs
`apps/web/app/[locale]/admin/(authed)/subscriptions/SubscriptionsToggle.tsx`.
