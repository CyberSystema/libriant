import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { controlDb } from '@libriant/db-control';
import { AppModule } from '../../src/app.module.js';
import { HttpExceptionFilter } from '../../src/platform/http-exception.filter.js';
import { RedisService } from '../../src/platform/redis.service.js';
import { PlatformSettingsService } from '../../src/platform-settings/platform-settings.service.js';
import { EffectivePlanService } from '../../src/plans/effective-plan.service.js';
import { SCHEDULED_JOBS } from '../../src/jobs/registry.js';
import { erasedMemberNumber } from '../../src/members/members.service.js';
import { applicationNotifyKey } from '../../src/applications/applications.service.js';
import type { JobContext } from '../../src/jobs/jobs.types.js';
import { listenOnce } from './listen-once.js';
import { declareBillingPosture } from './billing-posture.js';

declareBillingPosture(
  'unenforced',
  'Both halves of this file are about the SHIPPED configuration: erasure is not plan-gated, ' +
    'and the retention sweep must (a) delete site applications at the published 12 months with ' +
    'subscriptions off and (b) deliberately NOT touch a tenant audit log whose retention the ' +
    'free-for-all posture has lifted. One test flips the switch on for a few seconds — the ' +
    'escape hatch billing-posture.ts documents — to prove the audit-log limb deletes when a ' +
    'finite plan window actually applies.',
);

/**
 * privacy-legal-03 (erasure does not erase) and privacy-legal-05 (no retention
 * job exists), driven through the real entry points: the HTTP route a librarian
 * hits, and the registry entry the scheduled-jobs runner calls.
 *
 * Both findings were reported fixed once before and refuted by execution — the
 * first attempt shipped a database column nothing wrote and a retention rule
 * bolted onto the e-mail worker's timer, in no registry. So this file asserts
 * the mechanism from the outside: it re-runs the verifier's own repro
 * (create a member with a name, e-mail, date of birth and address; ask for it
 * to be deleted; read every field back) and it asserts what must SURVIVE just
 * as hard as what must go.
 *
 * Pre-reqs: the audit/dev Postgres + Redis, control DB migrated and seeded.
 */
let app: NestExpressApplication;
let redis: RedisService;
let slug = '';
let tenantId = '';
let tenantDbUrl = '';
let tenantStorageRoot = '';
let ownerCookie = '';
const tag = randomBytes(4).toString('hex');

/**
 * Everything the audit named, on one patron — and every identifying value is
 * unique per test. The "is it really gone?" assertion greps the WHOLE tenant
 * database for the name, the e-mail and the street; a shared street address
 * would make it fail against a different test's member and a shared name would
 * make it pass for the wrong reason.
 */
function patronFor(label: string) {
  return {
    fullName: `Μαρία Παπαδοπούλου-${label}-${tag}`,
    email: `${label}.${tag}@patron.test`,
    phone: '+30 2410 000000',
    dateOfBirth: '1984-05-17',
    addressLine1: `Ερμού 12, κτίριο ${label}-${tag}`,
    addressLine2: 'Διαμέρισμα 3',
    city: 'Λάρισα',
    postalCode: '41222',
    country: 'GR',
    staffNotes: `Προτιμά ελληνική λογοτεχνία (${label}-${tag}).`,
  };
}
type Patron = ReturnType<typeof patronFor>;

const MS_PER_DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * MS_PER_DAY);

function cookieFrom(res: request.Response, re: RegExp): string {
  const raw = res.headers['set-cookie'] as unknown as string[] | string | undefined;
  const cookies = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const c = cookies.find((x) => re.test(x));
  if (!c) throw new Error(`no cookie matching ${re}`);
  return c.split(';')[0]!;
}

/** Read the tenant database directly — the assertions have to look at columns,
 *  not at whatever the API chooses to serialize. */
async function tenantSql<T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const c = new PgClient({ connectionString: tenantDbUrl });
  await c.connect();
  try {
    const res = await c.query(sql, params);
    return res.rows as T[];
  } finally {
    await c.end();
  }
}

