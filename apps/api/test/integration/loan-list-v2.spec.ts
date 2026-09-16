import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import { randomBytes } from 'node:crypto';
import { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { controlDb } from '@libriant/db-control';
import { v2SessionOptions, V2_SCHEMA } from '@libriant/db-tenant';
import { AppModule } from '../../src/app.module.js';
import { HttpExceptionFilter } from '../../src/platform/http-exception.filter.js';
import { listenOnce } from './listen-once.js';
import { declareBillingPosture } from './billing-posture.js';

declareBillingPosture(
  'unenforced',
  'Reading the loan list is how a desk answers "where is this book". It is the same read the ' +
    'return counter makes, and it never stops.',
);

/**
 * `GET /t/:slug/circulation/loans` — the desk's work queue (2.0 phase 20q).
 *
 * Phase 20a built this route and shipped it with NO test. This spec is written
 * because 20q repoints the staff loans screen onto it, and the three things the
 * screen now depends on are exactly the three a unit test cannot see:
 *
 *   §1  the TITLE, which no 2.0 route joined before this phase
 *   §2  `?open=1`, which is `closed_at IS NULL` and NOT `status='active'`
 *   §3  the anonymised reader, which is the DEFAULT for a returned loan
 *
 * Each of the three has a wrong answer that renders perfectly: a missing title,
 * a copy reported as "not out" while a reader has it, and an empty Member column
 * that reads as a bug rather than as the privacy promise it is.
 */
let app: NestExpressApplication;
const tag = randomBytes(4).toString('hex');
let slug = '';
let owner = '';
let dbUrl = '';
let patronId = '';

const SESSION_RE = /^(__Host-)?libriant_session=/;
function cookieFrom(res: request.Response, re: RegExp): string {
  const raw = res.headers['set-cookie'] as unknown as string[] | string | undefined;
  const cookies = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const c = cookies.find((x) => re.test(x));
  if (!c) throw new Error(`no cookie matching ${re}`);
  return c.split(';')[0]!;
}
const api = () => request(app.getHttpServer());

async function sql<T = Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const c = new PgClient({ connectionString: dbUrl, options: v2SessionOptions(V2_SCHEMA) });
  await c.connect();
  try {
    return (await c.query(text, params)).rows as T[];
  } finally {
    await c.end();
  }
}

type LoanRow = {
  id: string;
  title: string | null;
  bibId: string;
  status: string;
  closedAt: string | null;
  anonymisedAt: string | null;
  item: { id: string; barcode: string | null };
  patron: { id: string; fullName: string; patronNumber: string | null } | null;
};

/** A record with a known title, a copy, and a loan of it. */
async function lend(title: string, barcode: string): Promise<{ loanId: string; itemId: string }> {
  const bib = await api()
    .post(`/t/${slug}/catalog/bib`)
    .set('Cookie', owner)
    .send({
      leader: '00000nam a2200000 a 4500',
      fields: [
        { t: '008', v: '260905s2026    gr |||||||||||000 0 gre d' },
        { t: '245', i: '00', s: [{ a: title }] },
      ],
    })
    .expect(201);
  const bibId = (bib.body as { recordId: string }).recordId;

  const item = await api()
    .post(`/t/${slug}/items`)
    .set('Cookie', owner)
    .send({
      bibId,
      barcode,
      itemTypeId: 'itype-book',
      owningBranchId: 'branch-main',
      permanentLocationId: 'loc-general',
    })
    .expect(201);
  const itemId = (item.body as { id: string }).id;

  const out = await api()
    .post(`/t/${slug}/circulation/checkout`)
    .set('Cookie', owner)
    .send({ itemBarcode: barcode, patronId })
    .expect(201);
  return { loanId: (out.body as { loanId: string }).loanId, itemId };
}

async function list(query: string): Promise<LoanRow[]> {
  const res = await api()
    .get(`/t/${slug}/circulation/loans?${query}`)
    .set('Cookie', owner)
    .expect(200);
  return (res.body as { items: LoanRow[] }).items;
}

let openLoan = { loanId: '', itemId: '' };
let returnedLoan = { loanId: '', itemId: '' };
let recalledLoan = { loanId: '', itemId: '' };

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

  slug = `loanlist-${tag}`;
  const res = await api()
    .post('/auth/signup')
    .send({
      libraryName: `Loan list ${slug}`,
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
  dbUrl = (await controlDb.tenant.findUnique({ where: { slug } }))!.dbUrl;

  const patron = await api()
    .post(`/t/${slug}/patrons`)
    .set('Cookie', owner)
    .send({ fullName: 'Μαρία Παπαδοπούλου' })
    .expect(201);
  patronId = (patron.body as { id: string }).id;

  openLoan = await lend('ΒΙΟΣ ΚΑΙ ΠΟΛΙΤΕΙΑ ΤΟΥ ΑΛΕΞΗ ΖΟΡΜΠΑ', `LL-${tag}-OPEN`);
  returnedLoan = await lend('ΤΟ ΤΡΙΤΟ ΣΤΕΦΑΝΙ', `LL-${tag}-BACK`);
  recalledLoan = await lend('Η ΦΟΝΙΣΣΑ', `LL-${tag}-RECALL`);

  // Hand it back — which also anonymises it, because that is the default.
  await api()
    .post(`/t/${slug}/circulation/checkin`)
    .set('Cookie', owner)
    // 200, not 201: a check-in creates nothing — it closes something.
    .send({ itemId: returnedLoan.itemId })
    .expect(200);

  // `recalled` has no route yet (phase 21 owns recall), so it is set directly.
  // The point of the row is that it is OPEN under a status that is not
  // `active` — which is the state `?status=active` answers wrongly about.
  await sql(`UPDATE loans SET status = 'recalled' WHERE id = $1`, [recalledLoan.loanId]);
}, 240_000);

