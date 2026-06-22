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

/**
 * End-to-end library-profile workflow: signup captures the profile; a tenant
 * owner edits FREE fields directly; proposes a CORE change (request); a platform
 * owner-admin approves; the change is applied to the tenant.
 *
 * Pre-reqs: `pnpm db:up` (dev Postgres + Redis) + control DB migrated/seeded.
 */
let app: NestExpressApplication;
let adminId = '';
let adminCookie = '';
let tenantCookie = '';
let slug = '';
const tag = randomBytes(3).toString('hex');

function cookieFrom(res: request.Response, re: RegExp): string {
  const raw = res.headers['set-cookie'] as unknown as string[] | string | undefined;
  const cookies = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const c = cookies.find((x) => re.test(x));
  if (!c) throw new Error(`no cookie matching ${re}`);
  return c.split(';')[0]!;
}

beforeAll(async () => {
  app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
    logger: ['error', 'warn'],
  });
  app.set('trust proxy', true);
  app.use(cookieParser());
  app.useGlobalFilters(new HttpExceptionFilter());
  await app.init();

  const redis = app.get(RedisService);
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await redis.ping()) break;
    await new Promise((r) => setTimeout(r, 100));
  }

  // Platform owner-admin (approves requests).
  const admin = await controlDb.adminUser.create({
    data: {
      email: `libwf-${tag}@test.local`,
      fullName: 'Lib WF Owner',
      role: 'owner',
      status: 'active',
      passwordHash: bcrypt.hashSync('lib-wf-test-pw-1', 8),
      mfaSecretCipher: randomBytes(32),
      mfaNonce: randomBytes(12),
      mfaKeyId: 'test',
    },
  });
  adminId = admin.id;
  const adminLogin = await request(app.getHttpServer())
    .post('/admin/auth/login')
    .send({ email: admin.email, password: 'lib-wf-test-pw-1' })
    .expect(200);
  adminCookie = cookieFrom(adminLogin, /^(__Host-)?libriant_admin=/);

  // A library (tenant) with a full profile, via signup.
  slug = `libwf-${tag}`;
  const signup = await request(app.getHttpServer())
    .post('/auth/signup')
    .send({
      libraryName: `Lib WF ${slug}`,
      slug,
      fullName: `Owner ${slug}`,
      email: `owner@${slug}.test`,
      password: 'owner-signup-pw-123',
      acceptLegal: true,
      libraryType: 'public',
      addressStreet: '1 Library St',
      addressCity: 'Athens',
      addressPostalCode: '10000',
      addressCountry: 'GR',
    })
    .expect(201);
  tenantCookie = cookieFrom(signup, /^(__Host-)?libriant_session=/);
}, 60_000);

afterAll(async () => {
  if (adminId) {
    await controlDb.adminUser.deleteMany({ where: { id: adminId } }).catch(() => undefined);
  }
  if (app) await app.close();
});

describe('library profile + edit-request workflow', () => {
  it('signup populated the profile', async () => {
    const res = await request(app.getHttpServer())
      .get(`/t/${slug}/library`)
      .set('Cookie', tenantCookie)
      .expect(200);
    expect(res.body.profile.libraryType).toBe('public');
    expect(res.body.profile.addressCity).toBe('Athens');
    expect(res.body.pendingRequest).toBeNull();
  });

  it('owner edits FREE fields directly (no approval)', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/t/${slug}/library`)
      .set('Cookie', tenantCookie)
      .send({ publicPhone: '+30 210 0000000', website: 'https://example.org' })
      .expect(200);
    expect(res.body.profile.publicPhone).toBe('+30 210 0000000');
  });

  it('proposing a CORE change creates a pending request (not applied yet)', async () => {
    await request(app.getHttpServer())
      .post(`/t/${slug}/library/requests`)
      .set('Cookie', tenantCookie)
      .send({ name: 'Renamed Library', addressCity: 'Thessaloniki', requestNote: 'We moved.' })
      .expect(201);

    // Not applied yet, and a pending request is visible.
    const profile = await request(app.getHttpServer())
      .get(`/t/${slug}/library`)
      .set('Cookie', tenantCookie)
      .expect(200);
    expect(profile.body.profile.name).toBe(`Lib WF ${slug}`); // unchanged
    expect(profile.body.pendingRequest).not.toBeNull();
  });

  it('a second pending request is rejected', async () => {
    await request(app.getHttpServer())
      .post(`/t/${slug}/library/requests`)
      .set('Cookie', tenantCookie)
      .send({ name: 'Another Name' })
      .expect(400);
  });

  it('owner-admin approves → the change is applied', async () => {
    const list = await request(app.getHttpServer())
      .get('/admin/library-requests?status=pending')
      .set('Cookie', adminCookie)
      .expect(200);
    const req = list.body.requests.find(
      (r: { tenant?: { slug?: string } }) => r.tenant?.slug === slug,
    );
    expect(req).toBeTruthy();

    await request(app.getHttpServer())
      .post(`/admin/library-requests/${req.id}/approve`)
      .set('Cookie', adminCookie)
      .send({ decisionNote: 'Verified.' })
      .expect(200);

    const after = await request(app.getHttpServer())
      .get(`/t/${slug}/library`)
      .set('Cookie', tenantCookie)
      .expect(200);
    expect(after.body.profile.name).toBe('Renamed Library');
    expect(after.body.profile.addressCity).toBe('Thessaloniki');
    expect(after.body.pendingRequest).toBeNull();
  });
});
