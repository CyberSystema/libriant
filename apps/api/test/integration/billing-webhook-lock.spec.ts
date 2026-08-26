import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Client as PgClient } from 'pg';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { controlDb } from '@libriant/db-control';
import { AppModule } from '../../src/app.module.js';
import { HttpExceptionFilter } from '../../src/platform/http-exception.filter.js';
import { RedisService } from '../../src/platform/redis.service.js';
import { STRIPE_DRIVER, type StripeDriver } from '../../src/billing/stripe-driver.js';
import { signFakeWebhook } from '../../src/billing/stripe-fake.driver.js';
import { loadEnv } from '../../src/config/env.js';
import { listenOnce } from './listen-once.js';
import { declareBillingPosture } from './billing-posture.js';

declareBillingPosture(
  'unenforced',
  'Nothing here asserts a plan gate — it asserts what a webhook WRITES. The webhook route is ' +
    'live regardless of the subscriptions switch (the signature is its authentication), and the ' +
    'launch configuration is the one worth testing the write path under.',
);

/**
 * data-integrity-09 — two DISTINCT Stripe events for one library used to
 * read-modify-write the same `subscriptions` row with no transaction and no row
 * lock between the read and the write.
 *
 * The webhook controller's Redis SETNX dedupes on `event.id`, so it serialises
 * RETRIES of one event and nothing else. `invoice.payment_failed` and
 * `invoice.payment_succeeded` are different ids — and Stripe delivers them
 * within milliseconds of each other when a dunning attempt finally clears.
 * Both derive `graceUntil` FROM the row they read, so the loser's write put
 * back a deadline computed from a row that no longer existed.
 *
 * The repro is deterministic rather than a timing loop: a session holds the
 * same `billing:<tenantId>` advisory lock the handler now takes, applies the
 * "payment succeeded" write while the webhook is in flight, and commits. If the
 * handler is in the lock domain it cannot have read the pre-success row.
 *
 * Driven through the real route, POST /webhooks/stripe, signature and all.
 *
 * Pre-reqs: `pnpm db:up` (dev Postgres + Redis).
 */

let app: NestExpressApplication;
let secret = '';
let tenantId = '';
const slug = 'billlock-' + randomBytes(3).toString('hex');
const customerId = `cus_billlock_${randomBytes(4).toString('hex')}`;
const subscriptionId = `sub_billlock_${randomBytes(4).toString('hex')}`;
const env = loadEnv();
const MS_PER_HOUR = 3_600_000;

/** The nearly-elapsed window the library was released from when it paid. */
let oldDeadline: Date;

async function dropTenantDb(id: string) {
  const dbName = `tenant_${id.replace(/[^a-z0-9_]/gi, '_').toLowerCase()}`;
  const admin = new PgClient({ connectionString: env.pgSuperuserUrl });
  await admin.connect();
  try {
    await admin.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [dbName],
    );
    await admin.query(`DROP DATABASE IF EXISTS "${dbName}"`);
  } finally {
    await admin.end();
  }
}

function invoiceFailedEvent() {
  return {
    id: `evt_${randomBytes(6).toString('hex')}`,
    type: 'invoice.payment_failed',
    created: Math.floor(Date.now() / 1000),
    data: {
      object: {
        id: `in_${randomBytes(4).toString('hex')}`,
        customer: customerId,
        subscription: subscriptionId,
        status: 'open',
        amount_paid: 0,
        amount_due: 3900,
        // A renewal, so the library HAS settled an invoice before and grace is
        // legitimately available to it (billing-05).
        billing_reason: 'subscription_cycle',
      },
    },
  };
}

beforeAll(async () => {
  app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
    logger: ['error', 'warn'],
  });
  app.use(cookieParser());
  app.useGlobalFilters(new HttpExceptionFilter());
  await app.init();
  await listenOnce(app);

  const redis = app.get(RedisService);
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await redis.ping()) break;
    await new Promise((r) => setTimeout(r, 100));
  }

  const driver = app.get<StripeDriver & { getSecret(): string }>(STRIPE_DRIVER);
  expect(driver.kind, 'this spec needs STRIPE_DRIVER=fake').toBe('fake');
  secret = driver.getSecret();

  const res = await request(app.getHttpServer())
    .post('/auth/signup')
    .send({
      libraryName: `Billing lock ${slug}`,
      slug,
      fullName: `Owner ${slug}`,
      email: `owner@${slug}.test`,
      password: 'billlock-test-pw-1',
      acceptLegal: true,
      libraryType: 'public',
      addressStreet: '1 Library St',
      addressCity: 'Athens',
      addressPostalCode: '10000',
      addressCountry: 'GR',
    })
    .expect(201);
  tenantId = res.body.tenant.id as string;

  await controlDb.billingAccount.upsert({
    where: { tenantId },
    create: {
      tenantId,
      stripeCustomerId: customerId,
      billingEmail: `billing@${slug}.test`,
      billingName: `Billing lock ${slug}`,
    },
    update: { stripeCustomerId: customerId },
  });
}, 90_000);

