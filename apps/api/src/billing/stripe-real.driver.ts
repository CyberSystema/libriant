import { Injectable, Logger } from '@nestjs/common';
import Stripe from 'stripe';
import { loadEnv } from '../config/env.js';
import type {
  StripeCheckoutInput,
  StripeCustomerInput,
  StripeDriver,
  StripePortalInput,
  StripeWebhookEvent,
} from './stripe-driver.js';

@Injectable()
export class RealStripeDriver implements StripeDriver {
  readonly isReal = true;
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
      apiVersion: '2026-05-27.dahlia',
      // Bound outbound latency so a Stripe incident can't tie up request
      // workers on the default 80s-per-call budget. Retries cover transient
      // network blips; webhooks/sweeps cover anything that still fails.
      timeout: 10_000,
      maxNetworkRetries: 2,
    });
    this.webhookSecret = env.stripeWebhookSecret;
  }

  async createCustomer(input: StripeCustomerInput): Promise<{ customerId: string }> {
    const customer = await this.stripe.customers.create({
      email: input.email,
      name: input.name,
      metadata: { tenantId: input.tenantId, tenantSlug: input.tenantSlug },
    });
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

  verifyWebhookSignature(rawBody: Buffer, signatureHeader: string): StripeWebhookEvent {
    const event = this.stripe.webhooks.constructEvent(rawBody, signatureHeader, this.webhookSecret);
    return event as unknown as StripeWebhookEvent;
  }
}
