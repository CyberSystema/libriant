import {
  BadRequestException,
  Controller,
  Headers,
  HttpCode,
  Inject,
  Logger,
  Post,
  Req,
  ServiceUnavailableException,
} from '@nestjs/common';
import { controlDb } from '@libriant/db-control';
import type { Request } from 'express';
import { BillingService } from './billing.service.js';
import { RedisService } from '../platform/redis.service.js';
import {
  STRIPE_DRIVER,
  type StripeCheckoutSessionShape,
  type StripeDriver,
  type StripeInvoiceShape,
  type StripeSubscriptionShape,
  type StripeWebhookEvent,
} from './stripe-driver.js';

const EVENT_KEY = (id: string) => `stripe:event:${id}`;
const EVENT_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days — long enough to outlast Stripe retries.

/** Postgres unique-violation. Means the event row already existed. */
const PRISMA_UNIQUE_VIOLATION = 'P2002';

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
    // billing-02. This route is unauthenticated by design (Stripe has no
    // credential to present) and exempt from maintenance/read-only mode, so
    // the signature IS the authentication. On a server with billing switched
    // off there is no signing secret and nothing legitimate can ever call
    // this — refuse before reading a byte of the body, rather than handing the
    // request to a driver that might verify it against a literal published in
    // this repository. 503, not 404: the endpoint exists and would work once
    // Stripe is configured, and hiding that from an operator debugging their
    // own deploy helps nobody.
    if (this.stripe.kind === 'disabled') {
      throw new ServiceUnavailableException(
        'Billing is not configured on this server — Stripe webhooks are not accepted.',
      );
    }

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

    // ---- Replay guard, in two layers -------------------------------------
    //
    // Layer 1 (DURABLE): the `stripe_webhook_events` row. Writing it first
    // also means a crash between here and the end of dispatch leaves a row
    // with processedAt = null for the retry sweep to rescue.
    //
    // Layer 2 (FAST): a Redis SETNX, which serializes concurrent deliveries.
    //
    // Wave 1 made the rest of this request path fail open but left the Redis
    // SET bare, so a Redis outage turned every webhook into a 500 and Stripe
    // retried the lot. The fix is NOT to swallow the error and carry on — a
    // replay guard that cannot reach its store must not silently accept
    // replays. It is to notice that the durable row already answers "have we
    // finished this event before?" better than Redis does. So Redis becomes
    // what it always really was, a concurrency lock, and losing it costs us
    // only protection against two SIMULTANEOUS deliveries of an event that has
    // never completed — a window every handler here is idempotent across. If
    // BOTH stores are unreachable we have no replay protection at all, and
    // that is the one case where we refuse and let Stripe retry.
    const persisted = await this.persistEvent(event);
    if (persisted.alreadyProcessed) {
      return { received: true, deduped: true };
    }

    let lockHeld = false;
    let lockAvailable = true;
    try {
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
      lockHeld = true;
    } catch (err) {
      lockAvailable = false;
      this.logger.error(
        `Redis unavailable for webhook dedupe (${event.id}): ${(err as Error).message}. ` +
          'Falling back to the durable stripe_webhook_events row.',
      );
    }

    if (!lockAvailable && !persisted.durable) {
      // Neither store is answering: we cannot tell a first delivery from the
      // fifth retry of one we already applied, and we would not be able to
      // record the outcome either. Refuse — Stripe redelivers for up to three
      // days, which is far longer than any Redis/Postgres outage we would
      // survive as a product anyway.
      throw new ServiceUnavailableException('Webhook storage unavailable — please redeliver.');
    }

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
      if (lockHeld) {
        await this.redis.client.del(EVENT_KEY(event.id)).catch(() => undefined);
      }
    }

    return { received: true };
  }

  /**
   * Record the event durably, and report what we learned.
   *
   *   `durable`          — the row is definitely on disk (we wrote it, or it
   *                        was already there). False only if Postgres refused.
   *   `alreadyProcessed` — a previous delivery of this exact event completed.
   *                        This is the replay guard that survives a Redis
   *                        outage, which is why it reads `processedAt` rather
   *                        than merely noting that the row exists: a row with
   *                        processedAt = null is an event that never finished
   *                        and SHOULD be retried.
   *
   * `create`-then-catch rather than the previous `upsert`, because an upsert
   * cannot tell "first delivery" from "fifth retry" — and that distinction is
   * the entire fallback.
   */
  private async persistEvent(
    event: StripeWebhookEvent,
  ): Promise<{ durable: boolean; alreadyProcessed: boolean }> {
    try {
      await controlDb.stripeWebhookEvent.create({
        data: { id: event.id, type: event.type, payloadJson: event as never },
      });
      return { durable: true, alreadyProcessed: false };
    } catch (err) {
      if ((err as { code?: string }).code !== PRISMA_UNIQUE_VIOLATION) {
        this.logger.warn(`Could not persist stripe_webhook_events row: ${(err as Error).message}`);
        return { durable: false, alreadyProcessed: false };
      }
    }
    try {
      const row = await controlDb.stripeWebhookEvent.findUnique({
        where: { id: event.id },
        select: { processedAt: true },
      });
      return { durable: true, alreadyProcessed: row?.processedAt != null };
    } catch (err) {
      this.logger.warn(`Could not read stripe_webhook_events row: ${(err as Error).message}`);
      return { durable: false, alreadyProcessed: false };
    }
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
        // The subscription.created/updated event that follows carries the full
        // state, so there is nothing to sync — but this is the earliest point
        // at which the tenant's outstanding Checkout session is spent, and the
        // duplicate-purchase guard needs to know (billing-03).
        await this.billing.handleCheckoutSessionCompleted(
          obj as unknown as StripeCheckoutSessionShape,
        );
        return;
      default:
        this.logger.debug(`Webhook ${event.type} (${event.id}) ignored — not subscribed.`);
    }
  }
}
