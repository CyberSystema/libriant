import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import type {
  StripeCheckoutInput,
  StripeCustomerInput,
  StripeDriver,
  StripePortalInput,
  StripePriceChangeInput,
  StripeSubscriptionState,
  StripeWebhookEvent,
} from './stripe-driver.js';

/**
 * The shipped production posture: billing is switched off, so there is NO
 * Stripe driver behind the billing surface at all.
 *
 * billing-02 (wave 2). `STRIPE_DRIVER=fake` used to mean both "we are not
 * taking payments" and "pretend to be Stripe", and every production template
 * shipped it — so a server with billing off still ran a stand-in that verified
 * webhook signatures against a literal published in this repository, on an
 * endpoint that is unauthenticated by design. The stand-in was never the thing
 * an operator without a Stripe account wanted; refusing outright is.
 *
 * Every operation throws 503 rather than returning a plausible-looking canned
 * value. A refusal is loud, appears in the logs, and cannot be mistaken for a
 * completed purchase; a canned `cus_fake_…` cannot be told apart from a real
 * one once it is written to a row.
 *
 * The webhook controller checks `kind` and refuses BEFORE reading the body, so
 * `verifyWebhookSignature` below is a backstop, not the primary guard.
 */
@Injectable()
export class DisabledStripeDriver implements StripeDriver {
  readonly isReal = false;
  readonly kind = 'disabled' as const;
  private readonly logger = new Logger(DisabledStripeDriver.name);

  constructor() {
    this.logger.log(
      'Billing is DISABLED (STRIPE_DRIVER=none): no Stripe driver is loaded, ' +
        'self-serve billing refuses, and POST /webhooks/stripe answers 503. ' +
        'Set STRIPE_DRIVER=real with STRIPE_API_KEY + STRIPE_WEBHOOK_SECRET to take payments.',
    );
  }

  /** The one message every refusal shares, so operators can grep for it. */
  private refuse(operation: string): never {
    throw new ServiceUnavailableException(
      `Billing is not configured on this server (${operation}). ` +
        'Set STRIPE_DRIVER=real with STRIPE_API_KEY + STRIPE_WEBHOOK_SECRET to enable it.',
    );
  }

  async createCustomer(_input: StripeCustomerInput): Promise<{ customerId: string }> {
    this.refuse('createCustomer');
  }

  async createCheckoutSession(
    _input: StripeCheckoutInput,
  ): Promise<{ url: string; sessionId: string }> {
    this.refuse('createCheckoutSession');
  }

  async expireCheckoutSession(_sessionId: string): Promise<void> {
    this.refuse('expireCheckoutSession');
  }

  async createBillingPortalSession(_input: StripePortalInput): Promise<{ url: string }> {
    this.refuse('createBillingPortalSession');
  }

  async cancelSubscriptionAtPeriodEnd(_subscriptionId: string): Promise<void> {
    this.refuse('cancelSubscriptionAtPeriodEnd');
  }

  async resumeSubscription(_subscriptionId: string): Promise<void> {
    this.refuse('resumeSubscription');
  }

  async changeSubscriptionPrice(_input: StripePriceChangeInput): Promise<void> {
    this.refuse('changeSubscriptionPrice');
  }

  async getSubscription(_subscriptionId: string): Promise<StripeSubscriptionState | null> {
    this.refuse('getSubscription');
  }

  async listSubscriptions(_customerId: string): Promise<StripeSubscriptionState[]> {
    this.refuse('listSubscriptions');
  }

  verifyWebhookSignature(_rawBody: Buffer, _signatureHeader: string): StripeWebhookEvent {
    // Never returns an event. The whole point of this posture is that nothing
    // reachable from the shipped templates can verify a webhook — least of all
    // against the published dev literal.
    this.refuse('verifyWebhookSignature');
  }
}
