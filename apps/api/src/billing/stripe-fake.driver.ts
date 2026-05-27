import { createHmac } from 'crypto';
import { Injectable, Logger } from '@nestjs/common';
import type {
  StripeCheckoutInput,
  StripeCustomerInput,
  StripeDriver,
  StripePortalInput,
  StripeWebhookEvent,
} from './stripe-driver.js';

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
  private readonly logger = new Logger(FakeStripeDriver.name);
  /** Default fake secret. Tests can override via `setSecret`. */
  private secret = 'fake-webhook-secret-for-dev';

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

  async createBillingPortalSession(input: StripePortalInput): Promise<{ url: string }> {
    return { url: `${input.returnUrl}#fake_portal=${input.customerId}` };
  }

  async cancelSubscriptionAtPeriodEnd(subscriptionId: string): Promise<void> {
    this.logger.debug(`fake stripe: cancel_at_period_end(${subscriptionId})`);
  }

  async resumeSubscription(subscriptionId: string): Promise<void> {
    this.logger.debug(`fake stripe: resume(${subscriptionId})`);
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
