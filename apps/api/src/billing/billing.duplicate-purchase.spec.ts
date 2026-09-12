import { ServiceUnavailableException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * billing-03, ROUND 2 — the window the in-flight-Checkout marker cannot close.
 *
 * Round 1 stopped the two-clicks-in-a-row case with a Redis marker, and the
 * verifier walked straight past it with the ordering Stripe actually uses:
 *
 *   1. A library on Starter clicks Community. Checkout session A opens; the
 *      marker records it.
 *   2. The card is charged and `checkout.session.completed` is delivered
 *      FIRST. Stripe does not guarantee its order against
 *      `customer.subscription.created`, and only the latter used to write
 *      `stripeSubscriptionId`. The completed-handler DELETED the marker.
 *   3. The library clicks another plan. Our row still says "no subscription",
 *      the marker is gone, and Checkout session B opens on a customer who is
 *      already paying. Two live subscriptions, two charges, and our single id
 *      column ends up remembering only the later one — so cancelling from the
 *      app stops one of them and the other bills forever.
 *
 * Two guards close it, and this file drives both through `startCheckout` /
 * `handleCheckoutSessionCompleted`, the two entry points the billing
 * controller and the webhook controller actually call:
 *
 *   - DURABLE: `checkout.session.completed` writes the subscription id to
 *     Postgres before it drops the marker.
 *   - AUTHORITATIVE: with no id on the row, the purchase path asks Stripe what
 *     subscriptions the CUSTOMER has before selling another one. That one also
 *     covers a lost marker, a lost webhook, and a flushed Redis.
 *
 * And the thing a guard must never do: brick purchasing. The last three tests
 * are all "…and it still sells".
 */

const {
  subFindUnique,
  subUpdate,
  subUpdateMany,
  planFindUnique,
  accountFindUnique,
  accountFindFirst,
  accountCreate,
  accountUpdateMany,
  tenantFindUnique,
  createCustomer,
  createCheckoutSession,
  expireCheckoutSession,
  changeSubscriptionPrice,
  getSubscription,
  listSubscriptions,
} = vi.hoisted(() => ({
  subFindUnique: vi.fn(),
  subUpdate: vi.fn(),
  subUpdateMany: vi.fn(),
  planFindUnique: vi.fn(),
  accountFindUnique: vi.fn(),
  accountFindFirst: vi.fn(),
  accountCreate: vi.fn(),
  // billing-09: `ensureStripeCustomer` claims the customer column with a
  // conditional updateMany instead of a blind update, so a racer that lost
  // adopts the winner's id rather than overwriting it.
  accountUpdateMany: vi.fn(),
  tenantFindUnique: vi.fn(),
  createCustomer: vi.fn(),
  createCheckoutSession: vi.fn(),
  expireCheckoutSession: vi.fn(),
  changeSubscriptionPrice: vi.fn(),
  getSubscription: vi.fn(),
  listSubscriptions: vi.fn(),
}));

vi.mock('@libriant/db-control', () => ({
  controlDb: {
    // 2.0 phase 20f: the sweeps read which libraries have been cut over.
    tenantSchemaState: { findMany: () => Promise.resolve([]) },
    subscription: { findUnique: subFindUnique, update: subUpdate, updateMany: subUpdateMany },
    plan: { findUnique: planFindUnique },
    billingAccount: {
      findUnique: accountFindUnique,
      findFirst: accountFindFirst,
      create: accountCreate,
      updateMany: accountUpdateMany,
    },
    tenant: { findUnique: tenantFindUnique },
  },
}));
vi.mock('../config/env.js', () => ({
  loadEnv: () => ({ billingReturnUrl: 'https://app.libriant.test' }),
}));

import { BillingService } from './billing.service.js';

const TENANT = 't1';

function plan(slug: string, id: string, priceId: string, monthlyPriceCents: number) {
  return {
    id,
    slug,
    name: slug,
    billingMode: 'stripe' as const,
    isActive: true,
    isPublic: true,
    archivedAt: null,
    stripePriceId: priceId,
    stripeAnnualPriceId: `${priceId}_annual`,
    // Integer minor units, and present on purpose: `startCheckout` now refuses
    // a plan priced at zero (billing-11), so a fixture without this field would
    // exercise a branch no real plan takes.
    monthlyPriceCents,
    annualPriceCents: monthlyPriceCents * 10,
  };
}
const PLANS: Record<string, ReturnType<typeof plan>> = {
  community: plan('community', 'p-comm', 'price_community', 3900),
  municipal: plan('municipal', 'p-muni', 'price_municipal', 7900),
};

/**
 * The `subscriptions` row, modelled rather than asserted: this file is about a
 * SEQUENCE of writes and reads across three calls, and a mock that only
 * records arguments cannot show that the second click reads what the webhook
 * wrote.
 */
let row: { planId: string; status: string; stripeSubscriptionId: string | null };

/** In-memory Redis holding the in-flight-Checkout marker. */
function makeRedis() {
  const store = new Map<string, string>();
  return {
    store,
    service: {
      client: {
        set: vi.fn(async (key: string, value: string, ...rest: unknown[]) => {
          if (rest.at(-1) === 'NX' && store.has(key)) return null;
          store.set(key, value);
          return 'OK';
        }),
        get: vi.fn(async (key: string) => store.get(key) ?? null),
        del: vi.fn(async (key: string) => (store.delete(key) ? 1 : 0)),
      },
    },
  };
}

function makeService(redis: ReturnType<typeof makeRedis>) {
  const stripe = {
    createCustomer,
    createCheckoutSession,
    expireCheckoutSession,
    changeSubscriptionPrice,
    getSubscription,
    listSubscriptions,
  };
  return new BillingService(
    { invalidate: vi.fn() } as never,
    stripe as never,
    { billingEnabled: vi.fn().mockResolvedValue(true) } as never,
    redis.service as never,
  );
}

let redis: ReturnType<typeof makeRedis>;
let billing: BillingService;
const MARKER = `billing:checkout:${TENANT}`;

beforeEach(() => {
  vi.clearAllMocks();
  row = { planId: 'p-starter', status: 'active', stripeSubscriptionId: null };
  subFindUnique.mockImplementation(async () => ({
    ...row,
    planSelectedAt: new Date(),
    tenant: { slug: 'acme', defaultLocale: 'el' },
  }));
  subUpdate.mockResolvedValue({});
  subUpdateMany.mockImplementation(
    async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      // Model the `stripeSubscriptionId: null` guard: it is the whole reason a
      // late `checkout.session.completed` cannot clobber a tracked id.
      if ('stripeSubscriptionId' in args.where && args.where.stripeSubscriptionId === null) {
        if (row.stripeSubscriptionId !== null) return { count: 0 };
        row.stripeSubscriptionId = args.data.stripeSubscriptionId as string;
        return { count: 1 };
      }
      return { count: 1 };
    },
  );
  planFindUnique.mockImplementation(
    async (args: { where: { slug: string } }) => PLANS[args.where.slug],
  );
  accountFindUnique.mockResolvedValue({ stripeCustomerId: 'cus_1' });
  accountFindFirst.mockResolvedValue({ tenantId: TENANT });
  accountCreate.mockResolvedValue({});
  // The claim succeeds: no concurrent racer in these scenarios.
  accountUpdateMany.mockResolvedValue({ count: 1 });
  tenantFindUnique.mockResolvedValue({
    id: TENANT,
    slug: 'acme',
    name: 'Acme Library',
    primaryEmail: null,
  });
  createCustomer.mockResolvedValue({ customerId: 'cus_new' });
  let n = 0;
  createCheckoutSession.mockImplementation(async () => {
    n += 1;
    return { url: `https://stripe.test/cs_${n}`, sessionId: `cs_${n}` };
  });
  expireCheckoutSession.mockResolvedValue(undefined);
  changeSubscriptionPrice.mockResolvedValue(undefined);
  getSubscription.mockImplementation(async (id: string) =>
    id === row.stripeSubscriptionId ? { id, status: 'active', priceId: 'price_community' } : null,
  );
  listSubscriptions.mockResolvedValue([]);
  redis = makeRedis();
  billing = makeService(redis);
});

