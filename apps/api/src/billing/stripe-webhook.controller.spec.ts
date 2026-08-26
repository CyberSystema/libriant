import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the DB. The controller does NOT upsert: it CREATEs and lets the unique
// violation tell it this delivery is a replay, then reads processedAt to learn
// whether the earlier delivery finished. That distinction is the whole durable
// replay guard, so the mock has to model it rather than flatten it.
const { stripeCreate, stripeFindUnique, stripeUpdate } = vi.hoisted(() => ({
  stripeCreate: vi.fn().mockResolvedValue({}),
  stripeFindUnique: vi.fn().mockResolvedValue(null),
  stripeUpdate: vi.fn().mockResolvedValue({}),
}));
vi.mock('@libriant/db-control', () => ({
  controlDb: {
    stripeWebhookEvent: {
      create: stripeCreate,
      findUnique: stripeFindUnique,
      update: stripeUpdate,
    },
  },
}));

/** What Prisma throws when the event id is already in the table. */
function uniqueViolation() {
  return Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
}

import { StripeWebhookController } from './stripe-webhook.controller.js';
import type { StripeDriver, StripeWebhookEvent } from './stripe-driver.js';
import type { BillingService } from './billing.service.js';

/**
 * Minimal Redis-shaped collaborator. Tests poke at the call args + return
 * values so we can assert exactly what the dedupe contract does.
 */
function makeRedis() {
  // Every one of these is awaited (and .catch()ed) by the controller, so they
  // must return promises — a bare vi.fn() yields undefined and the controller
  // dies on `.catch` of undefined, which looks like a product bug and is not.
  const set = vi.fn().mockResolvedValue('OK');
  const del = vi.fn().mockResolvedValue(1);
  const get = vi.fn().mockResolvedValue(null);
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
    handleCheckoutSessionCompleted: vi.fn().mockResolvedValue(undefined),
  } as unknown as BillingService;
}

/**
 * Stripe stamps every envelope with `created` (epoch seconds). It is present
 * here on purpose: billing-06's whole fix is that the controller must hand
 * that value to `syncStripeSubscription`, and a fixture without the field
 * cannot tell a wired dispatch from an unwired one.
 */
const SAMPLE_EVENT_CREATED = 1_787_000_000;

const sampleEvent: StripeWebhookEvent = {
  id: 'evt_test_1',
  type: 'customer.subscription.updated',
  created: SAMPLE_EVENT_CREATED,
  data: { object: { id: 'sub_1' } as never },
} as StripeWebhookEvent;

