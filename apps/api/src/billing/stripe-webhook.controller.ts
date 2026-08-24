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
 * WHAT A 200 FROM THIS ENDPOINT MEANS (billing-08).
 * Stripe treats 2xx as final and never redelivers, so a 200 is a promise: we
 * hold this event durably and will finish it, now or on the retry sweep. It is
 * NOT "the HTTP request reached us". The rule that keeps the promise honest:
 *
 *     200 only after the `stripe_webhook_events` row is on disk.
 *
 * The old code returned 200 unconditionally — the durable insert was
 * best-effort (`.catch()` → warn → carry on) and dispatch failure fell through
 * to `return { received: true }`. During a Postgres blip the insert and the
 * dispatch failed together, so there was no row for the retry sweep
 * (stripe-retry.job.ts selects exclusively FROM stripe_webhook_events) and no
 * Stripe redelivery either. A cancellation never applied, a payment failure
 * never recorded, a paid upgrade never provisioned — with no error row and no
 * alert. Both recovery mechanisms were unavailable in precisely the failure
 * they were built for.
 *
 * So there are now two non-2xx answers, and they mean different things:
 *   400 — signature/format. Genuinely unrecoverable; a retry cannot help.
 *   503 — we could not take durable custody. Retry, please.
 * A dispatch that fails AFTER the row is on disk still returns 200, because
 * the sweep can see that row and will re-run it (it picks up rows with
 * `error` set, and also rows merely older than the stale window, so a failed
 * error-write does not hide it either).
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
    // never completed — a window every handler here is idempotent across.
    const persisted = await this.persistEvent(event);
    if (persisted.alreadyProcessed) {
      return { received: true, deduped: true };
    }

    if (!persisted.durable) {
      // billing-08. THE ONE PLACE A WEBHOOK COULD BE LOST FOREVER.
      //
      // This used to be a warn-and-continue, and the refusal below it was
      // guarded on `!lockAvailable && !persisted.durable` — both stores. But
      // Redis being HEALTHY is not a reason to accept custody of an event we
      // cannot write down. With Postgres unavailable the sequence was: insert
      // fails (warn), Redis lock succeeds, dispatch fails against the same
      // dead Postgres, the error-row update fails too (swallowed), and the
      // handler returned 200. Stripe considers a 200 final, so it never
      // redelivered; the retry sweep selects only FROM stripe_webhook_events,
      // so a row that was never inserted is invisible to it forever. The event
      // was gone, silently, with no error row and no alert.
      //
      // Note the trigger is narrower than "Postgres is down": ONE transient
      // failure on this single insert is enough, because the dispatch that
      // follows would fail the same way and the 200 was unconditional.
      //
      // Refusing costs a redelivery. Stripe retries for about three days,
      // which outlasts any Postgres outage this product survives anyway.
      throw new ServiceUnavailableException('Webhook storage unavailable — please redeliver.');
    }

    let lockHeld = false;
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
      // Redis is only the concurrency lock now — the durable row above already
      // answered "have we finished this one before?", and we would not have
      // got here without it. Losing Redis costs protection against two
      // SIMULTANEOUS deliveries of an event that never completed, a window
      // every handler is idempotent across. Carrying on is correct; turning
      // every webhook into a 500 during a Redis blip is not.
      this.logger.error(
        `Redis unavailable for webhook dedupe (${event.id}): ${(err as Error).message}. ` +
          'Falling back to the durable stripe_webhook_events row.',
      );
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
      // Best-effort, and it is allowed to be: the row itself is already on
      // disk (we refused above otherwise), and the retry sweep picks a row up
      // on EITHER `error IS NOT NULL` or `receivedAt` older than its stale
      // window (stripe-retry.job.ts). So an unwritten error message costs five
      // minutes of latency, not the event.
      await controlDb.stripeWebhookEvent
        .update({
          where: { id: event.id },
          data: { error: message.slice(0, 1000) },
        })
        .catch(() => undefined);
      // Drop the 30-day lock. The comment here used to promise "so a Stripe
      // retry can re-attempt", which was never true — we return 200 below and
      // Stripe treats that as final (billing-08 flagged exactly this line).
      // What the drop actually buys is that the automatic sweep and an
      // operator's manual "Resend" from the Stripe Dashboard are not blocked
      // by a lock left over from the failed attempt.
      if (lockHeld) {
        await this.redis.client.del(EVENT_KEY(event.id)).catch(() => undefined);
      }
    }

    // 200 = "durably ours". The row is on disk and the sweep owns it from
    // here; see the class comment for why that is the whole contract.
    return { received: true };
  }

  /**
   * Record the event durably, and report what we learned.
   *
   *   `durable`          — the row is definitely on disk (we wrote it, or it
   *                        was already there). False only if Postgres refused,
   *                        which the caller answers with a 503: `durable` is
   *                        the precondition for returning 200 at all, because
   *                        the retry sweep can rescue nothing else (billing-08).
   *                        Note a P2002 whose follow-up read then fails also
   *                        reports false — the row exists, but we cannot tell
   *                        whether the earlier delivery completed, and guessing
   *                        either way is worse than asking Stripe to redeliver.
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
