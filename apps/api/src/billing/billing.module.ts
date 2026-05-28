import { Module, type Provider } from '@nestjs/common';
import { loadEnv } from '../config/env.js';
import { AdminModule } from '../admin/admin.module.js';
import { PlansModule } from '../plans/plans.module.js';
import { RedisModule } from '../platform/redis.module.js';
import { TenantModule } from '../tenancy/tenant.module.js';
import { BillingAdminController } from './billing-admin.controller.js';
import { BillingController } from './billing.controller.js';
import { BillingService } from './billing.service.js';
import { FakeStripeDriver } from './stripe-fake.driver.js';
import { RealStripeDriver } from './stripe-real.driver.js';
import { STRIPE_DRIVER } from './stripe-driver.js';
import { StripeWebhookController } from './stripe-webhook.controller.js';

/**
 * The driver provider chooses real vs fake at boot time based on
 * `STRIPE_DRIVER`. The fake driver is also explicitly bindable so tests
 * can `app.get(FakeStripeDriver)` to set the webhook secret without
 * caring how the real one is wired.
 */
const stripeDriverProvider: Provider = {
  provide: STRIPE_DRIVER,
  useFactory: () => {
    const env = loadEnv();
    return env.stripeDriver === 'real' ? new RealStripeDriver() : new FakeStripeDriver();
  },
};

@Module({
  imports: [RedisModule, TenantModule, PlansModule, AdminModule],
  providers: [BillingService, FakeStripeDriver, stripeDriverProvider],
  controllers: [BillingController, BillingAdminController, StripeWebhookController],
  exports: [BillingService, STRIPE_DRIVER],
})
export class BillingModule {}
