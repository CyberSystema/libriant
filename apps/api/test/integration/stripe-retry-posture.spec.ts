import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { controlDb } from '@libriant/db-control';
import {
  startScheduledJobs,
  type ScheduledJobsHandle,
} from '../../src/jobs/scheduled-jobs.runner.js';
import { SCHEDULED_JOBS } from '../../src/jobs/registry.js';
import type { JobContext } from '../../src/jobs/jobs.types.js';
import { declareBillingPosture } from './billing-posture.js';

declareBillingPosture(
  'unenforced',
  'reliability-16 is about what the stripe-webhook-retry cron does on the SHIPPED host, where ' +
    'subscriptions are off. Turning enforcement on would test a configuration no customer runs.',
);

/**
 * reliability-16, driven through the REGISTERED job rather than the exported
 * function — `SCHEDULED_JOBS` is what the worker actually runs, and the last
 * two rounds of this finding were both "the mechanism is fixed, the shipped
 * configuration still fails".
 *
 * The finding is a conjunction and both halves are asserted here:
 *   1. With `STRIPE_DRIVER=none` (the shipped default) the job must NOT fail —
 *      it used to build a RealStripeDriver with no API key and throw, 288
 *      times a day, on a server that is working exactly as intended.
 *   2. With Stripe configured it must still actually RETRY — a job that is
 *      quiet because it does nothing is the same blindness from the other end.
 */
const QUEUE_NAME = 'scheduled';
const QUEUE_PREFIX = 'lbr-bull';
const RETRY_JOB = 'stripe-webhook-retry';

const ctx = { emails: { enqueue: async () => undefined } } as unknown as JobContext;
let handle: ScheduledJobsHandle | undefined;
let tenantId: string;
let restoreSubscriptionId: string | null = null;
const savedDriver = process.env.STRIPE_DRIVER;

/** Run the registry's own entry, only speeding up its 5-minute interval. */
async function runRegisteredSweep(): Promise<{ ok: boolean; message: string }> {
  const registered = SCHEDULED_JOBS.find((j) => j.name === RETRY_JOB);
  if (!registered) throw new Error(`${RETRY_JOB} is not in SCHEDULED_JOBS`);
  handle = await startScheduledJobs([{ ...registered, intervalMs: 300 }], ctx);
  const deadline = Date.now() + 30_000;
  for (;;) {
    const result = handle.lastResults()[RETRY_JOB];
    if (result) return result;
    if (Date.now() > deadline) throw new Error(`${RETRY_JOB} never reported a result`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function clearSchedulers(): Promise<void> {
  const conn = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: null });
  const q = new Queue(QUEUE_NAME, { connection: conn, prefix: QUEUE_PREFIX });
  try {
    for (const s of await q.getJobSchedulers()) await q.removeJobScheduler(s.key);
  } finally {
    await q.close();
    await conn.quit();
  }
}

beforeAll(async () => {
  const tenant = await controlDb.tenant.findFirstOrThrow({ orderBy: { createdAt: 'asc' } });
  tenantId = tenant.id;
  const sub = await controlDb.subscription.findUniqueOrThrow({ where: { tenantId } });
  restoreSubscriptionId = sub.stripeSubscriptionId;
  await controlDb.billingAccount.upsert({
    where: { tenantId },
    update: { stripeCustomerId: 'cus_rel16_it' },
    create: {
      tenantId,
      stripeCustomerId: 'cus_rel16_it',
      billingEmail: `rel16@${tenant.slug}.test`,
      billingName: tenant.name,
    },
  });
});

afterEach(async () => {
  await handle?.stop();
  handle = undefined;
  await clearSchedulers();
  await controlDb.stripeWebhookEvent.deleteMany({ where: { id: { startsWith: 'evt_rel16_it' } } });
  await controlDb.subscription.update({
    where: { tenantId },
    data: { stripeSubscriptionId: null },
  });
});

afterAll(async () => {
  if (savedDriver === undefined) delete process.env.STRIPE_DRIVER;
  else process.env.STRIPE_DRIVER = savedDriver;
  await controlDb.subscription.update({
    where: { tenantId },
    data: { stripeSubscriptionId: restoreSubscriptionId },
  });
});

/** A delivery that failed once, so the sweep picks it up on its first tick. */
async function seedFailedEvent(id: string): Promise<void> {
  await controlDb.stripeWebhookEvent.create({
    data: {
      id,
      type: 'checkout.session.completed',
      error: 'previous failure',
      payloadJson: {
        id,
        type: 'checkout.session.completed',
        data: {
          object: {
            id: 'cs_rel16_it',
            customer: 'cus_rel16_it',
            subscription: 'sub_rel16_it',
            client_reference_id: tenantId,
          },
        },
      },
    },
  });
}

describe('the stripe-webhook-retry cron in the configuration that ships', () => {
  it('does not fail every five minutes when billing is switched off', async () => {
    process.env.STRIPE_DRIVER = 'none';
    await seedFailedEvent('evt_rel16_it_off');

    const result = await runRegisteredSweep();

    expect(result.ok).toBe(true);
    expect(result.message).toContain('billing is switched off');
    // The row is HELD, not silently dropped: the webhook endpoint refuses
    // every delivery in this posture, so replaying stored payloads would make
    // this sweep the only writer of subscription rows on a host that switched
    // that path off. It is counted in the message instead.
    expect(result.message).toContain('event(s)');
    const row = await controlDb.stripeWebhookEvent.findUniqueOrThrow({
      where: { id: 'evt_rel16_it_off' },
    });
    expect(row.processedAt).toBeNull();
  }, 60_000);

  it('still retries, and lands the purchase pointer, when Stripe IS configured', async () => {
    // NODE_ENV is `test` under vitest, so `fake` is a posture this host may
    // have — the same one `pnpm dev` runs. The half that matters is that the
    // sweep gets past driver construction and actually dispatches.
    process.env.STRIPE_DRIVER = 'fake';
    await seedFailedEvent('evt_rel16_it_on');

    const result = await runRegisteredSweep();

    expect(result.ok).toBe(true);
    expect(result.message).toContain('succeeded');
    const row = await controlDb.stripeWebhookEvent.findUniqueOrThrow({
      where: { id: 'evt_rel16_it_on' },
    });
    expect(row.processedAt).not.toBeNull();
    expect(row.error).toBeNull();
    // billing-03 round 2: replaying that event is what puts the subscription
    // id on the row, which is what stops the next click buying a second one.
    const sub = await controlDb.subscription.findUniqueOrThrow({ where: { tenantId } });
    expect(sub.stripeSubscriptionId).toBe('sub_rel16_it');
  }, 60_000);
});
