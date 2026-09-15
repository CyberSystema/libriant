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
  'A copy that is gone is gone whatever the library owes us. Refusing to record it would leave a ' +
    'book on the shelf list that nobody can find and a reader who cannot be told what happened.',
);

/**
 * Phase 20h — declaring a copy lost.
 *
 * §6 puts declare-lost in phase 21, which is in M3 — AFTER the cutover that
 * deletes 1.0's `POST /loans/:id/mark-lost`. A library that upgrades and can no
 * longer record a lost book has lost a circulation capability, not a screen.
 *
 * §3 is what makes it expressible at all: `closed_at` split from `returned_at`
 * so a lost loan can CLOSE without a return. In 1.0 it could not, so the partial
 * unique pinned the copy out of circulation for ever and a lost-then-found book
 * could never come back.
 */
let app: NestExpressApplication;
const tag = randomBytes(4).toString('hex');
let slug = '';
let owner = '';
let dbUrl = '';
let itemId = '';
let patronId = '';
let loanId = '';

const SESSION_RE = /^(__Host-)?libriant_session=/;
function cookieFrom(res: request.Response, re: RegExp): string {
  const raw = res.headers['set-cookie'] as unknown as string[] | string | undefined;
  const cookies = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const c = cookies.find((x) => re.test(x));
  if (!c) throw new Error(`no cookie matching ${re}`);
  return c.split(';')[0]!;
}
const api = () => request(app.getHttpServer());

/**
 * A raw connection carrying the 2.0 search path.
 *
 * Its own client, so nothing sets one for it — the lesson phase 20f learned the
 * hard way when the same omission broke `catalog-marc.ts`. `lbr2` first and
 * `public` second is right for a library that has not been cut over AND one
 * that has, and it lets these assertions name their tables the way the services
 * do.
 */
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

