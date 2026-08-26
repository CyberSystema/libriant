import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { Client as PgClient } from 'pg';
import { controlDb } from '@libriant/db-control';
import { LEGAL_DOCUMENTS, LEGAL_VERSION } from '@libriant/shared';
import { AppModule } from '../../src/app.module.js';
import { HttpExceptionFilter } from '../../src/platform/http-exception.filter.js';
import { RedisService } from '../../src/platform/redis.service.js';
import { readLegalAcceptance } from '../../src/auth/legal-acceptance.js';
import { loadEnv } from '../../src/config/env.js';
import { listenOnce } from './listen-once.js';
import { declareBillingPosture } from './billing-posture.js';

declareBillingPosture(
  'unenforced',
  'The legal-consent record is orthogonal to the plan layer, and `unenforced` is the ' +
    'configuration the five launch libraries actually sign up under (twelve months free), so ' +
    'it is literally the posture their acceptance is recorded in.',
);

/**
 * privacy-legal-09, second attempt — driven through the MOUNTED HTTP routes.
 *
 * ## Why this file exists on top of legal-acceptance.spec.ts
 *
 * The first attempt at this finding was refuted on three points, and the shape
 * of the refutation matters more than the list: everything it built was
 * correct, and none of it was reachable.
 *
 *   1. `readLegalAcceptance()` shipped with a comment admitting no HTTP route
 *      mounted it. So the audit's "nothing ever reads them" stayed true — a
 *      reader with no caller is not a reader.
 *   2. What it stored was a SHA-256 per document. A digest proves text has not
 *      changed; asked what a library agreed to, it answers with 64 hex
 *      characters. The words themselves lived only in the git tree.
 *   3. It bumped `LEGAL_VERSION` from 2026-06-22 to 2026-08-26 while nothing
 *      compared a stored version against the current one — so any library on
 *      the old text was silently restamped and never asked to re-accept.
 *
 * So the assertions here are deliberately about the PRODUCT, not the module:
 * every call goes over HTTP through the real AppModule, and the text that comes
 * back is compared byte-for-byte against the markdown read independently off
 * disk by this file. Three sources have to agree — the archived body served by
 * the API, the digest recorded at acceptance time, and the published file — and
 * no assertion here compares a value to itself.
 *
 * Pre-reqs: `pnpm db:up`, or the audit environment.
 */

let app: NestExpressApplication;
const created: Array<{ tenantId: string }> = [];
const env = loadEnv();
const PASSWORD = 'consent-evidence-test-pw-1';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// apps/api/test/integration → repo root
const REPO = path.resolve(HERE, '..', '..', '..', '..');

function cookieFrom(res: request.Response, re: RegExp): string {
  const raw = res.headers['set-cookie'] as unknown as string[] | string | undefined;
  const cookies = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const c = cookies.find((x) => re.test(x));
  if (!c) throw new Error(`no cookie matching ${re}`);
  return c.split(';')[0]!;
}

/**
 * The bytes a visitor is actually served: the published file minus its leading
 * author blockquote, exactly as apps/web/lib/legal.ts strips it before
 * rendering. Read here from `locales/`, independently of anything the API does.
 */
function publishedBody(locale: string, slug: string): string {
  const raw = readFileSync(path.join(REPO, 'locales', locale, 'legal', `${slug}.md`), 'utf8');
  const lines = raw.split('\n');
  if (lines[0]?.startsWith('>') !== true) return raw;
  let i = 0;
  while (i < lines.length && lines[i]!.startsWith('>')) i++;
  while (i < lines.length && lines[i]!.trim() === '') i++;
  return lines.slice(i).join('\n');
}

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

type SignedUp = { slug: string; tenantId: string; cookie: string; userId: string };

async function signUp(opts: { locale?: 'el' | 'en'; ip?: string } = {}): Promise<SignedUp> {
  const slug = `consent-${randomBytes(4).toString('hex')}`;
  const body: Record<string, unknown> = {
    libraryName: `Consent ${slug}`,
    slug,
    fullName: 'Μαρία Παπαδοπούλου',
    email: `owner@${slug}.test`,
    password: PASSWORD,
    acceptLegal: true,
    libraryType: 'public',
    addressStreet: '1 Library St',
    addressCity: 'Athens',
    addressPostalCode: '10000',
    addressCountry: 'GR',
  };
  if (opts.locale) body.defaultLocale = opts.locale;

  const res = await request(app.getHttpServer())
    .post('/auth/signup')
    .set('X-Real-IP', opts.ip ?? '198.51.100.77')
    .send(body)
    .expect(201);

  const tenantId = res.body.tenant.id as string;
  created.push({ tenantId });
  return {
    slug,
    tenantId,
    cookie: cookieFrom(res, /^(__Host-)?libriant_session=/),
    userId: res.body.user.id,
  };
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

  const redis = app.get(RedisService);
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await redis.ping()) break;
    await new Promise((r) => setTimeout(r, 100));
  }
}, 120_000);

