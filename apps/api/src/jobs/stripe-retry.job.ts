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
import type { JobResult } from './jobs.types.js';

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

export async function sweepFailedStripeWebhooks(): Promise<JobResult> {
  const env = loadEnv();
  // Don't pick up a row that's still within its normal in-flight window — only
  // ones old enough that any live attempt has certainly finished/crashed.
  const staleBefore = new Date(Date.now() - 5 * 60_000);
  const failed = await controlDb.stripeWebhookEvent.findMany({
    where: {
      processedAt: null,
      OR: [{ error: { not: null } }, { receivedAt: { lt: staleBefore } }],
    },
    orderBy: { receivedAt: 'asc' },
    take: 50, // bound the work per tick
    select: { id: true, type: true, payloadJson: true },
  });
  if (failed.length === 0) return { message: 'no failed events to retry', counts: { retried: 0 } };

  // Build the same collaborators the runtime uses. Direct construction
  // (no Nest DI) — these classes don't depend on framework features.
  const redis = new RedisService();
  const settings = new PlatformSettingsService(redis);
  const effective = new EffectivePlanService(redis, settings);
  const driver: StripeDriver =
    env.stripeDriver === 'real' ? new RealStripeDriver() : new FakeStripeDriver();
  // BillingService constructor: (effectivePlan, stripe, settings) — see billing.service.ts.
  const billing = new BillingService(effective, driver, settings);

  let succeeded = 0;
  let stillFailing = 0;

  try {
    for (const row of failed) {
      const event = row.payloadJson as unknown as StripeWebhookEvent;
      try {
        await dispatch(billing, event);
        await controlDb.stripeWebhookEvent.update({
          where: { id: row.id },
          data: { processedAt: new Date(), error: null },
        });
        succeeded++;
      } catch (err) {
        stillFailing++;
        await controlDb.stripeWebhookEvent.update({
          where: { id: row.id },
          data: { error: (err as Error).message.slice(0, 1000) },
        });
        logger.warn(`retry of ${row.type} (${row.id}) still failing: ${(err as Error).message}`);
      }
    }
  } finally {
    // Tear down the side-channel Redis the EffectivePlanService kept open.
    await redis.onModuleDestroy().catch(() => undefined);
  }

  return {
    message: `retried ${failed.length}: ${succeeded} succeeded, ${stillFailing} still failing`,
    counts: { considered: failed.length, succeeded, stillFailing },
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