/** The registry entry the runner actually calls — not the module's export. */
function retentionJob() {
  const job = SCHEDULED_JOBS.find((j) => j.name === 'retention-sweep');
  if (!job) throw new Error('retention-sweep is not in SCHEDULED_JOBS');
  return job;
}

async function runRetentionSweep() {
  const ctx = { redis, emails: undefined } as unknown as JobContext;
  return retentionJob().handler(ctx);
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
  await listenOnce(app);

  redis = app.get(RedisService);
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await redis.ping()) break;
    await new Promise((r) => setTimeout(r, 100));
  }

  slug = `erase-${tag}`;
  const signup = await request(app.getHttpServer())
    .post('/auth/signup')
    .send({
      libraryName: `Erasure Test ${slug}`,
      slug,
      fullName: `Owner ${slug}`,
      email: `owner@${slug}.test`,
      password: 'owner-signup-pw-123',
      acceptLegal: true,
      libraryType: 'public',
      addressStreet: '1 Library St',
      addressCity: 'Larisa',
      addressPostalCode: '41222',
      addressCountry: 'GR',
    })
    .expect(201);
  ownerCookie = cookieFrom(signup, /^(__Host-)?libriant_session=/);

  const tenant = await controlDb.tenant.findUnique({ where: { slug } });
  if (!tenant) throw new Error('signup did not create the tenant');
  tenantId = tenant.id;
  tenantDbUrl = tenant.dbUrl;
  tenantStorageRoot = tenant.storageUrl.replace(/^file:\/\//, '');
}, 120_000);

afterAll(async () => {
  // Leave the shared switch exactly as we found it: a `billing.enabled` row (or
  // its Redis cache entry) left behind poisons every spec file that runs next.
  await controlDb.platformSetting
    .deleteMany({ where: { key: 'billing.enabled' } })
    .catch(() => undefined);
  await redis?.client.del('platform_setting:billing.enabled').catch(() => undefined);
  await controlDb.application
    .deleteMany({ where: { libraryName: { startsWith: `Retention ${tag}` } } })
    .catch(() => undefined);
  await controlDb.emailOutbox.deleteMany({ where: { tenantId } }).catch(() => undefined);
  if (app) await app.close();
});

async function createPatron(patron: Patron): Promise<string> {
  const res = await request(app.getHttpServer())
    .post(`/t/${slug}/members`)
    .set('Cookie', ownerCookie)
    .send(patron)
    .expect(201);
  return res.body.id as string;
}

