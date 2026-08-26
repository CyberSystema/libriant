import { Injectable, Logger } from '@nestjs/common';
import Stripe from 'stripe';
import { loadEnv } from '../config/env.js';
import type {
  StripeCheckoutInput,
  StripeCustomerInput,
  StripeDriver,
  StripePortalInput,
  StripePriceChangeInput,
  StripePriceState,
  StripeSubscriptionState,
  StripeWebhookEvent,
} from './stripe-driver.js';

@Injectable()
export class RealStripeDriver implements StripeDriver {
  readonly isReal = true;
  readonly kind = 'real' as const;
  private readonly logger = new Logger(RealStripeDriver.name);
  private readonly stripe: Stripe;
  private readonly webhookSecret: string;

  constructor() {
    const env = loadEnv();
    if (!env.stripeApiKey) {
      throw new Error(
        'STRIPE_API_KEY is required when STRIPE_DRIVER=real. Set it (e.g. sk_test_…) or switch to STRIPE_DRIVER=fake in development.',
      );
    }
    if (!env.stripeWebhookSecret) {
      throw new Error(
        'STRIPE_WEBHOOK_SECRET is required when STRIPE_DRIVER=real. Copy it from the Stripe Dashboard or `stripe listen`.',
      );
    }
    this.stripe = new Stripe(env.stripeApiKey, {
      typescript: true,
      // Pin the API version explicitly. Without this, a Stripe SDK upgrade can
      // silently shift webhook payload shapes (e.g. `basil` moved the billing
      // period from Subscription onto SubscriptionItem) and break syncs at
      // runtime with no compile-time signal. A future SDK bump that drops this
      // literal will fail to type-check — forcing a conscious migration.
      //
      // 2026-08-22, stripe-node 22.2 → 22.5: moved 2026-05-27 → 2026-07-29,
      // both inside the Dahlia series. Stripe's own rule is that only the FIRST
      // version of a series (2026-03-25.dahlia) carries breaking changes and
      // "subsequent Dahlia versions will include only additive changes" — the
      // June and July releases are new payment methods and new fields, nothing
      // touching subscription periods, Checkout, or the webhook payloads read
      // in billing.service.ts. Breaking changes arrive with the next flower.
      apiVersion: '2026-07-29.dahlia',
      // Bound outbound latency so a Stripe incident can't tie up request
      // workers on the default 80s-per-call budget. Retries cover transient
      // network blips; webhooks/sweeps cover anything that still fails.
      timeout: 10_000,
      maxNetworkRetries: 2,
    });
    this.webhookSecret = env.stripeWebhookSecret;
  }

  /**
   * billing-09: the second argument is the fix. `ensureStripeCustomer` is
   * read-then-create with a network call and no lock in between, so two
   * concurrent purchase starts for the same library both created a customer —
   * and the library then paid on whichever one its session used, which may be
   * the one our row did not keep. Stripe replays the first response for a
   * repeated Idempotency-Key, so both racers now receive the SAME customer and
   * the duplicate is never created.
   */
  async createCustomer(input: StripeCustomerInput): Promise<{ customerId: string }> {
    const customer = await this.stripe.customers.create(
      {
        email: input.email,
        name: input.name,
        metadata: { tenantId: input.tenantId, tenantSlug: input.tenantSlug },
      },
      { idempotencyKey: input.idempotencyKey },
    );
    return { customerId: customer.id };
  }

