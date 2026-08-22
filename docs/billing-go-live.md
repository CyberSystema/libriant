# Switching billing on

_Libriant is a **[CyberSystema](https://cybersystema.com)** product._

Today `BILLING_ENABLED=false` and `STRIPE_DRIVER=fake`, so `unlimitedPlan()`
grants every tenant everything and no limit in the catalogue is enforced. This
is the sequence that ends that. **Read it all before starting** — one step is
irreversible in Stripe, and one silently disables half the pricing.

---

## Every paid plan needs TWO Stripe Prices

A Stripe Price is immutable and each billing interval is a separate object, so
a plan that is sold both monthly and annually carries two of them:

| Plan          | monthly | annual |
| ------------- | ------- | ------ |
| Community     | €39     | €390   |
| Municipal     | €79     | €790   |
| Central       | €119    | €1,190 |
| Institutional | €189    | €1,890 |

Starter is free and `on-prem-enterprise` is `billingMode = 'manual'`; neither
gets a Price.

**If you create only the monthly Price, annual billing disappears with no
error.** The API reports `hasStripeAnnualPrice: false`, the web clients hide the
cadence toggle, and every card falls back to the monthly figure — while
libriant.com goes on advertising the annual price the library cannot buy. There
is no warning anywhere. This is the step to get right.

## 1 — Create the Prices in Stripe

One Product per plan, two recurring Prices under it (`month` and `year`), in
EUR. Copy the eight `price_...` ids.

## 2 — Record them against the plans

`admin.libriant.com` → Plans → a plan shows both cadences and both ids. Or by
API, per plan:

```bash
curl -X PATCH https://admin.libriant.com/lbr-api/admin/plans/municipal \
  -H 'content-type: application/json' \
  -b "$ADMIN_COOKIE" \
  -d '{"stripePriceId":"price_...","stripeAnnualPriceId":"price_...","monthlyPriceCents":7900,"annualPriceCents":79000}'
```

The seed ships `price_seed_*` placeholders. They are not real Stripe objects and
every one of them must be replaced.

**Never repoint `stripePriceId` or `stripeAnnualPriceId` on a plan that already
has live subscribers.** Their webhooks still carry the old id, the reverse
lookup in `syncStripeSubscription` then matches nothing, and their subscription
rows go permanently stale behind a warning nobody reads. A price change means a
new Price and, for existing subscribers, a migration in Stripe.

Setting `annualPriceCents` to `null` clears the annual option and leaves the
plan monthly-only. The DB `CHECK` refuses any Stripe price id on a manual plan.

## 3 — Point the webhook at the app host

Stripe → Developers → Webhooks → `https://app.libriant.com/webhooks/stripe`.
Send a test event and confirm a 200 in `dc logs api`. Stripe retries for about
three days and then drops the event.

## 4 — Flip the switches

In `/srv/libriant/.env.prod`:

```sh
BILLING_ENABLED=true
STRIPE_DRIVER=real
STRIPE_API_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...
```

## Before you flip it: limits start biting that second

`unlimitedPlan()` is what has been answering every quota question so far. The
moment `BILLING_ENABLED=true`, `QuotaService` and `PlanGuard` enforce the real
caps against data that was loaded with none in force.

- **Check no existing tenant is already over its cap**, or a librarian meets a
  402 mid-task on Monday morning with no way to see why.
- **A tenant cannot see their own usage in production**: `GET /t/:slug/plan/usage`
  sits behind `NonProductionOnlyGuard`. Until that is opened up, the first
  signal a library gets is the refusal itself.
- **`storageUsedBytes` never self-heals.** `recomputeUsage()` exists but nothing
  schedules it, so a stale counter can deny an upload that should succeed.
- **Founding-offer libraries must be on `billingMode = 'manual'` with `paidUntil`
  twelve months out** before this flips, or they get charged for what they were
  promised free.

## Verify

```bash
curl -sS https://app.libriant.com/lbr-api/t/<slug>/billing/plans -b "$COOKIE" \
  | jq '.plans[] | {slug, monthlyPriceCents, annualPriceCents, hasStripePrice, hasStripeAnnualPrice}'
```

Every paid plan must show `hasStripeAnnualPrice: true`. Then open the billing
page as a librarian: the yearly/monthly toggle is there, yearly is selected, and
switching to monthly changes both the headline figure and what Checkout charges.
Take one plan all the way through Stripe test mode and confirm the amount on the
Checkout page matches the card that sent you there.
