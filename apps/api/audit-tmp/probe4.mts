import { controlDb } from '@libriant/db-control';
import { RedisService } from '../src/platform/redis.service.js';
import { PlatformSettingsService } from '../src/platform-settings/platform-settings.service.js';
import { EffectivePlanService } from '../src/plans/effective-plan.service.js';
import { FakeStripeDriver } from '../src/billing/stripe-fake.driver.js';
import { BillingService } from '../src/billing/billing.service.js';

const redis = new RedisService();
const settings = new PlatformSettingsService(redis);
const billing = new BillingService(new EffectivePlanService(redis, settings), new FakeStripeDriver(), settings);

// Who does Prisma pick for `stripeCustomerId: null`?
const victim = await controlDb.billingAccount.findFirst({ where: { stripeCustomerId: null } });
console.log('first billing account with a NULL stripeCustomerId:', victim?.tenantId, victim?.billingEmail);
const beforeRow = await controlDb.subscription.findUnique({ where: { tenantId: victim!.tenantId }, include: { plan: true } });
console.log('victim before:', beforeRow?.plan.slug, beforeRow?.status);

const now = Math.floor(Date.now()/1000);
await billing.syncStripeSubscription({
  id: 'sub_nullcustomer', customer: null as never, status: 'active',
  cancel_at_period_end: false, canceled_at: null,
  items: { data: [{ price: { id: 'price_seed_institutional' },
    current_period_start: now, current_period_end: now+2592000 }] },
} as never);
const afterRow = await controlDb.subscription.findUnique({ where: { tenantId: victim!.tenantId }, include: { plan: true } });
console.log('victim after :', afterRow?.plan.slug, afterRow?.status, afterRow?.stripeSubscriptionId);

await redis.onModuleDestroy(); await controlDb.$disconnect();
