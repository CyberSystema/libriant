import { controlDb } from '@libriant/db-control';
const tenants = await controlDb.tenant.findMany({ select: { id: true, slug: true } });
console.log('tenants', tenants);
const subs = await controlDb.subscription.findMany({ include: { plan: { select: { slug: true } } } });
console.log('subs', JSON.stringify(subs, null, 1));
console.log('billing accounts', await controlDb.billingAccount.findMany());
await controlDb.$disconnect();
