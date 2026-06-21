import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Regression test for the Stripe API `basil`/`dahlia` shape drift (audit C1):
 * the billing period moved off the top-level Subscription onto each
 * SubscriptionItem, so reading `payload.current_period_start` yields
 * `undefined → NaN → Invalid Date`, which Prisma rejects — breaking every real
 * subscription sync. The fix reads from `items.data[0]` and never builds an
 * Invalid Date.
 */
const { billingFindFirst, planFindUnique, subUpdate, subUpdateMany, subFindUnique } = vi.hoisted(
  () => ({
    billingFindFirst: vi.fn(),
    planFindUnique: vi.fn(),
    subUpdate: vi.fn().mockResolvedValue({}),
    subUpdateMany: vi.fn().mockResolvedValue({ count: 0 }),
    // syncStripeSubscription now reads the existing row for the stale-replay
    // monotonic guard (STRIPE-RETRY-STALE-REPLAY); null → no prior row → the
    // guard is a no-op and the period-shape assertions below still hold.
    subFindUnique: vi.fn().mockResolvedValue(null),
  }),
);

vi.mock('@libriant/db-control', () => ({
  controlDb: {
    billingAccount: { findFirst: billingFindFirst },
    plan: { findUnique: planFindUnique },
    subscription: { update: subUpdate, updateMany: subUpdateMany, findUnique: subFindUnique },
  },
}));

import { BillingService } from './billing.service.js';
import type { StripeSubscriptionShape } from './stripe-driver.js';

function makeService() {
  const effectivePlan = { invalidate: vi.fn().mockResolvedValue(undefined) };
  return new BillingService(effectivePlan as never, {} as never, {} as never);
}

const PERIOD_START = 1_781_000_000;
const PERIOD_END = 1_783_600_000;

function basilPayload(overrides: Partial<StripeSubscriptionShape> = {}): StripeSubscriptionShape {
  return {
    id: 'sub_1',
    customer: 'cus_1',
    status: 'active',
    cancel_at_period_end: false,
    canceled_at: null,
    items: {
      data: [
        {
          price: { id: 'price_1' },
          current_period_start: PERIOD_START,
          current_period_end: PERIOD_END,
        },
      ],
    },
    ...overrides,
  };
}

function lastUpdateData(): {
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
} {
  const call = subUpdate.mock.calls.at(-1);
  if (!call) throw new Error('subscription.update was not called');
  return call[0].data;
}

describe('BillingService.syncStripeSubscription (Stripe period shape)', () => {
  beforeEach(() => {
    billingFindFirst.mockReset().mockResolvedValue({ tenantId: 'tnt_1' });
    planFindUnique.mockReset().mockResolvedValue({ id: 'plan_1' });
    subFindUnique.mockReset().mockResolvedValue(null);
    subUpdate.mockClear();
    subUpdateMany.mockClear();
  });

  it('reads the billing period from items.data[0] (basil/dahlia shape) and writes valid Dates', async () => {
    await makeService().syncStripeSubscription(basilPayload());

    expect(subUpdate).toHaveBeenCalledTimes(1);
    const data = lastUpdateData();
    expect(data.currentPeriodStart).toEqual(new Date(PERIOD_START * 1000));
    expect(data.currentPeriodEnd).toEqual(new Date(PERIOD_END * 1000));
    expect(Number.isNaN(data.currentPeriodStart!.getTime())).toBe(false);
  });

  it('falls back to legacy top-level period fields when items carry none', async () => {
    const payload = basilPayload();
    const item = payload.items.data[0]!;
    delete item.current_period_start;
    delete item.current_period_end;
    payload.current_period_start = PERIOD_START;
    payload.current_period_end = PERIOD_END;

    await makeService().syncStripeSubscription(payload);

    const data = lastUpdateData();
    expect(data.currentPeriodStart).toEqual(new Date(PERIOD_START * 1000));
    expect(data.currentPeriodEnd).toEqual(new Date(PERIOD_END * 1000));
  });

  it('writes null (never an Invalid Date) when the period is absent everywhere', async () => {
    const payload = basilPayload();
    const item = payload.items.data[0]!;
    delete item.current_period_start;
    delete item.current_period_end;

    await expect(makeService().syncStripeSubscription(payload)).resolves.toBeUndefined();

    const data = lastUpdateData();
    expect(data.currentPeriodStart).toBeNull();
    expect(data.currentPeriodEnd).toBeNull();
  });
});

describe('BillingService.handleStripeSubscriptionDeleted (A6-01 stale-delete guard)', () => {
  beforeEach(() => {
    billingFindFirst.mockReset().mockResolvedValue({ tenantId: 'tnt_1' });
    planFindUnique.mockReset().mockResolvedValue({ id: 'plan_starter', billingMode: 'stripe' });
    subFindUnique.mockReset();
    subUpdate.mockClear();
  });

  it('downgrades when the deleted id matches the tracked subscription', async () => {
    subFindUnique.mockResolvedValue({ stripeSubscriptionId: 'sub_1' });
    await makeService().handleStripeSubscriptionDeleted(basilPayload({ id: 'sub_1' }));
    expect(subUpdate).toHaveBeenCalledTimes(1);
    expect(subUpdate.mock.calls[0]![0].data.status).toBe('canceled');
  });

  it('downgrades when we track no subscription id', async () => {
    subFindUnique.mockResolvedValue({ stripeSubscriptionId: null });
    await makeService().handleStripeSubscriptionDeleted(basilPayload({ id: 'sub_old' }));
    expect(subUpdate).toHaveBeenCalledTimes(1);
  });

  it('IGNORES a stale delete for a superseded subscription (tenant re-subscribed)', async () => {
    // Tenant churned off sub_old and is now active on sub_new; a replayed
    // delete for sub_old must NOT clobber the newer subscription.
    subFindUnique.mockResolvedValue({ stripeSubscriptionId: 'sub_new' });
    await makeService().handleStripeSubscriptionDeleted(basilPayload({ id: 'sub_old' }));
    expect(subUpdate).not.toHaveBeenCalled();
  });
});
