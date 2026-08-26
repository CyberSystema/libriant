import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import bcrypt from 'bcryptjs';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { controlDb } from '@libriant/db-control';
import { AppModule } from '../../src/app.module.js';
import { HttpExceptionFilter } from '../../src/platform/http-exception.filter.js';
import { RedisService } from '../../src/platform/redis.service.js';
import { STRIPE_DRIVER, type StripeDriver } from '../../src/billing/stripe-driver.js';
import { listenOnce } from './listen-once.js';
import { declareBillingPosture } from './billing-posture.js';

declareBillingPosture(
  'unenforced',
  'The subject is a WRITE guard on the admin plan catalogue, which is reachable ' +
    'whether or not subscriptions are switched on — and "off" is the shipped configuration, ' +
    'so this proves the guard works on the posture the launch actually runs.',
);

/**
 * billing-10, round 2 — is the write guard actually MOUNTED?
 *
 * The unit spec drives `PlanPriceWriteInterceptor.intercept()` directly. That
 * proves the logic, and proves nothing about whether Nest ever calls it: the
 * dominant failure in this remediation is machinery that is built correctly and
 * never reached, and round 1 of this very finding shipped a correct audit that
 * nothing was scheduled to run. So this file boots the real `AppModule`, logs
 * in a real owner admin, and sends the refutation's own request over HTTP:
 *
 *     PATCH /admin/plans/community  {"stripeAnnualPriceId":"price_monthly_39"}
 *
 * Before this package that returned 200 and stored the id. It must now be a 400.
 *
 * The Stripe driver the app booted with is `fake` under NODE_ENV=test, and a
 * fake has no Price catalogue to consult. So the interval/amount comparison is
 * exercised by REPLACING the driver's `getPrice` and `kind` on the singleton
 * instance the app already holds — the external system is stubbed, the route,
 * the guards, the interceptor chain and the controller are all real.
 *
 * Pre-reqs: `pnpm db:up` (dev Postgres + Redis).
 */
let app: NestExpressApplication;
let adminEmail: string;
const adminPassword = 'plan-price-write-pw-1';
let adminCookie = '';
let planSlug = '';
let driver: StripeDriver;
let redisService: RedisService;
let restoreDriver = (): void => undefined;

function adminCookieFrom(res: request.Response): string {
  const raw = res.headers['set-cookie'] as unknown as string[] | string | undefined;
  const cookies = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const c = cookies.find((x) => /^(__Host-)?libriant_admin=/.test(x));
  if (!c) throw new Error('no admin cookie set');
  return c.split(';')[0]!;
}

/**
 * What Stripe would say about the ids this file uses. `price_monthly_39` is a
 * genuine 1-month €39 Price — the whole point is that it is a perfectly VALID
 * Price sitting in the wrong column.
 */
const STRIPE_PRICES: Record<
  string,
  { id: string; active: boolean; currency: string; unitAmount: number; interval: string }
> = {
  price_monthly_39: {
    id: 'price_monthly_39',
    active: true,
    currency: 'eur',
    unitAmount: 3900,
    interval: 'month',
  },
  price_yearly_390: {
    id: 'price_yearly_390',
    active: true,
    currency: 'eur',
    unitAmount: 39000,
    interval: 'year',
  },
};

beforeAll(async () => {
  app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
    logger: ['error', 'warn'],
  });
  app.set('trust proxy', true);
  app.use(cookieParser());
  app.useGlobalFilters(new HttpExceptionFilter());
  await app.init();
  await listenOnce(app);
  redisService = app.get(RedisService);

  // Stub Stripe on the driver instance the running app injected into the
  // interceptor. `kind` is a class field, so it is writable via defineProperty.
  driver = app.get<StripeDriver>(STRIPE_DRIVER);
  const originalKind = driver.kind;
  const originalGetPrice = driver.getPrice.bind(driver);
  Object.defineProperty(driver, 'kind', { value: 'real', configurable: true, writable: true });
  (driver as { getPrice: (id: string) => Promise<unknown> }).getPrice = async (id: string) => {
    const price = STRIPE_PRICES[id];
    return price ? { ...price, intervalCount: 1 } : null;
  };
  restoreDriver = () => {
    Object.defineProperty(driver, 'kind', {
      value: originalKind,
      configurable: true,
      writable: true,
    });
    (driver as { getPrice: unknown }).getPrice = originalGetPrice;
  };

  adminEmail = `plan-price-${randomBytes(3).toString('hex')}@test.local`;
  await controlDb.adminUser.create({
    data: {
      email: adminEmail,
      fullName: 'Plan Price Write Test',
      role: 'owner',
      status: 'active',
      passwordHash: bcrypt.hashSync(adminPassword, 8),
      mfaSecretCipher: randomBytes(32),
      mfaNonce: randomBytes(12),
      mfaKeyId: 'test',
    },
  });
  const login = await request(app.getHttpServer())
    .post('/admin/auth/login')
    .send({ email: adminEmail, password: adminPassword })
    .expect(200);
  adminCookie = adminCookieFrom(login);

  // A throwaway plan of our own, so this file never edits a seeded row a
  // sibling spec might read. Shaped exactly like `community`: stripe-billed,
  // €39/month and €390/year, both columns still carrying seed placeholders.
  planSlug = `pricewrite-${randomBytes(3).toString('hex')}`;
  await controlDb.plan.create({
    data: {
      slug: planSlug,
      name: 'Price Write Test',
      billingMode: 'stripe',
      monthlyPriceCents: 3900,
      annualPriceCents: 39000,
      currency: 'EUR',
      stripePriceId: `price_seed_${planSlug}`,
      stripeAnnualPriceId: `price_seed_${planSlug}_annual`,
      isActive: true,
      isPublic: false,
      sortOrder: 999,
    },
  });
}, 60_000);