describe('privacy-legal-03 — erasure', () => {
  it('DELETE still archives, and archiving still keeps every identifier (by design)', async () => {
    // Not a regression test for the bug — a statement of the boundary. The
    // everyday "member has left" action must stay reversible; the audit's
    // complaint was that it was the ONLY thing on offer.
    const patron = patronFor('archived');
    const id = await createPatron(patron);
    await request(app.getHttpServer())
      .delete(`/t/${slug}/members/${id}`)
      .set('Cookie', ownerCookie)
      .expect(200);

    const [row] = await tenantSql<{ fullName: string; email: string; erasedAt: Date | null }>(
      'SELECT "fullName", email, "erasedAt" FROM members WHERE id = $1',
      [id],
    );
    expect(row!.fullName).toBe(patron.fullName);
    expect(row!.email).toBe(patron.email);
    expect(row!.erasedAt).toBeNull();
  });

  it('POST /:id/erase destroys every identifier — member row, audit trail, outbox, notes', async () => {
    const patron = patronFor('erased');
    const memberId = await createPatron(patron);

    // An edit, so the audit log holds a before AND an after snapshot — those
    // are the rows that kept a full name and e-mail after the old "erasure".
    await request(app.getHttpServer())
      .patch(`/t/${slug}/members/${memberId}`)
      .set('Cookie', ownerCookie)
      .send({ city: 'Βόλος' })
      .expect(200);

    // A closed loan whose return note names the patron, plus a book to hang it
    // on. This is the history that must SURVIVE the erasure, minus the name.
    const book = await request(app.getHttpServer())
      .post(`/t/${slug}/catalog/books`)
      .set('Cookie', ownerCookie)
      .send({ title: 'Το Κιβώτιο' })
      .expect(201);
    const copy = await request(app.getHttpServer())
      .post(`/t/${slug}/catalog/books/${book.body.id}/copies`)
      .set('Cookie', ownerCookie)
      .send({ barcode: `BC-${tag}-1` })
      .expect(201);
    const loan = await request(app.getHttpServer())
      .post(`/t/${slug}/loans`)
      .set('Cookie', ownerCookie)
      .send({ copyId: copy.body.id, memberId })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/t/${slug}/loans/${loan.body.loan.id}/return`)
      .set('Cookie', ownerCookie)
      .send({ notes: `Επιστράφηκε από τη ${patron.fullName} αυτοπροσώπως.` })
      .expect(201);

    // A photo: the member's face, which lives on the storage volume rather
    // than in a column. Nulling `photoAssetRef` without deleting the file
    // leaves the single most identifying thing in the system on disk.
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    );
    const photo = await request(app.getHttpServer())
      .post(`/t/${slug}/members/${memberId}/photo`)
      .set('Cookie', ownerCookie)
      .attach('file', png, 'patron.png')
      .expect(201);
    const photoPath = `${tenantStorageRoot}/${photo.body.photoAssetRef}`;
    expect(existsSync(photoPath)).toBe(true);

    // Two control-plane notices: one to the patron (must go), one to somebody
    // else in the same library (must stay).
    const keptOutboxEmail = `other.${tag}@patron.test`;
    for (const toEmail of [patron.email, keptOutboxEmail]) {
      await controlDb.emailOutbox.create({
        data: {
          kind: 'member_overdue',
          toEmail,
          subject: 'Εκπρόθεσμο: «Το Κιβώτιο»',
          bodyMarkdown: `Αγαπητέ/ή ${patron.fullName}, …`,
          tenantId,
          status: 'delivered',
          deliveredAt: new Date(),
        },
      });
    }

    // --- precondition: this is the state the verifier found ------------------
    const before = await tenantSql<Record<string, unknown>>('SELECT * FROM members WHERE id = $1', [
      memberId,
    ]);
    expect(before[0]!.fullName).toBe(patron.fullName);
    expect(before[0]!.dateOfBirth).not.toBeNull();
    expect(before[0]!.addressLine1).toBe(patron.addressLine1);
    const auditBefore = await tenantSql<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit_log
        WHERE "beforeJson"::text ILIKE $1 OR "afterJson"::text ILIKE $1`,
      [`%${patron.fullName}%`],
    );
    expect(Number(auditBefore[0]!.n)).toBeGreaterThan(0);

    // --- the erasure ---------------------------------------------------------
    const res = await request(app.getHttpServer())
      .post(`/t/${slug}/members/${memberId}/erase`)
      .set('Cookie', ownerCookie)
      .expect(201);
    expect(res.body.alreadyErased).toBe(false);
    expect(res.body.kept.loans).toBe(1);
    expect(res.body.cleared.outboxMessages).toBe(1);
    expect(res.body.cleared.photo).toBe(true);
    expect(existsSync(photoPath), 'the photo file survived the erasure').toBe(false);

    // --- the member row is a stub -------------------------------------------
    const [after] = await tenantSql<Record<string, unknown>>(
      'SELECT * FROM members WHERE id = $1',
      [memberId],
    );
    expect(after!.erasedAt).not.toBeNull();
    expect(after!.fullName).toBe('[erased]');
    expect(after!.memberNumber).toBe(erasedMemberNumber(memberId));
    expect(after!.searchText).toBe('');
    for (const col of [
      'email',
      'phone',
      'dateOfBirth',
      'addressLine1',
      'addressLine2',
      'city',
      'postalCode',
      'country',
      'photoAssetRef',
      'staffNotes',
    ]) {
      expect(after![col], `members.${col} survived the erasure`).toBeNull();
    }
    expect(after!.customFields).toEqual({});
    expect(after!.status).toBe('archived');

    // --- nothing anywhere else in the tenant DB still names them -------------
    for (const needle of [patron.fullName, patron.email, patron.addressLine1, patron.staffNotes]) {
      const [hit] = await tenantSql<{ n: string }>(
        `SELECT (
           (SELECT count(*) FROM members    WHERE (members::text)      ILIKE $1) +
           (SELECT count(*) FROM loans      WHERE (loans::text)        ILIKE $1) +
           (SELECT count(*) FROM reservations WHERE (reservations::text) ILIKE $1) +
           (SELECT count(*) FROM fines      WHERE (fines::text)        ILIKE $1) +
           (SELECT count(*) FROM audit_log  WHERE (audit_log::text)    ILIKE $1)
         )::text AS n`,
        [`%${needle}%`],
      );
      expect(Number(hit!.n), `"${needle}" still present in the tenant database`).toBe(0);
    }

    // --- what must survive ---------------------------------------------------
    const [keptLoan] = await tenantSql<{ id: string; notes: string | null; returnedAt: Date }>(
      'SELECT id, notes, "returnedAt" FROM loans WHERE "memberId" = $1',
      [memberId],
    );
    expect(keptLoan, 'the loan history was deleted along with the member').toBeTruthy();
    expect(keptLoan!.notes).toBeNull();
    expect(keptLoan!.returnedAt).not.toBeNull();

    const [erasedEvent] = await tenantSql<{ afterJson: Record<string, unknown> }>(
      `SELECT "afterJson" FROM audit_log WHERE action = 'member.erased' AND "targetId" = $1`,
      [memberId],
    );
    expect(erasedEvent, 'no accountability record that the erasure happened').toBeTruthy();
    expect(erasedEvent!.afterJson.loansKept).toBe(1);

    // The other patron's notice is untouched; theirs is gone. Asserted by
    // address rather than by counting rows — signup queues its own mail for
    // this tenant and that is not what this test is about.
    const theirs = await controlDb.emailOutbox.count({
      where: { tenantId, toEmail: patron.email },
    });
    const others = await controlDb.emailOutbox.count({
      where: { tenantId, toEmail: keptOutboxEmail },
    });
    expect(theirs).toBe(0);
    expect(others).toBe(1);
  });

  it('is safe to run twice, and the second run does not wipe the erasure record', async () => {
    const memberId = await createPatron(patronFor('twice'));
    await request(app.getHttpServer())
      .post(`/t/${slug}/members/${memberId}/erase`)
      .set('Cookie', ownerCookie)
      .expect(201);
    const again = await request(app.getHttpServer())
      .post(`/t/${slug}/members/${memberId}/erase`)
      .set('Cookie', ownerCookie)
      .expect(201);
    expect(again.body.alreadyErased).toBe(true);

    const [row] = await tenantSql<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit_log
        WHERE action = 'member.erased' AND "targetId" = $1 AND "afterJson" ? 'erasedAt'`,
      [memberId],
    );
    expect(Number(row!.n)).toBe(1);
  });

  it('refuses while the member still has a book out', async () => {
    const patron = patronFor('openloan');
    const memberId = await createPatron(patron);
    const book = await request(app.getHttpServer())
      .post(`/t/${slug}/catalog/books`)
      .set('Cookie', ownerCookie)
      .send({ title: 'Ο Πύργος' })
      .expect(201);
    const copy = await request(app.getHttpServer())
      .post(`/t/${slug}/catalog/books/${book.body.id}/copies`)
      .set('Cookie', ownerCookie)
      .send({ barcode: `BC-${tag}-2` })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/t/${slug}/loans`)
      .set('Cookie', ownerCookie)
      .send({ copyId: copy.body.id, memberId })
      .expect(201);

    const res = await request(app.getHttpServer())
      .post(`/t/${slug}/members/${memberId}/erase`)
      .set('Cookie', ownerCookie)
      .expect(400);
    expect(res.body.activeLoans).toBe(1);

    const [row] = await tenantSql<{ fullName: string }>(
      'SELECT "fullName" FROM members WHERE id = $1',
      [memberId],
    );
    expect(row!.fullName).toBe(patron.fullName);
  });
});

