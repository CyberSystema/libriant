/**
 * Every integration spec states, in its own file, which subscriptions posture
 * it is testing. There is no default.
 *
 * History, because both mistakes have now been made:
 *
 *   1. `setup.ts` forced `BILLING_ENABLED=true` for the WHOLE suite. The
 *      product ships with subscriptions OFF, so every integration run
 *      exercised the opposite of the shipped configuration — which is how a
 *      bigint overflow that 500'd every single file upload with billing off
 *      survived to the pre-release audit (data-integrity-01).
 *   2. The fix replaced that with a one-entry filename allowlist, defaulting
 *      everything else to OFF. That is the same bug pointed the other way:
 *      with billing off `EffectivePlanService` returns `unlimitedPlan()` —
 *      every bool gate ON and every int limit lifted — so nine of ten files
 *      silently ran with no plan enforcement at all, and a spec that meant to
 *      prove a closed gate would have passed against an open one.
 *
 * A suite-wide default is wrong in BOTH directions, because the posture is not
 * a property of the suite: it is a property of what each spec is trying to
 * prove. So there is no default. `setup.ts` unsets `BILLING_ENABLED` and fails
 * any file that did not call `declareBillingPosture(...)` before its tests run.
 *
 * Call it at MODULE scope, not inside a hook:
 *
 *     declareBillingPosture('unenforced', 'why this spec needs it');
 *
 * Module scope is late enough (`loadEnv()` re-reads `process.env` on every
 * call and nothing caches `billingEnabled`) and early enough (it runs before
 * any `beforeAll`, so it is set before the Nest app boots).
 */

/**
 * - `unenforced` — subscriptions OFF. THE LAUNCH CONFIGURATION: every int
 *   limit resolves to the `UNLIMITED_INT` sentinel and every bool feature is
 *   true. Anything that is not about a plan gate belongs here, because this is
 *   what customers actually run.
 * - `enforced` — subscriptions ON. Only for a spec that exists to prove a plan
 *   gate REFUSES something; under `unenforced` that assertion is vacuous.
 */
export type BillingPosture = 'unenforced' | 'enforced';

let declared: { posture: BillingPosture; why: string } | null = null;

/**
 * Pin this spec file's subscriptions posture. `why` is not decoration — an
 * undocumented `enforced` is how the suite drifted away from the shipped
 * configuration the first time.
 */
export function declareBillingPosture(posture: BillingPosture, why: string): void {
  if (!why.trim()) throw new Error('declareBillingPosture requires a reason.');
  if (declared && declared.posture !== posture) {
    // Two conflicting declarations in one process means one of them is a lie
    // about what the file runs under. Refuse rather than let last-write-wins
    // decide which half of the file is testing nothing.
    throw new Error(
      `Conflicting billing postures declared in one spec file: ` +
        `"${declared.posture}" then "${posture}".`,
    );
  }
  declared = { posture, why };
  // The env var is the bootstrap default PlatformSettingsService falls back to
  // when no `platform_settings` row exists. A spec that needs the switch to
  // change MID-file writes the row (and busts the Redis cache) itself — see
  // storage-quota.spec.ts.
  process.env.BILLING_ENABLED = posture === 'enforced' ? 'true' : 'false';
}

/** What this file declared, or null if it never did. Read by setup.ts. */
export function declaredBillingPosture(): { posture: BillingPosture; why: string } | null {
  return declared;
}
