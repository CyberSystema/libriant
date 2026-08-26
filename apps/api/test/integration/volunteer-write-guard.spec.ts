import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, it } from 'vitest';
import request from 'supertest';
import { controlDb } from '@libriant/db-control';
import { AppModule } from '../../src/app.module.js';
import { HttpExceptionFilter } from '../../src/platform/http-exception.filter.js';
import { listenOnce } from './listen-once.js';
import { declareBillingPosture } from './billing-posture.js';

declareBillingPosture(
  'unenforced',
  'The subject is role enforcement, not a plan gate, so this runs the configuration customers get.',
);

/**
 * The read-only role must not be able to write. Anywhere.
 *
 * authn-authz-06. Three tenant write surfaces carried `@UseGuards(TenantGuard)`
 * and nothing else, so a `volunteer` — the role a library gives the sixth-form
 * helper who shelves books on Saturdays — could upload and delete member photos,
 * book covers and arbitrary tenant files. The rest of the tenant surface was
 * correctly gated, which is what made it hard to see: the same account got 403
 * from POST /members and 201 from POST /storage/covers.
 *
 * A unit test on RolesGuard would not have caught this. The guard was never
 * wrong — it simply was not on the route. So this drives real HTTP with a real
 * volunteer session, and the OWNER control matters as much as the refusals: a
 * guard that refuses everyone is not a fix, it is an outage.
 */
let app: NestExpressApplication;
let slug: string;
let tenantId = '';
let ownerCookie = '';
let volunteerCookie = '';

const OWNER_PW = 'owner-guard-spec-password-1';
const VOLUNTEER_PW = 'volunteer-guard-spec-password-1';

function cookieFrom(res: request.Response): string {
  const raw = res.headers['set-cookie'] as unknown as string[] | string | undefined;
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const c = list.find((x) => /^(__Host-)?libriant_session=/.test(x));
  if (!c) throw new Error('no session cookie set');
  return c.split(';')[0]!;
}

beforeAll(async () => {
  app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
    logger: ['error'],
  });
  app.set('trust proxy', true);
  app.use(cookieParser());
  app.useGlobalFilters(new HttpExceptionFilter());
  await app.init();
  await listenOnce(app);

  slug = `volguard${randomBytes(3).toString('hex')}`;
  const signup = await request(app.getHttpServer())
    .post('/auth/signup')
    .send({
      libraryName: `Vol Guard ${slug}`,
      slug,
      fullName: 'Owner',
      email: `owner@${slug}.test`,
      password: OWNER_PW,
      acceptLegal: true,
      libraryType: 'public',
      addressStreet: '1 Library St',
      addressCity: 'Athens',
      addressPostalCode: '10000',
      addressCountry: 'GR',
    })
    .expect(201);
  ownerCookie = cookieFrom(signup);
  tenantId = (await controlDb.tenant.findUnique({ where: { slug }, select: { id: true } }))!.id;

  // EMAIL_DRIVER is console, so the owner can never clear EmailVerifiedGuard
  // through the product. Stamping it is the only way to reach the staff routes
  // at all — the alternative is a spec that cannot test what it is named for.
  await controlDb.user.updateMany({
    where: { tenantId, email: `owner@${slug}.test` },
    data: { emailVerifiedAt: new Date() },
  });

  const created = await request(app.getHttpServer())
    .post(`/t/${slug}/staff`)
    .set('Cookie', ownerCookie)
    .send({ role: 'volunteer', fullName: 'Weekend Helper' })
    .expect(201);

  const username = created.body.user.username as string;
  const login = await request(app.getHttpServer())
    .post('/auth/login')
    .send({ slug, identifier: username, password: created.body.tempPassword })
    .expect(200);
  volunteerCookie = cookieFrom(login);

  // Staff are created in the forced-change state; clear it so the session is a
  // normal one rather than one every route might treat specially.
  await request(app.getHttpServer())
    .post('/auth/complete-setup')
    .set('Cookie', volunteerCookie)
    .send({ newPassword: VOLUNTEER_PW })
    .expect(200);

  // complete-setup stamps sessionsValidAfter, which invalidates the cookie the
  // caller arrived with, and it does not re-mint one. Sign in again with the
  // new password — that is what the real user does too.
  const back = await request(app.getHttpServer())
    .post('/auth/login')
    .send({ slug, identifier: username, password: VOLUNTEER_PW })
    .expect(200);
  volunteerCookie = cookieFrom(back);
}, 120_000);

afterAll(async () => {
  if (tenantId) {
    await controlDb.tenant.deleteMany({ where: { id: tenantId } }).catch(() => undefined);
  }
  if (app) await app.close();
}, 60_000);

const PNG = Buffer.from('89504e470d0a1a0a', 'hex');

describe('a volunteer cannot write (authn-authz-06)', () => {
  it('is refused the tenant write surface that was already guarded — the control', async () => {
    // If this ever stops being 403 the role itself is broken and the assertions
    // below would pass for the wrong reason.
    await request(app.getHttpServer())
      .post(`/t/${slug}/members`)
      .set('Cookie', volunteerCookie)
      .send({ fullName: 'Patron', email: 'p@example.gr' })
      .expect(403);
  }, 60_000);

  it('cannot upload a file to tenant storage', async () => {
    await request(app.getHttpServer())
      .post(`/t/${slug}/storage/covers`)
      .set('Cookie', volunteerCookie)
      .attach('file', PNG, { filename: 'c.png', contentType: 'image/png' })
      .expect(403);
  }, 60_000);

  it('cannot delete from tenant storage', async () => {
    await request(app.getHttpServer())
      .delete(`/t/${slug}/storage/covers/anything.png`)
      .set('Cookie', volunteerCookie)
      .expect(403);
  }, 60_000);
});

describe('the roles that SHOULD write still can', () => {
  it('lets the owner upload — a guard that refuses everyone is an outage, not a fix', async () => {
    await request(app.getHttpServer())
      .post(`/t/${slug}/storage/covers`)
      .set('Cookie', ownerCookie)
      .attach('file', PNG, { filename: 'c.png', contentType: 'image/png' })
      .expect(201);
  }, 60_000);
});
