/**
 * The admin panel's view of `GET /admin/billing/price-catalogue`.
 *
 * billing-14. `PlatformSettingsService.subscriptionsStatus()` has returned
 * `stripeReady` since A5-03, with a comment saying "the admin UI can warn that
 * checkout won't really charge" — and `grep -rn stripeReady apps/web` returned
 * nothing. The value was computed for a reader that did not exist, so an
 * operator on a host that cannot charge a card saw a completely normal admin
 * panel and discovered the problem when the Subscriptions toggle threw at them.
 *
 * billing-10. The price reconciliation shipped as an endpoint an operator was
 * told to curl. "The audit would report it afterwards, but only if someone runs
 * the audit." Rendering it here is what makes it something people read.
 *
 * The admin panel is English-only (it has no translation catalogue and
 * `pnpm check:translations` does not cover it), so these strings are literals
 * by design — the same as every other string on these pages.
 */

export type PriceCataloguePlan = {
  slug: string;
  billingMode: 'stripe' | 'manual';
  currency: string;
  monthlyPriceCents: number;
  annualPriceCents: number | null;
  stripePriceId: string | null;
  stripeAnnualPriceId: string | null;
  /** Empty when this plan is safe to sell. */
  problems: string[];
  /** True but not a defect — e.g. the free tier's forced placeholder id. */
  notes: string[];
};

export type PriceCatalogue = {
  driver: 'real' | 'fake' | 'disabled';
  /** Can this host charge a card at all? */
  stripeReady: boolean;
  billingEnabled: boolean;
  /** Would the Subscriptions master switch accept being turned on right now? */
  subscriptionsCanBeEnabled: boolean;
  /** Why not, in plain language. Null when it would be accepted. */
  blockReason: string | null;
  ok: boolean;
  checkedAt: string;
  plans: PriceCataloguePlan[];
};

export function priceCatalogueFor(
  catalogue: PriceCatalogue | null,
  slug: string,
): PriceCataloguePlan | null {
  return catalogue?.plans.find((p) => p.slug === slug) ?? null;
}

export type StripeStateBanner = {
  severity: 'critical' | 'warning' | 'info';
  title: string;
  body: string;
};

/**
 * The banner that carries `stripeReady` to a human. Null only when this host
 * can charge and there is nothing to warn about.
 *
 * Severity is chosen by CONSEQUENCE, not by tidiness:
 *   - subscriptions already ON but nothing can charge → critical. Libraries are
 *     being gated behind a purchase this server cannot complete right now.
 *   - subscriptions off and nothing can charge → warning. Nothing is broken
 *     today; the operator simply cannot go live from this host, and finding
 *     that out from the toggle's exception is the defect being fixed.
 */
export function stripeStateBanner(catalogue: PriceCatalogue | null): StripeStateBanner | null {
  if (!catalogue) return null;
  if (catalogue.stripeReady) return null;

  const reason =
    catalogue.blockReason ??
    `STRIPE_DRIVER resolves to "${catalogue.driver}" on this host, so nothing here can take a payment.`;

  if (catalogue.billingEnabled) {
    return {
      severity: 'critical',
      title: 'Subscriptions are ON but this server cannot charge a card',
      body:
        `${reason} Every library is being asked to choose a plan it cannot pay for. ` +
        'Fix the driver or turn Subscriptions off until you can.',
    };
  }
  return {
    severity: 'warning',
    title: 'This server cannot charge a card',
    body:
      `${reason} The Subscriptions master switch will refuse to turn on until that is fixed, ` +
      'and the price ids below cannot be verified against Stripe.',
  };
}