afterAll(async () => {
  for (const c of created) {
    await controlDb.tenant.deleteMany({ where: { id: c.tenantId } }).catch(() => undefined);
    await dropTenantDb(c.tenantId).catch(() => undefined);
  }
  if (app) await app.close();
}, 120_000);

describe('the acceptance record can produce the text that was on screen', () => {
  it('serves the exact published body of every document over HTTP', async () => {
    const { slug, cookie } = await signUp({ locale: 'en' });

    const res = await request(app.getHttpServer())
      .get(`/t/${slug}/legal/consent/evidence`)
      .set('Cookie', cookie)
      .expect(200);

    expect(res.body.acceptances).toHaveLength(1);
    const acceptance = res.body.acceptances[0];
    expect(acceptance.version).toBe(LEGAL_VERSION);
    expect(acceptance.locale).toBe('en');
    expect(acceptance.localeAsserted).toBe(true);
    expect(acceptance.ip).toBe('198.51.100.77');
    expect(acceptance.acceptedBy.fullName).toBe('Μαρία Παπαδοπούλου');
    expect(acceptance.acceptedBy.role).toBe('owner');

    const docs = acceptance.documents as Array<{
      slug: string;
      body: string | null;
      sha256: string;
      presented: boolean;
      digestMatchesAcceptance: boolean | null;
    }>;
    expect(docs.map((d) => d.slug)).toEqual([...LEGAL_DOCUMENTS]);

    for (const doc of docs) {
      // THE ACCEPTANCE CRITERION: the words come back, and they are the words
      // the site publishes — compared against the file this test read itself.
      const expected = publishedBody('en', doc.slug);
      expect(doc.body, `no archived body for ${doc.slug}`).toBeTypeOf('string');
      expect(doc.body, `archived ${doc.slug} differs from locales/en/legal/${doc.slug}.md`).toBe(
        expected,
      );
      // …and the digest written at acceptance time is a digest OF THOSE BYTES,
      // which is what makes the pair evidence rather than two separate claims.
      expect(doc.sha256).toBe(createHash('sha256').update(expected, 'utf8').digest('hex'));
      expect(doc.digestMatchesAcceptance, `digest drift on ${doc.slug}`).toBe(true);
    }

    // Only the two behind the checkbox are claimed as shown; the DPA is
    // fingerprinted and archived but honestly marked incorporated-by-reference.
    expect(docs.filter((d) => d.presented).map((d) => d.slug)).toEqual(['terms', 'privacy']);

    // The English and Greek corpora are genuinely different documents, so a
    // record that names one is actually distinguishing them.
    expect(docs.find((d) => d.slug === 'terms')!.body).not.toBe(publishedBody('el', 'terms'));
  }, 120_000);

  it('archives BOTH published translations of the version, not only the one shown', async () => {
    // The library above was English. The Greek text of the same version has to
    // be retrievable too — the Terms incorporate the DPA and the AUP by
    // reference, and a Greek library disputing a clause needs the Greek words.
    const rows = await controlDb.legalDocumentVersion.findMany({
      where: { version: LEGAL_VERSION },
      select: { locale: true, slug: true, body: true, sha256: true },
    });
    expect(rows).toHaveLength(LEGAL_DOCUMENTS.length * 2);
    for (const row of rows) {
      expect(row.body).toBe(publishedBody(row.locale, row.slug));
      expect(row.sha256).toBe(createHash('sha256').update(row.body, 'utf8').digest('hex'));
    }
  }, 60_000);

  it('does not claim a translation the caller never declared', async () => {
    const { slug, cookie } = await signUp({});
    const res = await request(app.getHttpServer())
      .get(`/t/${slug}/legal/consent`)
      .set('Cookie', cookie)
      .expect(200);
    // The record still resolves to a corpus (there has to be one), but it says
    // out loud that the language was not attested — instead of the old
    // behaviour, which produced a record indistinguishable from a declared one.
    expect(res.body.acceptedLocaleAsserted).toBe(false);
    expect(res.body.acceptedVersion).toBe(LEGAL_VERSION);
  }, 120_000);
});

