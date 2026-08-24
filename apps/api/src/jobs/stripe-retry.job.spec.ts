import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  stripeFindMany,
  stripeCount,
  stripeUpdate,
  billingMethods,
  redisDestroy,
  redisReady,
  redisSet,
  redisDel,
} = vi.hoisted(() => ({
  stripeFindMany: vi.fn(),
  /** Rows past the give-up budget — the `abandoned` backlog gauge. */
  stripeCount: vi.fn().mockResolvedValue(0),
  stripeUpdate: vi.fn().mockResolvedValue({}),
  billingMethods: {
    syncStripeSubscription: vi.fn().mockResolvedValue(undefined),
    handleStripeSubscriptionDeleted: vi.fn().mockResolvedValue(undefined),
    handleStripeInvoicePaid: vi.fn().mockResolvedValue(undefined),
    handleStripeInvoiceFailed: vi.fn().mockResolvedValue(undefined),
    handleCheckoutSessionCompleted: vi.fn().mockResolvedValue(undefined),
  },
  redisDestroy: vi.fn().mockResolvedValue(undefined),
  redisReady: vi.fn().mockResolvedValue(undefined),
  redisSet: vi.fn().mockResolvedValue('OK'),
  redisDel: vi.fn().mockResolvedValue(1),
}));

