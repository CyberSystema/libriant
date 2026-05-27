/**
 * Boundary between BillingService and the actual Stripe SDK. Two drivers
 * implement this:
 *
 *   - `RealStripeDriver` (production)  — hits the real Stripe API
 *   - `FakeStripeDriver`  (dev/tests)  — pure-memory; records calls and
 *     generates deterministic IDs so we can exercise the full code path
 *     without network or credentials.
 *
 * The shape stays tiny on purpose. Everything the BillingService needs
 * lives here; everything Stripe-shaped that BillingService can derive
 * from local state stays out.
 */

export type StripeCustomerInput = {
  /** Tenant slug — embedded in customer metadata for traceability. */
  tenantSlug: string;
  /** Tenant id (cuid) — primary key we look up by on webhook delivery. */
  tenantId: string;
  email: string;
  name: string;
};

export type StripeCheckoutInput = {
  /** Stripe customer id, created via `createCustomer` (cached on tenant). */
  customerId: string;
  /** Price id from `plans.stripe_price_id`. */
  priceId: string;
  /** Where Stripe sends the browser after success. */
  successUrl: string;
  /** Where Stripe sends the browser if the user bails. */
  cancelUrl: string;
  /** Tenant id, recorded as `client_reference_id` for webhook correlation. */
  tenantId: string;
};

export type StripePortalInput = {
  customerId: string;
  returnUrl: string;
};

export type StripeWebhookEvent = {
  id: string;
  type: string;
  data: { object: Record<string, unknown> };
};

/**
 * The shape of `customer.subscription.*` event payload bodies the
 * BillingService consumes — kept small to avoid coupling to Stripe's
 * full TypeScript surface (which is huge).
 */
export type StripeSubscriptionShape = {
  id: string;
  customer: string;
  status: 'trialing' | 'active' | 'past_due' | 'canceled' | 'paused' | 'incomplete' | string;
  current_period_start: number;
  current_period_end: number;
  cancel_at_period_end: boolean;
  canceled_at: number | null;
  items: { data: Array<{ price: { id: string } }> };
};

export type StripeInvoiceShape = {
  id: string;
  customer: string;
  subscription: string | null;
  status: 'paid' | 'open' | 'void' | 'uncollectible' | 'draft' | string;
  amount_paid: number;
  amount_due: number;
};

export type StripeCheckoutSessionShape = {
  id: string;
  customer: string;
  subscription: string | null;
  client_reference_id: string | null;
};

export interface StripeDriver {
  /** True only for the real driver; used to skip "open Customer Portal" etc. in dev. */
  readonly isReal: boolean;

  createCustomer(input: StripeCustomerInput): Promise<{ customerId: string }>;
  createCheckoutSession(input: StripeCheckoutInput): Promise<{ url: string; sessionId: string }>;
  createBillingPortalSession(input: StripePortalInput): Promise<{ url: string }>;
  cancelSubscriptionAtPeriodEnd(subscriptionId: string): Promise<void>;
  resumeSubscription(subscriptionId: string): Promise<void>;
  /**
   * Verify the signature header against the *raw* request body. Stripe
   * signs the bytes, not the parsed JSON.
   *
   * Returns the parsed event on success; throws on any verification
   * failure so the webhook controller can return 400.
   */
  verifyWebhookSignature(rawBody: Buffer, signatureHeader: string): StripeWebhookEvent;
}

export const STRIPE_DRIVER = Symbol('STRIPE_DRIVER');
