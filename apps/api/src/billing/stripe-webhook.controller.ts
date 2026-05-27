import {
  BadRequestException,
  Controller,
  Headers,
  HttpCode,
  Inject,
  Logger,
  Post,
  Req,
} from '@nestjs/common';
import { controlDb } from '@libriant/db-control';
import type { Request } from 'express';
import { BillingService } from './billing.service.js';
import { RedisService } from '../platform/redis.service.js';
import {
  STRIPE_DRIVER,
  type StripeDriver,
  type StripeInvoiceShape,
  type StripeSubscriptionShape,
  type StripeWebhookEvent,
} from './stripe-driver.js';

const EVENT_KEY = (id: string) => `stripe:event:${id}`;
const EVENT_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days — long enough to outlast Stripe retries.

/**
 * Single endpoint that handles every Stripe event we care about.
 *
 *   POST /webhooks/stripe   — signature-verified, idempotent, returns 200
 *
 * The endpoint always returns 200 to Stripe as long as we *received* the
 * event (even if processing failed) — Stripe interprets non-2xx as a
 * delivery failure and retries. We log + insert a failed processing row
 * so a human can replay later. The only 4xx we ever return is for a
 * signature/format problem, which is genuinely unrecoverable.
 */
@Controller('webhooks/stripe')
export class StripeWebhookController {
  private readonly logger = new Logger(StripeWebhookController.name);

  constructor(
    @Inject(STRIPE_DRIVER) private readonly stripe: StripeDriver,
    @Inject(BillingService) private readonly billing: BillingService,
    @Inject(RedisService) private readonly redis: RedisService,
  ) {}

  @Post()
  @HttpCode(200)
  async handle(
    @Req() req: Request & { rawBody?: Buffer },
    @Headers('stripe-signature') signature: string | undefined,
  ): Promise<{ received: true; deduped?: true }> {
    if (!signature) {
      throw new BadRequestException('Missing stripe-signature header.');
    }
    if (!req.rawBody) {
      throw new BadRequestException('Raw body unavailable — server misconfigured.');
    }

    let event: StripeWebhookEvent;
    try {
      event = this.stripe.verifyWebhookSignature(req.rawBody, signature);
    } catch (err) {
      this.logger.warn(`Webhook signature verification failed: ${(err as Error).message}`);
      throw new BadRequestException('Invalid signature.');
    }

    // Redis SETNX gives us O(1) dedupe; the DB row gives us a durable audit
    // log + replay buffer. Redis wins races by ~1 ms so we never double-
    // process; the DB row is the source of truth for "have we seen this?".
    const setRes = await this.redis.client.set(
      EVENT_KEY(event.id),
      '1',
      'EX',
      EVENT_TTL_SECONDS,
      'NX',
    );
    if (setRes !== 'OK') {
      return { received: true, deduped: true };
    }
    // Best-effort persistence — Stripe will retry on 5xx, so even if this
    // upsert races a peer it's fine.
    await controlDb.stripeWebhookEvent
      .upsert({
        where: { id: event.id },
        create: {
          id: event.id,
          type: event.type,
          payloadJson: event as never,
        },
        update: {},
      })
      .catch((err: Error) => {
        this.logger.warn(`Could not persist stripe_webhook_events row: ${err.message}`);
      });

    try {
      await this.dispatch(event);
      await controlDb.stripeWebhookEvent
        .update({
          where: { id: event.id },
          data: { processedAt: new Date(), error: null },
        })
        .catch(() => undefined);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Webhook ${event.type} (${event.id}) failed: ${message}`);
      await controlDb.stripeWebhookEvent
        .update({
          where: { id: event.id },
          data: { error: message.slice(0, 1000) },
        })
        .catch(() => undefined);
      // Drop the Redis lock so a Stripe retry can re-attempt — otherwise
      // we'd be stuck on the failed event for 30 days.
      await this.redis.client.del(EVENT_KEY(event.id));
    }

    return { received: true };
  }

  private async dispatch(event: StripeWebhookEvent): Promise<void> {
    const obj = event.data.object as Record<string, unknown>;
    switch (event.type) {
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
        await this.billing.syncStripeSubscription(obj as unknown as StripeSubscriptionShape);
        return;
      case 'customer.subscription.deleted':
        await this.billing.handleStripeSubscriptionDeleted(
          obj as unknown as StripeSubscriptionShape,
        );
        return;
      case 'invoice.payment_succeeded':
        await this.billing.handleStripeInvoicePaid(obj as unknown as StripeInvoiceShape);
        return;
      case 'invoice.payment_failed':
        await this.billing.handleStripeInvoiceFailed(obj as unknown as StripeInvoiceShape);
        return;
      case 'checkout.session.completed':
        // The subscription.created/updated event that follows carries the
        // full state, so we don't have to act on the session itself.
        return;
      default:
        this.logger.debug(`Webhook ${event.type} (${event.id}) ignored — not subscribed.`);
    }
  }
}
