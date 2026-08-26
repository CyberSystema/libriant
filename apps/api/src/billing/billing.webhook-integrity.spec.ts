import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The webhook-side half of the billing-correctness package: billing-05,
 * billing-06, billing-07, billing-09 (repair half) and billing-12 (the
 * cancellation that arrives weeks after the plan moved).
 *
 * Every test drives a real `BillingService` method — the ones
 * `StripeWebhookController.dispatch` and the retry sweep call — against mocked
 * Prisma, so what is asserted is the write that would land on a real
 * `subscriptions` row, not the shape of an internal helper.
 */
const {
  billingFindFirst,
  billingFindUnique,
  billingUpdateMany,
  planFindFirst,
  planFindUnique,
  subFindUnique,
  subUpdate,
  subUpdateMany,
} = vi.hoisted(() => ({
  billingFindFirst: vi.fn(),
  billingFindUnique: vi.fn(),
  billingUpdateMany: vi.fn(),
  planFindFirst: vi.fn(),
  planFindUnique: vi.fn(),
  subFindUnique: vi.fn(),
  subUpdate: vi.fn(),
  subUpdateMany: vi.fn(),
}));

vi.mock('@libriant/db-control', () => ({
  controlDb: {
    billingAccount: {
      findFirst: billingFindFirst,
      findUnique: billingFindUnique,
      updateMany: billingUpdateMany,
    },
    plan: { findFirst: planFindFirst, findUnique: planFindUnique },
    subscription: { findUnique: subFindUnique, update: subUpdate, updateMany: subUpdateMany },
  },
}));

const GRACE_DAYS = 7;
vi.mock('../config/env.js', () => ({
  loadEnv: () => ({
    billingReturnUrl: 'https://app.libriant.test',
    billingGracePeriodDays: GRACE_DAYS,
  }),
}));

import { BillingService } from './billing.service.js';
import type { StripeInvoiceShape, StripeSubscriptionShape } from './stripe-driver.js';

const TENANT = 'tnt_paying';
const CUSTOMER = 'cus_paying';
const MS_PER_DAY = 86_400_000;

/** Same period start on every event: a mid-cycle re-price does not move it. */
const PERIOD_START = 1_787_000_000;
const PERIOD_END = 1_789_600_000;

const COMMUNITY = { id: 'p-comm', slug: 'community', priceId: 'price_community' };
const MUNICIPAL = { id: 'p-muni', slug: 'municipal', priceId: 'price_municipal' };

function subscriptionEvent(
  overrides: Partial<StripeSubscriptionShape> & { priceId?: string } = {},
): StripeSubscriptionShape {
  const { priceId = COMMUNITY.priceId, ...rest } = overrides;
  return {
    id: 'sub_live',
    customer: CUSTOMER,
    status: 'active',
    cancel_at_period_end: false,
    canceled_at: null,
    items: {
      data: [
        {
          price: { id: priceId },
          current_period_start: PERIOD_START,
          current_period_end: PERIOD_END,
        },
      ],
    },
    ...rest,
  };
}

function invoice(overrides: Partial<StripeInvoiceShape> = {}): StripeInvoiceShape {
  return {
    id: 'in_1',
    customer: CUSTOMER,
    subscription: 'sub_live',
    status: 'open',
    amount_paid: 0,
    amount_due: 3900,
    billing_reason: 'subscription_cycle',
    ...overrides,
  };
}

/** In-memory Redis: the applied-event marker (billing-06) actually persists. */
function makeRedis() {
  const store = new Map<string, string>();
  return {
    store,
    service: {
      client: {
        get: vi.fn(async (k: string) => store.get(k) ?? null),
        set: vi.fn(async (k: string, v: string) => {
          store.set(k, v);
          return 'OK';
        }),
        del: vi.fn(async (k: string) => (store.delete(k) ? 1 : 0)),
      },
    } as never,
  };
}

function makeService(stripe: Record<string, unknown> = {}) {
  const effectivePlan = { invalidate: vi.fn().mockResolvedValue(undefined) };
  const redis = makeRedis();
  const driver = {
    isReal: false,
    kind: 'fake',
    getSubscription: vi.fn().mockResolvedValue(null),
    cancelSubscriptionAtPeriodEnd: vi.fn().mockResolvedValue(undefined),
    ...stripe,
  };
  const svc = new BillingService(
    effectivePlan as never,
    driver as never,
    { billingEnabled: async () => true } as never,
    redis.service,
  );
  return { svc, driver, redis };
}

