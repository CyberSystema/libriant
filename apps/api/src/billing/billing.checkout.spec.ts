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
  listSubscriptions,
} = vi.hoisted(() => ({
  subFindUnique: vi.fn(),
  planFindUnique: vi.fn(),
  subUpdate: vi.fn().mockResolvedValue({}),
  subUpdateMany: vi.fn().mockResolvedValue({ count: 0 }),
  accountFindUnique: vi.fn(),
  createCheckoutSession: vi.fn(),
  getSubscription: vi.fn(),
  // billing-03 round 2: with no id on the row, the purchase path asks Stripe
  // about the CUSTOMER before selling. A stub that omits this makes every
  // checkout fail closed with a 503 — which is the guard working, not a bug.
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
  const stripe = { createCheckoutSession, getSubscription, listSubscriptions };
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
    listSubscriptions.mockResolvedValue([]);
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

/**
 * billing-01. The URLs Stripe redirects to after a successful payment used to
 * be `${BILLING_RETURN_URL}/t/<slug>/billing`, which is a 404 — the web app's
 * only billing route is `/[locale]/t/[slug]/billing` and the locale segment is
 * mandatory. The auditor booted the production build and confirmed it:
 * `/t/demo/billing?checkout=success` -> 404, `/el/t/demo/billing` -> 307.
 *
 * The route SHAPE is pinned against the file tree in return-url.spec.ts. What
 * is pinned here is that startCheckout actually routes through that builder —
 * the defect was two call sites hand-assembling the path, and a builder nobody
 * calls fixes nothing.
 */
describe('BillingService.startCheckout — where Stripe sends the browser back', () => {
  /** Mirrors apps/web/app/[locale]/t/[slug]/billing/page.tsx. */
  const REAL_BILLING_ROUTE = /^https:\/\/app\.libriant\.test\/(el|en)\/t\/acme\/billing(\?|$)/;

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
      // Deliberately no defaultLocale: an older tenant row, or a select that
      // forgot the column, must still produce a route that exists.
      tenant: { slug: 'acme' },
    });
    planFindUnique.mockResolvedValue(MUNICIPAL);
  });

  it('sends a success URL that is a real Next route, not a 404', async () => {
    await makeService().startCheckout('t1', { planSlug: 'municipal' });
    const { successUrl } = createCheckoutSession.mock.calls[0]![0] as { successUrl: string };
    expect(successUrl).toMatch(REAL_BILLING_ROUTE);
    expect(successUrl).toContain('checkout=success');
  });

  it('sends a cancel URL that is a real Next route too', async () => {
    await makeService().startCheckout('t1', { planSlug: 'municipal' });
    const { cancelUrl } = createCheckoutSession.mock.calls[0]![0] as { cancelUrl: string };
    expect(cancelUrl).toMatch(REAL_BILLING_ROUTE);
    expect(cancelUrl).toContain('checkout=cancelled');
  });

  it("uses the tenant's own locale when the row has one", async () => {
    subFindUnique.mockResolvedValue({
      planId: 'p-starter',
      status: 'active',
      stripeSubscriptionId: null,
      planSelectedAt: new Date(),
      tenant: { slug: 'acme', defaultLocale: 'en' },
    });
    await makeService().startCheckout('t1', { planSlug: 'municipal' });
    const { successUrl } = createCheckoutSession.mock.calls[0]![0] as { successUrl: string };
    expect(successUrl).toBe('https://app.libriant.test/en/t/acme/billing?checkout=success');
  });

  it('rescues a client that sends the old locale-less returnPath', async () => {
    // PlanGrid.tsx / ChoosePlanScreen.tsx send no returnPath today, but a
    // desktop build or an older bundle may still send the short form. It must
    // not reintroduce the 404.
    await makeService().startCheckout('t1', {
      planSlug: 'municipal',
      returnPath: '/t/acme/billing',
    });
    const { successUrl } = createCheckoutSession.mock.calls[0]![0] as { successUrl: string };
    expect(successUrl).toMatch(REAL_BILLING_ROUTE);
  });

  it('returns a real route from the in-place re-price branch as well', async () => {
    // The re-price branch never touches Checkout, so its URL is built
    // separately — and had the same defect.
    subFindUnique.mockResolvedValue({
      planId: 'p-starter',
      status: 'active',
      stripeSubscriptionId: 'sub_live',
      planSelectedAt: new Date(),
      tenant: { slug: 'acme', defaultLocale: 'el' },
    });
    getSubscription.mockResolvedValue({ id: 'sub_live', status: 'active' });
    const stripe = {
      createCheckoutSession,
      getSubscription,
      changeSubscriptionPrice: vi.fn().mockResolvedValue(undefined),
    };
    const svc = new BillingService(
      { invalidate: vi.fn() } as never,
      stripe as never,
      { billingEnabled: vi.fn().mockResolvedValue(true) } as never,
      makeRedis() as never,
    );
    const res = await svc.startCheckout('t1', { planSlug: 'municipal' });
    expect(res.outcome).toBe('plan_changed');
    expect(res.url).toMatch(REAL_BILLING_ROUTE);
  });
});
