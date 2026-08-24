import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { controlDb } from '@libriant/db-control';
import { makeTenantPrismaClient, type TenantPrismaClient } from '@libriant/db-tenant';
import { AppModule } from '../../src/app.module.js';
import { HttpExceptionFilter } from '../../src/platform/http-exception.filter.js';
import { RedisService } from '../../src/platform/redis.service.js';
import { listenOnce } from './listen-once.js';
import { declareBillingPosture } from './billing-posture.js';

declareBillingPosture(
  'unenforced',
  'Minting a member number and listing overdue loans are day-one library actions. ' +
    'Nothing here asserts a plan gate, so this runs the shipped configuration.',
);

/**
 * The two hot paths performance-02 and performance-04 are about, driven through
 * the REAL HTTP routes against a REAL provisioned tenant database.
 *
 * Both findings were previously reported fixed with the application code
 * untouched — a migration created `member_number_counters` and nothing read it,
 * and a partial index was created for an overdue ORDER BY that was written into
 * a SQL comment instead of into LoansService. So these tests deliberately
 * assert things that can only be true if the SERVICE changed:
 *
 *   - the counter row exists and tracks the numbers actually issued (the old
 *     scan-and-max never wrote it);
 *   - the overdue list comes back most-overdue-first, which only the `dueAt ASC`
 *     ordering produces;
 *   - the tenant database carries the index that ordering needs.
 */
let app: NestExpressApplication;
let tenantCookie = '';
let slug = '';
let tenantClient: TenantPrismaClient | null = null;
const tag = randomBytes(3).toString('hex');
const YEAR = new Date().getUTCFullYear();

function cookieFrom(res: request.Response, re: RegExp): string {
  const raw = res.headers['set-cookie'] as unknown as string[] | string | undefined;
  const cookies = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const c = cookies.find((x) => re.test(x));
  if (!c) throw new Error(`no cookie matching ${re}`);
  return c.split(';')[0]!;
}

const http = () => request(app.getHttpServer());

// Returns the supertest Test (not a promise of one) so callers can chain
// `.expect(...)` the way every other spec in this directory does.
const createMember = (body: Record<string, unknown>) =>
  http().post(`/t/${slug}/members`).set('Cookie', tenantCookie).send(body);

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

  slug = `perfhot-${tag}`;
  const signup = await http()
    .post('/auth/signup')
    .send({
      libraryName: `Perf Hot ${slug}`,
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

  const tenant = await controlDb.tenant.findUnique({ where: { slug } });
  if (!tenant) throw new Error('signup did not provision a tenant');
  tenantClient = makeTenantPrismaClient({ databaseUrl: tenant.dbUrl, maxPoolSize: 2 });
}, 120_000);

afterAll(async () => {
  if (tenantClient) await tenantClient.$disconnect().catch(() => undefined);
  if (app) await app.close();
});

describe('performance-04 — member numbers come from the counter, not a table scan', () => {
  it('seeds the counter from the numbers already on the shelf', async () => {
    // A member the library numbered by hand, above where a fresh counter starts.
    await createMember({
      fullName: 'Χειροκίνητο Μέλος',
      memberNumber: `M-${YEAR}-0500`,
    }).expect(201);

    // The first auto-numbered member must continue from it, not collide with it.
    const first = await createMember({ fullName: 'Πρώτο Μέλος' }).expect(201);
    expect(first.body.memberNumber).toBe(`M-${YEAR}-0501`);

    const rows = await tenantClient!.$queryRawUnsafe<{ year: number; nextSeq: number }[]>(
      'SELECT "year", "nextSeq" FROM "member_number_counters" ORDER BY "year"',
    );
    // The audited implementation never wrote this table: an empty result here
    // means the scan-and-max is back.
    expect(rows).toHaveLength(1);
    expect(rows[0]!.year).toBe(YEAR);
    expect(rows[0]!.nextSeq).toBe(501);
  });

  it('hands out consecutive numbers and keeps the counter in step', async () => {
    const issued: string[] = [];
    for (let i = 0; i < 5; i++) {
      const res = await createMember({ fullName: `Σειρά ${i}` }).expect(201);
      issued.push(res.body.memberNumber);
    }
    expect(issued).toEqual([502, 503, 504, 505, 506].map((n) => `M-${YEAR}-0${n}`));
    const [counter] = await tenantClient!.$queryRawUnsafe<{ nextSeq: number }[]>(
      'SELECT "nextSeq" FROM "member_number_counters" WHERE "year" = $1',
      YEAR,
    );
    expect(counter!.nextSeq).toBe(506);
  });

  it('gives ten CONCURRENT creates ten distinct numbers', async () => {
    const res = await Promise.all(
      Array.from({ length: 10 }, (_, i) => createMember({ fullName: `Ταυτόχρονο ${i}` })),
    );
    for (const r of res) expect(r.status).toBe(201);
    const numbers = res.map((r) => r.body.memberNumber as string);
    expect(new Set(numbers).size).toBe(10);
  });
});

