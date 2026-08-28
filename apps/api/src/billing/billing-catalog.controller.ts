import { Controller, Get, Inject, UseGuards } from '@nestjs/common';
import { AdminAuthGuard } from '../admin/admin-auth.guard.js';
import { AdminRolesGuard } from '../admin/admin-roles.guard.js';
import { AdminRoles } from '../admin/admin-roles.decorator.js';
import { BillingService } from './billing.service.js';

/**
 * The price-catalogue reconciliation endpoint (billing-10).
 *
 *   GET /admin/billing/price-catalogue
 *
 * WHY IT EXISTS. Nothing in the product ever compared `plans.stripePriceId` /
 * `plans.stripeAnnualPriceId` with Stripe. `PATCH /admin/plans/:slug` accepts
 * either column as a bare string — no format check, no Stripe round trip, no
 * check that the amount, the currency or the recurring INTERVAL match the
 * column being written. A monthly id pasted into the annual column bills €39 a
 * month to a library that clicked "390 € a year", and every check the product
 * performed still passed. Worse, the go-live verification an operator was told
 * to run asked whether `hasStripeAnnualPrice` was true — computed as
 * `!!stripeAnnualPriceId`, which is true for every `price_seed_*` placeholder
 * the seed ships. The one mechanical safeguard reported success on exactly the
 * unconfigured database it existed to catch.
 *
 * This is read-only and owner-gated, it costs one Stripe `prices.retrieve` per
 * DISTINCT id in the catalogue (memoised, so a duplicated id is one call), and
 * it is the check `docs/RUNBOOK.md` §4.3c sends the operator to. It
 * reports `ok:false` with a plain-language reason per plan, so it can FAIL —
 * which is the property the old check lacked.
 *
 * It is not a substitute for validating the PATCH itself; see the package
 * report for the change `admin-plans.controller.ts` still needs, which this
 * package does not own.
 */
@Controller('admin/billing')
@UseGuards(AdminAuthGuard, AdminRolesGuard)
export class BillingCatalogController {
  constructor(@Inject(BillingService) private readonly svc: BillingService) {}

  @Get('price-catalogue')
  @AdminRoles('owner')
  async priceCatalogue() {
    return this.svc.auditPriceCatalogue();
  }
}
