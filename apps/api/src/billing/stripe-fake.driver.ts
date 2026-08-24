import { createHmac } from 'crypto';
import { Injectable, Logger } from '@nestjs/common';
import { loadEnv } from '../config/env.js';
import { isTrustedLocalNodeEnv } from './stripe-driver-kind.js';
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
 * The dev fallback webhook secret. It is published in this repository, so a
 * signature made with it proves nothing — see the constructor for where that
 * stops mattering.
 */
const DEV_WEBHOOK_SECRET = 'fake-webhook-secret-for-dev';

/**
 * Pure-memory Stripe stand-in. Used in dev + tests so the BillingService
 * exercises its full state machine without hitting Stripe.
 *
 * Behavior contracts honored:
 *
 *   - `createCustomer` returns a stable `cus_fake_<tenantId>` id so the
 *     same tenant always maps to the same id across server restarts.
 *   - `createCheckoutSession` returns a URL the test harness can POST a
 *     simulated webhook to. The URL doesn't actually open anything; the
 *     verification probes synthesize the corresponding webhook themselves.
 *   - `verifyWebhookSignature` uses the same `t=<unix> v1=<hmac>` scheme
 *     as Stripe, signed with the configured webhook secret. Test harness
 *     calls `signFakeWebhook` from the controller drill to build that
 *     header.
 */
@Injectable()
export class FakeStripeDriver implements StripeDriver {
  readonly isReal = false;
  readonly kind = 'fake' as const;
  private readonly logger = new Logger(FakeStripeDriver.name);
  /** Resolved in the constructor. Tests can override via `setSecret`. */
  private secret = DEV_WEBHOOK_SECRET;

  /**
   * billing-02, guard 1 — the driver refuses to EXIST off a developer's
   * machine.
   *
   * `POST /webhooks/stripe` is unauthenticated by design (Stripe has no
   * credential to present) and exempt from maintenance/read-only mode, so the
   * signature IS the authentication. This driver used to check it against
   * `DEV_WEBHOOK_SECRET` — a literal published in this repository — while every
   * production template shipped `STRIPE_DRIVER=fake`. The auditor rewrote a
   * tenant's subscription over plain HTTP with no credential at all: starter →
   * institutional, HTTP 200.
   *
   * WHY THE RAW `process.env.NODE_ENV` AND NOT `loadEnv().nodeEnv`: this guard
   * originally read the resolved value, and `loadEnv()` defaults an UNSET
   * NODE_ENV to `development`. A verifier then obtained this driver on a
   * deployed host by simply not setting NODE_ENV — with STRIPE_DRIVER=fake and
   * BILLING_ENABLED=true — restoring the whole vulnerability. Only the raw
   * variable answers "did a human deliberately declare this a dev box?".
   *
   * `test` is trusted alongside `development` because the integration suite
   * boots the real AppModule with `STRIPE_DRIVER=fake` (vitest sets
   * NODE_ENV=test itself), and `env.ts` already treats NODE_ENV=test as a
   * local posture everywhere else — it waives the secret-strength floor and
   * ships non-Secure cookies there. A deployment running NODE_ENV=test is
   * unsafe long before it reaches this line.
   *
   * Note that on a deployed host `createStripeDriver` never gets this far: the
   * posture resolver downgrades `fake` to `disabled` so the server still boots
   * with billing off. This throw is the backstop for anything that constructs
   * the class directly.
   */
  constructor() {
    const env = loadEnv();
    if (!isTrustedLocalNodeEnv()) {
      throw new Error(
        `STRIPE_DRIVER=fake is not usable with NODE_ENV=${process.env.NODE_ENV ?? '(unset)'} — refusing to start. ` +
          'The fake driver accepts webhooks signed with a secret published in this repository, ' +
          "which lets anyone on the internet rewrite any tenant's subscription. " +
          'Use STRIPE_DRIVER=none to run with billing switched off, or STRIPE_DRIVER=real with ' +
          'STRIPE_API_KEY + STRIPE_WEBHOOK_SECRET to take payments.',
      );
    }
    // Prefer a real webhook secret when the operator configured one: handing
    // STRIPE_WEBHOOK_SECRET to the API and getting the published literal
    // enforced anyway is precisely the surprise that made this exploitable.
    if (env.stripeWebhookSecret) this.secret = env.stripeWebhookSecret;
  }

  setSecret(secret: string): void {
    this.secret = secret;
  }

  getSecret(): string {
    return this.secret;
  }

  async createCustomer(input: StripeCustomerInput): Promise<{ customerId: string }> {
    const customerId = `cus_fake_${input.tenantId}`;
    this.logger.debug(`fake stripe: createCustomer(${customerId}) for ${input.tenantSlug}`);
    return { customerId };
  }

