import { IsDateString, IsIn, IsOptional, IsString, Length, Matches } from 'class-validator';

const PLAN_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$/;

export class StartCheckoutDto {
  /** Plan slug to upgrade/downgrade to. Must be `billingMode=stripe`. */
  @IsString()
  @Matches(PLAN_SLUG_RE)
  planSlug!: string;

  /**
   * Billing cadence. Defaults to monthly so an older client that does not send
   * it keeps working. Annual is ten months for twelve and is what Greek public
   * buyers actually contract on.
   */
  @IsOptional()
  @IsIn(['month', 'year'])
  interval?: 'month' | 'year';

  /**
   * Optional path the user should land on after Stripe Checkout completes
   * (`/billing?upgrade=success` etc). Resolved against `BILLING_RETURN_URL`.
   */
  @IsOptional()
  @IsString()
  @Length(1, 200)
  returnPath?: string;
}

export class OpenPortalDto {
  @IsOptional()
  @IsString()
  @Length(1, 200)
  returnPath?: string;
}

/**
 * Library-side: record the library's explicit plan choice (the chooser shown
 * when subscriptions are enabled but no plan was picked yet). Only valid for
 * free plans — paid plans must go through Stripe Checkout (`/checkout`).
 */
export class SelectPlanDto {
  @IsString()
  @Matches(PLAN_SLUG_RE)
  planSlug!: string;
}

/**
 * Admin-side: force a tenant onto a specific plan without payment. Used
 * for support sessions, on-prem contracts, and the manual-billing flow.
 */
export class AdminSetPlanDto {
  @IsString()
  @Matches(PLAN_SLUG_RE)
  planSlug!: string;
}

/**
 * Admin-side: extend a manual-billing tenant's paid-until date. Used when
 * the library has paid by bank transfer / invoice and we want to keep
 * features unlocked through the next billing period.
 */
export class AdminSetPaidUntilDto {
  @IsDateString()
  paidUntil!: string;
}