afterAll(async () => {
  restoreDriver();
  // This file drives POST /admin/subscriptions, which WRITES the global switch
  // and leaves a 30 s Redis cache behind it. Deleting the row alone is not
  // enough — the cached value outranks it for the rest of the TTL, in every
  // sibling spec's process, and that is a documented cross-file flake (see
  // admin-role-guard.spec.ts). Clear both, visibly.
  await controlDb.platformSetting
    .deleteMany({ where: { key: { contains: 'billing' } } })
    .catch(() => undefined);
  await redisService?.client.del('platform_setting:billing.enabled').catch(() => undefined);
  if (planSlug) {
    await controlDb.plan.deleteMany({ where: { slug: planSlug } }).catch(() => undefined);
  }
  if (adminEmail) {
    await controlDb.adminUser.deleteMany({ where: { email: adminEmail } }).catch(() => undefined);
  }
  if (app) await app.close();
});

async function patch(body: Record<string, unknown>) {
  return request(app.getHttpServer())
    .patch(`/admin/plans/${planSlug}`)
    .set('Cookie', adminCookie)
    .send(body);
}

async function storedIds() {
  const row = await controlDb.plan.findUnique({ where: { slug: planSlug } });
  return { monthly: row?.stripePriceId ?? null, annual: row?.stripeAnnualPriceId ?? null };
}