describe('the completed-checkout webhook races the second click', () => {
  it('buys ONE subscription when checkout.session.completed lands before the second click', async () => {
    // 1. First click — a Checkout session opens for the library's first plan.
    const first = await billing.startCheckout(TENANT, { planSlug: 'community' });
    expect(first.outcome).toBe('checkout');
    expect(redis.store.has(MARKER)).toBe(true);

    // 2. Stripe charges the card and delivers `checkout.session.completed`
    //    BEFORE `customer.subscription.created`.
    await billing.handleCheckoutSessionCompleted({
      id: 'cs_1',
      customer: 'cus_1',
      subscription: 'sub_A',
      client_reference_id: TENANT,
    });
    // The durable half: the pointer is on the row even though the subscription
    // event has not arrived, so the plan/status are still the old ones.
    expect(row.stripeSubscriptionId).toBe('sub_A');
    expect(row.planId).toBe('p-starter');
    expect(redis.store.has(MARKER)).toBe(false);

    // 3. The human clicks another plan in that window.
    const second = await billing.startCheckout(TENANT, { planSlug: 'municipal' });

    expect(second.outcome).toBe('plan_changed');
    expect(changeSubscriptionPrice).toHaveBeenCalledWith({
      subscriptionId: 'sub_A',
      priceId: 'price_municipal',
    });
    // The whole finding, in one assertion: exactly one Checkout session ever
    // existed, so exactly one subscription can ever be billed.
    expect(createCheckoutSession).toHaveBeenCalledTimes(1);
  });

  it('adopts the live subscription when the marker AND the completed webhook are both lost', async () => {
    // Redis flushed, or the webhook never delivered: our row says "nothing",
    // the marker is gone, and Stripe alone knows the library already pays.
    await billing.startCheckout(TENANT, { planSlug: 'community' });
    redis.store.clear();
    listSubscriptions.mockResolvedValue([
      { id: 'sub_B', status: 'active', priceId: 'price_community' },
    ]);

    const second = await billing.startCheckout(TENANT, { planSlug: 'municipal' });

    expect(second.outcome).toBe('plan_changed');
    expect(listSubscriptions).toHaveBeenCalledWith('cus_1');
    expect(changeSubscriptionPrice).toHaveBeenCalledWith({
      subscriptionId: 'sub_B',
      priceId: 'price_municipal',
    });
    expect(createCheckoutSession).toHaveBeenCalledTimes(1);
    // And the pointer is written, so the next click is answered from our row.
    expect(row.stripeSubscriptionId).toBe('sub_B');
  });

  it('re-prices the newest and refuses to add a third when the customer already has two', async () => {
    listSubscriptions.mockResolvedValue([
      { id: 'sub_new', status: 'active', priceId: 'price_community' },
      { id: 'sub_old', status: 'past_due', priceId: 'price_community' },
    ]);

    const result = await billing.startCheckout(TENANT, { planSlug: 'municipal' });

    expect(result.outcome).toBe('plan_changed');
    expect(changeSubscriptionPrice).toHaveBeenCalledWith({
      subscriptionId: 'sub_new',
      priceId: 'price_municipal',
    });
    expect(createCheckoutSession).not.toHaveBeenCalled();
  });

  it('fails CLOSED when Stripe cannot say whether the customer already pays', async () => {
    listSubscriptions.mockRejectedValue(new Error('connect ETIMEDOUT api.stripe.com:443'));

    await expect(billing.startCheckout(TENANT, { planSlug: 'community' })).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    // "Stripe did not answer" is not "they have nothing" — guessing the latter
    // is exactly how the second live subscription gets sold.
    expect(createCheckoutSession).not.toHaveBeenCalled();
  });

  it('keeps the marker when a completed session carries no subscription id', async () => {
    await billing.startCheckout(TENANT, { planSlug: 'community' });

    await billing.handleCheckoutSessionCompleted({
      id: 'cs_1',
      customer: 'cus_1',
      subscription: null,
      client_reference_id: TENANT,
    });

    // Nothing durable to fall back on, so the marker must stay: it is the only
    // guard left between this tenant and a second Checkout session.
    expect(row.stripeSubscriptionId).toBeNull();
    expect(redis.store.has(MARKER)).toBe(true);
  });

  it('does not clobber a subscription id the subscription event already wrote', async () => {
    row.stripeSubscriptionId = 'sub_first';

    await billing.handleCheckoutSessionCompleted({
      id: 'cs_9',
      customer: 'cus_1',
      subscription: 'sub_second',
      client_reference_id: TENANT,
    });

    expect(row.stripeSubscriptionId).toBe('sub_first');
  });
});