describe('a library left behind by a version bump is detected and can re-accept', () => {
  it('reads legalAcceptedVersion, flags the mismatch, and clears it on re-acceptance', async () => {
    const { slug, tenantId, cookie, userId } = await signUp({ locale: 'el' });

    // Fresh signup: current, nothing to do.
    const fresh = await request(app.getHttpServer())
      .get(`/t/${slug}/legal/consent`)
      .set('Cookie', cookie)
      .expect(200);
    expect(fresh.body.currentVersion).toBe(LEGAL_VERSION);
    expect(fresh.body.acceptedVersion).toBe(LEGAL_VERSION);
    expect(fresh.body.reacceptanceRequired).toBe(false);

    // Now reproduce EXACTLY the state the refutation described: a library
    // holding the previous stamp while the published documents have moved on.
    // (The first attempt created this state for real by bumping LEGAL_VERSION
    // from 2026-06-22, and nothing anywhere noticed.)
    await controlDb.tenant.update({
      where: { id: tenantId },
      data: { legalAcceptedVersion: '2026-06-22' },
    });
    await controlDb.user.update({
      where: { id: userId },
      data: { legalAcceptedVersion: '2026-06-22' },
    });

    const stale = await request(app.getHttpServer())
      .get(`/t/${slug}/legal/consent`)
      .set('Cookie', cookie)
      .expect(200);
    expect(stale.body.acceptedVersion).toBe('2026-06-22');
    expect(stale.body.reacceptanceRequired, 'the version mismatch went undetected').toBe(true);

    // The evidence endpoint carries the same flag, and — this is the part that
    // matters — each acceptance is still resolved against THE VERSION IT WAS
    // MADE UNDER, taken from the audit row, not against whatever LEGAL_VERSION
    // is today. Serving today's text under an older stamp would be the original
    // defect with extra steps.
    const staleEvidence = await request(app.getHttpServer())
      .get(`/t/${slug}/legal/consent/evidence`)
      .set('Cookie', cookie)
      .expect(200);
    expect(staleEvidence.body.reacceptanceRequired).toBe(true);
    expect(staleEvidence.body.acceptedVersion).toBe('2026-06-22');
    expect(staleEvidence.body.acceptances[0].version).toBe(LEGAL_VERSION);

    // Re-accept, in English this time — a different corpus from the signup.
    const accepted = await request(app.getHttpServer())
      .post(`/t/${slug}/legal/consent/accept`)
      .set('Cookie', cookie)
      .set('X-Real-IP', '203.0.113.42')
      .send({ locale: 'en' })
      .expect(200);
    expect(accepted.body.acceptedVersion).toBe(LEGAL_VERSION);
    expect(accepted.body.reacceptanceRequired).toBe(false);

    // The column really moved — read straight from the control DB, not from
    // the response we just asserted on.
    const row = await controlDb.tenant.findUnique({
      where: { id: tenantId },
      select: { legalAcceptedVersion: true },
    });
    expect(row!.legalAcceptedVersion).toBe(LEGAL_VERSION);

    // Two acceptances now, newest first, and the new one carries the English
    // text while the original still carries the Greek one it was made under.
    const evidence = await request(app.getHttpServer())
      .get(`/t/${slug}/legal/consent/evidence`)
      .set('Cookie', cookie)
      .expect(200);
    expect(evidence.body.acceptances).toHaveLength(2);
    const [latest, first] = evidence.body.acceptances;
    expect(latest.locale).toBe('en');
    expect(latest.ip).toBe('203.0.113.42');
    expect(latest.documents.find((d: { slug: string }) => d.slug === 'terms').body).toBe(
      publishedBody('en', 'terms'),
    );
    expect(first.locale).toBe('el');
    expect(first.documents.find((d: { slug: string }) => d.slug === 'terms').body).toBe(
      publishedBody('el', 'terms'),
    );

    // Independent second view of the same rows, through the low-level reader:
    // if these disagree, one of the two is lying about the record.
    const direct = await readLegalAcceptance(tenantId);
    expect(direct).toHaveLength(2);
    expect(direct[0]!.evidence?.locale).toBe('en');
    expect(direct[1]!.evidence?.locale).toBe('el');
  }, 180_000);

  it('rejects an acceptance that will not name the language it displayed', async () => {
    const { slug, cookie } = await signUp({ locale: 'el' });
    await request(app.getHttpServer())
      .post(`/t/${slug}/legal/consent/accept`)
      .set('Cookie', cookie)
      .send({})
      .expect(400);
    await request(app.getHttpServer())
      .post(`/t/${slug}/legal/consent/accept`)
      .set('Cookie', cookie)
      .send({ locale: 'fr' })
      .expect(400);
  }, 120_000);

  it('is not readable without a session for that library', async () => {
    const { slug } = await signUp({ locale: 'el' });
    await request(app.getHttpServer()).get(`/t/${slug}/legal/consent`).expect(401);
    await request(app.getHttpServer()).get(`/t/${slug}/legal/consent/evidence`).expect(401);
    await request(app.getHttpServer())
      .post(`/t/${slug}/legal/consent/accept`)
      .send({ locale: 'el' })
      .expect(401);

    // A different library's owner cannot read this one's contract record.
    const other = await signUp({ locale: 'el' });
    await request(app.getHttpServer())
      .get(`/t/${slug}/legal/consent/evidence`)
      .set('Cookie', other.cookie)
      .expect(403);
  }, 180_000);
});
