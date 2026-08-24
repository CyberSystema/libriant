import 'reflect-metadata';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import bcrypt from 'bcryptjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { controlDb } from '@libriant/db-control';
import { AppModule } from '../../src/app.module.js';
import { HttpExceptionFilter } from '../../src/platform/http-exception.filter.js';
import { RedisService } from '../../src/platform/redis.service.js';
import { listenOnce } from './listen-once.js';
import { declareBillingPosture } from './billing-posture.js';

declareBillingPosture(
  'unenforced',
  'Subscriptions OFF is the shipped configuration, and this file walks the day-one ' +
    'recovery procedure an operator runs on a brand-new library. No assertion here ' +
    'depends on a plan gate refusing anything.',
);

/**
 * THE OPERATOR'S ESCAPE HATCH, WALKED END TO END — launch-readiness-01.
 *
 * Libriant ships with `EMAIL_DRIVER=console`: every message is composed, stored
 * and marked delivered against a fabricated provider id, and then goes nowhere.
 * So the whole of account recovery rests on five owner-admin routes and one web
 * page, and the last two audit rounds found that path broken in a way no unit
 * test could see:
 *
 *   round 1 — the body was withheld from the log, so nobody could read a link.
 *   round 2 — the link was readable, and pointed at `/<locale>/login/reset`,
 *             WHICH WAS NOT A ROUTE. The librarian got a Next.js 404 and the
 *             only way to spend a valid token was a hand-built curl.
 *
 * Both failures live BETWEEN the pieces — a service that mints a URL, a Next
 * app that does or doesn't serve it, an auth service that redeems it from a
 * Redis key whose shape is duplicated in two files. So this spec drives the
 * real HTTP routes in the real order, and asserts the two seams that broke:
 * the minted URL is backed by a page file that exists on disk, and the token it
 * carries is redeemed by the REAL `POST /auth/password-reset/complete`.
 *
 * It also pins the privacy invariants the same surface has to hold:
 *   - privacy-legal-06 — the persisted body carries no live token, and the
 *     minted link keeps its token OUT of the query string.
 *   - privacy-legal-04 — no route here writes personal data onto an audit row
 *     that a tenant deletion cannot reach.
 *
 * Pre-reqs: `source docs/audit/pre-release-2026-08-23/env/setup-audit-env.sh`.
 */
let app: NestExpressApplication;
let ownerAdminId = '';
let supportAdminId = '';
let ownerCookie = '';
let supportCookie = '';
let slug = '';
let tenantId = '';
let ownerUserId = '';
const tag = randomBytes(3).toString('hex');
const ownerPassword = 'escape-hatch-owner-pw-1';
const ADMIN_PW = 'escape-hatch-admin-pw-1';

function cookieFrom(res: request.Response, re: RegExp): string {
  const raw = res.headers['set-cookie'] as unknown as string[] | string | undefined;
  const cookies = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const c = cookies.find((x) => re.test(x));
  if (!c) throw new Error(`no cookie matching ${re}`);
  return c.split(';')[0]!;
}

async function makeAdmin(role: 'owner' | 'support', label: string) {
  const admin = await controlDb.adminUser.create({
    data: {
      email: `esc-${role}-${tag}@test.local`,
      fullName: label,
      role,
      status: 'active',
      passwordHash: bcrypt.hashSync(ADMIN_PW, 8),
      // MFA cipher/nonce/keyId are required columns (written for real on
      // enrollment); placeholders here mirror scripts/bootstrap-admin.ts.
      mfaSecretCipher: randomBytes(32),
      mfaNonce: randomBytes(12),
      mfaKeyId: 'test',
    },
  });
  const login = await request(app.getHttpServer())
    .post('/admin/auth/login')
    .send({ email: admin.email, password: ADMIN_PW })
    .expect(200);
  return { id: admin.id, cookie: cookieFrom(login, /^(__Host-)?libriant_admin=/) };
}

