import { Module, type Provider } from '@nestjs/common';
import { AdminModule } from '../admin/admin.module.js';
import { PlansModule } from '../plans/plans.module.js';
import { PlatformSettingsModule } from '../platform-settings/platform-settings.module.js';
import { RedisModule } from '../platform/redis.module.js';
import { TenantModule } from '../tenancy/tenant.module.js';
import { BillingAdminController } from './billing-admin.controller.js';
import { BillingCatalogController } from './billing-catalog.controller.js';
import { BillingController } from './billing.controller.js';
import { BillingService } from './billing.service.js';
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
  providers: [BillingService, stripeDriverProvider],
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