/** The write that landed on `subscriptions`, or null when none did. */
function lastUpdate(): Record<string, unknown> | null {
  const call = subUpdate.mock.calls.at(-1);
  return call ? (call[0].data as Record<string, unknown>) : null;
}

/**
 * The whole `subscriptions` row, as every read in these paths sees it —
 * including the `plan`/`tenant` relations `getSnapshot` needs at the end of
 * the invoice handlers. Tests override FIELDS on it rather than replacing it,
 * so a test cannot accidentally pass because a field it never mentioned went
 * missing.
 */
function subRow(overrides: Record<string, unknown> = {}) {
  return {
    tenantId: TENANT,
    planId: COMMUNITY.id,
    status: 'active',
    graceUntil: null,
    stripeSubscriptionId: 'sub_live',
    currentPeriodStart: new Date(PERIOD_START * 1000),
    currentPeriodEnd: null,
    billingMode: 'stripe',
    plan: { id: COMMUNITY.id, slug: COMMUNITY.slug, name: 'Community' },
    tenant: { slug: 'acme', defaultLocale: 'el' },
    planSelectedAt: new Date(),
    paidUntil: null,
    cancelAtPeriodEnd: false,
    canceledAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  billingFindFirst.mockReset().mockResolvedValue({ tenantId: TENANT });
  billingFindUnique.mockReset().mockResolvedValue({ stripeCustomerId: CUSTOMER });
  billingUpdateMany.mockReset().mockResolvedValue({ count: 1 });
  planFindFirst.mockReset().mockImplementation(async (args: { where: { OR: unknown[] } }) => {
    const priceId = (args.where.OR as Array<Record<string, string>>)[0]?.stripePriceId;
    if (priceId === MUNICIPAL.priceId) return MUNICIPAL;
    return COMMUNITY;
  });
  planFindUnique
    .mockReset()
    .mockResolvedValue({ id: 'p-starter', slug: 'starter', billingMode: 'stripe' });
  subFindUnique.mockReset().mockResolvedValue(subRow());
  subUpdate.mockReset().mockResolvedValue({});
  subUpdateMany.mockReset().mockResolvedValue({ count: 0 });
});

// ---------------------------------------------------------------------------
// billing-07 — a payload with no customer must pick no victim
// ---------------------------------------------------------------------------