describe('performance-02 — the overdue list is ordered by how overdue it is', () => {
  const dueOffsetsDays = [-30, -1, -10, -3]; // deliberately not in order
  let memberId = '';
  let bookId = '';

  it('checks out four loans and backdates them', async () => {
    const member = await createMember({ fullName: 'Δανειζόμενος' }).expect(201);
    memberId = member.body.id;
    const book = await http()
      .post(`/t/${slug}/catalog/books`)
      .set('Cookie', tenantCookie)
      .send({ title: 'Βιβλίο Δοκιμής' })
      .expect(201);
    bookId = book.body.id;

    for (let i = 0; i < dueOffsetsDays.length; i++) {
      const copy = await http()
        .post(`/t/${slug}/catalog/books/${bookId}/copies`)
        .set('Cookie', tenantCookie)
        .send({ barcode: `PERF-${tag}-${i}` })
        .expect(201);
      const loan = await http()
        .post(`/t/${slug}/loans`)
        .set('Cookie', tenantCookie)
        .send({ copyId: copy.body.id, memberId })
        .expect(201);
      // The checkout endpoint will not let a librarian book a due date in the
      // past, so age the loan the way time would.
      const dueAt = new Date(Date.now() + dueOffsetsDays[i]! * 86_400_000);
      await tenantClient!.loan.update({
        where: { id: loan.body.loan.id },
        data: { dueAt, loanedAt: new Date(dueAt.getTime() - 14 * 86_400_000) },
      });
    }
  });

  it('returns the MOST overdue first (dueAt ascending), through the real route', async () => {
    const res = await http()
      .get(`/t/${slug}/loans?overdue=1&limit=100`)
      .set('Cookie', tenantCookie)
      .expect(200);
    const due = res.body.items.map((l: { dueAt: string }) => new Date(l.dueAt).getTime());
    expect(due).toHaveLength(4);
    expect(due).toEqual([...due].sort((a, b) => a - b));
    // The audited ordering was `loanedAt DESC`, which for these loans is the
    // exact reverse — so this assertion fails if the service is reverted.
    expect(due).not.toEqual([...due].sort((a, b) => b - a));
  });

  it('leaves the UNFILTERED list newest-first, as before', async () => {
    const res = await http()
      .get(`/t/${slug}/loans?limit=100`)
      .set('Cookie', tenantCookie)
      .expect(200);
    const loaned = res.body.items.map((l: { loanedAt: string }) => new Date(l.loanedAt).getTime());
    expect(loaned.length).toBeGreaterThanOrEqual(4);
    expect(loaned).toEqual([...loaned].sort((a, b) => b - a));
  });

  it('provisions the index that ordering needs, and drops the one it cannot use', async () => {
    const idx = await tenantClient!.$queryRawUnsafe<{ indexname: string }[]>(
      "SELECT indexname FROM pg_indexes WHERE tablename = 'loans'",
    );
    const names = idx.map((r) => r.indexname);
    expect(names).toContain('loans_status_dueAt_id_idx');
    // Partial on `status = 'active'`, which Prisma's `CAST($1::text AS enum)`
    // can never satisfy because `enum_in` is STABLE and so is never folded to a
    // constant for the predicate prover.
    expect(names).not.toContain('loans_active_dueAt_idx');
  });
});
