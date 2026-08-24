/**
 * Boundary between BillingService and the actual Stripe SDK. Three drivers
 * implement this:
 *
 *   - `RealStripeDriver`     (production) — hits the real Stripe API
 *   - `DisabledStripeDriver` (production, billing off) — refuses every
 *     operation with a 503. The SHIPPED default: a server that is not taking
 *     payments must not carry a Stripe stand-in at all (billing-02).
 *   - `FakeStripeDriver`     (dev/tests)  — pure-memory; records calls and
 *     generates deterministic IDs so we can exercise the full code path
 *     without network or credentials. Never loaded on a deployed host.
 *
 * The shape stays tiny on purpose. Everything the BillingService needs
 * lives here; everything Stripe-shaped that BillingService can derive
 * from local state stays out.
 */

import type { StripeDriverKind } from './stripe-driver-kind.js';

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

export type StripePriceChangeInput = {
  /** The subscription to re-price — never a new one. */
  subscriptionId: string;
  /** Price id from `plans.stripe_price_id` / `plans.stripe_annual_price_id`. */
  priceId: string;
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
  cancel_at_period_end: boolean;
  canceled_at: number | null;
  items: {
    data: Array<{
      price: { id: string };
      // As of Stripe API 2025-03-31 (`basil`) the billing period moved from
      // the top-level Subscription onto each SubscriptionItem. We pin the
      // SDK's API version (see RealStripeDriver), so this is where the
      // period actually lives on every event we receive.
      current_period_start?: number;
      current_period_end?: number;
    }>;
  };
  // Legacy (pre-`basil`) top-level period fields. Kept optional purely as a
  // fallback for an account pinned to an older API version — current events
  // carry the period on `items.data[]` above, not here.
  current_period_start?: number;
  current_period_end?: number;
};

/**
 * The Stripe subscription statuses in which a subscription actually EXISTS as
 * a billing relationship — i.e. the ones where re-pricing it in place is the
 * right move and opening a second one would double-charge.
 *
 * `incomplete` and `unpaid` are deliberately absent, and that omission is a
 * bug fix, not an oversight. Both map to our local `past_due` (our enum has no
 * finer grain), and `past_due` reads as "live" everywhere else — so a
 * subscription whose very first payment never completed used to be RE-PRICED
 * on the customer's next purchase attempt instead of re-purchased. The library
 * saw a successful-looking plan change, and nobody was ever charged a cent.
 * `incomplete_expired` and `canceled` are terminal for the same reason.
 */
export const STRIPE_LIVE_STATUSES: ReadonlySet<string> = new Set([
  'active',
  'trialing',
  'past_due',
  'paused',
]);

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

/**
 * What Stripe currently says about a subscription id we hold. Deliberately
 * smaller than `StripeSubscriptionShape`: the only questions the purchase path
 * asks are "does it still exist" and "is it live".
 */
export type StripeSubscriptionState = {
  id: string;
  /** Stripe's own status string — NOT our local enum. See STRIPE_LIVE_STATUSES. */
  status: string;
  /** The price it is currently on, when the subscription has exactly one item. */
  priceId: string | null;
};

export interface StripeDriver {
  /** True only for the real driver; used to skip "open Customer Portal" etc. in dev. */
  readonly isReal: boolean;
  /**
   * Which posture this process is in. `isReal` cannot distinguish "in-memory
   * stand-in" from "billing switched off, no driver at all", and the webhook
   * route has to refuse for the second without refusing for the first.
   */
  readonly kind: StripeDriverKind;

  createCustomer(input: StripeCustomerInput): Promise<{ customerId: string }>;
  createCheckoutSession(input: StripeCheckoutInput): Promise<{ url: string; sessionId: string }>;
  /**
   * Expire an OPEN Checkout session so it can never be completed.
   *
   * billing-03 (duplicate-purchase half): the previous guard keyed on our own
   * `stripeSubscriptionId`, so it did nothing while that was still null — a
   * brand-new library could open Checkout for Community, press Back, open
   * Checkout for Municipal, and complete BOTH. Two live subscriptions, two
   * charges, and our row only ever remembered the newer id. The second click
   * now expires the first session before opening the second, so at most one of
   * them can ever be completed.
   *
   * Throws when Stripe refuses — notably when the session is already COMPLETE,
   * which the caller must treat as "a subscription now exists", never as a
   * reason to open another session.
   */
  expireCheckoutSession(sessionId: string): Promise<void>;
  createBillingPortalSession(input: StripePortalInput): Promise<{ url: string }>;
  cancelSubscriptionAtPeriodEnd(subscriptionId: string): Promise<void>;
  resumeSubscription(subscriptionId: string): Promise<void>;
  /**
   * Move an EXISTING subscription onto another price, with prorations.
   *
   * billing-03: Checkout in `mode:'subscription'` always opens an ADDITIONAL
   * subscription for the customer — it can never modify one. Routing a plan
   * change through it therefore left the old subscription billing forever
   * while our row remembered only the new id. Every plan change on a live
   * subscription goes through here instead; Checkout is for the FIRST
   * subscription only.
   *
   * Returns once Stripe has accepted the change. The resulting
   * `customer.subscription.updated` webhook is what moves our own row.
   */
  changeSubscriptionPrice(input: StripePriceChangeInput): Promise<void>;
  /**
   * Ask Stripe what it currently thinks of a subscription id we hold.
   * Resolves `null` when Stripe has no such subscription.
   *
   * billing-03 (lockout half): the purchase path used to decide "re-price vs
   * buy" from our OWN row — any tenant carrying a `stripeSubscriptionId` whose
   * local status was not `canceled` could never reach Checkout again, even
   * when that id was long gone in Stripe. One missed
   * `customer.subscription.deleted` bricked purchasing for that library
   * permanently, because `changeSubscriptionPrice` then failed forever on an
   * id that no longer existed. Stripe is the source of truth for whether a
   * subscription is live; ask it.
   */
  getSubscription(subscriptionId: string): Promise<StripeSubscriptionState | null>;
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
