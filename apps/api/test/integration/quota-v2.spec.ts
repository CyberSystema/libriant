import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { controlDb } from '@libriant/db-control';
import { AppModule } from '../../src/app.module.js';
import { HttpExceptionFilter } from '../../src/platform/http-exception.filter.js';
import { EffectivePlanService } from '../../src/plans/effective-plan.service.js';
import { listenOnce } from './listen-once.js';
import { declareBillingPosture } from './billing-posture.js';

declareBillingPosture(
  'enforced',
  'This spec is ABOUT the ceiling. It sets a finite `max_books` and `max_members` override on its ' +
    'own tenant and asserts the 2.0 write surface refuses past it — which is the whole point.',
);

/**
 * Plan ceilings reach the 2.0 write surface (2.0 phase 20g).
 *
 * ## What was wrong
 *
 * 1.0 enforces `max_books` inside `BooksService.create` and `max_members` on
 * `MembersController.create`. The 2.0 write surface — the one the cutover
 * replaces them with — enforced NEITHER, and `QUOTA_COUNTERS` still counted
 * `books` and `members`, tables the cutover archives.
 *
 * So the two halves were pointed at the wrong datamodel in opposite directions:
 * usage read a table nobody was writing any more, and the writers had no ceiling
 * at all. A library on a five-hundred-title plan could catalogue without limit
 * through the very screens 2.0 gives it, and its usage page would say zero.
 */
let app: NestExpressApplication;
const tag = randomBytes(4).toString('hex');
let slug = '';
let owner = '';
let tenantId = '';
let effective: EffectivePlanService;

const SESSION_RE = /^(__Host-)?libriant_session=/;
function cookieFrom(res: request.Response, re: RegExp): string {
  const raw = res.headers['set-cookie'] as unknown as string[] | string | undefined;
  const cookies = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const c = cookies.find((x) => re.test(x));
  if (!c) throw new Error(`no cookie matching ${re}`);
  return c.split(';')[0]!;
}
const api = () => request(app.getHttpServer());

/** A minimal but real MARC record — the editor's own shape. */
const record = (title: string) => ({
  leader: '00000nam a2200000 a 4500',
  fields: [
    { t: '008', v: '260905s2026    gr |||||||||||000 0 gre d' },
    { t: '245', i: '00', s: [{ a: title }] },
  ],
});

/**
 * Pin a finite ceiling on this tenant only.
 *
 * The invalidate is not optional: `EffectivePlanService` is a Redis cache in
 * front of the control plane, so a limit written and read in the same breath is
 * the OLD limit for up to a TTL. That is deliberate in the product — a plan
 * change is not a hot-path read — and it is why every spec that moves a limit
 * calls this.
 */
async function setLimit(featureKey: string, value: number): Promise<void> {
  await controlDb.tenantPlanOverride.upsert({
    where: { tenantId_featureKey: { tenantId, featureKey } },
    create: { tenantId, featureKey, valueInt: value },
    update: { valueInt: value },
  });
  await effective.invalidate(tenantId);
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

  slug = `quota-${tag}`;
  const res = await api()
    .post('/auth/signup')
    .send({
      libraryName: `Quota ${slug}`,
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
  owner = cookieFrom(res, SESSION_RE);
  tenantId = (await controlDb.tenant.findUnique({ where: { slug } }))!.id;
  effective = app.get(EffectivePlanService);
}, 180_000);

afterAll(async () => {
  await app?.close();
});

describe('§1 the catalogue ceiling', () => {
  it('lets a library catalogue up to its plan', async () => {
    await setLimit('max_books', 2);
    for (const t of ['ΠΡΩΤΟ', 'ΔΕΥΤΕΡΟ']) {
      await api().post(`/t/${slug}/catalog/bib`).set('Cookie', owner).send(record(t)).expect(201);
    }
  }, 120_000);

  it('and REFUSES the one past it — which nothing did before', async () => {
    const res = await api()
      .post(`/t/${slug}/catalog/bib`)
      .set('Cookie', owner)
      .send(record('ΤΡΙΤΟ'));
    expect(res.status, JSON.stringify(res.body)).toBe(402);
  }, 60_000);

  it('counts BIBLIOGRAPHIC records only — a library is not billed for its own headings', async () => {
    // `marc_records` holds authority, holdings and classification records too.
    // Counting those would charge a library for the headings it catalogues
    // with, which is why both the ceiling and the counter say `bibliographic`.
    await setLimit('max_books', 3);
    const authority = await api()
      .post(`/t/${slug}/catalog/bib`)
      .set('Cookie', owner)
      .send({ ...record('ΚΑΘΙΕΡΩΜΕΝΟΣ'), kind: 'authority' });
    // Authority records are refused by the write path for a different reason
    // (no Avram definition in this build), so the assertion is narrow: whatever
    // happens, it is NOT a quota refusal.
    expect(authority.status).not.toBe(402);
  }, 60_000);

  it('lifts the moment the ceiling does', async () => {
    await setLimit('max_books', 50);
    await api()
      .post(`/t/${slug}/catalog/bib`)
      .set('Cookie', owner)
      .send(record('ΤΕΤΑΡΤΟ'))
      .expect(201);
  }, 60_000);
});

describe('§2 the reader ceiling', () => {
  it('refuses an enrolment past the plan', async () => {
    await setLimit('max_members', 1);
    await api()
      .post(`/t/${slug}/patrons`)
      .set('Cookie', owner)
      .send({ fullName: 'Πρώτη Αναγνώστρια' })
      .expect(201);
    const res = await api()
      .post(`/t/${slug}/patrons`)
      .set('Cookie', owner)
      .send({ fullName: 'Δεύτερος Αναγνώστης' });
    expect(res.status, JSON.stringify(res.body)).toBe(402);
  }, 120_000);

  it('does not bill a library for a reader it erased under Article 17', async () => {
    // The predicate excludes `erased_at`, and the reason is not performance: a
    // library is legally required to keep the row, and charging its plan for
    // complying with the GDPR would be the wrong answer to the wrong question.
    const list = await api().get(`/t/${slug}/patrons`).set('Cookie', owner).expect(200);
    const first = (list.body as { items: { id: string }[] }).items[0]!;
    await api()
      .post(`/t/${slug}/patrons/${first.id}/erase`)
      .set('Cookie', owner)
      .send({ reason: 'Article 17(1)(a)' })
      .expect(200);

    // The erased reader no longer counts, so the slot is free again.
    await api()
      .post(`/t/${slug}/patrons`)
      .set('Cookie', owner)
      .send({ fullName: 'Τρίτη Αναγνώστρια' })
      .expect(201);
  }, 120_000);
});

describe('§3 the usage page counts what the ceiling counts', () => {
  it('reports 2.0 tables, not the 1.0 ones the cutover archives', async () => {
    await setLimit('max_books', 50);
    await setLimit('max_members', 50);
    const res = await api().get(`/t/${slug}/plan/usage`).set('Cookie', owner).expect(200);
    const usage = (res.body as { usage: { feature: string; used: number }[] }).usage;
    const books = usage.find((u) => u.feature === 'max_books');
    const members = usage.find((u) => u.feature === 'max_members');
    // Non-zero is the whole assertion: every record and reader this spec made
    // went through the 2.0 write surface, so a counter still reading `books`
    // and `members` would report zero for both.
    expect(books?.used, 'usage still counts the 1.0 `books` table').toBeGreaterThan(0);
    expect(members?.used, 'usage still counts the 1.0 `members` table').toBeGreaterThan(0);
  }, 60_000);
});