afterAll(async () => {
  await app?.close();
});

describe('§1 the title — the join no 2.0 route made before this phase', () => {
  it('carries the projected title on every row', async () => {
    const rows = await list('limit=25');
    const row = rows.find((r) => r.id === openLoan.loanId);
    expect(row, 'the open loan should be on the unfiltered list').toBeDefined();
    expect(row!.title).toBe('ΒΙΟΣ ΚΑΙ ΠΟΛΙΤΕΙΑ ΤΟΥ ΑΛΕΞΗ ΖΟΡΜΠΑ');
  }, 60_000);

  it('reads the title of the bib that was LENT, which is the loan’s own bib_id', async () => {
    const rows = await list(`itemId=${openLoan.itemId}&limit=25`);
    const [row] = rows;
    const stored = await sql<{ bib_id: string }>(`SELECT bib_id FROM loans WHERE id = $1`, [
      openLoan.loanId,
    ]);
    expect(row!.bibId).toBe(stored[0]!.bib_id);
    const projected = await sql<{ title: string }>(
      `SELECT title FROM bib_records WHERE bib_id = $1`,
      [stored[0]!.bib_id],
    );
    expect(row!.title).toBe(projected[0]!.title);
  }, 60_000);

  it('does not fall over on a page with no rows', async () => {
    // The guard in `bibTitlesFor`: an empty id list must not become `IN ()`,
    // which is a scan of the whole projection.
    const rows = await list('status=lost&limit=25');
    expect(rows).toEqual([]);
  }, 60_000);
});

describe('§2 `?open=1` is `closed_at IS NULL`, and that is four statuses', () => {
  it('returns the recalled loan, which `?status=active` does not', async () => {
    const open = await list('open=1&limit=25');
    const active = await list('status=active&limit=25');
    const openIds = open.map((r) => r.id);
    const activeIds = active.map((r) => r.id);

    expect(openIds, 'a recalled copy is still out').toContain(recalledLoan.loanId);
    expect(
      activeIds,
      'this is the wrong answer 1.0 gave, and the reason `?open=1` exists',
    ).not.toContain(recalledLoan.loanId);
    expect(openIds).toContain(openLoan.loanId);
  }, 60_000);

  it('excludes the returned loan, and every row it returns is genuinely open', async () => {
    const open = await list('open=1&limit=25');
    expect(open.map((r) => r.id)).not.toContain(returnedLoan.loanId);
    for (const row of open) {
      expect(row.closedAt, `${row.id} came back from ?open=1 but is closed`).toBeNull();
    }
  }, 60_000);

  it('answers the return desk’s question in one row when paired with ?itemId=', async () => {
    // `loans_one_open_per_item` is UNIQUE on exactly this predicate, so the
    // pair can match at most one loan however long the copy's history is.
    const rows = await list(`itemId=${recalledLoan.itemId}&open=1&limit=1`);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(recalledLoan.loanId);

    // And the returned copy has no open loan at all — which is what makes
    // "nothing to return" honest rather than a filter artefact.
    expect(await list(`itemId=${returnedLoan.itemId}&open=1&limit=1`)).toEqual([]);
  }, 60_000);

  it('composes with ?overdue=1 rather than refusing it, unlike a conflicting ?status=', async () => {
    await api()
      .get(`/t/${slug}/circulation/loans?open=1&overdue=1`)
      .set('Cookie', owner)
      .expect(200);
    await api()
      .get(`/t/${slug}/circulation/loans?status=lost&overdue=1`)
      .set('Cookie', owner)
      .expect(400);
  }, 60_000);
});

describe('§3 the anonymised reader is the default, not an incident', () => {
  it('nulls the patron on the returned loan and stamps when', async () => {
    const rows = await list('status=returned&limit=25');
    const row = rows.find((r) => r.id === returnedLoan.loanId);
    expect(row, 'the returned loan should be findable').toBeDefined();
    expect(row!.patron, 'reading history is anonymised on return by default').toBeNull();
    expect(
      row!.anonymisedAt,
      'a null patron with no anonymisedAt would be indistinguishable from a bug',
    ).not.toBeNull();
    // The book survives the reader, which is what makes the row still useful.
    expect(row!.title).toBe('ΤΟ ΤΡΙΤΟ ΣΤΕΦΑΝΙ');
  }, 60_000);

  it('keeps the reader on an open loan', async () => {
    const rows = await list(`itemId=${openLoan.itemId}&open=1&limit=1`);
    expect(rows[0]!.patron?.id).toBe(patronId);
    expect(rows[0]!.patron?.fullName).toBe('Μαρία Παπαδοπούλου');
    expect(rows[0]!.anonymisedAt).toBeNull();
  }, 60_000);
});
