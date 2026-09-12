import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import { randomBytes } from 'node:crypto';
import { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { controlDb } from '@libriant/db-control';
import { AppModule } from '../../src/app.module.js';
import { HttpExceptionFilter } from '../../src/platform/http-exception.filter.js';
import { TenantResolverService } from '../../src/tenancy/tenant-resolver.service.js';
import type { TenantContext } from '../../src/tenancy/tenant-context.js';
import { DEFAULT_ITEM_IDS } from '../../src/items/item-defaults.js';
import { ItemsService } from '../../src/items/items.service.js';
import { CheckoutService } from '../../src/circulation/checkout.service.js';
import { OverdueAccrualService } from '../../src/fees/overdue-accrual.service.js';
import { listenOnce } from './listen-once.js';
import { declareBillingPosture } from './billing-posture.js';

declareBillingPosture(
  'unenforced',
  'What a reader owes is a fact about a loan, not a feature. A library behind on its own bill ' +
    'still has to tell somebody standing at the desk what they owe, and a sweep that skipped ' +
    'unpaid tenants would make the balance quietly wrong rather than visibly withheld.',
);

/**
 * Phase 20b-ii — the overdue sweep 2.0 never had.
 *
 * 2.0 accrues an overdue fine in exactly one place: inside the checkin
 * transaction. So until the book comes back, the reader owes nothing, and both
 * `deskSummary` and the fee list say so. **A patron three weeks overdue walks up
 * to the desk and the screen shows a zero balance.** 1.0 had a sweep; the 2.0
 * build never replaced it.
 *
 * §2 is the assertion that matters, and it is only possible because of the shape
 * phase 18 chose: the accrual recomputes the TOTAL and posts the delta, so
 * running it twice moves nothing the second time. Phase 18 measured the
 * alternative — composed as a window, four of seven policy shapes diverge and
 * one charges zero — which is why a periodic sweep could not have been built on
 * it at all.
 */
let app: NestExpressApplication;
const tag = randomBytes(4).toString('hex');
let slug = '';
let dbUrl = '';
let ctx: TenantContext;
let sweeper: OverdueAccrualService;
let items: ItemsService;
let checkouts: CheckoutService;

const api = () => request(app.getHttpServer());
const ACTOR = { userId: 'test-user', actorId: 'test-user', actorType: 'user' } as never;

async function sql<T = Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const c = new PgClient({ connectionString: dbUrl });
  await c.connect();
  try {
    return (await c.query(text, params)).rows as T[];
  } finally {
    await c.end();
  }
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

  slug = `sweep-${tag}`;
  await api()
    .post('/auth/signup')
    .send({
      libraryName: `Sweep ${slug}`,
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
  const t = await controlDb.tenant.findUnique({ where: { slug } });
  dbUrl = t!.dbUrl;
  ctx = (await app.get(TenantResolverService).resolveBySlug(slug))!;

  // TURN FINES ON, before any checkout.
  //
  // The seeded default is `amountPerIntervalCents: 0n`, and that is deliberate:
  // `circulation-defaults.ts` encodes 1.0's `overdueFinesEnabled = false` as a
  // zero amount rather than a master switch, because "nothing is charged" is
  // faithful and a second switch would be a second place to disagree. So a
  // library that charges nothing is the DEFAULT, and a sweep over it correctly
  // posts nothing — which is what this fixture first proved about itself.
  //
  // It has to happen before the checkout, because `policy_snapshot` is pinned
  // then. The write goes through the same trigger a settings form would, so
  // `circulation_policy_version` bumps and the cached snapshot is invalidated
  // exactly as it would be in production.
  await sql(
    `UPDATE lbr2.overdue_fine_policies
        SET amount_per_interval_cents = 50, interval_value = 1, interval_unit = 'days',
            charge_at = 'intervalEnd', count_closed_days = true`,
  );
  sweeper = app.get(OverdueAccrualService);
  items = app.get(ItemsService);
  checkouts = app.get(CheckoutService);
}, 180_000);

afterAll(async () => {
  await app?.close();
});

/** A patron with an account, a copy, and a loan that went out and is overdue. */
async function overdueLoan(n: number, daysOverdue: number): Promise<{ patronId: string }> {
  const patronId = `sw-${tag}-p${n}`;
  const bibId = `sw-${tag}-b${n}`;
  await sql(
    `INSERT INTO lbr2.patrons (id, full_name, sort_name, search_text, updated_at)
     VALUES ($1, 'Reader', 'reader', 'reader', pg_catalog.now())`,
    [patronId],
  );
  await sql(
    `INSERT INTO lbr2.patron_accounts (id, patron_id, currency, opened_at)
     VALUES ($1, $2, 'EUR', pg_catalog.now())`,
    [`${patronId}-acc`, patronId],
  );
  await sql(
    `INSERT INTO lbr2.marc_records
       (id, public_no, kind, schema, status, leader, content_hash, record_status_code, updated_at)
     VALUES ($1, pg_catalog.nextval('lbr2.marc_public_no_seq'), 'bibliographic', 'marc21',
             'complete', pg_catalog.rpad('x', 24, 'x'),
             pg_catalog.decode(pg_catalog.repeat('ab', 32), 'hex'), 'n', pg_catalog.now())`,
    [bibId],
  );
  const item = await items.create(ctx, ACTOR, {
    bibId,
    itemTypeId: DEFAULT_ITEM_IDS.itemType,
    owningBranchId: DEFAULT_ITEM_IDS.branch,
    permanentLocationId: DEFAULT_ITEM_IDS.location,
    barcode: `SW-${tag}-${n}`,
  });
  await checkouts.checkout(ctx, ACTOR, {
    patronId,
    itemBarcode: `SW-${tag}-${n}`,
    branchId: DEFAULT_ITEM_IDS.branch,
  } as never);
  // Backdate the loan rather than the clock: the sweep prices from `dueAt`, and
  // a book that went out a fortnight ago and was due last week is exactly the
  // state a library is in every morning.
  //
  // BOTH dates move. `loans_due_after_loaned` is a CHECK, so pulling `due_at`
  // back past `loaned_at` is refused — which is the constraint doing its job:
  // a loan due before it was lent is not a state the product should be able to
  // reach, in a fixture or otherwise.
  await sql(
    `UPDATE lbr2.loans
        SET loaned_at = pg_catalog.now() - (($2::int + 14) || ' days')::interval,
            due_at    = pg_catalog.now() - ($2 || ' days')::interval
      WHERE item_id = $1 AND closed_at IS NULL`,
    [item.id, String(daysOverdue)],
  );
  return { patronId };
}

async function owed(patronId: string): Promise<bigint> {
  const rows = await sql<{ owed: string | null }>(
    `SELECT pg_catalog.sum(owed_cents)::text AS owed FROM lbr2.fees WHERE patron_id = $1`,
    [patronId],
  );
  return BigInt(rows[0]?.owed ?? '0');
}

describe('§1 the defect', () => {
  it('a patron with an unreturned overdue book owes nothing until the sweep runs', async () => {
    const { patronId } = await overdueLoan(1, 10);
    // This is the bug, asserted before it is fixed: the book is ten days late
    // and the desk shows zero.
    expect(await owed(patronId)).toBe(0n);

    const out = await sweeper.sweep(ctx, new Date());
    expect(out.loansConsidered).toBeGreaterThanOrEqual(1);
    expect(out.firstRefusal, 'the sweep refused a loan').toBeUndefined();
    expect(await owed(patronId)).toBeGreaterThan(0n);
  }, 60_000);
});

describe('§2 running it again moves nothing', () => {
  it('is idempotent, because the accrual recomputes a TOTAL and posts a delta', async () => {
    const { patronId } = await overdueLoan(2, 5);
    await sweeper.sweep(ctx, new Date());
    const after = await owed(patronId);
    expect(after).toBeGreaterThan(0n);

    const second = await sweeper.sweep(ctx, new Date());
    expect(await owed(patronId)).toBe(after);
    // The second run priced the same loans and moved no money.
    expect(second.centsPosted).toBe(0n);
  }, 60_000);

  it('and the ledger still balances — the phase-18 identity', async () => {
    // Every journal balances is the trigger's job, so a failure here means it
    // was bypassed. The sweep posts through the same `accrueWithin` the checkin
    // path uses, which is the reason it can.
    const rows = await sql<{ bad: string }>(
      `SELECT pg_catalog.count(*)::text AS bad FROM (
         SELECT transaction_id FROM lbr2.account_entries
          GROUP BY transaction_id
         HAVING pg_catalog.sum(debit_cents) <> pg_catalog.sum(credit_cents)) x`,
    );
    expect(rows[0]!.bad).toBe('0');
  });
});

describe('§3 what it charges more for', () => {
  it('a longer overdue costs more than a shorter one', async () => {
    const a = await overdueLoan(3, 2);
    const b = await overdueLoan(4, 20);
    await sweeper.sweep(ctx, new Date());
    expect(await owed(b.patronId)).toBeGreaterThan(await owed(a.patronId));
  }, 60_000);

  it('a loan that is not yet due is not charged', async () => {
    const { patronId } = await overdueLoan(5, -5);
    await sweeper.sweep(ctx, new Date());
    expect(await owed(patronId)).toBe(0n);
  }, 60_000);
});
