import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * billing-02, wave 2. `STRIPE_DRIVER=fake` was doing two unrelated jobs —
 * "billing is switched off" and "pretend to be Stripe" — and `.env.prod.example`,
 * `ensure-env.sh` and the production compose file all wrote it. Because the
 * fake verified webhook signatures against a literal published in this
 * repository, and `POST /webhooks/stripe` is unauthenticated by design, the
 * auditor moved a tenant from starter to institutional over plain HTTP with no
 * credential at all.
 *
 * Wave 1 made the fake's constructor throw off a dev machine, which turned the
 * SHIPPED configuration into a crash-loop and left `NODE_ENV=test` / an unset
 * NODE_ENV as the operator's only escapes — the second of which
 * `config/env.ts` reads as `development`, restoring the hole in full. A
 * verifier executed exactly that.
 *
 * These tests pin the posture that replaced it: three values, `none` shipped
 * by default, and no path from a deployed host to the stand-in.
 */
const { env } = vi.hoisted(() => ({
  env: { billingEnabled: false },
}));

// Everything except BILLING_ENABLED is derived from process.env, because the
// posture resolver reads process.env directly and the drivers must agree with
// it. Faking the two apart is how you write a green test for a broken boot.
vi.mock('../config/env.js', () => ({
  loadEnv: () => ({
    billingEnabled: env.billingEnabled,
    nodeEnv: process.env.NODE_ENV ?? 'development',
    stripeApiKey: process.env.STRIPE_API_KEY || null,
    stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET || null,
  }),
}));

import { createStripeDriver } from './stripe-driver.factory.js';
import { resolveStripeDriverKind } from './stripe-driver-kind.js';
import { DisabledStripeDriver } from './stripe-disabled.driver.js';
import { FakeStripeDriver, signFakeWebhook } from './stripe-fake.driver.js';

/** The secret the fake used to accept unconditionally — it is in git. */
const PUBLISHED_LITERAL = 'fake-webhook-secret-for-dev';

const EVENT = JSON.stringify({
  id: 'evt_forged',
  type: 'customer.subscription.updated',
  data: { object: { id: 'sub_forged' } },
});

const SAVED = { ...process.env };

/** Set the three variables the posture depends on, clearing any leftovers. */
function setEnv(vars: {
  NODE_ENV?: string;
  STRIPE_DRIVER?: string;
  STRIPE_API_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
}) {
  for (const key of ['NODE_ENV', 'STRIPE_DRIVER', 'STRIPE_API_KEY', 'STRIPE_WEBHOOK_SECRET']) {
    delete process.env[key];
  }
  Object.assign(process.env, vars);
}

beforeEach(() => {
  env.billingEnabled = false;
  setEnv({ NODE_ENV: 'development' });
});

afterEach(() => {
  for (const key of ['NODE_ENV', 'STRIPE_DRIVER', 'STRIPE_API_KEY', 'STRIPE_WEBHOOK_SECRET']) {
    delete process.env[key];
    if (SAVED[key] !== undefined) process.env[key] = SAVED[key];
  }
});

describe('resolveStripeDriverKind — the three postures', () => {
  it('gives production the DISABLED driver as shipped: STRIPE_DRIVER=none boots', () => {
    // The exact configuration written by .env.prod.example, ensure-env.sh and
    // docker-compose.prod.yml. Wave 1 crash-looped on this.
    setEnv({ NODE_ENV: 'production', STRIPE_DRIVER: 'none' });
    expect(createStripeDriver()).toBeInstanceOf(DisabledStripeDriver);
  });

  it.each(['off', 'disabled', 'NONE'])('accepts %s as the disabled posture', (raw) => {
    setEnv({ NODE_ENV: 'production', STRIPE_DRIVER: raw });
    expect(resolveStripeDriverKind().kind).toBe('disabled');
  });

  it('downgrades a legacy STRIPE_DRIVER=fake on a deployed host to disabled, and BOOTS', () => {
    // Every .env.prod provisioned before this change carries `fake`, and
    // ensure-env.sh never overwrites an existing value. Throwing here would
    // crash-loop those hosts on the very deploy that ships the fix.
    setEnv({ NODE_ENV: 'production', STRIPE_DRIVER: 'fake' });
    const posture = resolveStripeDriverKind();
    expect(posture.kind).toBe('disabled');
    expect(posture.downgradedFrom).toBe('fake');
    expect(posture.reason).toMatch(/published in this repository/);
    expect(createStripeDriver()).toBeInstanceOf(DisabledStripeDriver);
  });

  it('cannot be talked into the fake by UNSETTING NODE_ENV (the executed bypass)', () => {
    // config/env.ts defaults an unset NODE_ENV to 'development'. Deciding
    // "may this host have the stand-in?" from that value is what let a
    // verifier construct the fake on a deployed host with STRIPE_DRIVER=fake
    // and BILLING_ENABLED=true.
    setEnv({ STRIPE_DRIVER: 'fake' });
    expect(resolveStripeDriverKind().kind).toBe('disabled');
    expect(createStripeDriver()).not.toBeInstanceOf(FakeStripeDriver);
  });

  it('cannot be talked into the fake by NODE_ENV=staging either', () => {
    setEnv({ NODE_ENV: 'staging', STRIPE_DRIVER: 'fake' });
    expect(createStripeDriver()).toBeInstanceOf(DisabledStripeDriver);
  });

  it.each(['development', 'test'])('still hands dev/test the fake under NODE_ENV=%s', (node) => {
    setEnv({ NODE_ENV: node, STRIPE_DRIVER: 'fake' });
    expect(createStripeDriver()).toBeInstanceOf(FakeStripeDriver);
  });

  it('an unset STRIPE_DRIVER with credentials still means "real" (env.ts parity)', () => {
    setEnv({
      NODE_ENV: 'production',
      STRIPE_API_KEY: 'sk_test_x',
      STRIPE_WEBHOOK_SECRET: 'whsec_x',
    });
    expect(resolveStripeDriverKind().kind).toBe('real');
  });

  it('an unset STRIPE_DRIVER with no credentials boots disabled rather than dying on "real"', () => {
    setEnv({ NODE_ENV: 'production' });
    expect(createStripeDriver()).toBeInstanceOf(DisabledStripeDriver);
  });

  it('THROWS on a typo rather than silently picking a posture', () => {
    setEnv({ NODE_ENV: 'production', STRIPE_DRIVER: 'reall' });
    expect(() => resolveStripeDriverKind()).toThrow(/not a recognised value/);
  });
});

