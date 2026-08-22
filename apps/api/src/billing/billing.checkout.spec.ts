import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A plan now carries TWO Stripe Prices, because a Stripe Price is immutable and
 * each billing interval is its own object. The failure this guards against is
 * quiet and expensive: the plan card leads with the annual figure, so sending
 * the monthly price id to Checkout would quote a library €790 and charge them
 * €79 — or the reverse.
 */

const { subFindUnique, planFindUnique, subUpdate, accountFindUnique, createCheckoutSession } =
  vi.hoisted(() => ({
    subFindUnique: vi.fn(),
    planFindUnique: vi.fn(),
    subUpdate: vi.fn().mockResolvedValue({}),
    accountFindUnique: vi.fn(),
    createCheckoutSession: vi.fn(),
  }));

vi.mock('@libriant/db-control', () => ({
  controlDb: {
    subscription: { findUnique: subFindUnique, update: subUpdate },
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

function makeService() {
  const stripe = { createCheckoutSession };
  // Self-serve checkout is gated on the master subscriptions switch.
  const settings = { billingEnabled: vi.fn().mockResolvedValue(true) };
  return new BillingService({ invalidate: vi.fn() } as never, stripe as never, settings as never);
}

describe('BillingService.startCheckout — billing cadence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    accountFindUnique.mockResolvedValue({ stripeCustomerId: 'cus_1' });
    createCheckoutSession.mockResolvedValue({ url: 'https://stripe.test/s', sessionId: 's1' });
    subFindUnique.mockResolvedValue({
      planId: 'p-starter',
      status: 'active',
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
