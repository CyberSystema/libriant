/**
 * The single authority on which Stripe posture this process is in.
 *
 * WHY THIS EXISTS AT ALL (billing-02, wave 2).
 * `STRIPE_DRIVER=fake` was doing two unrelated jobs: "billing is switched off"
 * and "pretend to be Stripe". Every production template shipped `fake`, so a
 * server with billing off was running a stand-in whose webhook signature check
 * used a literal published in this repository — and `POST /webhooks/stripe` is
 * unauthenticated by design, so the auditor rewrote a tenant's subscription
 * over plain HTTP. Wave 1 fixed the symptom by making the fake driver's
 * constructor throw off a dev machine, which turned the SHIPPED configuration
 * into a crash-loop: the templates still wrote `fake`, and the only escape an
 * operator without Stripe keys had was `NODE_ENV=test` or unsetting NODE_ENV —
 * and an unset NODE_ENV is read as `development` by config/env.ts, which
 * restores the original hole in full.
 *
 * So the two jobs are split into three postures:
 *
 *   real     — the Stripe API. Requires STRIPE_API_KEY + STRIPE_WEBHOOK_SECRET.
 *   disabled — NO Stripe driver at all. Every billing operation refuses and
 *              `POST /webhooks/stripe` answers 503 instead of verifying a
 *              signature against anything. This is the shipped default.
 *   fake     — the in-memory stand-in. Development and the test suite ONLY.
 *
 * WHY IT READS `process.env` DIRECTLY instead of `loadEnv()`:
 *
 *   1. `AppEnv.stripeDriver` is typed `'real' | 'fake'` — it cannot express
 *      "disabled", and collapsing the third posture into either of the other
 *      two is the exact conflation this file exists to undo.
 *   2. `loadEnv()` defaults an UNSET `NODE_ENV` to `'development'`. Deciding
 *      "may this host have the fake driver?" from that value means an operator
 *      can obtain the fake on a deployed host simply by not setting NODE_ENV.
 *      The raw variable is the only thing that answers the question honestly.
 */

export type StripeDriverKind = 'real' | 'fake' | 'disabled';

export type StripeDriverPosture = {
  kind: StripeDriverKind;
  /**
   * Set when the requested posture was DOWNGRADED (always to `disabled`).
   * The caller logs it at error level: the operator asked for something the
   * server refused to give them and needs to know why billing is off.
   */
  downgradedFrom?: string;
  /** Human-readable explanation of the downgrade, for the boot log. */
  reason?: string;
};

/**
 * `development` and `test` are the trusted-local pair config/env.ts already
 * uses for the secret-strength floor and the cookie `Secure` flag. A host
 * running either of them is unsafe long before it reaches billing.
 *
 * Deliberately reads the RAW variable: an unset NODE_ENV is NOT trusted-local
 * here, even though `loadEnv()` reports it as `development`. That default is a
 * quickstart convenience; letting it unlock the fake driver would hand a
 * deployed host the unauthenticated-webhook-writer back.
 */
export function isTrustedLocalNodeEnv(): boolean {
  const raw = process.env.NODE_ENV;
  return raw === 'development' || raw === 'test';
}

/** True when both Stripe credentials the real driver needs are present. */
function hasStripeCredentials(): boolean {
  return !!process.env.STRIPE_API_KEY?.length && !!process.env.STRIPE_WEBHOOK_SECRET?.length;
}

/**
 * Resolve the posture for this process. Pure — safe to call from a constructor
 * and from a request path alike.
 *
 * Accepted `STRIPE_DRIVER` values: `real`, `fake`, `none` (aliases `off`,
 * `disabled`). An unrecognised value THROWS rather than defaulting: a typo in
 * a variable with three legal settings is a monetization outage or a security
 * posture change, and silently picking one of them is how we got here.
 */
export function resolveStripeDriverKind(): StripeDriverPosture {
  const raw = (process.env.STRIPE_DRIVER ?? '').toLowerCase().trim();

  if (raw === 'real') return { kind: 'real' };

  if (raw === 'none' || raw === 'off' || raw === 'disabled') return { kind: 'disabled' };

  if (raw === 'fake') {
    if (isTrustedLocalNodeEnv()) return { kind: 'fake' };
    // Every host provisioned before this change carries `STRIPE_DRIVER=fake`
    // in its .env.prod, and `ensure-env.sh` never overwrites an existing
    // value. Throwing here would crash-loop those hosts on the deploy that
    // ships this code — for a setting whose intended meaning ("we are not
    // taking payments") the `disabled` posture serves perfectly. So downgrade
    // loudly instead of refusing to boot: the operator gets a server that
    // works with billing off, plus an error in the log naming the fix.
    return {
      kind: 'disabled',
      downgradedFrom: 'fake',
      reason:
        `STRIPE_DRIVER=fake is not usable with NODE_ENV=${process.env.NODE_ENV ?? '(unset)'} — ` +
        'running with billing DISABLED instead. The fake driver accepts webhooks signed with a ' +
        'secret published in this repository, which would let anyone on the internet rewrite any ' +
        "tenant's subscription. Set STRIPE_DRIVER=none to make this explicit, or STRIPE_DRIVER=real " +
        'with STRIPE_API_KEY + STRIPE_WEBHOOK_SECRET to take payments.',
    };
  }

  if (raw === '') {
    // Unset. Keys present means the operator plainly intends to charge and
    // merely forgot the switch — honour that, exactly as config/env.ts does.
    if (hasStripeCredentials()) return { kind: 'real' };
    // Keys absent: on a dev/test box the fake is the quickstart default that
    // has always applied here. Anywhere else, `disabled` — which is a posture
    // that BOOTS, unlike config/env.ts's "assume real" default, whose only
    // outcome without credentials is RealStripeDriver throwing at startup.
    return isTrustedLocalNodeEnv() ? { kind: 'fake' } : { kind: 'disabled' };
  }

  throw new Error(
    `STRIPE_DRIVER="${process.env.STRIPE_DRIVER}" is not a recognised value. ` +
      'Use "real" (Stripe API, needs STRIPE_API_KEY + STRIPE_WEBHOOK_SECRET), ' +
      '"none" (billing switched off — no driver, webhooks refused), ' +
      'or "fake" (in-memory stand-in, development and tests only).',
  );
}
