import { controlDb } from '@libriant/db-control';
import { RedisService } from '../src/platform/redis.service.js';
import { PlatformSettingsService } from '../src/platform-settings/platform-settings.service.js';
import { EffectivePlanService } from '../src/plans/effective-plan.service.js';
import { FakeStripeDriver } from '../src/billing/stripe-fake.driver.js';
import { BillingService } from '../src/billing/billing.service.js';

const redis = new RedisService();
const settings = new PlatformSettingsService(redis);
const effective = new EffectivePlanService(redis, settings);
const billing = new BillingService(effective, new FakeStripeDriver(), settings);

const tenant = await controlDb.tenant.findFirstOrThrow();
const T = tenant.id;
const CUS = `cus_test_${T}`;
await controlDb.billingAccount.update({ where: { tenantId: T }, data: { stripeCustomerId: CUS } });

const now = Math.floor(Date.now() / 1000);
const P1 = now - 10 * 86400;           // period started 10 days ago
const sub = (id: string, price: string, status: string, pStart = P1) => ({
  id, customer: CUS, status, cancel_at_period_end: false, canceled_at: null,
  items: { data: [{ price: { id: price }, current_period_start: pStart, current_period_end: pStart + 30 * 86400 }] },
});
const show = async (label: string) => {
  const s = await controlDb.subscription.findUniqueOrThrow({ where: { tenantId: T }, include: { plan: true } });
  console.log(`${label.padEnd(46)} plan=${s.plan.slug.padEnd(14)} status=${String(s.status).padEnd(9)} stripeSub=${s.stripeSubscriptionId} grace=${s.graceUntil?.toISOString() ?? 'null'}`);
};

console.log('--- A. annual price id resolves through the reverse lookup ---');
await billing.syncStripeSubscription(sub('sub_A', 'price_seed_community_annual', 'active') as never);
await show('after annual community sub_A');

console.log('\n--- B. mid-cycle UPGRADE, same subscription + same period start ---');
await billing.syncStripeSubscription(sub('sub_A', 'price_seed_municipal', 'active') as never);
await show('after upgrade to municipal (same period)');
console.log('   now replay the OLDER community event (retry sweep / out-of-order delivery)');
await billing.syncStripeSubscription(sub('sub_A', 'price_seed_community_annual', 'active') as never);
await show('after stale replay of the community event');

console.log('\n--- C. dunning: grace anchored to first failure ---');
await billing.recordPaymentFailure(T); await show('1st invoice.payment_failed');
const g1 = (await controlDb.subscription.findUniqueOrThrow({ where: { tenantId: T } })).graceUntil;
await new Promise((r) => setTimeout(r, 1100));
await billing.recordPaymentFailure(T); await show('2nd invoice.payment_failed (1s later)');
const g2 = (await controlDb.subscription.findUniqueOrThrow({ where: { tenantId: T } })).graceUntil;
console.log('   grace slid forward?', g1?.getTime() !== g2?.getTime());

console.log('\n--- D. a SECOND Stripe subscription for the same customer ---');
await billing.syncStripeSubscription(sub('sub_B', 'price_seed_central', 'active', now) as never);
await show('after checkout created sub_B while sub_A lives');
console.log('   rows anywhere still referencing sub_A:',
  await controlDb.subscription.count({ where: { stripeSubscriptionId: 'sub_A' } }));

console.log('\n--- E. subscription.deleted downgrade ---');
await billing.handleStripeSubscriptionDeleted({ ...sub('sub_B', 'price_seed_central', 'canceled'), canceled_at: now } as never);
await show('after customer.subscription.deleted(sub_B)');

await redis.onModuleDestroy(); await controlDb.$disconnect();
