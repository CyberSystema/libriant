import { Logger } from '@nestjs/common';
import { loadEnv } from '../config/env.js';
import type { StripeDriver } from './stripe-driver.js';
import { resolveStripeDriverKind } from './stripe-driver-kind.js';
import { DisabledStripeDriver } from './stripe-disabled.driver.js';
import { FakeStripeDriver } from './stripe-fake.driver.js';
import { RealStripeDriver } from './stripe-real.driver.js';

const logger = new Logger('StripeDriverFactory');

/**
 * Pick the Stripe driver for this process.
 *
 * billing-02. `STRIPE_DRIVER=fake` used to mean two different things —
 * "billing is switched off" and "pretend to be Stripe" — and every production
 * template shipped it, which put an unauthenticated remote-write endpoint
 * (signature verified against a literal published in this repository) on every
 * deployed host. `resolveStripeDriverKind()` separates the two jobs into three
 * postures; this function turns a posture into an object.
 *
 * The shipped default is `disabled`: a server that is not taking payments
 * carries NO Stripe driver, refuses every billing operation with a 503, and
 * answers `POST /webhooks/stripe` with a 503 instead of verifying anything.
 *
 * WHY THE DOWNGRADE PATH IS A LOG LINE AND NOT A THROW: wave 1 made the fake
 * driver's constructor throw off a dev machine, which turned the shipped
 * configuration into a crash-loop — the templates still wrote `fake`, and so
 * does every .env.prod provisioned before this change (ensure-env.sh never
 * overwrites an existing value). Refusing to boot punishes the operator for a
 * setting whose intent, "we are not charging anyone", the `disabled` posture
 * satisfies exactly. So `fake` on a deployed host becomes `disabled` plus a
 * loud error in the log. The one configuration we still refuse outright is
 * below, and it is refused because there is no safe way to guess what was
 * meant.
 */
export function createStripeDriver(): StripeDriver {
  const env = loadEnv();
  const posture = resolveStripeDriverKind();

  if (posture.kind === 'real') return new RealStripeDriver();

  if (posture.reason) {
    // The operator asked for something we would not give them. Say so at error
    // level: from their point of view billing has silently stopped existing.
    logger.error(posture.reason);
  }

  // The one hard refusal. `BILLING_ENABLED=true` arms plan and quota
  // enforcement for every tenant; with no driver that can transact, every
  // library is gated into a dead end with no way to pay its way out, and the
  // admin "Subscriptions" toggle (guard 3) is not on the boot path to stop it.
  // Both halves of this are a deliberate operator action, so neither one is
  // safe to override on their behalf — fail loudly and name both exits.
  if (env.billingEnabled && posture.kind === 'disabled') {
    throw new Error(
      `BILLING_ENABLED is on but no Stripe driver is available (STRIPE_DRIVER=${
        process.env.STRIPE_DRIVER || '(unset)'
      }, NODE_ENV=${process.env.NODE_ENV ?? '(unset)'}) — refusing to start. ` +
        'Plan and quota enforcement would gate every library with no way to purchase. ' +
        'Set STRIPE_DRIVER=real with STRIPE_API_KEY + STRIPE_WEBHOOK_SECRET, or turn BILLING_ENABLED off.',
    );
  }

  if (posture.kind === 'disabled') return new DisabledStripeDriver();

  // `fake` only ever comes back for an explicitly declared development/test
  // NODE_ENV (see resolveStripeDriverKind), which is precisely where the
  // integration suite runs the whole enforcement path with BILLING_ENABLED=true
  // against the stand-in.
  return new FakeStripeDriver();
}
