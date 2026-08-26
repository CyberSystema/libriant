import { Module, type Provider } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { AdminModule } from '../admin/admin.module.js';
import { PlansModule } from '../plans/plans.module.js';
import { PlatformSettingsModule } from '../platform-settings/platform-settings.module.js';
import { RedisModule } from '../platform/redis.module.js';
import { TenantModule } from '../tenancy/tenant.module.js';
import { BillingAdminController } from './billing-admin.controller.js';
import { BillingCatalogController } from './billing-catalog.controller.js';
import { BillingController } from './billing.controller.js';
import { BillingService } from './billing.service.js';
import { PlanPriceWriteInterceptor } from './plan-price-write.interceptor.js';
import { createStripeDriver } from './stripe-driver.factory.js';
import { STRIPE_DRIVER } from './stripe-driver.js';
import { StripeWebhookController } from './stripe-webhook.controller.js';

/**
 * The driver provider resolves one of three postures at boot from
 * `STRIPE_DRIVER` — real, disabled (the shipped default: no driver at all,
 * every billing operation and the webhook route refuse) or fake (development
 * and tests only) — and refuses to boot on the one configuration that cannot
 * be reconciled, enforcement armed with nothing that can take a payment. See
 * `createStripeDriver` and `resolveStripeDriverKind`.
 *
 * Neither concrete driver is bound as a provider of its own: nothing injects
 * them by class (a test that needs one reaches for STRIPE_DRIVER), and a
 * second binding would construct a second instance — which, since billing-02,
 * throws outright for the fake anywhere but a declared dev/test box.
 */
const stripeDriverProvider: Provider = {
  provide: STRIPE_DRIVER,
  useFactory: () => createStripeDriver(),
};

@Module({
  imports: [RedisModule, TenantModule, PlansModule, AdminModule, PlatformSettingsModule],
  providers: [
    BillingService,
    stripeDriverProvider,
    /**
     * billing-10, round 2. The catalogue audit reports a bad Stripe price id
     * AFTER it has been saved — "only if someone runs the audit", as the
     * refutation put it. This refuses the save.
     *
     * Registered here rather than in `app.module.ts` because the invariant is
     * billing's and `BillingModule` already imports `AdminModule` (so the plans
     * controller cannot inject billing without closing a module cycle).
     * `APP_INTERCEPTOR` is honoured from any module — the same registration
     * shape `SupportAuditInterceptor` uses. Being global costs one class
     * identity comparison per request; everything else is behind that check.
     */
    { provide: APP_INTERCEPTOR, useClass: PlanPriceWriteInterceptor },
  ],
  controllers: [
    BillingController,
    BillingAdminController,
    // billing-10: the catalogue reconciliation an operator runs before going
    // live. Mounted here so it is a real, reachable route rather than a helper
    // nothing calls.
    BillingCatalogController,
    StripeWebhookController,
  ],
  exports: [BillingService, STRIPE_DRIVER],
})
export class BillingModule {}