  async createCheckoutSession(
    input: StripeCheckoutInput,
  ): Promise<{ url: string; sessionId: string }> {
    const sessionId = `cs_fake_${input.tenantId}_${Date.now().toString(36)}`;
    // The URL is informational — nothing opens in dev. The verification
    // probe posts a synthesized webhook directly to `/webhooks/stripe`.
    const url = `${input.successUrl}#fake_checkout=${sessionId}`;
    this.logger.debug(`fake stripe: createCheckoutSession(${sessionId})`);
    return { url, sessionId };
  }

  async expireCheckoutSession(sessionId: string): Promise<void> {
    // Nothing to expire — the fake never opened a real session. Dev still gets
    // the in-flight-checkout bookkeeping (the Redis marker) exercised end to
    // end; only the Stripe-side revocation is a no-op.
    this.logger.debug(`fake stripe: checkout.sessions.expire(${sessionId})`);
  }

  async createBillingPortalSession(input: StripePortalInput): Promise<{ url: string }> {
    return { url: `${input.returnUrl}#fake_portal=${input.customerId}` };
  }

  async cancelSubscriptionAtPeriodEnd(subscriptionId: string): Promise<void> {
    this.logger.debug(`fake stripe: cancel_at_period_end(${subscriptionId})`);
  }

  async resumeSubscription(subscriptionId: string): Promise<void> {
    this.logger.debug(`fake stripe: resume(${subscriptionId})`);
  }

  async changeSubscriptionPrice(input: StripePriceChangeInput): Promise<void> {
    // Nothing to mutate — the fake keeps no subscription state. Dev sees the
    // local row move only once a synthesized `customer.subscription.updated`
    // is posted to /webhooks/stripe, exactly as with a real plan change.
    this.logger.debug(
      `fake stripe: subscriptions.update(${input.subscriptionId}) → price ${input.priceId}`,
    );
  }

  /**
   * The fake keeps no subscription state, so it can only answer from the shape
   * of the id it is handed. It reports every id as `active`, which reproduces
   * the behaviour dev had before the purchase path started consulting Stripe:
   * a tracked id means "re-price in place". Exercising the reconciliation
   * branches (subscription gone / never paid) needs the real driver or a unit
   * test — a fake that guessed would only teach dev the wrong lesson.
   */
  async getSubscription(subscriptionId: string): Promise<StripeSubscriptionState | null> {
    return { id: subscriptionId, status: 'active', priceId: null };
  }

  /**
   * The fake keeps no subscription state, so it can only honestly answer "I
   * know of none" — which routes dev to the Checkout branch, exactly as it did
   * before the purchase path started asking. The branch this feeds (adopting a
   * subscription our row has not heard about yet) is covered by unit tests
   * with an explicit stub; a fake that invented a subscription id here would
   * make every dev checkout a re-price of something that does not exist.
   */
  async listSubscriptions(_customerId: string): Promise<StripeSubscriptionState[]> {
    return [];
  }

  verifyWebhookSignature(rawBody: Buffer, signatureHeader: string): StripeWebhookEvent {
    // Mirrors Stripe's "t=<unix>,v1=<hmac>" scheme. Time tolerance is 5 min.
    const parts = Object.fromEntries(
      signatureHeader.split(',').map((kv) => {
        const ix = kv.indexOf('=');
        return [kv.slice(0, ix), kv.slice(ix + 1)];
      }),
    );
    const ts = Number(parts.t);
    const sig = parts.v1;
    if (!ts || !sig) throw new Error('Malformed signature header.');
    const ageSec = Math.abs(Date.now() / 1000 - ts);
    if (ageSec > 5 * 60) throw new Error('Signature timestamp outside tolerance.');
    const expected = createHmac('sha256', this.secret)
      .update(`${ts}.${rawBody.toString('utf8')}`)
      .digest('hex');
    if (expected !== sig) throw new Error('Signature mismatch.');
    return JSON.parse(rawBody.toString('utf8')) as StripeWebhookEvent;
  }
}

/**
 * Helper for tests / drills. Builds a Stripe-shaped `stripe-signature`
 * header for a given JSON payload + secret. Mirrors what `stripe listen`
 * does in real life so the controller verification path is exercised.
 */
export function signFakeWebhook(
  payload: string | Buffer,
  secret: string,
  timestampSec = Math.floor(Date.now() / 1000),
): string {
  const body = typeof payload === 'string' ? payload : payload.toString('utf8');
  const sig = createHmac('sha256', secret).update(`${timestampSec}.${body}`).digest('hex');
  return `t=${timestampSec},v1=${sig}`;
}