describe('createStripeDriver — enforcement armed with nothing to charge with', () => {
  it('refuses to boot when BILLING_ENABLED is on and no driver can transact', () => {
    setEnv({ NODE_ENV: 'production', STRIPE_DRIVER: 'none' });
    env.billingEnabled = true;
    expect(() => createStripeDriver()).toThrow(/refusing to start/i);
  });

  it('refuses on the legacy fake+enforcement combination too', () => {
    setEnv({ NODE_ENV: 'production', STRIPE_DRIVER: 'fake' });
    env.billingEnabled = true;
    expect(() => createStripeDriver()).toThrow(/BILLING_ENABLED is on/);
  });

  it.each(['development', 'test'])(
    'allows the fake with enforcement on under NODE_ENV=%s (the integration suite runs exactly this)',
    (node) => {
      setEnv({ NODE_ENV: node, STRIPE_DRIVER: 'fake' });
      env.billingEnabled = true;
      expect(createStripeDriver()).toBeInstanceOf(FakeStripeDriver);
    },
  );
});

describe('createStripeDriver — the real driver is still reachable', () => {
  it('hands back the real driver whenever STRIPE_DRIVER=real with keys', () => {
    setEnv({
      NODE_ENV: 'production',
      STRIPE_DRIVER: 'real',
      STRIPE_API_KEY: 'sk_test_not_a_real_key',
      STRIPE_WEBHOOK_SECRET: 'whsec_not_a_real_secret',
    });
    env.billingEnabled = true;
    expect(createStripeDriver().isReal).toBe(true);
  });
});

describe('DisabledStripeDriver — refuses instead of pretending', () => {
  it('never verifies a webhook, so the published literal buys nothing', () => {
    const driver = new DisabledStripeDriver();
    const body = Buffer.from(EVENT);
    expect(() =>
      driver.verifyWebhookSignature(body, signFakeWebhook(body, PUBLISHED_LITERAL)),
    ).toThrow(/not configured/i);
  });

  it('refuses every money-moving operation', async () => {
    const driver = new DisabledStripeDriver();
    await expect(driver.createCheckoutSession({} as never)).rejects.toThrow(/not configured/i);
    await expect(driver.createCustomer({} as never)).rejects.toThrow(/not configured/i);
    await expect(driver.changeSubscriptionPrice({} as never)).rejects.toThrow(/not configured/i);
  });
});

describe('FakeStripeDriver — refuses to EXIST off a declared dev/test box', () => {
  it.each(['production', 'staging'])('throws under NODE_ENV=%s', (node) => {
    setEnv({ NODE_ENV: node });
    expect(() => new FakeStripeDriver()).toThrow(/refusing to start/i);
  });

  it('throws when NODE_ENV is UNSET, even though env.ts would call that development', () => {
    setEnv({});
    expect(() => new FakeStripeDriver()).toThrow(/refusing to start/i);
  });

  it('names both production exits, not just STRIPE_DRIVER=real', () => {
    setEnv({ NODE_ENV: 'production' });
    expect(() => new FakeStripeDriver()).toThrow(/STRIPE_DRIVER=none/);
  });

  it.each(['development', 'test'])('still constructs under NODE_ENV=%s', (node) => {
    setEnv({ NODE_ENV: node });
    expect(new FakeStripeDriver().isReal).toBe(false);
  });

  it('enforces the operator-configured STRIPE_WEBHOOK_SECRET when there is one', () => {
    // The audit printed `driver secret in use : fake-webhook-secret-for-dev`
    // with STRIPE_WEBHOOK_SECRET set to a real whsec_… — the fake ignored it.
    setEnv({ NODE_ENV: 'development', STRIPE_WEBHOOK_SECRET: 'whsec_the_operator_set_a_real_one' });
    const driver = new FakeStripeDriver();
    const body = Buffer.from(EVENT);

    expect(() =>
      driver.verifyWebhookSignature(body, signFakeWebhook(body, PUBLISHED_LITERAL)),
    ).toThrow(/Signature mismatch/);
    expect(
      driver.verifyWebhookSignature(
        body,
        signFakeWebhook(body, 'whsec_the_operator_set_a_real_one'),
      ).id,
    ).toBe('evt_forged');
  });

  it('falls back to the published literal only when nothing is configured', () => {
    setEnv({ NODE_ENV: 'development' });
    const driver = new FakeStripeDriver();
    const body = Buffer.from(EVENT);
    expect(driver.verifyWebhookSignature(body, signFakeWebhook(body, PUBLISHED_LITERAL)).id).toBe(
      'evt_forged',
    );
  });
});
