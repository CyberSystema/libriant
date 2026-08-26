/**
 * The one place that knows what makes a stored Stripe price id CORRECT.
 *
 * billing-10, round 2. Round 1 built `BillingService.auditPriceCatalogue()` —
 * a real reconciliation that really fails on the seeded catalogue — and mounted
 * it at `GET /admin/billing/price-catalogue`. The refutation was not that the
 * audit is wrong; it is that `PATCH /admin/plans/:slug` still accepted
 * `{"stripeAnnualPriceId":"price_monthly_39"}` without a murmur:
 *
 *   > The audit would report it afterwards, but only if someone runs the audit.
 *
 * So the checks live here, in a module with no NestJS and no Prisma in it, and
 * BOTH readers use them: the after-the-fact audit, and `PlanPriceWriteInterceptor`,
 * which refuses the write in the first place. One implementation means the write
 * guard and the report can never disagree about what "correct" means — a split
 * would be worse than either, because an operator would fix the plan until the
 * report went green and the guard would still refuse the save.
 *
 * Amounts are integer minor units on both sides: Stripe reports `unit_amount`
 * in minor units and `plans.monthlyPriceCents` stores minor units. No float is
 * constructed anywhere in this file.
 */

import type { StripePriceState } from './stripe-driver.js';

/**
 * Prefix of the Stripe price ids the SEED writes so the
 * `plans_stripe_price_matches_mode` CHECK constraint can be satisfied before
 * anyone has a Stripe account (`price_seed_starter`, `price_seed_community`,
 * `price_seed_community_annual`, …).
 *
 * `hasStripePrice` used to be `!!plan.stripePriceId`, which is TRUE for every
 * one of these — so a completely unconfigured control plane reported a fully
 * configured price catalogue, the operator's go-live check passed on seed data,
 * and the UI rendered a Subscribe button that Stripe answers with
 * `No such price: price_seed_community`.
 */
export const SEED_PRICE_PREFIX = 'price_seed_';

/**
 * Whether a stored Stripe price id could plausibly BUY something.
 *
 * Deliberately narrower than "non-null": a real Stripe Price id starts
 * `price_`, and anything under `price_seed_` is a placeholder this repository
 * wrote itself. This is not a substitute for asking Stripe — it is the cheap
 * check that keeps the product from offering a purchase it cannot complete, on
 * every read path.
 */
export function isUsableStripePriceId(id: string | null | undefined): id is string {
  return typeof id === 'string' && id.startsWith('price_') && !id.startsWith(SEED_PRICE_PREFIX);
}

/** Which of the two price columns is being talked about. */
export type PriceColumnLabel = 'monthly' | 'annual';

/** What the plan row says this column's Price must be. */
export type PriceColumnExpectation = {
  label: PriceColumnLabel;
  id: string;
  /** Integer minor units the plan advertises. Null when the plan has no amount for this cadence. */
  expectedCents: number | null;
  /** ISO-4217 as stored on the plan (any case). */
  expectedCurrency: string;
  /** `month` for the monthly column, `year` for the annual one. */
  expectedInterval: 'month' | 'year';
};

/**
 * `null`  — Stripe has no such Price.
 * `'error'` — Stripe could not be asked (network, or the `disabled` driver
 *             refusing). Deliberately NOT collapsed into `null`: "we do not
 *             know" and "it does not exist" call for different words in front
 *             of an operator about to take money.
 */
export type PriceLookupOutcome = StripePriceState | null | 'error';

/**
 * Why an id that fails `isUsableStripePriceId` fails it, in words. Two very
 * different mistakes hide behind one boolean: a `price_seed_*` placeholder this
 * repository wrote (the shipped state of every paid plan), and a string that
 * was never a Price id at all — most often a `prod_…` Product id, which is the
 * easiest thing to copy out of the Stripe Dashboard by accident.
 */
export function unusablePriceIdProblem(label: PriceColumnLabel, id: string): string {
  if (id.startsWith(SEED_PRICE_PREFIX)) {
    return (
      `the ${label} price id "${id}" is a seeded placeholder, not a Stripe ` +
      'Price — replace it with the real id from the Stripe Dashboard'
    );
  }
  return (
    `the ${label} price id "${id}" is not a Stripe Price id — a Price id starts with ` +
    '"price_" (a "prod_" id is the Product, not the Price)'
  );
}

/**
 * Everything wrong with one price column, in the order an operator would want
 * to hear it. Empty array means this column is safe to sell.
 *
 * Every string is written to be readable on its own, because both callers
 * surface them without context: the audit lists them per plan, and the write
 * guard joins them into the 400 an admin sees on save.
 */
export function stripePriceProblems(
  expectation: PriceColumnExpectation,
  price: PriceLookupOutcome,
): string[] {
  const { label, id, expectedCents, expectedCurrency, expectedInterval } = expectation;
  if (price === 'error') {
    return [`Stripe could not be asked about the ${label} price ${id}`];
  }
  if (price === null) {
    return [`Stripe has no Price ${id} (${label}) — Checkout would fail on it`];
  }

  const problems: string[] = [];
  if (!price.active) problems.push(`the ${label} Price ${id} is archived`);
  if (price.currency.toLowerCase() !== expectedCurrency.toLowerCase()) {
    problems.push(
      `the ${label} Price ${id} is in ${price.currency.toUpperCase()} but the ` +
        `plan is priced in ${expectedCurrency.toUpperCase()}`,
    );
  }
  // Integer comparison on both sides. A Price with a null unit_amount is
  // tiered/metered, which our per-seat-free flat plans never are.
  if (expectedCents != null && price.unitAmount !== expectedCents) {
    problems.push(
      `the ${label} Price ${id} charges ${price.unitAmount ?? 'a variable amount'} ` +
        `but the plan advertises ${expectedCents} (minor units) — the page and the ` +
        'card would disagree',
    );
  }
  // The defect the finding is named for: a MONTHLY Price in the annual column
  // bills €39 every month to a library that clicked "390 € a year". Nothing in
  // the product could tell, because nothing ever asked Stripe what interval the
  // id recurs on.
  if (price.interval !== expectedInterval || price.intervalCount !== 1) {
    problems.push(
      `the ${label} Price ${id} recurs every ${price.intervalCount ?? '?'} ` +
        `${price.interval ?? 'one-off'} — the ${label} column must hold a ` +
        `1-${expectedInterval} Price`,
    );
  }
  return problems;
}
