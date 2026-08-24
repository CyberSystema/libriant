import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A plan now carries TWO Stripe Prices, because a Stripe Price is immutable and
 * each billing interval is its own object. The failure this guards against is
 * quiet and expensive: the plan card leads with the annual figure, so sending
 * the monthly price id to Checkout would quote a library €790 and charge them
 * €79 — or the reverse.
 */

const {
  subFindUnique,
  planFindUnique,
  subUpdate,
  subUpdateMany,
  accountFindUnique,
  createCheckoutSession,
  getSubscription,
} = vi.hoisted(() => ({
  subFindUnique: vi.fn(),
  planFindUnique: vi.fn(),
  subUpdate: vi.fn().mockResolvedValue({}),
  subUpdateMany: vi.fn().mockResolvedValue({ count: 0 }),
  accountFindUnique: vi.fn(),
  createCheckoutSession: vi.fn(),
  getSubscription: vi.fn(),
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

/** In-memory stand-in for the Redis holding the in-flight-checkout marker. */
function makeRedis() {
  const store = new Map<string, string>();
  return {
    client: {
      set: vi.fn(async (key: string, value: string, ..._rest: unknown[]) => {
        if (_rest.at(-1) === 'NX' && store.has(key)) return null;
        store.set(key, value);
        return 'OK';
      }),
      get: vi.fn(async (key: string) => store.get(key) ?? null),
      del: vi.fn(async (key: string) => (store.delete(key) ? 1 : 0)),
    },
  };
}

function makeService() {
  const stripe = { createCheckoutSession, getSubscription };
  // Self-serve checkout is gated on the master subscriptions switch.
  const settings = { billingEnabled: vi.fn().mockResolvedValue(true) };
  return new BillingService(
    { invalidate: vi.fn() } as never,
    stripe as never,
    settings as never,
    makeRedis() as never,
  );
}

describe('BillingService.startCheckout — billing cadence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    accountFindUnique.mockResolvedValue({ stripeCustomerId: 'cus_1' });
    createCheckoutSession.mockResolvedValue({ url: 'https://stripe.test/s', sessionId: 's1' });
    getSubscription.mockResolvedValue(null);
    subFindUnique.mockResolvedValue({
      planId: 'p-starter',
      status: 'active',
      stripeSubscriptionId: null,
      planSelectedAt: new Date(),
      tenant: { slug: 'acme' },
    });
    planFindUnique.mockResolvedValue(MUNICIPAL);
  });

  it('sends the ANNUAL price id when the caller asks for a year', async () => {
    await makeService().startCheckout('t1', { planSlug: 'municipal', interval: 'year' });
    expect(createCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({ priceId: 'price_municipal_annual' }),
    );
  });

  it('sends the MONTHLY price id when the caller asks for a month', async () => {
    await makeService().startCheckout('t1', { planSlug: 'municipal', interval: 'month' });
    expect(createCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({ priceId: 'price_municipal_monthly' }),
    );
  });

  it('defaults to monthly, so an older client that sends no interval still works', async () => {
    await makeService().startCheckout('t1', { planSlug: 'municipal' });
    expect(createCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({ priceId: 'price_municipal_monthly' }),
    );
  });

  it('refuses annual on a plan that is not offered annually, rather than silently billing monthly', async () => {
    planFindUnique.mockResolvedValue({
      ...MUNICIPAL,
      stripeAnnualPriceId: null,
      annualPriceCents: null,
    });
    await expect(
      makeService().startCheckout('t1', { planSlug: 'municipal', interval: 'year' }),
    ).rejects.toThrow(/not offered annually/i);
    expect(createCheckoutSession).not.toHaveBeenCalled();
  });
});