/** Audit rows this run's admins wrote, newest first. */
function auditRows() {
  return controlDb.auditEvent.findMany({
    where: { actorId: { in: [ownerAdminId, supportAdminId] } },
    orderBy: { occurredAt: 'desc' },
  });
}

beforeAll(async () => {
  app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
    logger: ['error', 'warn'],
  });
  // Mirror main.ts so guards/middleware behave as in production.
  app.set('trust proxy', true);
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

  const owner = await makeAdmin('owner', 'Escape Hatch Owner');
  ownerAdminId = owner.id;
  ownerCookie = owner.cookie;
  const support = await makeAdmin('support', 'Escape Hatch Support');
  supportAdminId = support.id;
  supportCookie = support.cookie;

  // A brand-new library, through the real signup route — this is the state an
  // operator is called about on day one.
  slug = `esc${tag}`;
  await request(app.getHttpServer())
    .post('/auth/signup')
    .send({
      libraryName: `Escape Hatch ${tag}`,
      slug,
      fullName: `Owner ${tag}`,
      email: `owner@${slug}.test`,
      password: ownerPassword,
      acceptLegal: true,
      libraryType: 'public',
      addressStreet: '1 Library St',
      addressCity: 'Athens',
      addressPostalCode: '10000',
      addressCountry: 'GR',
    })
    .expect(201);

  const tenant = await controlDb.tenant.findUniqueOrThrow({ where: { slug } });
  tenantId = tenant.id;
  const user = await controlDb.user.findFirstOrThrow({ where: { tenantId, role: 'owner' } });
  ownerUserId = user.id;
}, 120_000);

afterAll(async () => {
  await controlDb.auditEvent
    .deleteMany({ where: { actorId: { in: [ownerAdminId, supportAdminId] } } })
    .catch(() => undefined);
  await controlDb.adminUser
    .deleteMany({ where: { id: { in: [ownerAdminId, supportAdminId] } } })
    .catch(() => undefined);
  if (app) await app.close();
});

describe('escape hatch: read the mail nobody received', () => {
  it('persists the verification body with the token SEALED, not in cleartext', async () => {
    const row = await controlDb.emailOutbox.findFirstOrThrow({
      where: { tenantId, kind: 'email_verification' },
    });
    // privacy-legal-06: what Postgres holds — and therefore what pg_dumpall
    // puts in every nightly backup — must not be redeemable.
    expect(row.bodyMarkdown).toMatch(/\{\{lbr-secret:[0-9a-f]+:\d+\}\}/);
    expect(row.bodyMarkdown).not.toMatch(/token=[A-Za-z0-9_-]{20,}/);
  });

  it('re-hydrates a live link for an owner admin, and refuses a support admin', async () => {
    const row = await controlDb.emailOutbox.findFirstOrThrow({
      where: { tenantId, kind: 'email_verification' },
    });

    await request(app.getHttpServer())
      .get(`/admin/outbox/${row.id}`)
      .set('Cookie', supportCookie)
      .expect(403);

    const res = await request(app.getHttpServer())
      .get(`/admin/outbox/${row.id}`)
      .set('Cookie', ownerCookie)
      .expect(200);
    expect(res.body.linkState).toBe('live');
    expect(res.body.body).toMatch(/token=[A-Za-z0-9_-]{20,}/);
    // The panel must say out loud that nothing is being delivered, or a green
    // "delivered" column reads as "the librarian got it".
    expect(res.body.delivering).toBe(false);
  });
});

