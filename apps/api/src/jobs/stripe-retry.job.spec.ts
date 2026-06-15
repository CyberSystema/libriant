import { beforeEach, describe, expect, it, vi } from 'vitest';

const { stripeFindMany, stripeUpdate, billingMethods, redisDestroy } = vi.hoisted(() => ({
  stripeFindMany: vi.fn(),
  stripeUpdate: vi.fn().mockResolvedValue({}),
  billingMethods: {
    syncStripeSubscription: vi.fn().mockResolvedValue(undefined),
    handleStripeSubscriptionDeleted: vi.fn().mockResolvedValue(undefined),
    handleStripeInvoicePaid: vi.fn().mockResolvedValue(undefined),
    handleStripeInvoiceFailed: vi.fn().mockResolvedValue(undefined),
  },
  redisDestroy: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@libriant/db-control', () => ({
  controlDb: {
    stripeWebhookEvent: { findMany: stripeFindMany, update: stripeUpdate },
  },
}));
vi.mock('../config/env.js', () => ({
  loadEnv: () => ({ stripeDriver: 'fake' }),
}));
// These are all instantiated with `new` in the sweeper. Under vitest 4 a
// `vi.fn` wrapping an arrow can't be constructed, so use regular functions
// that return the mock instance.
vi.mock('../billing/billing.service.js', () => ({
  BillingService: vi.fn(function () {
    return billingMethods;
  }),
}));
vi.mock('../plans/effective-plan.service.js', () => ({
  EffectivePlanService: vi.fn(function () {
    return {};
  }),
}));
vi.mock('../billing/stripe-fake.driver.js', () => ({
  FakeStripeDriver: vi.fn(function () {
    return {};
  }),
}));
vi.mock('../billing/stripe-real.driver.js', () => ({
  RealStripeDriver: vi.fn(function () {
    return {};
  }),
}));
vi.mock('../platform/redis.service.js', () => ({
  RedisService: vi.fn(function () {
    // The sweep now claims the controller's `stripe:event:<id>` SETNX lock
    // before dispatch (STRIPE-RETRY-NO-LOCK). set→'OK' = lock acquired, so each
    // row is processed and the existing succeeded/stillFailing assertions hold.
    return {
      client: {
        set: vi.fn().mockResolvedValue('OK'),
        del: vi.fn().mockResolvedValue(1),
      },
      onModuleDestroy: redisDestroy,
    };
  }),
}));

import { sweepFailedStripeWebhooks } from './stripe-retry.job.js';

describe('sweepFailedStripeWebhooks', () => {
  beforeEach(() => {
    stripeFindMany.mockReset();
    stripeUpdate.mockClear();
    for (const fn of Object.values(billingMethods)) fn.mockClear();
  });

  it('returns a no-op summary when nothing has failed', async () => {
    stripeFindMany.mockResolvedValue([]);

    const result = await sweepFailedStripeWebhooks();

    expect(result).toEqual({ message: 'no failed events to retry', counts: { retried: 0 } });
    expect(stripeUpdate).not.toHaveBeenCalled();
  });

  it('re-dispatches each failed row and marks succeeded ones processed', async () => {
    stripeFindMany.mockResolvedValue([
      {
        id: 'evt_1',
        type: 'customer.subscription.updated',
        payloadJson: { id: 'evt_1', type: 'customer.subscription.updated', data: { object: {} } },
      },
      {
        id: 'evt_2',
        type: 'invoice.payment_succeeded',
        payloadJson: { id: 'evt_2', type: 'invoice.payment_succeeded', data: { object: {} } },
      },
    ]);

    const result = await sweepFailedStripeWebhooks();

    expect(result.counts?.succeeded).toBe(2);
    expect(result.counts?.stillFailing).toBe(0);
    expect(billingMethods.syncStripeSubscription).toHaveBeenCalledTimes(1);
    expect(billingMethods.handleStripeInvoicePaid).toHaveBeenCalledTimes(1);
    expect(stripeUpdate).toHaveBeenCalledTimes(2);
    expect(stripeUpdate.mock.calls[0]![0]).toMatchObject({
      data: expect.objectContaining({ error: null, processedAt: expect.any(Date) }),
    });
  });

  it('records the still-failing error message and bumps stillFailing count', async () => {
    stripeFindMany.mockResolvedValue([
      {
        id: 'evt_1',
        type: 'customer.subscription.updated',
        payloadJson: { id: 'evt_1', type: 'customer.subscription.updated', data: { object: {} } },
      },
    ]);
    billingMethods.syncStripeSubscription.mockRejectedValueOnce(new Error('db lost'));

    const result = await sweepFailedStripeWebhooks();

    expect(result.counts?.succeeded).toBe(0);
    expect(result.counts?.stillFailing).toBe(1);
    expect(stripeUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ error: 'db lost' }),
      }),
    );
  });

  it('skips unknown event types cleanly (no billing call, but still marked processed)', async () => {
    stripeFindMany.mockResolvedValue([
      {
        id: 'evt_x',
        type: 'customer.created',
        payloadJson: { id: 'evt_x', type: 'customer.created', data: { object: {} } },
      },
    ]);

    const result = await sweepFailedStripeWebhooks();

    expect(result.counts?.succeeded).toBe(1);
    expect(billingMethods.syncStripeSubscription).not.toHaveBeenCalled();
  });

  it('bounds the work to 50 rows per tick (matches `take: 50`)', async () => {
    stripeFindMany.mockResolvedValue([]);
    await sweepFailedStripeWebhooks();
    expect(stripeFindMany).toHaveBeenCalledWith(expect.objectContaining({ take: 50 }));
  });
});