describe('privacy-legal-05 — retention sweep', () => {
  it('is registered in the job registry the runner consumes', () => {
    const names = SCHEDULED_JOBS.map((j) => j.name);
    expect(names).toContain('retention-sweep');
    expect(retentionJob().intervalMs).toBe(24 * 60 * 60_000);
  });

  it('deletes site applications past the published 12 months — and keeps the rest', async () => {
    const mk = async (
      label: string,
      data: { createdAt: Date; reviewedAt?: Date; status: 'new' | 'contacted' | 'accepted' },
    ) => {
      const row = await controlDb.application.create({
        data: {
          libraryName: `Retention ${tag} ${label}`,
          libraryType: 'public',
          city: 'Λάρισα',
          contactName: 'Γιώργος Δήμου',
          contactEmail: `apply.${tag}.${label}@example.test`,
          consent: true,
          privacyVersion: '2026-08-22',
          status: data.status,
          createdAt: data.createdAt,
          reviewedAt: data.reviewedAt ?? null,
        },
      });
      return row.id;
    };

    // 13 months old, never went anywhere → past the promise, must go.
    const stale = await mk('stale', { createdAt: daysAgo(395), status: 'new' });
    // 13 months old but we accepted them: the notice says those details move
    // into the library's account and live under the service agreement.
    const accepted = await mk('accepted', { createdAt: daysAgo(395), status: 'accepted' });
    // Old row, but we were in touch two months ago — the clock runs from the
    // contact, not from the submission.
    const recentlyContacted = await mk('contacted', {
      createdAt: daysAgo(395),
      reviewedAt: daysAgo(60),
      status: 'contacted',
    });
    // Three months old — nowhere near.
    const fresh = await mk('fresh', { createdAt: daysAgo(90), status: 'new' });

    const result = await runRetentionSweep();
    expect(result.counts?.applicationsPurged).toBeGreaterThanOrEqual(1);

    const survivors = await controlDb.application.findMany({
      where: { id: { in: [stale, accepted, recentlyContacted, fresh] } },
      select: { id: true },
    });
    expect(survivors.map((r) => r.id).sort()).toEqual([accepted, recentlyContacted, fresh].sort());

    // Re-running deletes nothing more — the sweep is safe on every tick.
    const second = await runRetentionSweep();
    expect(second.counts?.applicationsPurged).toBe(0);
  });

  it("takes the applicant's admin notification with them, submitted through the real form", async () => {
    // privacy-legal-14. The row is created by POSTing the public application
    // form — the same urlencoded submission a librarian on libriant.com makes —
    // so the outbox notification, its idempotency key and the applicant's
    // address in `replyToEmail` are all produced by the real code path rather
    // than seeded to match the sweep's expectations.
    const email = `retention.notify.${tag}@example.test`;
    const res = await request(app.getHttpServer())
      .post('/apply')
      .set('X-Real-IP', `203.0.113.${Math.floor(Math.random() * 200) + 1}`)
      // A librarian's browser sends this, and OriginCheckMiddleware now requires
      // it on /apply: the form has no non-browser caller, so a missing Origin
      // there is a script rather than a visitor. Without it this reads 403 and
      // the spec proves nothing about the sweep.
      .set('Origin', `https://${process.env.SITE_HOST}`)
      .type('form')
      .send({
        libraryName: `Notify ${tag}`,
        libraryType: 'school',
        city: 'Καρδίτσα',
        // Both are required now, and `phoneDialCode` carries the ISO country
        // code rather than the digits — the API composes '+30 2441000000' from
        // it. A submission missing either is a 400, not a stored row.
        country: 'GR',
        contactName: 'Ελένη Παππά',
        contactEmail: email,
        phoneDialCode: 'GR',
        phone: '2441000000',
        message: 'Ενδιαφερόμαστε για τη σχολική μας βιβλιοθήκη.',
        consent: 'yes',
      });
    expect([200, 303]).toContain(res.status);

    const application = await controlDb.application.findFirst({
      where: { contactEmail: email },
      select: { id: true },
    });
    expect(application, 'the form did not store an application').not.toBeNull();

    const key = applicationNotifyKey(application!.id);
    const before = await controlDb.emailOutbox.findUnique({ where: { idempotencyKey: key } });
    expect(before, 'the form did not enqueue the admin notification').not.toBeNull();
    // The second copy the finding is about: the applicant is in the body, and
    // their address is in the envelope even after the 90-day body sweep.
    expect(before!.bodyMarkdown).toContain(email);
    expect(before!.replyToEmail).toBe(email);

    // Age the application past the published promise, exactly as time would.
    await controlDb.application.update({
      where: { id: application!.id },
      data: { createdAt: daysAgo(400), status: 'new', reviewedAt: null },
    });

    await runRetentionSweep();

    expect(await controlDb.application.findUnique({ where: { id: application!.id } })).toBeNull();
    expect(await controlDb.emailOutbox.findUnique({ where: { idempotencyKey: key } })).toBeNull();
    // Nothing of that person is left anywhere in the control plane.
    expect(await controlDb.emailOutbox.count({ where: { replyToEmail: email } })).toBe(0);
  });

  it('leaves a tenant audit log alone while the plan grants unlimited retention', async () => {
    const id = `ancient-unlimited-${tag}`;
    await tenantSql(
      `INSERT INTO audit_log (id, "actorType", action, "occurredAt")
       VALUES ($1, 'system', 'test.ancient', $2)`,
      [id, daysAgo(400)],
    );

    const result = await runRetentionSweep();
    // Subscriptions are off, so every int feature resolves to the "unlimited"
    // sentinel: retention is LIFTED, and deleting here would destroy a
    // library's audit history it was told it could keep.
    expect(result.counts?.tenantsUnlimited).toBeGreaterThanOrEqual(1);
    expect(result.counts?.auditRowsDeleted).toBe(0);

    const [row] = await tenantSql<{ n: string }>(
      'SELECT count(*)::text AS n FROM audit_log WHERE id = $1',
      [id],
    );
    expect(Number(row!.n)).toBe(1);
  });

  it('enforces audit_log_retention_days once subscriptions are on', async () => {
    const settings = app.get(PlatformSettingsService);
    const plans = app.get(EffectivePlanService);
    const ancient = `ancient-enforced-${tag}`;
    const recent = `recent-enforced-${tag}`;
    try {
      await controlDb.platformSetting.upsert({
        where: { key: 'billing.enabled' },
        create: { key: 'billing.enabled', value: 'true' },
        update: { value: 'true' },
      });
      await redis.client.del('platform_setting:billing.enabled');
      await plans.invalidate(tenantId);
      expect(await settings.billingEnabled()).toBe(true);

      // Read the window rather than hard-coding it: what this test proves is
      // that the sweep enforces WHATEVER the plan sells, and the seeded values
      // are free to change (they were repriced in August).
      const days = await plans.getInt(tenantId, 'audit_log_retention_days');
      expect(days).toBeGreaterThan(1);
      expect(days).toBeLessThan(3650);

      await tenantSql(
        `INSERT INTO audit_log (id, "actorType", action, "occurredAt")
         VALUES ($1, 'system', 'test.ancient', $2), ($3, 'system', 'test.recent', $4)`,
        [ancient, daysAgo(days * 2 + 10), recent, new Date()],
      );

      const result = await runRetentionSweep();
      expect(result.counts?.auditRowsDeleted).toBeGreaterThanOrEqual(1);
    } finally {
      await controlDb.platformSetting
        .deleteMany({ where: { key: 'billing.enabled' } })
        .catch(() => undefined);
      await redis.client.del('platform_setting:billing.enabled').catch(() => undefined);
      await plans.invalidate(tenantId).catch(() => undefined);
    }

    // Past the window: gone. Inside it: untouched.
    const rows = await tenantSql<{ id: string }>('SELECT id FROM audit_log WHERE id IN ($1, $2)', [
      ancient,
      recent,
    ]);
    expect(rows.map((r) => r.id)).toEqual([recent]);
  });
});
