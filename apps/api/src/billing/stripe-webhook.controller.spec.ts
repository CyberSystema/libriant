import { BadRequestException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the DB so the controller's persistence calls become no-ops.
const { stripeUpsert, stripeUpdate } = vi.hoisted(() => ({
  stripeUpsert: vi.fn().mockResolvedValue({}),
  stripeUpdate: vi.fn().mockResolvedValue({}),
}));
vi.mock('@libriant/db-control', () => ({
  controlDb: {
    stripeWebhookEvent: { upsert: stripeUpsert, update: stripeUpdate },
  },
}));

import { StripeWebhookController } from './stripe-webhook.controller.js';
import type { StripeDriver, StripeWebhookEvent } from './stripe-driver.js';
import type { BillingService } from './billing.service.js';

/**
 * Minimal Redis-shaped collaborator. Tests poke at the call args + return
 * values so we can assert exactly what the dedupe contract does.
 */
function makeRedis() {
  const set = vi.fn();
  const del = vi.fn();
  const get = vi.fn();
  return {
    service: { client: { set, del, get } } as never,
    set,
    del,
    get,
  };
}

function makeStripeDriver(event: StripeWebhookEvent | Error) {
  return {
    verifyWebhookSignature: vi.fn().mockImplementation(() => {
      if (event instanceof Error) throw event;
      return event;
    }),
  } as unknown as StripeDriver;
}

function makeBilling() {
  return {
    syncStripeSubscription: vi.fn().mockResolvedValue(undefined),
    handleStripeSubscriptionDeleted: vi.fn().mockResolvedValue(undefined),
    handleStripeInvoicePaid: vi.fn().mockResolvedValue(undefined),
    handleStripeInvoiceFailed: vi.fn().mockResolvedValue(undefined),
  } as unknown as BillingService;
}

const sampleEvent: StripeWebhookEvent = {
  id: 'evt_test_1',
  type: 'customer.subscription.updated',
  data: { object: { id: 'sub_1' } as never },
} as StripeWebhookEvent;

describe('StripeWebhookController.handle', () => {
  beforeEach(() => {
    stripeUpsert.mockClear();
    stripeUpdate.mockClear();
  });

  it('rejects 400 when stripe-signature header is missing', async () => {
    const redis = makeRedis();
    const c = new StripeWebhookController(
      makeStripeDriver(sampleEvent),
      makeBilling(),
      redis.service,
    );

    await expect(
      c.handle({ rawBody: Buffer.from('{}') } as never, undefined),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects 400 when the raw body is missing (server misconfigured)', async () => {
    const redis = makeRedis();
    const c = new StripeWebhookController(
      makeStripeDriver(sampleEvent),
      makeBilling(),
      redis.service,
    );

    await expect(c.handle({} as never, 't=1,v1=sig')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects 400 when signature verification fails', async () => {
    const redis = makeRedis();
    const driver = makeStripeDriver(new Error('bad signature'));
    const c = new StripeWebhookController(driver, makeBilling(), redis.service);

    await expect(c.handle({ rawBody: Buffer.from('{}') } as never, 'sig')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('processes a fresh event, calls billing, writes the DB row, returns received:true', async () => {
    const redis = makeRedis();
    redis.set.mockResolvedValue('OK'); // Redis SETNX won
    const billing = makeBilling();
    const c = new StripeWebhookController(makeStripeDriver(sampleEvent), billing, redis.service);

    const out = await c.handle({ rawBody: Buffer.from('{}') } as never, 'sig');

    expect(out).toEqual({ received: true });
    expect(redis.set).toHaveBeenCalledWith(
      'stripe:event:evt_test_1',
      '1',
      'EX',
      expect.any(Number),
      'NX',
    );
    expect(billing.syncStripeSubscription).toHaveBeenCalledTimes(1);
    expect(stripeUpsert).toHaveBeenCalledTimes(1);
    // processedAt + clear error
    expect(stripeUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'evt_test_1' },
        data: expect.objectContaining({ error: null, processedAt: expect.any(Date) }),
      }),
    );
  });

  it('short-circuits with deduped:true when Redis SETNX loses the race', async () => {
    const redis = makeRedis();
    redis.set.mockResolvedValue(null); // SETNX returned null → key already existed
    const billing = makeBilling();
    const c = new StripeWebhookController(makeStripeDriver(sampleEvent), billing, redis.service);

    const out = await c.handle({ rawBody: Buffer.from('{}') } as never, 'sig');

    expect(out).toEqual({ received: true, deduped: true });
    expect(billing.syncStripeSubscription).not.toHaveBeenCalled();
    // The durable row is now persisted BEFORE the Redis dedupe lock (audit
    // billing-3), so the upsert still runs even when this delivery is a dup.
    expect(stripeUpsert).toHaveBeenCalledTimes(1);
  });

  it('drops the Redis lock when dispatch throws so Stripe retries can re-attempt', async () => {
    const redis = makeRedis();
    redis.set.mockResolvedValue('OK');
    const billing = makeBilling();
    (billing.syncStripeSubscription as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('billing exploded'),
    );
    const c = new StripeWebhookController(makeStripeDriver(sampleEvent), billing, redis.service);

    const out = await c.handle({ rawBody: Buffer.from('{}') } as never, 'sig');

    // We still return 200 so Stripe doesn't permanently fail — but the
    // lock is dropped so the retry can fire.
    expect(out).toEqual({ received: true });
    expect(redis.del).toHaveBeenCalledWith('stripe:event:evt_test_1');
    // The DB row gets a snipped error message so a human can replay later.
    expect(stripeUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ error: 'billing exploded' }),
      }),
    );
  });

  it('routes each event type to its billing handler', async () => {
    const cases: Array<{ type: StripeWebhookEvent['type']; method: keyof BillingService }> = [
      { type: 'customer.subscription.created', method: 'syncStripeSubscription' },
      { type: 'customer.subscription.updated', method: 'syncStripeSubscription' },
      {
        type: 'customer.subscription.deleted',
        method: 'handleStripeSubscriptionDeleted',
      },
      { type: 'invoice.payment_succeeded', method: 'handleStripeInvoicePaid' },
      { type: 'invoice.payment_failed', method: 'handleStripeInvoiceFailed' },
    ];
    for (const { type, method } of cases) {
      const redis = makeRedis();
      redis.set.mockResolvedValue('OK');
      const billing = makeBilling();
      const c = new StripeWebhookController(
        makeStripeDriver({ ...sampleEvent, id: `evt_${type}`, type } as never),
        billing,
        redis.service,
      );

      await c.handle({ rawBody: Buffer.from('{}') } as never, 'sig');

      expect(billing[method]).toHaveBeenCalledTimes(1);
    }
  });
});
