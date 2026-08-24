import { controlDb } from '@libriant/db-control';
import { Logger } from '@nestjs/common';
import { BillingService } from '../billing/billing.service.js';
import { EffectivePlanService } from '../plans/effective-plan.service.js';
import { PlatformSettingsService } from '../platform-settings/platform-settings.service.js';
import { FakeStripeDriver } from '../billing/stripe-fake.driver.js';
import { RealStripeDriver } from '../billing/stripe-real.driver.js';
import { loadEnv } from '../config/env.js';
import { RedisService } from '../platform/redis.service.js';
import type {
  StripeDriver,
  StripeInvoiceShape,
  StripeSubscriptionShape,
  StripeWebhookEvent,
} from '../billing/stripe-driver.js';
import { describeError } from './job-error.js';
import type { JobContext, JobResult } from './jobs.types.js';

/**
 * 16 deferred — "Stripe webhook retry sweep".
 *
 * Reads every `stripe_webhook_events` row that hasn't been processed and
 * either errored OR was received long enough ago that an in-flight attempt
 * should have finished (covers a process crash between the Redis lock and the
 * end of dispatch — the row exists with `processedAt IS NULL, error IS NULL`
 * but nothing will ever retry it otherwise). Re-runs the same dispatch the
 * controller does. Rows are bounded: the table is cleaned at 30 days.
 *
 * Why a periodic sweep and not BullMQ retries on the controller path:
 * Stripe's own delivery retries us at increasing intervals up to 3 days;
 * BullMQ retries on the same edge would be double-counting. The sweep
 * handles the case where Stripe's first delivery hit a transient DB
 * blip — we re-process locally without waiting for the next Stripe retry.
 */
const logger = new Logger('StripeRetrySweeper');

// A SHORT-TTL, sweep-OWNED lock (STRIPE-RETRY-NO-LOCK / BILL-3 / REM-5). It must
// NOT reuse the controller's `stripe:event:<id>` dedup key: that key lives for
// 30 days, so a controller that CRASHED mid-dispatch leaves it held with the
// row still `processedAt = null` — and rescuing exactly that row is this
// sweep's whole reason to exist. Contending for it would make the sweep skip
// the crash case for 30 days. Instead we take a private claim that only
// serializes concurrent sweep ticks (overlapping crons); double-processing vs a
// simultaneous live redelivery is harmless because every handler is idempotent.
const SWEEP_LOCK = (id: string) => `stripe:retry-sweep:${id}`;
const SWEEP_LOCK_TTL_SECONDS = 300; // bounds a wedged sweep; ~the stale window.

/**
 * How long a row stays in the retry set before the sweep gives up on it.
 *
 * A row that cannot be processed at all — a payload shape the handler chokes
 * on, a tenant that no longer exists — used to be re-dispatched every five
 * minutes for the 30 days it lives in the table, failing every time. With
 * `stillFailing` wired into the runner's ok decision that single row pinned
 * stripe-webhook-retry at `ok:false` forever, and an alert that never goes
 * green gets muted, which costs us the signal for the failures that DO matter.
 *
 * 24 h is chosen against Stripe's own envelope: Stripe retries a failed
 * delivery for about 3 days, so anything still unprocessed a full day after we
 * received it has survived ~288 of our attempts plus several of theirs, and
 * attempt 289 is not the one that works. The row is only DROPPED FROM THE
 * RETRY SET, never deleted or marked processed: it is counted as `abandoned`,
 * which the runner prints in the health message as a backlog. Re-arming one
 * after an outage that genuinely lasted longer than this is a single
 * `UPDATE stripe_webhook_events SET "receivedAt" = NOW() WHERE id = …`.
 */
const GIVE_UP_AFTER_MS = 24 * 60 * 60_000;