describe('billing-10: the price-id write guard is mounted on PATCH /admin/plans/:slug', () => {
  it('refuses the refutation’s own request and stores nothing', async () => {
    const before = await storedIds();

    const res = await patch({ stripeAnnualPriceId: 'price_monthly_39' });

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/1-year Price/);
    // The row is the assertion that matters: a 400 with the write still applied
    // would be worse than no guard at all.
    expect(await storedIds()).toEqual(before);
  });

  it('accepts the same id in the column it belongs to', async () => {
    const res = await patch({ stripePriceId: 'price_monthly_39' });

    expect(res.status).toBe(200);
    expect((await storedIds()).monthly).toBe('price_monthly_39');
  });

  it('accepts a correct annual Price once the monthly one is set', async () => {
    const res = await patch({ stripeAnnualPriceId: 'price_yearly_390' });

    expect(res.status).toBe(200);
    expect(await storedIds()).toEqual({
      monthly: 'price_monthly_39',
      annual: 'price_yearly_390',
    });
  });

  it('refuses an amount change that would leave the card charging the old price', async () => {
    const res = await patch({ monthlyPriceCents: 4900 });

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/charges 3900 but the plan advertises 4900/);
    const row = await controlDb.plan.findUnique({ where: { slug: planSlug } });
    expect(row?.monthlyPriceCents).toBe(3900);
  });

  it('refuses putting the monthly id in the annual column as well', async () => {
    const res = await patch({ stripeAnnualPriceId: 'price_monthly_39' });

    expect(res.status).toBe(400);
    expect((await storedIds()).annual).toBe('price_yearly_390');
  });

  it('refuses a seeded placeholder being written back in', async () => {
    const res = await patch({ stripePriceId: 'price_seed_community' });

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/seeded placeholder/);
  });

  it('still lets a rename through — the guard is not a blanket refusal', async () => {
    const res = await patch({ name: 'Price Write Test (renamed)' });

    expect(res.status).toBe(200);
    expect(res.body.plan.name).toBe('Price Write Test (renamed)');
  });

  it('is not reachable without an owner session', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/admin/plans/${planSlug}`)
      .send({ stripeAnnualPriceId: 'price_monthly_39' });

    // 401, never 400: the interceptor runs AFTER the guards, so an anonymous
    // caller can never make this server call Stripe. See the class comment on
    // PlanPriceWriteInterceptor for why it is not a guard.
    expect(res.status).toBe(401);
  });
});

describe('billing-14: the admin UI can finally see whether this host can charge', () => {
  it('reports stripeReady=false on a host running the in-memory stand-in', async () => {
    const res = await request(app.getHttpServer())
      .get('/admin/billing/price-catalogue')
      .set('Cookie', adminCookie)
      .expect(200);

    // `driver` is the object this process booted with — stubbed to `real` in
    // beforeAll so the price comparisons above could run. `stripeReady` is
    // deliberately NOT read from it: it is resolved from the live
    // STRIPE_DRIVER posture, which is what `setBillingEnabled` consults. Under
    // NODE_ENV=test with no Stripe credentials that resolves to the fake, so
    // this host cannot charge a card and must say so.
    expect(res.body.stripeReady).toBe(false);
    expect(res.body.billingEnabled).toBe(false);
    // This is the value `stripeStateBanner()` in
    // apps/web/app/[locale]/admin/(authed)/plans/price-catalogue.ts renders.
    // False here is what puts the banner on the screen at all.
    expect(typeof res.body.subscriptionsCanBeEnabled).toBe('boolean');
  });

  /**
   * The banner's whole claim is that it PREDICTS the Subscriptions toggle
   * rather than merely correlating with it — that is why both read the live
   * `STRIPE_DRIVER` posture and not the booted driver object. Assert the
   * prediction against the real toggle endpoint, in both directions.
   */
  it('predicts exactly what POST /admin/subscriptions will do', async () => {
    const catalogue = await request(app.getHttpServer())
      .get('/admin/billing/price-catalogue')
      .set('Cookie', adminCookie)
      .expect(200);
    const predicted = catalogue.body.subscriptionsCanBeEnabled as boolean;

    if (predicted) {
      expect(catalogue.body.blockReason).toBeNull();
    } else {
      expect(catalogue.body.blockReason).toMatch(/STRIPE_DRIVER/);
    }

    try {
      const toggle = await request(app.getHttpServer())
        .post('/admin/subscriptions')
        .set('Cookie', adminCookie)
        .send({ enabled: true });

      expect(toggle.status).toBe(predicted ? 200 : 400);
      if (!predicted) {
        // Same fact, same words the operator would have read on /admin/plans.
        expect(JSON.stringify(toggle.body)).toMatch(/STRIPE_DRIVER/);
      }
    } finally {
      // Put the switch back where this file found it before anything else runs.
      await request(app.getHttpServer())
        .post('/admin/subscriptions')
        .set('Cookie', adminCookie)
        .send({ enabled: false });
    }
  });

  /**
   * The branch above only exercises the trusted-local case (NODE_ENV=test with
   * the stand-in is a posture `setBillingEnabled` deliberately allows). The
   * production-shaped case — a host with NO driver at all, which is the shipped
   * default — is the one the finding is about, so drive it explicitly.
   * `resolveStripeDriverKind()` reads `process.env` on every call precisely so
   * this is answerable at runtime rather than only at boot.
   */
  it('warns, and refuses, on the shipped STRIPE_DRIVER=none posture', async () => {
    const previous = process.env.STRIPE_DRIVER;
    process.env.STRIPE_DRIVER = 'none';
    try {
      const catalogue = await request(app.getHttpServer())
        .get('/admin/billing/price-catalogue')
        .set('Cookie', adminCookie)
        .expect(200);

      expect(catalogue.body.stripeReady).toBe(false);
      expect(catalogue.body.subscriptionsCanBeEnabled).toBe(false);
      // `none` is the env spelling; `disabled` is the POSTURE it resolves to,
      // and the posture is what both the banner and the toggle name — so the
      // operator reads the same word in both places.
      expect(catalogue.body.blockReason).toMatch(/STRIPE_DRIVER resolves to "disabled"/);

      const toggle = await request(app.getHttpServer())
        .post('/admin/subscriptions')
        .set('Cookie', adminCookie)
        .send({ enabled: true });

      // Predicted refusal, actual refusal. Before this package the operator saw
      // a completely normal screen and only met this message by pressing the
      // button.
      expect(toggle.status).toBe(400);
      expect(String(toggle.body.message)).toMatch(/STRIPE_DRIVER resolves to "disabled"/);
    } finally {
      if (previous === undefined) delete process.env.STRIPE_DRIVER;
      else process.env.STRIPE_DRIVER = previous;
    }
  });
});
