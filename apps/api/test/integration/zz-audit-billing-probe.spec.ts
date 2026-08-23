import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { controlDb } from '@libriant/db-control';
import { AppModule } from '../../src/app.module.js';
import { HttpExceptionFilter } from '../../src/platform/http-exception.filter.js';
import { signFakeWebhook } from '../../src/billing/stripe-fake.driver.js';
import { listenOnce } from './listen-once.js';

let app: NestExpressApplication;

beforeAll(async () => {
  app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: false, rawBody: true });
  app.set('trust proxy', true);
  app.use(cookieParser());
  app.useGlobalFilters(new HttpExceptionFilter());
  await app.init();
  await listenOnce(app);
});
afterAll(async () => { await app.close(); });

describe('AUDIT: /webhooks/stripe over real HTTP', () => {
  it('accepts an event signed with the HARDCODED fake-driver secret', async () => {
    const tenant = await controlDb.tenant.findFirstOrThrow();
    const CUS = `cus_audit_${tenant.id}`;
    await controlDb.billingAccount.upsert({
      where: { tenantId: tenant.id },
      create: { tenantId: tenant.id, stripeCustomerId: CUS, billingEmail: 'a@b.c', billingName: 'x' },
      update: { stripeCustomerId: CUS },
    });
    const before = await controlDb.subscription.findUniqueOrThrow({
      where: { tenantId: tenant.id }, include: { plan: true } });
    const now = Math.floor(Date.now() / 1000);
    const body = JSON.stringify({
      id: `evt_audit_${now}`, type: 'customer.subscription.updated',
      data: { object: { id: 'sub_audit', customer: CUS, status: 'active',
        cancel_at_period_end: false, canceled_at: null,
        items: { data: [{ price: { id: 'price_seed_institutional' },
          current_period_start: now, current_period_end: now + 2592000 }] } } },
    });
    // No credential of any kind — just the literal from stripe-fake.driver.ts:32.
    const sig = signFakeWebhook(body, 'fake-webhook-secret-for-dev');
    const res = await request(app.getHttpServer())
      .post('/webhooks/stripe')
      .set('stripe-signature', sig)
      .set('content-type', 'application/json')
      .send(body);
    const after = await controlDb.subscription.findUniqueOrThrow({
      where: { tenantId: tenant.id }, include: { plan: true } });
    console.log('AUDIT status:', res.status, 'body:', JSON.stringify(res.body));
    console.log('AUDIT plan before:', before.plan.slug, '→ after:', after.plan.slug,
      '| status', after.status, '| stripeSub', after.stripeSubscriptionId);
    expect(res.status).toBe(200);
  });

  it('rejects an event signed with anything else', async () => {
    const now = Math.floor(Date.now() / 1000);
    const body = JSON.stringify({ id: `evt_audit_bad_${now}`, type: 'customer.subscription.updated',
      data: { object: {} } });
    const res = await request(app.getHttpServer())
      .post('/webhooks/stripe')
      .set('stripe-signature', signFakeWebhook(body, 'whsec_something_else'))
      .set('content-type', 'application/json')
      .send(body);
    console.log('AUDIT wrong-secret status:', res.status);
    expect(res.status).toBe(400);
  });
});