export async function sweepFailedStripeWebhooks(ctx?: JobContext): Promise<JobResult> {
  const env = loadEnv();
  // Don't pick up a row that's still within its normal in-flight window — only
  // ones old enough that any live attempt has certainly finished/crashed.
  const staleBefore = new Date(Date.now() - 5 * 60_000);
  const giveUpBefore = new Date(Date.now() - GIVE_UP_AFTER_MS);
  const failed = await controlDb.stripeWebhookEvent.findMany({
    where: {
      processedAt: null,
      // Past the give-up budget the row leaves the retry set — see
      // GIVE_UP_AFTER_MS. Without this bound one poison row made every run red.
      receivedAt: { gte: giveUpBefore },
      OR: [{ error: { not: null } }, { receivedAt: { lt: staleBefore } }],
    },
    orderBy: { receivedAt: 'asc' },
    take: 50, // bound the work per tick
    select: { id: true, type: true, payloadJson: true },
  });
  // Counted on every tick, including clean ones: dropping a row from the retry
  // set must not also drop it from the operator's view. This is the number a
  // human has to look at and decide about; it deliberately does NOT make the
  // run not-ok (see BACKLOG_KEYS in scheduled-jobs.runner.ts). Cost: one COUNT
  // every 5 min over a table that is pruned at 30 days and has no index on
  // `processedAt` — negligible at our volumes, and if it ever isn't, the fix is
  // a partial index on (processedAt) WHERE processedAt IS NULL, not silence.
  const abandoned = await controlDb.stripeWebhookEvent.count({
    where: { processedAt: null, receivedAt: { lt: giveUpBefore } },
  });
  if (failed.length === 0) {
    return { message: 'no failed events to retry', counts: { retried: 0, abandoned } };
  }

  // jobs-new: open Redis FIRST and keep every other collaborator construction
  // inside the try below, so the `finally` teardown always covers the
  // connection — an exception from a downstream constructor can no longer
  // leak the ioredis client.
  const redis = ctx?.redis ?? new RedisService();
  /** Non-null only when this call created the client and therefore owns it. */
  const ownedRedis = ctx?.redis ? null : redis;

  let succeeded = 0;
  /**
   * Rows inside the retry budget that this run tried and could not process.
   * Named with the `…Failed` suffix on purpose: that is what makes the runner
   * mark the run not-ok (jobs.types.ts). It used to be called `stillFailing`,
   * which conflated "broken right now" with "known-stuck pile" and latched the
   * job permanently red.
   */
  let retryFailed = 0;
  let skipped = 0;

  try {
    // reliability-16: the first thing the loop does is SET the sweep lock. On a
    // client we just constructed that command rejects outright — the socket is
    // still `connecting` and `enableOfflineQueue: false` refuses to buffer — so
    // the whole sweep aborted having retried nothing, every time there was
    // actually something to retry. Invisible on a healthy system because of the
    // early return above.
    await redis.ready();
    // Build the same collaborators the runtime uses. Direct construction
    // (no Nest DI) — these classes don't depend on framework features.
    const settings = new PlatformSettingsService(redis);
    const effective = new EffectivePlanService(redis, settings);
    const driver: StripeDriver =
      env.stripeDriver === 'real' ? new RealStripeDriver() : new FakeStripeDriver();
    // BillingService constructor: (effectivePlan, stripe, settings) — see billing.service.ts.
    const billing = new BillingService(effective, driver, settings);

    for (const row of failed) {
      const event = row.payloadJson as unknown as StripeWebhookEvent;
      // Serialize concurrent sweep ticks on the same event (overlapping crons).
      // SETNX on the sweep-private key — if another tick already holds it, skip.
      const lockKey = SWEEP_LOCK(event.id);
      const claimed = await redis.client.set(lockKey, '1', 'EX', SWEEP_LOCK_TTL_SECONDS, 'NX');
      if (claimed !== 'OK') {
        skipped++;
        continue;
      }
      try {
        await dispatch(billing, event);
        await controlDb.stripeWebhookEvent.update({
          where: { id: row.id },
          data: { processedAt: new Date(), error: null },
        });
        succeeded++;
      } catch (err) {
        retryFailed++;
        // Keep the raw message for the admin panel, but never persist an empty
        // one — a Prisma init error can carry exactly that (see describeError).
        const reason = (err as Error)?.message || describeError(err);
        await controlDb.stripeWebhookEvent.update({
          where: { id: row.id },
          data: { error: reason.slice(0, 1000) },
        });
        logger.warn(`retry of ${row.type} (${row.id}) still failing: ${describeError(err)}`);
      } finally {
        // Release our claim so a later Stripe redelivery / sweep can re-attempt
        // (mirrors the controller dropping the lock once it's done with it).
        await redis.client.del(lockKey).catch(() => undefined);
      }
    }
  } finally {
    // Tear down the side-channel Redis the EffectivePlanService kept open —
    // but only if it was ours. A client from the job context is the worker's
    // long-lived one and every other job is still using it.
    await ownedRedis?.onModuleDestroy().catch(() => undefined);
  }

  return {
    message: `retried ${failed.length}: ${succeeded} succeeded, ${retryFailed} still failing, ${skipped} skipped (locked)`,
    counts: { considered: failed.length, succeeded, retryFailed, skipped, abandoned },
  };
}

/** Mirrors `StripeWebhookController.dispatch` — kept in sync via the tests. */
async function dispatch(billing: BillingService, event: StripeWebhookEvent): Promise<void> {
  const obj = event.data.object as Record<string, unknown>;
  switch (event.type) {
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
      await billing.syncStripeSubscription(obj as unknown as StripeSubscriptionShape);
      return;
    case 'customer.subscription.deleted':
      await billing.handleStripeSubscriptionDeleted(obj as unknown as StripeSubscriptionShape);
      return;
    case 'invoice.payment_succeeded':
      await billing.handleStripeInvoicePaid(obj as unknown as StripeInvoiceShape);
      return;
    case 'invoice.payment_failed':
      await billing.handleStripeInvoiceFailed(obj as unknown as StripeInvoiceShape);
      return;
    default:
      // Unknown type — clear the error so it doesn't loop forever.
      return;
  }
}