beforeEach(async () => {
  // A library in dunning: past_due with an hour of grace left. This is the row
  // the failure handler reads to decide whether to keep or re-arm the window.
  oldDeadline = new Date(Date.now() + MS_PER_HOUR);
  await controlDb.subscription.update({
    where: { tenantId },
    data: {
      status: 'past_due',
      graceUntil: oldDeadline,
      stripeSubscriptionId: subscriptionId,
      billingMode: 'stripe',
    },
  });
});

afterAll(async () => {
  if (tenantId) {
    await controlDb.tenant.deleteMany({ where: { id: tenantId } }).catch(() => undefined);
    await dropTenantDb(tenantId).catch(() => undefined);
  }
  if (app) await app.close();
}, 60_000);

describe('subscription writes are serialised per tenant (data-integrity-09)', () => {
  it('does not resurrect a grace deadline that a concurrent payment cleared', async () => {
    const body = JSON.stringify(invoiceFailedEvent());
    const sig = signFakeWebhook(body, secret);

    // Stand in for `recordPaymentSuccess` mid-transaction, and hold BOTH locks
    // a real one holds, because the two of them are what pin the interleaving
    // down in each direction:
    //
    //   `pg_advisory_xact_lock('billing:<tenant>')` — what the fixed handler
    //   takes as its first statement, so it waits here and reads nothing until
    //   the payment has committed.
    //
    //   `SELECT … FOR UPDATE` on the row — what any UPDATE of it needs. The
    //   UNFIXED handler ignores the advisory lock and sails straight to its
    //   plain SELECT, reading the pre-payment row, and only then stalls on this
    //   one. When the payment commits, its UPDATE lands on top: the lost update
    //   the finding is about, with the deadline computed from a row that no
    //   longer exists.
    const paying = new PgClient({ connectionString: env.controlDbUrl });
    await paying.connect();
    let pending: Promise<request.Response>;
    try {
      await paying.query('BEGIN');
      await paying.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
        `billing:${tenantId}`,
      ]);
      await paying.query(`SELECT 1 FROM "subscriptions" WHERE "tenantId" = $1 FOR UPDATE`, [
        tenantId,
      ]);

      // `.then()` is what dispatches a supertest request; a Test object that is
      // only constructed sends nothing, and this one has to be in flight.
      pending = request(app.getHttpServer())
        .post('/webhooks/stripe')
        .set('stripe-signature', sig)
        .set('Content-Type', 'application/json')
        .send(body)
        .then((r) => r);
      await new Promise((r) => setTimeout(r, 500));

      await paying.query(
        `UPDATE "subscriptions" SET "status" = 'active', "graceUntil" = NULL WHERE "tenantId" = $1`,
        [tenantId],
      );
      await paying.query('COMMIT');
    } finally {
      await paying.end().catch(() => undefined);
    }

    expect((await pending!).status).toBe(200);

    const row = await controlDb.subscription.findUniqueOrThrow({
      where: { tenantId },
      select: { status: true, graceUntil: true },
    });
    // The handler ran after the payment landed, so it must have derived its
    // answer from the row the payment left: `active` with no window, which is
    // not a running grace window, so it arms a FRESH one. Reading the
    // pre-payment row instead put the old hour-from-now deadline straight back
    // — a deadline the library had already been released from, and the one the
    // finding is about.
    expect(row.graceUntil).not.toBeNull();
    expect(
      row.graceUntil!.getTime() - oldDeadline.getTime(),
      'graceUntil is the pre-payment deadline — the read happened before the concurrent write',
    ).toBeGreaterThan(MS_PER_HOUR);
    expect(row.graceUntil!.getTime()).toBeGreaterThan(
      Date.now() + (env.billingGracePeriodDays - 1) * 24 * MS_PER_HOUR,
    );
  }, 60_000);
});