describe('escape hatch: unblock a library that cannot add its second librarian', () => {
  it('reproduces the dead end, then walks the operator out of it', async () => {
    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ slug, identifier: `owner@${slug}.test`, password: ownerPassword })
      .expect(200);
    const session = cookieFrom(login, /^(__Host-)?libriant_session=/);

    // The finding's exact symptom: EmailVerifiedGuard on POST /t/:slug/staff,
    // and the only writer of emailVerifiedAt is redeeming an emailed token.
    const blocked = await request(app.getHttpServer())
      .post(`/t/${slug}/staff`)
      .set('Cookie', session)
      .send({ role: 'librarian' })
      .expect(403);
    expect(blocked.body.code).toBe('email_verification_required');

    await request(app.getHttpServer())
      .post(`/admin/account-recovery/users/${ownerUserId}/verify-email`)
      .set('Cookie', supportCookie)
      .expect(403);

    const verified = await request(app.getHttpServer())
      .post(`/admin/account-recovery/users/${ownerUserId}/verify-email`)
      .set('Cookie', ownerCookie)
      .expect(200);
    expect(verified.body.alreadyVerified).toBe(false);

    const staff = await request(app.getHttpServer())
      .post(`/t/${slug}/staff`)
      .set('Cookie', session)
      .send({ role: 'librarian' })
      .expect(201);
    expect(staff.body.user.username).toBeTruthy();
    expect(staff.body.tempPassword).toBeTruthy();
  }, 60_000);
});