describe('billing-07: a webhook with a null customer rewrites nobody', () => {
  /**
   * The executed defect: `findFirst({ where: { stripeCustomerId: null } })`
   * renders as `stripeCustomerId IS NULL`, and signup gives EVERY tenant a
   * billing_accounts row with a null customer id (44 of 46 on the audit control
   * plane). So a null customer did not fail to match — it matched an arbitrary
   * library, and the handler rewrote that library's plan.
   */
  it.each([
    [
      'subscription.updated',
      (s: BillingService) =>
        s.syncStripeSubscription(subscriptionEvent({ customer: null as never })),
    ],
    [
      'subscription.deleted',
      (s: BillingService) =>
        s.handleStripeSubscriptionDeleted(subscriptionEvent({ customer: null as never })),
    ],
    [
      'invoice.payment_failed',
      (s: BillingService) => s.handleStripeInvoiceFailed(invoice({ customer: null as never })),
    ],
    [
      'invoice.payment_succeeded',
      (s: BillingService) => s.handleStripeInvoicePaid(invoice({ customer: null as never })),
    ],
  ])('%s never reaches the database', async (_name, run) => {
    const { svc } = makeService();

    await run(svc);

    expect(billingFindFirst).not.toHaveBeenCalled();
    expect(subUpdate).not.toHaveBeenCalled();
  });

  it('checkout.session.completed with neither a client_reference_id nor a customer touches nothing', async () => {
    const { svc } = makeService();

    await svc.handleCheckoutSessionCompleted({
      id: 'cs_1',
      customer: null as never,
      subscription: 'sub_live',
      client_reference_id: null,
    });

    expect(billingFindFirst).not.toHaveBeenCalled();
    expect(subUpdateMany).not.toHaveBeenCalled();
  });

  it('a real customer id still resolves its own tenant', async () => {
    const { svc } = makeService();

    await svc.syncStripeSubscription(subscriptionEvent());

    expect(billingFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { stripeCustomerId: CUSTOMER } }),
    );
    expect(subUpdate).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// billing-05 — a grace window needs a settled invoice
// ---------------------------------------------------------------------------

describe('billing-05: grace requires evidence that somebody paid', () => {
  it('arms no grace window when the FIRST invoice of a subscription fails', async () => {
    const { svc } = makeService();

    await svc.handleStripeInvoiceFailed(invoice({ billing_reason: 'subscription_create' }));

    expect(lastUpdate()).toMatchObject({ status: 'past_due', graceUntil: null });
  });

  it('arms the grace window when a RENEWAL fails on a subscription that has paid before', async () => {
    const { svc } = makeService();
    const before = Date.now();

    await svc.handleStripeInvoiceFailed(invoice({ billing_reason: 'subscription_cycle' }));

    const data = lastUpdate();
    expect(data?.status).toBe('past_due');
    const grace = data?.graceUntil as Date;
    expect(grace).toBeInstanceOf(Date);
    expect(grace.getTime()).toBeGreaterThanOrEqual(before + GRACE_DAYS * MS_PER_DAY - 5_000);
  });

  it('treats an invoice with no billing_reason as unproven, not as a renewal', async () => {
    const { svc } = makeService();

    await svc.handleStripeInvoiceFailed(invoice({ billing_reason: undefined }));

    expect(lastUpdate()).toMatchObject({ graceUntil: null });
  });

  it('does not tear down a grace window a genuine renewal failure already armed', async () => {
    const running = new Date(Date.now() + 3 * MS_PER_DAY);
    // `stripeSubscriptionId` is read first, by the BILL-2 guard that refuses an
    // invoice belonging to some other subscription — omit it and the test
    // would pass for the wrong reason (nothing written at all).
    subFindUnique.mockResolvedValue(subRow({ status: 'past_due', graceUntil: running }));
    const { svc } = makeService();

    await svc.handleStripeInvoiceFailed(invoice({ billing_reason: 'subscription_create' }));

    expect(lastUpdate()).toMatchObject({ status: 'past_due', graceUntil: running });
  });

  /**
   * The half an earlier round already closed, locked down so it cannot regress:
   * Stripe's `incomplete` (first payment never completed) collapses onto our
   * local `past_due`, and the resolver admits `past_due` ONLY while
   * `graceUntil > now()`. A null grace is therefore what makes an unpaid
   * subscription grant nothing.
   */
  it('a subscription stuck at Stripe `incomplete` gets past_due with NO grace window', async () => {
    const { svc } = makeService();

    await svc.syncStripeSubscription(subscriptionEvent({ status: 'incomplete' }));

    expect(lastUpdate()).toMatchObject({ status: 'past_due', graceUntil: null });
  });
});

// ---------------------------------------------------------------------------
// billing-06 — order subscription events by the envelope, not the period
// ---------------------------------------------------------------------------

describe('billing-06: a stale subscription event cannot revert the plan', () => {
  const OLDER = { id: 'evt_old', createdAt: new Date(PERIOD_START * 1000 + 60_000) };
  const NEWER = { id: 'evt_new', createdAt: new Date(PERIOD_START * 1000 + 120_000) };

  it('ignores an older event for the same subscription, even though the period start is identical', async () => {
    const { svc } = makeService();

    // The upgrade lands first.
    await svc.syncStripeSubscription(subscriptionEvent({ priceId: MUNICIPAL.priceId }), NEWER);
    expect(lastUpdate()).toMatchObject({ planId: MUNICIPAL.id });

    // The superseded community event is redelivered. Same subscription, same
    // `current_period_start` — which is exactly why the old period-comparison
    // guard let it through and the library silently fell back to Community.
    await svc.syncStripeSubscription(subscriptionEvent({ priceId: COMMUNITY.priceId }), OLDER);

    expect(subUpdate).toHaveBeenCalledTimes(1);
    expect(lastUpdate()).toMatchObject({ planId: MUNICIPAL.id });
  });

  it('still applies a genuinely newer event', async () => {
    const { svc } = makeService();

    await svc.syncStripeSubscription(subscriptionEvent({ priceId: COMMUNITY.priceId }), OLDER);
    await svc.syncStripeSubscription(subscriptionEvent({ priceId: MUNICIPAL.priceId }), NEWER);

    expect(subUpdate).toHaveBeenCalledTimes(2);
    expect(lastUpdate()).toMatchObject({ planId: MUNICIPAL.id });
  });

  it('a first-ever event for a subscription always applies', async () => {
    const { svc } = makeService();

    await svc.syncStripeSubscription(subscriptionEvent(), OLDER);

    expect(subUpdate).toHaveBeenCalledTimes(1);
  });

  /**
   * The retry sweep re-dispatches a stored `data.object` with no envelope —
   * the second live path the verifier named. With no timestamp to order by,
   * ask the authority: Stripe still has the subscription on the newer price,
   * so the replay has been overtaken.
   */
  it('an un-orderable replay is refused when Stripe says the subscription moved on', async () => {
    subFindUnique.mockResolvedValue(subRow({ planId: MUNICIPAL.id }));
    const { svc, driver } = makeService({
      getSubscription: vi
        .fn()
        .mockResolvedValue({ id: 'sub_live', status: 'active', priceId: MUNICIPAL.priceId }),
    });

    await svc.syncStripeSubscription(subscriptionEvent({ priceId: COMMUNITY.priceId }));

    expect(driver.getSubscription).toHaveBeenCalledWith('sub_live');
    expect(subUpdate).not.toHaveBeenCalled();
  });

  it('an un-orderable replay that Stripe agrees with still applies', async () => {
    subFindUnique.mockResolvedValue(subRow({ planId: MUNICIPAL.id }));
    const { svc } = makeService({
      getSubscription: vi
        .fn()
        .mockResolvedValue({ id: 'sub_live', status: 'active', priceId: COMMUNITY.priceId }),
    });

    await svc.syncStripeSubscription(subscriptionEvent({ priceId: COMMUNITY.priceId }));

    expect(lastUpdate()).toMatchObject({ planId: COMMUNITY.id });
  });

  it('does not spend a Stripe call on a replay that would not move the plan', async () => {
    const { svc, driver } = makeService();

    await svc.syncStripeSubscription(subscriptionEvent({ priceId: COMMUNITY.priceId }));

    expect(driver.getSubscription).not.toHaveBeenCalled();
    expect(subUpdate).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// billing-09 — repair a customer id the race lost
// ---------------------------------------------------------------------------

describe('billing-09: checkout.session.completed reconciles the Stripe customer', () => {
  it('adopts the session customer when the library has none on file', async () => {
    billingUpdateMany.mockResolvedValue({ count: 1 });
    const { svc } = makeService();

    await svc.handleCheckoutSessionCompleted({
      id: 'cs_1',
      customer: 'cus_the_one_they_paid_on',
      subscription: 'sub_live',
      client_reference_id: TENANT,
    });

    expect(billingUpdateMany).toHaveBeenCalledWith({
      where: { tenantId: TENANT, stripeCustomerId: null },
      data: { stripeCustomerId: 'cus_the_one_they_paid_on' },
    });
  });

  it('never overwrites a customer id we already track', async () => {
    // Nothing claimed: the column was not null.
    billingUpdateMany.mockResolvedValue({ count: 0 });
    billingFindUnique.mockResolvedValue({ stripeCustomerId: CUSTOMER });
    const { svc } = makeService();

    await svc.handleCheckoutSessionCompleted({
      id: 'cs_1',
      customer: 'cus_other',
      subscription: 'sub_live',
      client_reference_id: TENANT,
    });

    expect(billingUpdateMany).toHaveBeenCalledTimes(1);
    expect(billingUpdateMany.mock.calls[0]?.[0].where).toMatchObject({ stripeCustomerId: null });
  });
});

// ---------------------------------------------------------------------------
// billing-12 — a cancellation must not drag a contracted library back
// ---------------------------------------------------------------------------

describe('billing-12: subscription.deleted leaves a manually-billed library alone', () => {
  it('ignores the delete for a tenant an operator moved onto a manual plan', async () => {
    subFindUnique.mockResolvedValue(subRow({ stripeSubscriptionId: null, billingMode: 'manual' }));
    const { svc } = makeService();

    await svc.handleStripeSubscriptionDeleted(subscriptionEvent({ id: 'sub_live' }));

    expect(subUpdate).not.toHaveBeenCalled();
  });

  it('still downgrades a stripe-billed library whose subscription really ended', async () => {
    subFindUnique.mockResolvedValue(subRow());
    planFindUnique.mockResolvedValue({ id: 'p-starter', slug: 'starter', billingMode: 'stripe' });
    const { svc } = makeService();

    await svc.handleStripeSubscriptionDeleted(subscriptionEvent({ id: 'sub_live' }));

    expect(lastUpdate()).toMatchObject({ planId: 'p-starter', status: 'canceled' });
  });
});