describe('StripeWebhookController.handle', () => {
  beforeEach(() => {
    stripeCreate.mockReset().mockResolvedValue({});
    stripeFindUnique.mockReset().mockResolvedValue(null);
    stripeUpdate.mockReset().mockResolvedValue({});
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
    // billing-06 WIRING. The stale-replay guard orders events by the
    // ENVELOPE's `created`, because a mid-cycle plan change leaves
    // `current_period_start` untouched and the old guard compared exactly
    // that. The guard is only worth anything if this dispatch actually hands
    // the timestamp over, so assert the second argument, not just the call.
    expect(billing.syncStripeSubscription).toHaveBeenCalledWith(
      { id: 'sub_1' },
      { id: 'evt_test_1', createdAt: new Date(SAMPLE_EVENT_CREATED * 1000) },
    );
    expect(stripeCreate).toHaveBeenCalledTimes(1);
    // processedAt + clear error
    expect(stripeUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'evt_test_1' },
        data: expect.objectContaining({ error: null, processedAt: expect.any(Date) }),
      }),
    );
  });

  /**
   * billing-03, round 2. `checkout.session.completed` is the earliest proof
   * that a subscription exists, and its handler is what writes
   * `stripeSubscriptionId` durably before the marker is dropped. That is worth
   * nothing if the ROUTE does not reach the handler, so drive the HTTP entry
   * point and assert the payload arrives intact — this is the wiring, not the
   * mechanism.
   */
  it('routes checkout.session.completed to the duplicate-purchase handler', async () => {
    const redis = makeRedis();
    redis.set.mockResolvedValue('OK');
    const billing = makeBilling();
    const session = {
      id: 'cs_live_1',
      customer: 'cus_1',
      subscription: 'sub_A',
      client_reference_id: 'tenant-1',
    };
    const c = new StripeWebhookController(
      makeStripeDriver({
        id: 'evt_cs_1',
        type: 'checkout.session.completed',
        data: { object: session as never },
      } as StripeWebhookEvent),
      billing,
      redis.service,
    );

    const out = await c.handle({ rawBody: Buffer.from('{}') } as never, 'sig');

    expect(out).toEqual({ received: true });
    expect(billing.handleCheckoutSessionCompleted).toHaveBeenCalledWith(session);
    // And the delivery is recorded as processed, so the retry sweep leaves it be.
    expect(stripeUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'evt_cs_1' },
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
    // The durable row is written BEFORE the Redis lock is taken, so it exists
    // even for a delivery that loses the race — which is what lets the retry
    // sweep find an event that crashed mid-dispatch.
    expect(stripeCreate).toHaveBeenCalledTimes(1);
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

  it('treats a completed earlier delivery as a replay, without Redis and without dispatching', async () => {
    const redis = makeRedis();
    stripeCreate.mockRejectedValue(uniqueViolation());
    stripeFindUnique.mockResolvedValue({ processedAt: new Date('2026-08-01T00:00:00Z') });
    const billing = makeBilling();
    const c = new StripeWebhookController(makeStripeDriver(sampleEvent), billing, redis.service);

    const out = await c.handle({ rawBody: Buffer.from('{}') } as never, 'sig');

    expect(out).toEqual({ received: true, deduped: true });
    expect(billing.syncStripeSubscription).not.toHaveBeenCalled();
    // The durable row answered on its own. Redis is never consulted, which is
    // the property that makes the replay guard survive a Redis outage.
    expect(redis.set).not.toHaveBeenCalled();
  });

  it('re-dispatches an event whose earlier delivery never finished (processedAt null)', async () => {
    const redis = makeRedis();
    stripeCreate.mockRejectedValue(uniqueViolation());
    stripeFindUnique.mockResolvedValue({ processedAt: null });
    const billing = makeBilling();
    const c = new StripeWebhookController(makeStripeDriver(sampleEvent), billing, redis.service);

    const out = await c.handle({ rawBody: Buffer.from('{}') } as never, 'sig');

    // A row is not a completion. An event that crashed mid-dispatch MUST be
    // retried, or the subscription state stays wrong forever.
    expect(out).toEqual({ received: true });
    expect(billing.syncStripeSubscription).toHaveBeenCalledTimes(1);
  });

  it('still processes the event when Redis is unreachable but the durable row was written', async () => {
    const redis = makeRedis();
    redis.set.mockRejectedValue(new Error('Stream is not writeable'));
    const billing = makeBilling();
    const c = new StripeWebhookController(makeStripeDriver(sampleEvent), billing, redis.service);

    const out = await c.handle({ rawBody: Buffer.from('{}') } as never, 'sig');

    // Losing Redis costs only protection against two SIMULTANEOUS deliveries
    // of an event that never completed. It must not turn every webhook into a
    // 500 — Stripe would retry the lot and the outage would compound.
    expect(out).toEqual({ received: true });
    expect(billing.syncStripeSubscription).toHaveBeenCalledTimes(1);
  });

  it('refuses with 503 when NEITHER store is reachable, so Stripe redelivers', async () => {
    const redis = makeRedis();
    redis.set.mockRejectedValue(new Error('Stream is not writeable'));
    stripeCreate.mockRejectedValue(new Error('could not connect to server'));
    const billing = makeBilling();
    const c = new StripeWebhookController(makeStripeDriver(sampleEvent), billing, redis.service);

    // With no replay guard at all we cannot tell a first delivery from the
    // fifth retry of one already applied, and could not record the outcome
    // either. Refusing is the only honest answer; Stripe redelivers for days.
    await expect(c.handle({ rawBody: Buffer.from('{}') } as never, 'sig')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(billing.syncStripeSubscription).not.toHaveBeenCalled();
  });

  /**
   * billing-08. The event that could be lost forever.
   *
   * The refusal above used to require BOTH stores to be down. With Postgres
   * down and Redis healthy the handler warned, took the Redis lock, dispatched
   * against the same dead Postgres, failed to write the error row, and
   * returned 200 — which Stripe treats as final. The retry sweep selects only
   * FROM stripe_webhook_events, so the row that was never inserted was
   * invisible to it forever. A cancellation, a payment failure or a paid
   * upgrade simply vanished, with no error row and no alert.
   *
   * These four tests exist to make the invariant unfakeable: NO 200 WITHOUT A
   * DURABLE ROW.
   */
  describe('a 200 means the event is durably ours', () => {
    it('refuses with 503 when the durable insert fails, even though Redis is fine', async () => {
      const redis = makeRedis();
      redis.set.mockResolvedValue('OK'); // Redis perfectly healthy.
      stripeCreate.mockRejectedValue(new Error('could not connect to server'));
      const billing = makeBilling();
      const c = new StripeWebhookController(makeStripeDriver(sampleEvent), billing, redis.service);

      await expect(c.handle({ rawBody: Buffer.from('{}') } as never, 'sig')).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
    });

    it('does not dispatch, and does not take the lock, when it cannot take custody', async () => {
      const redis = makeRedis();
      redis.set.mockResolvedValue('OK');
      stripeCreate.mockRejectedValue(new Error('could not connect to server'));
      const billing = makeBilling();
      const c = new StripeWebhookController(makeStripeDriver(sampleEvent), billing, redis.service);

      await expect(c.handle({ rawBody: Buffer.from('{}') } as never, 'sig')).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      // Dispatching a half-applied change we cannot record is how state
      // diverges silently — refuse before touching billing at all.
      expect(billing.syncStripeSubscription).not.toHaveBeenCalled();
      // And no 30-day lock left behind to block the redelivery we just asked for.
      expect(redis.set).not.toHaveBeenCalled();
    });

    it('refuses when the row exists but its processedAt cannot be read', async () => {
      const redis = makeRedis();
      redis.set.mockResolvedValue('OK');
      stripeCreate.mockRejectedValue(uniqueViolation());
      stripeFindUnique.mockRejectedValue(new Error('connection terminated'));
      const billing = makeBilling();
      const c = new StripeWebhookController(makeStripeDriver(sampleEvent), billing, redis.service);

      // A row we cannot read is not a replay guard. Re-dispatching might
      // re-apply something already applied; skipping might drop something
      // never applied. Asking Stripe to come back is the only safe answer.
      await expect(c.handle({ rawBody: Buffer.from('{}') } as never, 'sig')).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      expect(billing.syncStripeSubscription).not.toHaveBeenCalled();
    });

    it('still returns 200 when dispatch fails AFTER the row is on disk', async () => {
      const redis = makeRedis();
      redis.set.mockResolvedValue('OK');
      const billing = makeBilling();
      (billing.syncStripeSubscription as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('billing exploded'),
      );
      // Even the error-row write fails — the sweep's stale-window clause
      // (receivedAt older than 5 min) still finds a row with error IS NULL, so
      // the event is not lost and a redelivery is not needed.
      stripeUpdate.mockRejectedValue(new Error('connection terminated'));
      const c = new StripeWebhookController(makeStripeDriver(sampleEvent), billing, redis.service);

      await expect(c.handle({ rawBody: Buffer.from('{}') } as never, 'sig')).resolves.toEqual({
        received: true,
      });
      expect(stripeCreate).toHaveBeenCalledTimes(1);
    });
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