describe('escape hatch: get the owner back into their own library', () => {
  it('mints a link that LANDS on a page the web app actually serves', async () => {
    const res = await request(app.getHttpServer())
      .post(`/admin/account-recovery/users/${ownerUserId}/reset-link`)
      .set('Cookie', ownerCookie)
      .expect(200);

    const url = new URL(res.body.url as string);
    const segments = url.pathname.split('/').filter(Boolean);
    expect(segments[0]).toMatch(/^(el|en)$/);

    // THE ASSERTION THIS FILE EXISTS FOR. Round 2 shipped a URL whose route did
    // not exist anywhere in apps/web — the operator read it out and the
    // librarian got a 404. Resolve the minted path to the page file that has to
    // back it, and fail here rather than on the phone.
    const webApp = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../web/app');
    const pageFile = path.join(webApp, '[locale]', ...segments.slice(1), 'page.tsx');
    expect(
      existsSync(pageFile),
      `the reset link points at ${url.pathname}, so ${pageFile} must exist`,
    ).toBe(true);

    // privacy-legal-06: the token rides in the FRAGMENT. A query-string token
    // is written verbatim into Caddy's JSON access log as `request.uri`, and
    // scripts/backup.sh tars that directory into the nightly backup.
    expect(url.search).toBe('');
    expect(url.hash).toMatch(/^#token=[A-Za-z0-9_-]{20,}&slug=/);
  });

  it('issues a token the REAL reset endpoint accepts, and the new password signs in', async () => {
    const res = await request(app.getHttpServer())
      .post(`/admin/account-recovery/users/${ownerUserId}/reset-link`)
      .set('Cookie', ownerCookie)
      .expect(200);
    const token = new URLSearchParams(new URL(res.body.url as string).hash.replace(/^#/, '')).get(
      'token',
    );
    expect(token).toBeTruthy();

    // AdminOutboxService duplicates PasswordResetService's TTL, the
    // `pwreset:<token>` key shape AND its `{uid,tid}` payload, because the auth
    // service exposes no mint-only entry point. This is the check that keeps
    // the two in step: a drift on either side stops being a silent 400 on a
    // librarian's phone call and becomes a red build.
    const newPassword = 'a-brand-new-passphrase-9';
    await request(app.getHttpServer())
      .post('/auth/password-reset/complete')
      .send({ token, newPassword })
      .expect(200);

    await request(app.getHttpServer())
      .post('/auth/login')
      .send({ slug, identifier: `owner@${slug}.test`, password: newPassword })
      .expect(200);

    // Single-use: the second redemption of the same token must fail.
    await request(app.getHttpServer())
      .post('/auth/password-reset/complete')
      .send({ token, newPassword: 'yet-another-passphrase-9' })
      .expect(404);
  }, 30_000);

  it('refuses a support-tier admin — this is an account-takeover primitive', async () => {
    await request(app.getHttpServer())
      .post(`/admin/account-recovery/users/${ownerUserId}/reset-link`)
      .set('Cookie', supportCookie)
      .expect(403);
  });
});

describe('what the audit trail may and may not record (privacy-legal-04)', () => {
  it('records the directory search — without recording what was searched for', async () => {
    const before = (await auditRows()).length;
    const res = await request(app.getHttpServer())
      .get(`/admin/account-recovery/users?q=${encodeURIComponent(`owner@${slug}.test`)}`)
      .set('Cookie', ownerCookie)
      .expect(200);
    expect(res.body.users.length).toBeGreaterThan(0);

    const rows = await auditRows();
    expect(rows.length).toBe(before + 1);
    const row = rows[0]!;
    expect(row.action).toBe('user.directory.searched');
    // A cross-tenant search has no tenant to be erased with, so the term — an
    // e-mail address, every time — may not be in it.
    expect(JSON.stringify(row.afterJson)).not.toContain(`owner@${slug}.test`);
    expect((row.afterJson as Record<string, unknown>).returned).toBeGreaterThan(0);
  });

  it('keeps a PATRON address out of the row written when their notice is read', async () => {
    // A member notice, shaped exactly as member-notifications.job.ts enqueues
    // one. Reading its body is the route that used to write
    // `after.toEmail` — a patron's address — onto a `tenantId: null` row, which
    // the delete CASCADE and the redaction trigger both key on tenantId and so
    // both skip. Orphaned patron PII, produced by the very fix for
    // privacy-legal-04.
    const patron = `maria.papadopoulou.${tag}@example.gr`;
    const notice = await controlDb.emailOutbox.create({
      data: {
        kind: 'member_overdue',
        toEmail: patron,
        subject: 'Το βιβλίο σας έχει καθυστερήσει',
        bodyMarkdown: `Γεια σας Μαρία Παπαδοπούλου, το «Το Κιβώτιο» έληξε στις 2026-08-01.`,
        tenantId,
        status: 'delivered',
      },
    });

    const res = await request(app.getHttpServer())
      .get(`/admin/outbox/${notice.id}`)
      .set('Cookie', ownerCookie)
      .expect(200);
    // The operator still sees the address — that is the point of the viewer.
    expect(res.body.toEmail).toBe(patron);

    const row = (await auditRows())[0]!;
    expect(row.action).toBe('email_outbox.body.read');
    expect(row.targetId).toBe(notice.id);
    // The row belongs to the library, so the tenant's own deletion reaches it…
    expect(row.tenantId).toBe(tenantId);
    // …and it carries no address to have to reach.
    expect(JSON.stringify(row.afterJson)).not.toContain(patron);
    expect(JSON.stringify(row.afterJson)).not.toContain('Παπαδοπούλου');

    await controlDb.emailOutbox.delete({ where: { id: notice.id } }).catch(() => undefined);
  });

  it('leaves no orphaned personal data behind across the whole procedure', async () => {
    // The invariant, checked over everything this file caused to be written
    // rather than route by route: a row with no tenantId cannot be redacted by
    // the tenant's deletion, so it must contain nothing personal in the first
    // place. `@` is a blunt probe on purpose — it catches an address that
    // arrives through a field nobody thought to check.
    const orphans = (await auditRows()).filter((r) => r.tenantId === null);
    expect(orphans.length).toBeGreaterThan(0); // the cross-tenant reads are here
    for (const row of orphans) {
      const payload = `${JSON.stringify(row.beforeJson)}${JSON.stringify(row.afterJson)}`;
      expect(payload, `${row.action} put an address on a tenantId-NULL row`).not.toMatch(/@/);
    }
  });

  it('never records the reset URL itself', async () => {
    const rows = await auditRows();
    const issued = rows.filter((r) => r.action === 'user.password_reset_link.issued');
    expect(issued.length).toBeGreaterThan(0);
    for (const row of issued) {
      // An audit_log full of live reset links is the same defect as an
      // email_outbox full of them — same export, same backup, and nothing ever
      // sweeps audit_log.
      expect(JSON.stringify(row.afterJson)).not.toContain('token=');
      expect(row.tenantId).toBe(tenantId);
    }
  });
});
