import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { Client as PgClient } from 'pg';
import { controlDb } from '@libriant/db-control';
import { LEGAL_DOCUMENTS, LEGAL_VERSION, SIGNUP_CONSENT_DOCS } from '@libriant/shared';
import { AppModule } from '../../src/app.module.js';
import { HttpExceptionFilter } from '../../src/platform/http-exception.filter.js';
import { RedisService } from '../../src/platform/redis.service.js';
import { readLegalAcceptance } from '../../src/auth/legal-acceptance.js';
import { loadEnv } from '../../src/config/env.js';
import { listenOnce } from './listen-once.js';
import { declareBillingPosture } from './billing-posture.js';

declareBillingPosture(
  'unenforced',
  'Signup and the legal-acceptance record are orthogonal to the plan layer, and this is the ' +
    'configuration real libraries sign up under — every launch library gets twelve months ' +
    'free, so `unenforced` is literally the posture their acceptance is recorded in.',
);

/**
 * privacy-legal-09, driven through the real signup endpoint.
 *
 * The audit found acceptance recorded but not evidenced: `legalAcceptedVersion`
 * was a single date string covering all seven documents, nothing ever read it,
 * and the web app renders `locales/<locale>/legal/<slug>.md` from disk at
 * request time — so the record pointed at a mutable file. Article 5(2)/7(1)
 * require the ability to demonstrate WHAT was agreed; a date cannot.
 *
 * A unit test cannot prove this: the evidence has to survive the real
 * transaction that creates the Tenant and the owner User, and the digests it
 * carries have to be the digests of the documents actually on disk. So this
 * signs a library up over HTTP and then reads the record back through
 * `readLegalAcceptance`, comparing each digest against a freshly computed hash
 * of the live markdown — three independent sources, no assertion of a value
 * against itself.
 *
 * Pre-reqs: `pnpm db:up`, or the audit environment.
 */

let app: NestExpressApplication;
const created: Array<{ tenantId: string; slug: string }> = [];
const env = loadEnv();
const password = 'legal-acceptance-test-pw-1';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// apps/api/test/integration → repo root
const REPO = path.resolve(HERE, '..', '..', '..', '..');

/** The bytes a visitor is served: the file minus its leading author blockquote. */
function publishedDigest(locale: string, slug: string): string {
  const raw = readFileSync(path.join(REPO, 'locales', locale, 'legal', `${slug}.md`), 'utf8');
  const lines = raw.split('\n');
  let body = raw;
  if (lines[0]?.startsWith('>')) {
    let i = 0;
    while (i < lines.length && lines[i]!.startsWith('>')) i++;
    while (i < lines.length && lines[i]!.trim() === '') i++;
    body = lines.slice(i).join('\n');
  }
  return createHash('sha256').update(body, 'utf8').digest('hex');
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

async function signUp(locale: 'el' | 'en') {
  const slug = `legal-${locale}-${randomBytes(3).toString('hex')}`;
  await request(app.getHttpServer())
    .post('/auth/signup')
    .set('X-Real-IP', '198.51.100.77')
    .send({
      libraryName: `Legal Acceptance ${slug}`,
      slug,
      fullName: 'Μαρία Παπαδοπούλου',
      email: `owner@${slug}.test`,
      password,
      defaultLocale: locale,
      acceptLegal: true,
      libraryType: 'school',
      addressStreet: '1 Library St',
      addressCity: 'Athens',
      addressPostalCode: '10000',
      addressCountry: 'GR',
    })
    .expect(201);
  const tenant = await controlDb.tenant.findUnique({
    where: { slug },
    select: { id: true, legalAcceptedVersion: true, legalAcceptedAt: true },
  });
  created.push({ tenantId: tenant!.id, slug });
  return { slug, tenant: tenant! };
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
}, 60_000);

describe('signup evidences WHICH text the library agreed to', () => {
  it('records a digest per document against the Greek corpus the owner was shown', async () => {
    const { slug, tenant } = await signUp('el');

    // The pre-existing columns still say when and under which stamp…
    expect(tenant.legalAcceptedVersion).toBe(LEGAL_VERSION);
    expect(tenant.legalAcceptedAt).toBeTruthy();

    // …and the new record says what. Read back through the reader, not by
    // querying the table directly: "nothing ever read them" was half the
    // finding, so the reader is part of the fix and has to be exercised.
    const acceptances = await readLegalAcceptance(tenant.id);
    expect(acceptances, 'no tenant.legal_accepted record was written').toHaveLength(1);
    const record = acceptances[0]!;

    expect(record.ip).toBe('198.51.100.77');
    expect(record.evidence?.version).toBe(LEGAL_VERSION);
    expect(record.evidence?.locale).toBe('el');
    expect(record.evidence?.acceptedBy.email).toBe(`owner@${slug}.test`);
    expect(record.evidence?.acceptedBy.fullName).toBe('Μαρία Παπαδοπούλου');
    expect(record.evidence?.acceptedBy.role).toBe('owner');
    expect(record.userId).toBe(record.evidence?.acceptedBy.userId);

    // Every document in the version, each fingerprinting the file on disk.
    const docs = record.evidence!.documents;
    expect(docs.map((d) => d.slug)).toEqual([...LEGAL_DOCUMENTS]);
    for (const doc of docs) {
      expect(doc.sha256, `digest for ${doc.slug} does not match the published file`).toBe(
        publishedDigest('el', doc.slug),
      );
      expect(doc.archivePath).toBe(`docs/legal/accepted/${LEGAL_VERSION}/el/${doc.slug}.md`);
      // The frozen copy has to be there, or the digest points at nothing.
      expect(() => readFileSync(path.join(REPO, doc.archivePath), 'utf8')).not.toThrow();
    }

    // Exactly the documents behind the checkbox are claimed as presented —
    // read from the constant the signup label is built from, never hard-coded
    // here, because a hard-coded list is how the record and the screen drift
    // apart (privacy-legal-13). Everything else in the corpus is fingerprinted
    // and archived but honestly marked as incorporated by reference.
    expect(docs.filter((d) => d.presented).map((d) => d.slug)).toEqual([...SIGNUP_CONSENT_DOCS]);
    expect(docs.find((d) => d.slug === 'dpa')!.presented).toBe(true);
    expect(docs.find((d) => d.slug === 'acceptable-use')!.presented).toBe(false);
  }, 90_000);

  it('records the English corpus when the owner signed up in English', async () => {
    const { tenant } = await signUp('en');
    const record = (await readLegalAcceptance(tenant.id))[0]!;

    expect(record.evidence?.locale).toBe('en');
    const terms = record.evidence!.documents.find((d) => d.slug === 'terms')!;
    expect(terms.sha256).toBe(publishedDigest('en', 'terms'));
    // The two locales are different documents, so their digests must differ —
    // otherwise the record would not actually distinguish which text was shown.
    expect(terms.sha256).not.toBe(publishedDigest('el', 'terms'));
  }, 90_000);
});