vi.mock('@libriant/db-control', () => ({
  controlDb: {
    stripeWebhookEvent: {
      findMany: stripeFindMany,
      count: stripeCount,
      update: stripeUpdate,
    },
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
vi.mock('../platform/redis.service.js', async (importOriginal) => ({
  // Partial mock: only RedisService is stubbed. FailOpenMemo is real and is
  // imported by other services this spec pulls in transitively — replacing the
  // whole module made them fail with "No FailOpenMemo export is defined".
  ...(await importOriginal<typeof import('../platform/redis.service.js')>()),
  RedisService: vi.fn(function () {
    // The sweep claims its OWN sweep-private `stripe:retry-sweep:<id>` lock
    // (short TTL) before dispatch — deliberately NOT the controller's 30-day
    // `stripe:event:<id>` dedup key, so it can rescue crash-recovery rows the
    // controller already locked. set→'OK' = lock acquired, so each row is
    // processed and the existing succeeded/retryFailed assertions hold.
    return {
      client: { set: redisSet, del: redisDel },
      ready: redisReady,
      onModuleDestroy: redisDestroy,
    };
  }),
}));

import { sweepFailedStripeWebhooks } from './stripe-retry.job.js';
import { RedisService } from '../platform/redis.service.js';
import { FakeStripeDriver } from '../billing/stripe-fake.driver.js';
import { RealStripeDriver } from '../billing/stripe-real.driver.js';
import { toScheduledJobResult } from './scheduled-jobs.runner.js';
import type { JobContext } from './jobs.types.js';

/**
 * The sweep now resolves its Stripe POSTURE from the raw environment, via the
 * same factory the app boots with (reliability-16). So every test has to say
 * which posture it is in — reading whatever the developer happens to export is
 * how this job ended up throwing on the shipped configuration in the first
 * place.
 */
const ENV_KEYS = ['STRIPE_DRIVER', 'STRIPE_API_KEY', 'STRIPE_WEBHOOK_SECRET', 'NODE_ENV'] as const;
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

const SUB_UPDATED = {
  id: 'evt_1',
  type: 'customer.subscription.updated',
  payloadJson: { id: 'evt_1', type: 'customer.subscription.updated', data: { object: {} } },
};

describe('sweepFailedStripeWebhooks', () => {
  beforeEach(() => {
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
    // `fake` + NODE_ENV=test is the posture the unit suite runs the sweep in.
    process.env.STRIPE_DRIVER = 'fake';
    stripeFindMany.mockReset();
    stripeCount.mockReset().mockResolvedValue(0);
    stripeUpdate.mockClear();
    vi.mocked(RedisService).mockClear();
    vi.mocked(RealStripeDriver).mockClear();
    vi.mocked(FakeStripeDriver).mockClear();
    redisReady.mockReset().mockResolvedValue(undefined);
    redisSet.mockReset().mockResolvedValue('OK');
    redisDel.mockReset().mockResolvedValue(1);
    for (const fn of Object.values(billingMethods)) fn.mockClear();
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  it('does not claim the sweep lock before the socket is ready', async () => {
    // reliability-16: same cold-client defect as member-notifications, but the
    // throw is not caught per row — the whole sweep aborted having retried
    // nothing, and only ever when there was actually something to retry.
    let socketReady = false;
    redisReady.mockImplementation(async () => {
      socketReady = true;
    });
    redisSet.mockImplementation(async () => {
      if (!socketReady) {
        throw new Error("Stream isn't writeable and enableOfflineQueue options is false");
      }
      return 'OK';
    });
    stripeFindMany.mockResolvedValue([SUB_UPDATED]);

    const result = await sweepFailedStripeWebhooks();

    expect(redisReady).toHaveBeenCalled();
    expect(result.counts?.succeeded).toBe(1);
  });

  it("borrows the runner's long-lived client and does not close it", async () => {
    stripeFindMany.mockResolvedValue([SUB_UPDATED]);
    const shared = {
      redis: {
        client: { set: redisSet, del: redisDel },
        ready: vi.fn().mockResolvedValue(undefined),
        onModuleDestroy: vi.fn(),
      },
    };

    await sweepFailedStripeWebhooks(shared as unknown as JobContext);

    expect(shared.redis.ready).toHaveBeenCalled();
    expect(shared.redis.onModuleDestroy).not.toHaveBeenCalled();
    expect(vi.mocked(RedisService)).not.toHaveBeenCalled();
  });

  it('returns a no-op summary when nothing has failed', async () => {
    stripeFindMany.mockResolvedValue([]);

    const result = await sweepFailedStripeWebhooks();

    expect(result).toEqual({
      message: 'no failed events to retry',
      counts: { retried: 0, abandoned: 0 },
    });
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
    expect(result.counts?.retryFailed).toBe(0);
    expect(billingMethods.syncStripeSubscription).toHaveBeenCalledTimes(1);
    expect(billingMethods.handleStripeInvoicePaid).toHaveBeenCalledTimes(1);
    expect(stripeUpdate).toHaveBeenCalledTimes(2);
    expect(stripeUpdate.mock.calls[0]![0]).toMatchObject({
      data: expect.objectContaining({ error: null, processedAt: expect.any(Date) }),
    });
  });

  it('records the still-failing error message and bumps retryFailed count', async () => {
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
    expect(result.counts?.retryFailed).toBe(1);
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

  it('drops rows past the give-up budget out of the retry set', async () => {
    // A row that cannot be processed at all was re-dispatched every 5 minutes
    // for 30 days, failing each time — which pinned the job at ok:false
    // forever once `stillFailing` counted as a failure. The retry set is now
    // age-bounded so the poison row stops being retried.
    stripeFindMany.mockResolvedValue([]);

    await sweepFailedStripeWebhooks();

    const where = stripeFindMany.mock.calls[0]![0].where;
    expect(where.receivedAt.gte).toBeInstanceOf(Date);
    // ~24h ago, give or take the millisecond the test took.
    expect(Date.now() - where.receivedAt.gte.getTime()).toBeGreaterThan(23 * 60 * 60_000);
  });

  it('still reports the abandoned pile, it just does not call the run broken', async () => {
    // Dropping a row from the retry set must not drop it from the operator's
    // view: `abandoned` is a backlog key (see scheduled-jobs.runner.ts), so it
    // prints in the health message without flipping `ok`.
    stripeFindMany.mockResolvedValue([]);
    stripeCount.mockResolvedValue(3);

    const result = await sweepFailedStripeWebhooks();

    expect(result.counts?.abandoned).toBe(3);
    expect(stripeCount).toHaveBeenCalledWith({
      where: { processedAt: null, receivedAt: { lt: expect.any(Date) } },
    });
  });

  /**
   * reliability-16, third cause. The Redis defect was fixed and the job STILL
   * failed on its first event every five minutes in the configuration that
   * ships — because it picked its driver by hand
   * (`env.stripeDriver === 'real' ? Real : Fake`), and `config/env.ts` reports
   * the shipped `STRIPE_DRIVER=none` as `'real'` outside development. Every
   * tick built a RealStripeDriver with no API key and threw before touching a
   * single row.
   */
  describe('the shipped posture: STRIPE_DRIVER=none', () => {
    it('says so, quietly and explicitly, instead of failing 288 times a day', async () => {
      process.env.STRIPE_DRIVER = 'none';
      process.env.NODE_ENV = 'production';
      stripeCount.mockResolvedValue(4);

      const result = await sweepFailedStripeWebhooks();

      expect(result.message).toContain('billing is switched off (STRIPE_DRIVER=none)');
      expect(result.counts).toEqual({ retried: 0, held: 4 });
      // No driver is built at all — that construction was the failure.
      expect(vi.mocked(RealStripeDriver)).not.toHaveBeenCalled();
      expect(vi.mocked(FakeStripeDriver)).not.toHaveBeenCalled();
      // And no work is claimed: the webhook route answers 503 before reading a
      // body in this posture, so nothing can enter the retry set.
      expect(stripeFindMany).not.toHaveBeenCalled();
    });

    it('reports the held pile without calling the run broken', async () => {
      process.env.STRIPE_DRIVER = 'none';
      stripeCount.mockResolvedValue(4);

      // The health surface is the point: this is what /healthz and the alert
      // rules read, and a red row every 5 minutes is a row nobody reads.
      const health = toScheduledJobResult(await sweepFailedStripeWebhooks());

      expect(health.ok).toBe(true);
      expect(health.message).not.toContain('FAILED');
      expect(health.message).toContain('4 event(s)');
    });

    it('treats a legacy STRIPE_DRIVER=fake on a deployed host the same way', async () => {
      // Every host provisioned before billing-02 still carries `fake`, which
      // the posture resolver downgrades to `disabled`. The old ternary would
      // have constructed the fake driver, which refuses to exist off a dev box.
      process.env.STRIPE_DRIVER = 'fake';
      process.env.NODE_ENV = 'production';
      stripeCount.mockResolvedValue(0);

      const result = await sweepFailedStripeWebhooks();

      expect(result.message).toContain('billing is switched off (STRIPE_DRIVER=fake)');
      expect(vi.mocked(FakeStripeDriver)).not.toHaveBeenCalled();
      expect(vi.mocked(RealStripeDriver)).not.toHaveBeenCalled();
    });
  });

  it('builds its driver through the posture factory when Stripe IS configured', async () => {
    process.env.STRIPE_DRIVER = 'real';
    process.env.STRIPE_API_KEY = 'sk_test_unit';
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_unit';
    stripeFindMany.mockResolvedValue([SUB_UPDATED]);

    const result = await sweepFailedStripeWebhooks();

    expect(vi.mocked(RealStripeDriver)).toHaveBeenCalledTimes(1);
    expect(result.counts?.succeeded).toBe(1);
  });

  it('replays checkout.session.completed — the row the purchase guard depends on', async () => {
    // It used to fall through to `default`, which marks the row processed
    // without doing anything. That handler is the one that writes
    // `stripeSubscriptionId` the moment a purchase lands (billing-03 round 2),
    // so silently dropping it left the duplicate-purchase window open.
    const session = {
      id: 'cs_1',
      customer: 'cus_1',
      subscription: 'sub_A',
      client_reference_id: 't1',
    };
    stripeFindMany.mockResolvedValue([
      {
        id: 'evt_cs',
        type: 'checkout.session.completed',
        payloadJson: {
          id: 'evt_cs',
          type: 'checkout.session.completed',
          data: { object: session },
        },
      },
    ]);

    const result = await sweepFailedStripeWebhooks();

    expect(billingMethods.handleCheckoutSessionCompleted).toHaveBeenCalledWith(session);
    expect(result.counts?.succeeded).toBe(1);
  });
});