describe('an in-place plan change revokes the Checkout session it makes stale', () => {
  it('expires the outstanding session at Stripe instead of merely forgetting it', async () => {
    await billing.startCheckout(TENANT, { planSlug: 'community' });
    expect(redis.store.has(MARKER)).toBe(true);
    // Meanwhile a subscription appears for this customer (Dashboard, or the
    // adoption path) — the open session is now a loaded gun.
    listSubscriptions.mockResolvedValue([
      { id: 'sub_live', status: 'active', priceId: 'price_community' },
    ]);

    await billing.startCheckout(TENANT, { planSlug: 'municipal' });

    expect(expireCheckoutSession).toHaveBeenCalledWith('cs_1');
    expect(redis.store.has(MARKER)).toBe(false);
  });

  it('keeps the marker when Stripe refuses the expire, so the next attempt retries it', async () => {
    await billing.startCheckout(TENANT, { planSlug: 'community' });
    listSubscriptions.mockResolvedValue([
      { id: 'sub_live', status: 'active', priceId: 'price_community' },
    ]);
    expireCheckoutSession.mockRejectedValue(
      new Error('You cannot expire a Checkout Session that is complete.'),
    );

    // The plan change itself is legitimate and still goes through.
    const result = await billing.startCheckout(TENANT, { planSlug: 'municipal' });

    expect(result.outcome).toBe('plan_changed');
    expect(redis.store.has(MARKER)).toBe(true);
  });
});

describe('the guard does not brick purchasing', () => {
  it('sells when the customer exists but every Stripe subscription is dead', async () => {
    listSubscriptions.mockResolvedValue([
      { id: 'sub_dead', status: 'canceled', priceId: 'price_community' },
      { id: 'sub_never_paid', status: 'incomplete', priceId: 'price_community' },
    ]);

    const result = await billing.startCheckout(TENANT, { planSlug: 'community' });

    expect(result.outcome).toBe('checkout');
    expect(changeSubscriptionPrice).not.toHaveBeenCalled();
  });

  it('never asks Stripe about a customer that does not exist yet', async () => {
    accountFindUnique.mockResolvedValue(null);
    listSubscriptions.mockRejectedValue(new Error('should not have been called'));

    const result = await billing.startCheckout(TENANT, { planSlug: 'community' });

    expect(result.outcome).toBe('checkout');
    expect(listSubscriptions).not.toHaveBeenCalled();
  });
});
