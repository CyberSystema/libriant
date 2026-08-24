import { ConflictException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * billing-03. Stripe Checkout in `mode:'subscription'` can only CREATE a
 * subscription — it has no way to modify one. Sending an upgrade through it
 * left the old subscription billing forever, and `syncStripeSubscription` then
 * overwrote `stripeSubscriptionId`, so the orphan existed only inside Stripe:
 * Community → Municipal charged €39 AND €79 every month, and cancelling from
 * the app stopped only the newer of the two. A live subscription must be
 * re-priced in place; Checkout is for the first subscription only.
 */
const {
  subFindUnique,
  planFindUnique,
  subUpdate,
  subUpdateMany,
  accountFindUnique,
  createCheckoutSession,
  changeSubscriptionPrice,
  getSubscription,
  listSubscriptions,
} = vi.hoisted(() => ({
  subFindUnique: vi.fn(),
  planFindUnique: vi.fn(),
  subUpdate: vi.fn().mockResolvedValue({}),
  subUpdateMany: vi.fn().mockResolvedValue({ count: 1 }),
  accountFindUnique: vi.fn(),
  createCheckoutSession: vi.fn(),
  changeSubscriptionPrice: vi.fn().mockResolvedValue(undefined),
  getSubscription: vi.fn(),
  listSubscriptions: vi.fn(),
}));

vi.mock('@libriant/db-control', () => ({
  controlDb: {
    subscription: { findUnique: subFindUnique, update: subUpdate, updateMany: subUpdateMany },
    plan: { findUnique: planFindUnique },
    billingAccount: { findUnique: accountFindUnique },
  },
}));
vi.mock('../config/env.js', () => ({
  loadEnv: () => ({ billingReturnUrl: 'https://app.libriant.test' }),
}));

import { BillingService } from './billing.service.js';

const MUNICIPAL = {
  id: 'p-muni',
  slug: 'municipal',
  name: 'Municipal',
  billingMode: 'stripe' as const,
  isActive: true,
  isPublic: true,
  archivedAt: null,
  stripePriceId: 'price_municipal_monthly',
  stripeAnnualPriceId: 'price_municipal_annual',
  monthlyPriceCents: 7900,
  annualPriceCents: 79000,
};

/** A library already paying for Community, one live Stripe subscription. */
function paying(overrides: Record<string, unknown> = {}) {
  return {
    planId: 'p-community',
    status: 'active',
    stripeSubscriptionId: 'sub_live',
    planSelectedAt: new Date(),
    tenant: { slug: 'acme' },
    ...overrides,
  };
}

/**
 * Redis holds the in-flight-Checkout marker (billing-03): it is what stops a
 * library that clicks Community and then Municipal from ending up with two
 * live subscriptions. The purchase path REFUSES without it, so every test that
 * reaches Checkout has to supply one.
 */
function makeRedis(overrides: Partial<Record<'set' | 'get' | 'del', unknown>> = {}) {
  return {
    client: {
      set: vi.fn().mockResolvedValue('OK'),
      get: vi.fn().mockResolvedValue(null),
      del: vi.fn().mockResolvedValue(1),
      ...overrides,
    },
  };
}

function makeService(redis: unknown = makeRedis()) {
  const stripe = {
    createCheckoutSession,
    changeSubscriptionPrice,
    getSubscription,
    listSubscriptions,
  };
  const settings = { billingEnabled: vi.fn().mockResolvedValue(true) };
  return new BillingService(
    { invalidate: vi.fn() } as never,
    stripe as never,
    settings as never,
    redis as never,
  );
}

describe('BillingService.startCheckout — an existing subscription is CHANGED, not re-bought', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    accountFindUnique.mockResolvedValue({ stripeCustomerId: 'cus_1' });
    subUpdateMany.mockResolvedValue({ count: 1 });
    createCheckoutSession.mockResolvedValue({ url: 'https://stripe.test/s', sessionId: 's1' });
    changeSubscriptionPrice.mockResolvedValue(undefined);
    planFindUnique.mockResolvedValue(MUNICIPAL);
    // Nothing at Stripe under this customer unless a test says otherwise.
    listSubscriptions.mockResolvedValue([]);
    // The local row is a CACHE of Stripe, not the truth. Every test states what
    // Stripe itself reports, because trusting the row is what produced both the
    // permanent purchase lockout and the silent no-charge "success" below.
    getSubscription.mockResolvedValue({
      id: 'sub_live',
      status: 'active',
      priceId: 'price_community_monthly',
    });
  });

  it('re-prices the live subscription instead of opening a second one', async () => {
    subFindUnique.mockResolvedValue(paying());

    const res = await makeService().startCheckout('t1', { planSlug: 'municipal' });

    expect(changeSubscriptionPrice).toHaveBeenCalledWith({
      subscriptionId: 'sub_live',
      priceId: 'price_municipal_monthly',
    });
    // The bug in one assertion: a second Checkout session IS a second
    // subscription, and the first one never stops billing.
    expect(createCheckoutSession).not.toHaveBeenCalled();
    expect(res.outcome).toBe('plan_changed');
    expect(res.sessionId).toBeNull();
    // No `?checkout=success` — nothing in apps/web reads that param, and the
    // SSR snapshot still shows the OLD plan until the webhook lands, so the
    // banner it was meant to trigger would have been a lie anyway.
    //
    // The locale segment is billing-01: this assertion used to pin
    // `/t/acme/billing`, a path the web app has never served (its one billing
    // route is `/[locale]/t/[slug]/billing`). The test agreed with the bug, so
    // it protected it. `el` is the fallback — this fixture's tenant has no
    // defaultLocale, and Greek is the launch market.
    expect(res.url).toBe('https://app.libriant.test/el/t/acme/billing');
  });

  it('carries the requested cadence into the re-price, not just the plan', async () => {
    subFindUnique.mockResolvedValue(paying());

    await makeService().startCheckout('t1', { planSlug: 'municipal', interval: 'year' });

    expect(changeSubscriptionPrice).toHaveBeenCalledWith({
      subscriptionId: 'sub_live',
      priceId: 'price_municipal_annual',
    });
  });

  it('re-prices a past_due subscription too — it is still live and still billing', async () => {
    subFindUnique.mockResolvedValue(paying({ status: 'past_due' }));
    getSubscription.mockResolvedValue({
      id: 'sub_live',
      status: 'past_due',
      priceId: 'price_community_monthly',
    });

    await makeService().startCheckout('t1', { planSlug: 'municipal' });

    expect(changeSubscriptionPrice).toHaveBeenCalledTimes(1);
    expect(createCheckoutSession).not.toHaveBeenCalled();
  });

  it('lets a Stripe failure surface instead of falling back to a second subscription', async () => {
    subFindUnique.mockResolvedValue(paying());
    changeSubscriptionPrice.mockRejectedValue(new Error('stripe: no such subscription'));

    await expect(makeService().startCheckout('t1', { planSlug: 'municipal' })).rejects.toThrow(
      /no such subscription/,
    );
    expect(createCheckoutSession).not.toHaveBeenCalled();
  });

  it('opens Checkout for a library that has no Stripe subscription yet', async () => {
    subFindUnique.mockResolvedValue(paying({ planId: 'p-starter', stripeSubscriptionId: null }));

    const res = await makeService().startCheckout('t1', { planSlug: 'municipal' });

    expect(createCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({ customerId: 'cus_1', priceId: 'price_municipal_monthly' }),
    );
    expect(changeSubscriptionPrice).not.toHaveBeenCalled();
    expect(res).toEqual({ url: 'https://stripe.test/s', sessionId: 's1', outcome: 'checkout' });
  });

  it('opens Checkout when the tracked subscription is canceled — Stripe cannot re-price it', async () => {
    subFindUnique.mockResolvedValue(
      paying({ status: 'canceled', stripeSubscriptionId: 'sub_dead' }),
    );
    getSubscription.mockResolvedValue({ id: 'sub_dead', status: 'canceled', priceId: null });

    await makeService().startCheckout('t1', { planSlug: 'municipal' });

    expect(createCheckoutSession).toHaveBeenCalledTimes(1);
    expect(changeSubscriptionPrice).not.toHaveBeenCalled();
  });

  it('re-purchases when Stripe no longer has the tracked subscription at all', async () => {
    // A missed customer.subscription.deleted used to brick purchasing for that
    // library FOREVER: the row still named a subscription, so every attempt was
    // routed to a re-price of something that does not exist. Recovery required
    // a manual SQL update. Asking Stripe is what makes it self-heal.
    subFindUnique.mockResolvedValue(paying({ stripeSubscriptionId: 'sub_vanished' }));
    getSubscription.mockResolvedValue(null);

    const res = await makeService().startCheckout('t1', { planSlug: 'municipal' });

    expect(createCheckoutSession).toHaveBeenCalledTimes(1);
    expect(changeSubscriptionPrice).not.toHaveBeenCalled();
    expect(res.outcome).toBe('checkout');
  });

  for (const status of ['incomplete', 'unpaid', 'incomplete_expired'] as const) {
    it(`re-purchases rather than re-prices a ${status} subscription — nobody ever paid for it`, async () => {
      // Both incomplete and unpaid collapse into our local 'past_due', and
      // past_due reads as live — so a subscription whose payment never
      // completed was RE-PRICED. The library saw the plan change succeed and
      // was never charged a cent. Stripe's own status is the only thing that
      // can tell these apart from a genuinely live past_due.
      subFindUnique.mockResolvedValue(paying({ status: 'past_due' }));
      getSubscription.mockResolvedValue({ id: 'sub_live', status, priceId: null });

      await makeService().startCheckout('t1', { planSlug: 'municipal' });

      expect(changeSubscriptionPrice).not.toHaveBeenCalled();
      expect(createCheckoutSession).toHaveBeenCalledTimes(1);
    });
  }

  it('refuses rather than guessing when Stripe cannot be reached', async () => {
    // "Stripe did not answer" is not "there is no subscription". Guessing the
    // latter opens a SECOND live subscription and double-charges a real library
    // every month until someone notices.
    subFindUnique.mockResolvedValue(paying());
    getSubscription.mockRejectedValue(new Error('ETIMEDOUT'));

    await expect(makeService().startCheckout('t1', { planSlug: 'municipal' })).rejects.toThrow(
      /could not reach Stripe/i,
    );
    expect(createCheckoutSession).not.toHaveBeenCalled();
    expect(changeSubscriptionPrice).not.toHaveBeenCalled();
  });

  it('refuses a second Checkout while the first is still in flight', async () => {
    // The window the original fix missed: the guard keyed on OUR
    // stripeSubscriptionId, which is still null between clicking Community and
    // the webhook landing. Click Community, go back, click Municipal — two
    // Checkout sessions, both complete, two live subscriptions.
    subFindUnique.mockResolvedValue(paying({ planId: 'p-starter', stripeSubscriptionId: null }));
    const redis = makeRedis({ set: vi.fn().mockResolvedValue(null) }); // slot already claimed

    await expect(
      makeService(redis).startCheckout('t1', { planSlug: 'municipal' }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(createCheckoutSession).not.toHaveBeenCalled();
  });

  it('refuses rather than proceeding unguarded when Redis is unreachable', async () => {
    // Deliberately the opposite call from the webhook route, which fails OPEN.
    // That one has a durable Postgres guard to fall back on; this one has no
    // second guard, and what it protects is a library being charged twice a
    // month indefinitely for a mistake it cannot see.
    subFindUnique.mockResolvedValue(paying({ planId: 'p-starter', stripeSubscriptionId: null }));
    const redis = makeRedis({
      set: vi.fn().mockRejectedValue(new Error('Stream is not writeable')),
    });

    await expect(makeService(redis).startCheckout('t1', { planSlug: 'municipal' })).rejects.toThrow(
      /temporarily unavailable|Nothing has been charged/i,
    );
    expect(createCheckoutSession).not.toHaveBeenCalled();
  });

  it('still refuses a no-op change to the plan the library is already active on', async () => {
    subFindUnique.mockResolvedValue(paying({ planId: MUNICIPAL.id }));

    await expect(makeService().startCheckout('t1', { planSlug: 'municipal' })).rejects.toThrow(
      /already on the Municipal plan/,
    );
    expect(changeSubscriptionPrice).not.toHaveBeenCalled();
    expect(createCheckoutSession).not.toHaveBeenCalled();
  });
});