/** A record, a copy and a reader, then lend it. */
async function lendSomething(barcode: string): Promise<string> {
  const bib = await api()
    .post(`/t/${slug}/catalog/bib`)
    .set('Cookie', owner)
    .send({
      leader: '00000nam a2200000 a 4500',
      fields: [
        { t: '008', v: '260905s2026    gr |||||||||||000 0 gre d' },
        { t: '245', i: '00', s: [{ a: 'ΧΑΜΕΝΟ ΒΙΒΛΙΟ' }] },
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
  itemId = (item.body as { id: string }).id;

  const out = await api()
    .post(`/t/${slug}/circulation/checkout`)
    .set('Cookie', owner)
    .send({ itemBarcode: barcode, patronId })
    .expect(201);
  return (out.body as { loanId: string }).loanId;
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

  slug = `lost-${tag}`;
  const res = await api()
    .post('/auth/signup')
    .send({
      libraryName: `Lost ${slug}`,
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
    .send({ fullName: 'Απωλέσας Αναγνώστης' })
    .expect(201);
  patronId = (patron.body as { id: string }).id;
  loanId = await lendSomething(`LOST-${tag}-1`);
}, 240_000);

afterAll(async () => {
  await app?.close();
});

describe('§1 the loan closes and the copy stops being on the shelf', () => {
  it('records the loss', async () => {
    const res = await api()
      .post(`/t/${slug}/circulation/loans/${loanId}/declare-lost`)
      .set('Cookie', owner)
      .send({ note: 'reader says it was never returned' })
      .expect(201);
    const body = res.body as { charged: boolean; reason: string | null; itemId: string };
    expect(body.charged).toBe(false);
    expect(body.reason, 'the response should say why nothing was charged').toContain('phase 21');
  }, 60_000);

  it('closes the loan WITHOUT a return — the split §3 exists for', async () => {
    const rows = await sql<{
      status: string;
      closed_at: Date | null;
      returned_at: Date | null;
      declared_lost_at: Date | null;
      patron_id: string | null;
    }>(
      `SELECT status, closed_at, returned_at, declared_lost_at, patron_id
         FROM loans WHERE id = $1`,
      [loanId],
    );
    expect(rows[0]!.status).toBe('lost');
    expect(
      rows[0]!.closed_at,
      'loans_closed_consistency would have refused an open lost loan',
    ).not.toBeNull();
    expect(rows[0]!.returned_at, 'nothing came back').toBeNull();
    expect(rows[0]!.declared_lost_at).not.toBeNull();
    // The reader is KEPT: the library is still trying to get the book back, and
    // anonymisation belongs to the return.
    expect(rows[0]!.patron_id).toBe(patronId);
  });

  it('frees the copy from the one-open-loan index, so it can be lent again if it turns up', async () => {
    // 1.0's dead end: a lost loan kept `returnedAt IS NULL` for ever, so
    // `loans_one_open_per_item` pinned the copy permanently.
    const open = await sql(`SELECT 1 FROM loans WHERE item_id = $1 AND closed_at IS NULL`, [
      itemId,
    ]);
    expect(open).toHaveLength(0);
  });

  it('moves the copy to `missing` through the one status writer', async () => {
    // `item_status` has six values and `lost` is not one of them.
    const item = await sql<{ status: string }>(`SELECT status FROM items WHERE id = $1`, [itemId]);
    expect(item[0]!.status).toBe('missing');
    const history = await sql(
      `SELECT 1 FROM item_status_history WHERE item_id = $1 AND to_status = 'missing'`,
      [itemId],
    );
    expect(history.length, 'the copy moved without an entry in its own history').toBeGreaterThan(0);
  });

  it('and the loan’s own history says so', async () => {
    const events = await sql<{ kind: string }>(
      `SELECT kind FROM loan_events WHERE loan_id = $1 ORDER BY occurred_at DESC LIMIT 1`,
      [loanId],
    );
    expect(events[0]!.kind).toBe('declared_lost');
  });

  it('refuses a second declaration', async () => {
    await api()
      .post(`/t/${slug}/circulation/loans/${loanId}/declare-lost`)
      .set('Cookie', owner)
      .send({})
      .expect(400);
  });
});

describe('§2 the replacement charge, through the real ledger', () => {
  it('raises a balanced fee linked to the loan and the copy', async () => {
    const second = await lendSomething(`LOST-${tag}-2`);
    const res = await api()
      .post(`/t/${slug}/circulation/loans/${second}/declare-lost`)
      .set('Cookie', owner)
      .send({ amountCents: 1850, note: 'replacement' })
      .expect(201);
    const body = res.body as { charged: boolean; feeId: string };
    expect(body.charged).toBe(true);

    const fee = await sql<{ loan_id: string | null; item_id: string | null; owed_cents: string }>(
      `SELECT loan_id, item_id, owed_cents::text FROM fees WHERE id = $1`,
      [body.feeId],
    );
    // LINKED, which 1.0's mark-lost fine could not be and 20d's imported ones
    // cannot be either — the import surface has no column for it.
    expect(fee[0]!.loan_id).toBe(second);
    expect(fee[0]!.item_id).toBe(itemId);
    expect(Number(fee[0]!.owed_cents)).toBe(1850);

    const legs = await sql<{ debit_cents: string; credit_cents: string; account: string }>(
      `SELECT account, debit_cents::text, credit_cents::text FROM account_entries WHERE fee_id = $1`,
      [body.feeId],
    );
    expect(legs.length).toBeGreaterThanOrEqual(2);
    const debits = legs.reduce((n, l) => n + Number(l.debit_cents), 0);
    const credits = legs.reduce((n, l) => n + Number(l.credit_cents), 0);
    expect(debits).toBe(credits);
    // A replacement, not an overdue — the fee type decides the revenue account.
    expect(legs.map((l) => l.account)).toContain('replacement_revenue');
  }, 120_000);

  it('refuses a negative or zero charge rather than posting one', async () => {
    const third = await lendSomething(`LOST-${tag}-3`);
    await api()
      .post(`/t/${slug}/circulation/loans/${third}/declare-lost`)
      .set('Cookie', owner)
      .send({ amountCents: 0 })
      .expect(400);
    // And the loan is untouched by the refusal.
    const rows = await sql<{ closed_at: Date | null }>(
      `SELECT closed_at FROM loans WHERE id = $1`,
      [third],
    );
    expect(rows[0]!.closed_at).toBeNull();
  }, 120_000);
});