  async createCheckoutSession(
    input: StripeCheckoutInput,
  ): Promise<{ url: string; sessionId: string }> {
    const session = await this.stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: input.customerId,
      line_items: [{ price: input.priceId, quantity: 1 }],
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      client_reference_id: input.tenantId,
      // Don't let one tenant accidentally pay for another by editing the
      // pre-filled customer email at checkout.
      customer_update: { name: 'auto', address: 'auto' },
    });
    if (!session.url) throw new Error('Stripe returned a session without a redirect URL.');
    return { url: session.url, sessionId: session.id };
  }

  /**
   * billing-03: expire an open Checkout session so a second click cannot leave
   * two completable sessions outstanding. Stripe refuses this on a session
   * that is already `complete`; that rejection is meaningful and must reach
   * the caller rather than being swallowed — it means a subscription exists.
   */
  async expireCheckoutSession(sessionId: string): Promise<void> {
    await this.stripe.checkout.sessions.expire(sessionId);
  }

  async createBillingPortalSession(input: StripePortalInput): Promise<{ url: string }> {
    const session = await this.stripe.billingPortal.sessions.create({
      customer: input.customerId,
      return_url: input.returnUrl,
    });
    return { url: session.url };
  }

  async cancelSubscriptionAtPeriodEnd(subscriptionId: string): Promise<void> {
    await this.stripe.subscriptions.update(subscriptionId, { cancel_at_period_end: true });
  }

  async resumeSubscription(subscriptionId: string): Promise<void> {
    await this.stripe.subscriptions.update(subscriptionId, { cancel_at_period_end: false });
  }

  /**
   * billing-03: the ONLY way to change what a live subscription costs. Stripe
   * re-prices by replacing the item, so we must send the existing item's id —
   * omitting it appends a second item and the customer pays for both.
   *
   * `create_prorations` credits the unused remainder of the old price and
   * charges the new one pro rata on the next invoice, which is what an upgrade
   * mid-period should do. We refuse anything but a single-item subscription:
   * every subscription this app creates has exactly one line, so more than one
   * means a human edited it in the Dashboard and guessing which line to
   * replace would silently drop what they added.
   */
  async changeSubscriptionPrice(input: StripePriceChangeInput): Promise<void> {
    const current = await this.stripe.subscriptions.retrieve(input.subscriptionId);
    const items = current.items.data;
    const item = items[0];
    if (items.length !== 1 || !item) {
      throw new Error(
        `Subscription ${input.subscriptionId} has ${items.length} items — refusing to re-price it automatically.`,
      );
    }
    // Already on that price (a double-submit, or a resumed cancellation).
    // Sending it again would raise a zero-value proration on the invoice.
    if (item.price.id === input.priceId) {
      this.logger.log(`Subscription ${input.subscriptionId} already on price ${input.priceId}.`);
      return;
    }
    await this.stripe.subscriptions.update(input.subscriptionId, {
      items: [{ id: item.id, price: input.priceId }],
      proration_behavior: 'create_prorations',
    });
  }

  /**
   * billing-03 (lockout half): the authoritative answer to "is the id on our
   * row still a real, live subscription?". A deleted subscription answers with
   * Stripe's `resource_missing` error, which we translate to `null` so the
   * purchase path can clear the dead pointer and sell again — rather than
   * letting a single missed `customer.subscription.deleted` webhook lock a
   * library out of buying anything, forever.
   *
   * Any OTHER error (network, 5xx, auth) propagates on purpose. "Stripe did
   * not answer" is not the same as "there is no subscription", and treating
   * it as the latter is how you sell a second subscription to someone who
   * already has one.
   */
  async getSubscription(subscriptionId: string): Promise<StripeSubscriptionState | null> {
    try {
      const sub = await this.stripe.subscriptions.retrieve(subscriptionId);
      const items = sub.items.data;
      return {
        id: sub.id,
        status: sub.status,
        // Only meaningful for a single-item subscription; `changeSubscriptionPrice`
        // refuses to touch anything else anyway.
        priceId: items.length === 1 ? (items[0]?.price.id ?? null) : null,
      };
    } catch (err) {
      if (
        err instanceof Stripe.errors.StripeInvalidRequestError &&
        err.code === 'resource_missing'
      ) {
        this.logger.warn(`Stripe has no subscription ${subscriptionId} — treating it as gone.`);
        return null;
      }
      throw err;
    }
  }

  /**
   * billing-03, round 2: the authoritative answer to "does this customer
   * already pay us?", asked when our own row cannot answer it.
   *
   * Stripe returns list results newest-first, which is the order the caller
   * wants: if a customer somehow has more than one live subscription, the one
   * that was just bought is the one to re-price.
   *
   * `limit: 20` is generous — every customer this app creates should have
   * exactly one — and bounded on purpose: this runs on a request path, and a
   * customer with more subscriptions than that has a problem no amount of
   * paging fixes.
   */
  async listSubscriptions(customerId: string): Promise<StripeSubscriptionState[]> {
    const page = await this.stripe.subscriptions.list({
      customer: customerId,
      // The caller decides what counts as live (STRIPE_LIVE_STATUSES);
      // narrowing to 'active' here would hide trialing/past_due/paused, each
      // of which must be re-priced rather than re-bought.
      status: 'all',
      limit: 20,
    });
    return page.data.map((sub) => ({
      id: sub.id,
      status: sub.status,
      priceId: sub.items.data.length === 1 ? (sub.items.data[0]?.price.id ?? null) : null,
    }));
  }

  /**
   * billing-10: the catalogue audit's only source of truth. `resource_missing`
   * is translated to `null` — "Stripe has no such Price" is an ANSWER, and the
   * most important one the audit can get, because it is what a `price_seed_*`
   * placeholder or a typo produces. Every other error propagates: "Stripe did
   * not answer" must never be reported to an operator as "the id is fine".
   */
  async getPrice(priceId: string): Promise<StripePriceState | null> {
    try {
      const price = await this.stripe.prices.retrieve(priceId);
      return {
        id: price.id,
        active: price.active,
        currency: price.currency,
        // Stripe reports minor units as an integer. Keep it one.
        unitAmount: price.unit_amount ?? null,
        interval: price.recurring?.interval ?? null,
        intervalCount: price.recurring?.interval_count ?? null,
      };
    } catch (err) {
      if (
        err instanceof Stripe.errors.StripeInvalidRequestError &&
        err.code === 'resource_missing'
      ) {
        return null;
      }
      throw err;
    }
  }

  verifyWebhookSignature(rawBody: Buffer, signatureHeader: string): StripeWebhookEvent {
    const event = this.stripe.webhooks.constructEvent(rawBody, signatureHeader, this.webhookSecret);
    return event as unknown as StripeWebhookEvent;
  }
}
