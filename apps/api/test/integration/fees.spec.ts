import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import { randomBytes } from 'node:crypto';
import { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { controlDb } from '@libriant/db-control';
import type { TenantPrismaClientV2 } from '@libriant/db-tenant';
import { AppModule } from '../../src/app.module.js';
import { HttpExceptionFilter } from '../../src/platform/http-exception.filter.js';
import { TenantPrismaService } from '../../src/tenancy/tenant-prisma.service.js';
import { TenantResolverService } from '../../src/tenancy/tenant-resolver.service.js';
import type { TenantContext } from '../../src/tenancy/tenant-context.js';
import { DEFAULT_ITEM_IDS } from '../../src/items/item-defaults.js';
import { FeesService } from '../../src/fees/fees.service.js';
import { CashDrawerService } from '../../src/fees/cash-drawer.service.js';
import { ReceiptsService } from '../../src/fees/receipts.service.js';
import {
  findAccountBalanceDrift,
  findFeeCounterDrift,
  findUnbalancedTransactions,
} from '../../src/fees/ledger-identities.js';
import { planRefund, planSettlement } from '../../src/fees/fee-settlement.js';
import { listenOnce } from './listen-once.js';
import { declareBillingPosture } from './billing-posture.js';

declareBillingPosture(
  'unenforced',
  'A debt a reader already owes does not stop being owed because the library is late paying ' +
    'its own bill, and a librarian who cannot take the money cannot clear the block that is ' +
    'keeping a reader from borrowing. Money owed is part of circulation.',
);

/**
 * Phase 18 — the fees ledger.
 *
 * §6's acceptance clause, sentence by sentence:
 *
 *   "10,000 random charge/pay/waive/refund/write-off sequences leave every    → §5
 *      reconciliation identity intact"
 *   "the fees_one_open_accrual_per_loan upsert survives a return racing the   → §4
 *      accrual sweep without aborting the return (DATA-1 repro, ported)"
 *   "a reprint is byte-identical"                                            → §3
 *   "a drawer close with a variance records it rather than adjusting"        → §2
 *   "libriant_circ_ledger_drift_total emitted and alerting"                  → check:alerts
 */
let app: NestExpressApplication;
const tag = randomBytes(4).toString('hex');
let slug = '';
/**
 * The owner session. This file drives the SERVICES directly for the ledger
 * invariants — that is the level those are true at — but the payment-method
 * list is a ROUTE, and whether it is reachable and what it hands back is only
 * answerable over HTTP.
 */
let owner = '';
let dbUrl = '';
let v2: TenantPrismaClientV2;
let ctx: TenantContext;
let fees: FeesService;
let drawers: CashDrawerService;
let receipts: ReceiptsService;

const SESSION_RE = /^(__Host-)?libriant_session=/;
function cookieFrom(res: request.Response, re: RegExp): string {
  const raw = res.headers['set-cookie'] as unknown as string[] | string | undefined;
  const cookies = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const c = cookies.find((x) => re.test(x));
  if (!c) throw new Error(`no cookie matching ${re}`);
  return c.split(';')[0]!;
}

async function sql<T = Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const client = new PgClient({ connectionString: dbUrl });
  await client.connect();
  try {
    return (await client.query(text, params)).rows as T[];
  } finally {
    await client.end();
  }
}

/**
 * Several statements on ONE connection, inside one transaction.
 *
 * `sql()` above uses a parameterised query, and libpq refuses more than one
 * command in a prepared statement — so the "two statements" assertions below
 * cannot be written with it. They need a real transaction that issues the legs
 * separately, because the property under test is that the STATEMENT trigger
 * fires before the transaction ends.
 */
async function sqlTx(statements: readonly string[]): Promise<void> {
  const client = new PgClient({ connectionString: dbUrl });
  await client.connect();
  try {
    await client.query('BEGIN');
    for (const stmt of statements) await client.query(stmt);
    await client.query('COMMIT');
  } finally {
    await client.end();
  }
}

const api = () => request(app.getHttpServer());
const ACTOR = { userId: 'test-user', actorId: 'test-user', actorType: 'user' } as never;
const BRANCH = DEFAULT_ITEM_IDS.branch;

let patronSeq = 0;
async function makePatron(): Promise<string> {
  const id = `patron-${tag}-${(patronSeq += 1)}`;
  await sql(
    `INSERT INTO lbr2.patrons (id, full_name, sort_name, search_text, updated_at)
     VALUES ($1, 'Δοκιμή Αναγνώστης', 'δοκιμη αναγνωστησ', 'δοκιμη αναγνωστησ', pg_catalog.now())`,
    [id],
  );
  return id;
}

/** Every identity, as the nightly job runs them. Empty is the only pass. */
async function identities(): Promise<{ i1: number; i2: number; i3: number }> {
  return v2.$transaction(async (tx) => ({
    i1: (await findUnbalancedTransactions(tx)).length,
    i2: (await findFeeCounterDrift(tx)).length,
    i3: (await findAccountBalanceDrift(tx)).length,
  }));
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

  slug = `fees-${tag}`;
  const res = await api()
    .post('/auth/signup')
    .send({
      libraryName: `Fees ${slug}`,
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
  const t = await controlDb.tenant.findUnique({ where: { slug } });
  dbUrl = t!.dbUrl;

  ctx = (await app.get(TenantResolverService).resolveBySlug(slug))!;
  v2 = app.get(TenantPrismaService).getClientV2(ctx);
  fees = app.get(FeesService);
  drawers = app.get(CashDrawerService);
  receipts = app.get(ReceiptsService);
}, 240_000);

afterAll(async () => {
  await app?.close();
});

// ---------------------------------------------------------------------------
// 1. The journal is a journal, and the database says so
// ---------------------------------------------------------------------------

describe('the ledger refuses to hold anything that is not a journal', () => {
  it('a charge posts two legs that balance, and the receivable is the patron balance', async () => {
    const patron = await makePatron();
    const { feeId } = await fees.charge(ctx, ACTOR, {
      patronId: patron,
      feeTypeId: 'feetype_manual',
      branchId: BRANCH,
      currency: 'EUR',
      amountCents: 500n,
      reason: 'a lost bookmark',
    });

    const legs = await sql<{ account: string; debit_cents: string; credit_cents: string }>(
      `SELECT account, debit_cents::text, credit_cents::text
         FROM lbr2.account_entries WHERE fee_id = $1 ORDER BY account`,
      [feeId],
    );
    expect(legs).toHaveLength(2);
    expect(legs.map((l) => l.account).sort()).toEqual(['patron_receivable', 'service_revenue']);

    const balances = await fees.balances(ctx, patron);
    expect(balances).toEqual([{ currency: 'EUR', owedCents: 500n }]);
    expect(await identities()).toEqual({ i1: 0, i2: 0, i3: 0 });
  });

  it('A ONE-LEGGED JOURNAL IS UNWRITABLE — the trigger, not a nightly report', async () => {
    const patron = await makePatron();
    await fees.charge(ctx, ACTOR, {
      patronId: patron,
      feeTypeId: 'feetype_manual',
      branchId: BRANCH,
      currency: 'EUR',
      amountCents: 100n,
      reason: 'seed',
    });
    const [account] = await sql<{ id: string }>(
      `SELECT id FROM lbr2.patron_accounts WHERE patron_id = $1`,
      [patron],
    );

    await expect(
      sqlTx([
        `INSERT INTO lbr2.account_transactions (id, kind, currency, total_cents, account_id, branch_id, created_at)
           VALUES ('halfjournal-${tag}', 'charge', 'EUR', 500, '${account!.id}', '${BRANCH}', pg_catalog.now())`,
        `INSERT INTO lbr2.account_entries (id, transaction_id, account, account_id, currency, debit_cents, credit_cents, created_at)
           VALUES ('halfleg-${tag}', 'halfjournal-${tag}', 'patron_receivable', '${account!.id}', 'EUR', 500, 0, pg_catalog.now())`,
      ]),
    ).rejects.toThrow(/does not balance/);
  });

  it('THE LEGS MUST ARRIVE IN ONE STATEMENT, which is what makes postJournalWithin the only writer', async () => {
    const patron = await makePatron();
    await fees.charge(ctx, ACTOR, {
      patronId: patron,
      feeTypeId: 'feetype_manual',
      branchId: BRANCH,
      currency: 'EUR',
      amountCents: 100n,
      reason: 'seed',
    });
    const [account] = await sql<{ id: string }>(
      `SELECT id FROM lbr2.patron_accounts WHERE patron_id = $1`,
      [patron],
    );
    // Two legs that WOULD balance, written one statement at a time. The
    // transaction would be consistent by the end; the statement trigger refuses
    // the first one anyway, and that is the property.
    await expect(
      sqlTx([
        `INSERT INTO lbr2.account_transactions (id, kind, currency, total_cents, account_id, branch_id, created_at)
           VALUES ('twostmt-${tag}', 'charge', 'EUR', 500, '${account!.id}', '${BRANCH}', pg_catalog.now())`,
        `INSERT INTO lbr2.account_entries (id, transaction_id, account, account_id, currency, debit_cents, credit_cents, created_at)
           VALUES ('ts1-${tag}', 'twostmt-${tag}', 'patron_receivable', '${account!.id}', 'EUR', 500, 0, pg_catalog.now())`,
        `INSERT INTO lbr2.account_entries (id, transaction_id, account, account_id, currency, debit_cents, credit_cents, created_at)
           VALUES ('ts2-${tag}', 'twostmt-${tag}', 'service_revenue', NULL, 'EUR', 0, 500, pg_catalog.now())`,
      ]),
    ).rejects.toThrow(/does not balance/);
  });

  it('a posted entry cannot be edited or deleted — a mistake needs a reversing entry', async () => {
    const patron = await makePatron();
    const { feeId } = await fees.charge(ctx, ACTOR, {
      patronId: patron,
      feeTypeId: 'feetype_manual',
      branchId: BRANCH,
      currency: 'EUR',
      amountCents: 250n,
      reason: 'append-only',
    });
    await expect(
      sql(`UPDATE lbr2.account_entries SET debit_cents = 1 WHERE fee_id = $1`, [feeId]),
    ).rejects.toThrow(/append-only/);
    await expect(
      sql(`DELETE FROM lbr2.account_entries WHERE fee_id = $1`, [feeId]),
    ).rejects.toThrow(/append-only/);
  });
});

// ---------------------------------------------------------------------------
// 2. The drawer. THE VARIANCE IS RECORDED, NEVER APPLIED.
// ---------------------------------------------------------------------------

describe('a cash drawer', () => {
  async function servicePoint(): Promise<string> {
    const id = `sp-${tag}-${randomBytes(3).toString('hex')}`;
    await sql(
      `INSERT INTO lbr2.service_points (id, branch_id, code, name, created_at)
       VALUES ($1, $2, $3, 'Γραφείο', pg_catalog.now())`,
      [id, BRANCH, id.slice(-8)],
    );
    return id;
  }

  it('records a shortfall rather than adjusting the till', async () => {
    const sp = await servicePoint();
    const patron = await makePatron();
    const { drawerSessionId } = await drawers.open(ctx, ACTOR, {
      servicePointId: sp,
      currency: 'EUR',
      openingFloatCents: 5000n,
    });

    await fees.charge(ctx, ACTOR, {
      patronId: patron,
      feeTypeId: 'feetype_manual',
      branchId: BRANCH,
      currency: 'EUR',
      amountCents: 300n,
      reason: 'a fine',
    });
    await fees.settle(ctx, ACTOR, {
      patronId: patron,
      kind: 'payment',
      currency: 'EUR',
      branchId: BRANCH,
      amountCents: 300n,
      paymentMethodId: 'paymethod_cash',
      drawerSessionId,
    });

    // The journal says 5300. The librarian counts 5270.
    const close = await drawers.close(ctx, ACTOR, {
      drawerSessionId,
      countedCents: 5270n,
      note: 'thirty cents short, counted twice',
    });

    expect(close.expectedCents).toBe(5300n);
    expect(close.countedCents).toBe(5270n);
    expect(close.varianceCents).toBe(-30n);

    // THE EXPECTED FIGURE IS NOT REWRITTEN to match the count.
    const [row] = await sql<{ expected_cents: string; variance_cents: string }>(
      `SELECT expected_cents::text, variance_cents::text
         FROM lbr2.cash_drawer_sessions WHERE id = $1`,
      [drawerSessionId],
    );
    expect(row!.expected_cents).toBe('5300');
    expect(row!.variance_cents).toBe('-30');

    // And the books say the library is down thirty cents, in an EXPENSE account
    // — not that the till holds money it does not have.
    const [short] = await sql<{ debit: string }>(
      `SELECT COALESCE(pg_catalog.sum(debit_cents - credit_cents), 0)::text AS debit
         FROM lbr2.account_entries WHERE account = 'cash_over_short'`,
    );
    expect(short!.debit).toBe('30');
    expect(await identities()).toEqual({ i1: 0, i2: 0, i3: 0 });
  });

  it('a drawer that counts exactly posts no journal at all', async () => {
    const sp = await servicePoint();
    const { drawerSessionId } = await drawers.open(ctx, ACTOR, {
      servicePointId: sp,
      currency: 'EUR',
      openingFloatCents: 1000n,
    });
    const close = await drawers.close(ctx, ACTOR, { drawerSessionId, countedCents: 1000n });
    expect(close.varianceCents).toBe(0n);
    expect(close.transactionId).toBeNull();
  });

  it('one open drawer per desk, because two is two people sure what is in the till', async () => {
    const sp = await servicePoint();
    await drawers.open(ctx, ACTOR, {
      servicePointId: sp,
      currency: 'EUR',
      openingFloatCents: 0n,
    });
    await expect(
      drawers.open(ctx, ACTOR, { servicePointId: sp, currency: 'EUR', openingFloatCents: 0n }),
    ).rejects.toThrow(/already has an open drawer/);
  });
});

// ---------------------------------------------------------------------------
// 3. A reprint is BYTE-IDENTICAL
// ---------------------------------------------------------------------------

describe('a receipt', () => {
  it('is rendered once and reprinted verbatim, even after the library is renamed', async () => {
    const patron = await makePatron();
    await fees.charge(ctx, ACTOR, {
      patronId: patron,
      feeTypeId: 'feetype_manual',
      branchId: BRANCH,
      currency: 'EUR',
      amountCents: 240n,
      reason: 'three overdue books',
    });
    const paid = await fees.settle(ctx, ACTOR, {
      patronId: patron,
      kind: 'payment',
      currency: 'EUR',
      branchId: BRANCH,
      amountCents: 240n,
      paymentMethodId: 'paymethod_cash',
    });

    const at = new Date('2026-09-16T10:00:00.000Z');
    const stored = await v2.$transaction(async (tx) => {
      const number = await receipts.nextNumberWithin(tx, BRANCH, at);
      const bytes = receipts.render({
        number,
        branchName: 'Κεντρική',
        libraryName: 'Δημοτική Βιβλιοθήκη',
        locale: 'el',
        currency: 'EUR',
        totalCents: 240n,
        at,
        lines: [{ label: 'Πρόστιμο', amountCents: 240n }],
      });
      return receipts.storeWithin(tx, {
        transactionId: paid.transactionId,
        branchId: BRANCH,
        number,
        currency: 'EUR',
        totalCents: 240n,
        locale: 'el',
        bytes,
        at,
      });
    });

    const first = await receipts.reprint(ctx, stored.receiptId);

    // The world moves on: the library is renamed and the branch with it. A
    // renderer would pick both up. The stored bytes do not.
    await sql(`UPDATE lbr2.branches SET name = 'Νέα Κεντρική' WHERE id = $1`, [BRANCH]);

    const second = await receipts.reprint(ctx, stored.receiptId);
    expect(second.bytes.equals(first.bytes)).toBe(true);
    expect(second.bytes.toString('utf8')).toContain('Δημοτική Βιβλιοθήκη');
    expect(second.bytes.toString('utf8')).not.toContain('Νέα Κεντρική');
  });

  it('refuses a stored receipt whose bytes no longer match their digest', async () => {
    const patron = await makePatron();
    await fees.charge(ctx, ACTOR, {
      patronId: patron,
      feeTypeId: 'feetype_manual',
      branchId: BRANCH,
      currency: 'EUR',
      amountCents: 100n,
      reason: 'tamper',
    });
    const paid = await fees.settle(ctx, ACTOR, {
      patronId: patron,
      kind: 'payment',
      currency: 'EUR',
      branchId: BRANCH,
      amountCents: 100n,
      paymentMethodId: 'paymethod_cash',
    });
    const at = new Date('2026-09-16T11:00:00.000Z');
    const stored = await v2.$transaction(async (tx) => {
      const number = await receipts.nextNumberWithin(tx, BRANCH, at);
      return receipts.storeWithin(tx, {
        transactionId: paid.transactionId,
        branchId: BRANCH,
        number,
        currency: 'EUR',
        totalCents: 100n,
        locale: 'el',
        bytes: Buffer.from('original', 'utf8'),
        at,
      });
    });

    // The append-only trigger makes this unreachable through the application,
    // which is exactly why the reprint checks anyway. Dropping it for one
    // statement is the only way to reach the branch at all.
    await sql(`ALTER TABLE lbr2.receipts DISABLE TRIGGER receipts_append_only`);
    await sql(`UPDATE lbr2.receipts SET rendered_bytes = $1 WHERE id = $2`, [
      Buffer.from('tampered', 'utf8'),
      stored.receiptId,
    ]);
    await sql(`ALTER TABLE lbr2.receipts ENABLE TRIGGER receipts_append_only`);

    await expect(receipts.reprint(ctx, stored.receiptId)).rejects.toThrow(
      /does not match its own digest/,
    );
  });

  it('two desks printing at once cannot take the same number', async () => {
    const at = new Date('2026-09-16T12:00:00.000Z');
    const taken = await Promise.all(
      Array.from({ length: 8 }, () =>
        v2.$transaction((tx) => receipts.nextNumberWithin(tx, BRANCH, at)),
      ),
    );
    expect(new Set(taken).size).toBe(taken.length);
  });
});

// ---------------------------------------------------------------------------
// 4. Settlement, and the arithmetic that has no residue
// ---------------------------------------------------------------------------

/**
 * The payment methods a desk can settle with (2.0 phase 20o).
 *
 * FOUND BY THE WRITE-ONLY-COLUMN SWEEP, and the only one of its findings that
 * stopped money rather than hiding a field: `settlementAccountFor` refuses a
 * payment with "Money that moved needs a payment method" when `paymentMethodId`
 * is null and 404s an unknown or archived one — and NO ROUTE LISTED THEM. A
 * caller had to already know an id it had no way to obtain.
 *
 * The evidence was in this file: every settlement test above hard-codes
 * `paymentMethodId: 'paymethod_cash'`, which is precisely the workaround a
 * caller invents when there is nothing to ask. Third instance of the shape after
 * `itemTypeId` (20k) and `patronCategoryId` (20m).
 */
describe('the payment methods a desk can settle with', () => {
  it('lists them, and the seeded cash method is among them', async () => {
    const res = await api().get(`/t/${slug}/fees/payment-methods`).set('Cookie', owner).expect(200);
    const items = res.body.items as {
      id: string;
      code: string;
      name: string;
      kind: string;
      requiresDrawer: boolean;
    }[];
    expect(items.length).toBeGreaterThan(0);
    const cash = items.find((m) => m.id === 'paymethod_cash');
    expect(cash, 'the id every settlement test in this file hard-codes').toBeDefined();
    // The flag a desk needs BEFORE it offers a method: whether a drawer session
    // has to be open first. Discovering that from a refusal is the failure this
    // route exists to prevent.
    expect(typeof cash!.requiresDrawer).toBe('boolean');
  });

  it('does not hand out the ledger account behind each method', async () => {
    // Which asset account cash lands in is the ledger's business. A screen that
    // showed it would be offering a librarian a choice about double-entry
    // bookkeeping.
    const res = await api().get(`/t/${slug}/fees/payment-methods`).set('Cookie', owner).expect(200);
    for (const m of res.body.items as Record<string, unknown>[]) {
      expect(m.settlementAccount).toBeUndefined();
    }
  });

  it('is the list that makes a payment possible at all', async () => {
    // THE BLOCKER, at the level it lives. The refusal is a SERVICE check that
    // runs after DTO validation, so it is unreachable over HTTP without an
    // otherwise-valid body — asserting it here is what actually pins it.
    const patronId = await makePatron();
    const base = {
      patronId,
      kind: 'payment' as const,
      currency: 'EUR',
      branchId: BRANCH,
      // Non-zero: "A settlement must move money" is checked first, and a zero
      // would never reach the payment-method check this test is about.
      amountCents: 100n,
    };
    await expect(fees.settle(ctx, ACTOR, base)).rejects.toThrow(/payment method/i);

    // And an id FROM THE LIST gets past that check — which is the whole reason
    // the route exists.
    const res = await api().get(`/t/${slug}/fees/payment-methods`).set('Cookie', owner).expect(200);
    const methodId = (res.body.items as { id: string }[])[0]!.id;
    await expect(
      fees.settle(ctx, ACTOR, { ...base, paymentMethodId: methodId }),
    ).resolves.toBeDefined();
  });
});

describe('settling charges', () => {
  it('spreads a payment oldest-first and leaves the remainder as a credit', async () => {
    const patron = await makePatron();
    for (const amount of [80n, 80n, 80n]) {
      await fees.charge(ctx, ACTOR, {
        patronId: patron,
        feeTypeId: 'feetype_manual',
        branchId: BRANCH,
        currency: 'EUR',
        amountCents: amount,
        reason: 'overdue',
      });
    }
    const out = await fees.settle(ctx, ACTOR, {
      patronId: patron,
      kind: 'payment',
      currency: 'EUR',
      branchId: BRANCH,
      amountCents: 500n,
      paymentMethodId: 'paymethod_cash',
    });

    // 240 applied across three charges, 260 left over as a credit.
    expect(out.allocations).toHaveLength(3);
    expect(out.allocations.reduce((s, a) => s + a.amountCents, 0n)).toBe(240n);
    expect(out.creditCents).toBe(260n);
    expect(await fees.balances(ctx, patron)).toEqual([]);
    expect(await identities()).toEqual({ i1: 0, i2: 0, i3: 0 });
  });

  it('refuses to forgive more than is owed — that is a typo, not a credit', async () => {
    const patron = await makePatron();
    await fees.charge(ctx, ACTOR, {
      patronId: patron,
      feeTypeId: 'feetype_manual',
      branchId: BRANCH,
      currency: 'EUR',
      amountCents: 100n,
      reason: 'overdue',
    });
    await expect(
      fees.settle(ctx, ACTOR, {
        patronId: patron,
        kind: 'waiver',
        currency: 'EUR',
        branchId: BRANCH,
        amountCents: 500n,
      }),
    ).rejects.toThrow(/only 100 is owed/);
  });

  it('A REFUND REOPENS THE CHARGE — status and closed_at go back, not just the counter', async () => {
    const patron = await makePatron();
    const { feeId } = await fees.charge(ctx, ACTOR, {
      patronId: patron,
      feeTypeId: 'feetype_manual',
      branchId: BRANCH,
      currency: 'EUR',
      amountCents: 400n,
      reason: 'replacement',
    });
    await fees.settle(ctx, ACTOR, {
      patronId: patron,
      kind: 'payment',
      currency: 'EUR',
      branchId: BRANCH,
      amountCents: 400n,
      paymentMethodId: 'paymethod_cash',
    });
    let [fee] = await sql<{ status: string; closed_at: string | null; owed_cents: string }>(
      `SELECT status, closed_at, owed_cents::text FROM lbr2.fees WHERE id = $1`,
      [feeId],
    );
    expect(fee!.status).toBe('paid');
    expect(fee!.closed_at).not.toBeNull();

    await fees.refund(ctx, ACTOR, {
      patronId: patron,
      currency: 'EUR',
      branchId: BRANCH,
      amountCents: 150n,
      paymentMethodId: 'paymethod_cash',
    });

    [fee] = await sql<{ status: string; closed_at: string | null; owed_cents: string }>(
      `SELECT status, closed_at, owed_cents::text FROM lbr2.fees WHERE id = $1`,
      [feeId],
    );
    expect(fee!.status).toBe('outstanding');
    expect(fee!.closed_at).toBeNull();
    expect(fee!.owed_cents).toBe('150');
    expect(await identities()).toEqual({ i1: 0, i2: 0, i3: 0 });
  });

  it('cannot refund money that was never taken', async () => {
    const patron = await makePatron();
    await fees.charge(ctx, ACTOR, {
      patronId: patron,
      feeTypeId: 'feetype_manual',
      branchId: BRANCH,
      currency: 'EUR',
      amountCents: 100n,
      reason: 'unpaid',
    });
    await expect(
      fees.refund(ctx, ACTOR, {
        patronId: patron,
        currency: 'EUR',
        branchId: BRANCH,
        amountCents: 100n,
        paymentMethodId: 'paymethod_cash',
      }),
    ).rejects.toThrow(/only 0 has been paid/);
  });

  it('balances are PER CURRENCY, and the currency-blind sum is not available', async () => {
    const patron = await makePatron();
    await fees.charge(ctx, ACTOR, {
      patronId: patron,
      feeTypeId: 'feetype_manual',
      branchId: BRANCH,
      currency: 'EUR',
      amountCents: 774n,
      reason: 'eur',
    });
    await fees.charge(ctx, ACTOR, {
      patronId: patron,
      feeTypeId: 'feetype_manual',
      branchId: BRANCH,
      currency: 'GBP',
      amountCents: 640n,
      reason: 'gbp',
    });
    const balances = await fees.balances(ctx, patron);
    expect(balances).toEqual([
      { currency: 'EUR', owedCents: 774n },
      { currency: 'GBP', owedCents: 640n },
    ]);
    // 1414 is a number of nothing, and there is no shape of this API that
    // returns it.
    expect(balances.length).toBe(2);

    // TWO ACCOUNTS, one per currency.
    const accounts = await sql<{ n: string }>(
      `SELECT pg_catalog.count(*)::text AS n FROM lbr2.patron_accounts WHERE patron_id = $1`,
      [patron],
    );
    expect(accounts[0]!.n).toBe('2');
  });
});

// ---------------------------------------------------------------------------
// 5. THE PROPERTY TEST
// ---------------------------------------------------------------------------

describe('the identities survive a long random sequence', () => {
  /**
   * §6 asks for 10,000 random charge/pay/waive/refund/write-off sequences.
   *
   * The three identities are whole-table aggregates, so asserting them after
   * EVERY operation is quadratic and was measured, in the phase-18 design
   * review, at eight to twelve minutes for one test — a cost that buys nothing,
   * because a drift introduced at step 4,000 is still there at step 10,000.
   * They are therefore asserted at intervals and at the end, and the end is the
   * one that has to hold.
   *
   * DETERMINISTIC. A fixed seed, so a failure is reproducible and a reviewer can
   * run the exact sequence that broke. A random-seeded property test that fails
   * once in CI and never again is worse than no property test.
   */
  const OPERATIONS = 10_000;

  function lcg(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
      s = (Math.imul(s, 1_664_525) + 1_013_904_223) >>> 0;
      return s / 0x1_0000_0000;
    };
  }

  it(`holds across ${OPERATIONS} random operations`, async () => {
    const rand = lcg(20_260_918);
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;

    // Eight patrons, so charges and settlements collide on the same accounts
    // rather than each living in its own quiet corner.
    const patrons: string[] = [];
    for (let i = 0; i < 8; i += 1) patrons.push(await makePatron());

    let charges = 0;
    let payments = 0;
    let waivers = 0;
    let writeOffs = 0;
    let refunds = 0;
    let refused = 0;

    for (let n = 0; n < OPERATIONS; n += 1) {
      const patron = pick(patrons);
      const roll = rand();
      try {
        if (roll < 0.45) {
          await fees.charge(ctx, ACTOR, {
            patronId: patron,
            feeTypeId: pick(['feetype_manual', 'feetype_overdue', 'feetype_printing']),
            branchId: BRANCH,
            currency: 'EUR',
            amountCents: BigInt(1 + Math.floor(rand() * 500)),
            reason: `op ${n}`,
          });
          charges += 1;
        } else if (roll < 0.75) {
          await fees.settle(ctx, ACTOR, {
            patronId: patron,
            kind: 'payment',
            currency: 'EUR',
            branchId: BRANCH,
            amountCents: BigInt(1 + Math.floor(rand() * 700)),
            paymentMethodId: 'paymethod_cash',
          });
          payments += 1;
        } else if (roll < 0.85) {
          await fees.settle(ctx, ACTOR, {
            patronId: patron,
            kind: 'waiver',
            currency: 'EUR',
            branchId: BRANCH,
            amountCents: BigInt(1 + Math.floor(rand() * 200)),
          });
          waivers += 1;
        } else if (roll < 0.93) {
          await fees.settle(ctx, ACTOR, {
            patronId: patron,
            kind: 'write_off',
            currency: 'EUR',
            branchId: BRANCH,
            amountCents: BigInt(1 + Math.floor(rand() * 200)),
          });
          writeOffs += 1;
        } else {
          await fees.refund(ctx, ACTOR, {
            patronId: patron,
            currency: 'EUR',
            branchId: BRANCH,
            amountCents: BigInt(1 + Math.floor(rand() * 150)),
            paymentMethodId: 'paymethod_cash',
          });
          refunds += 1;
        }
      } catch {
        // A refusal is a legitimate outcome — waiving more than is owed,
        // refunding more than was taken. What matters is that a refused
        // operation leaves NOTHING behind, which the identities below assert.
        refused += 1;
      }

      if (n > 0 && n % 2_500 === 0) {
        expect(await identities()).toEqual({ i1: 0, i2: 0, i3: 0 });
      }
    }

    // Every operation class actually happened. Without this the test could pass
    // by having done almost nothing.
    expect(charges).toBeGreaterThan(1_000);
    expect(payments).toBeGreaterThan(500);
    expect(waivers).toBeGreaterThan(100);
    expect(writeOffs).toBeGreaterThan(100);
    expect(refunds).toBeGreaterThan(100);
    expect(refused).toBeLessThan(OPERATIONS);

    expect(await identities()).toEqual({ i1: 0, i2: 0, i3: 0 });
  }, 900_000);
});

// ---------------------------------------------------------------------------
// 6. The pure allocators, exhaustively
// ---------------------------------------------------------------------------

describe('the allocator loses nothing and invents nothing', () => {
  it('applied + unapplied is always exactly the amount tendered', () => {
    for (let amount = 1n; amount <= 300n; amount += 1n) {
      const plan = planSettlement(amount, [
        { feeId: 'a', owedCents: 37n },
        { feeId: 'b', owedCents: 101n },
        { feeId: 'c', owedCents: 5n },
      ]);
      expect(plan.appliedCents + plan.unappliedCents).toBe(amount);
      expect(plan.allocations.reduce((s, a) => s + a.amountCents, 0n)).toBe(plan.appliedCents);
      // No zero allocations: fee_allocations_not_zero would refuse the row, and
      // an allocation that moved nothing is a claim to have touched a fee.
      expect(plan.allocations.every((a) => a.amountCents > 0n)).toBe(true);
    }
  });

  it('never allocates more to a charge than that charge owes', () => {
    const plan = planSettlement(1_000n, [
      { feeId: 'a', owedCents: 10n },
      { feeId: 'b', owedCents: 20n },
    ]);
    expect(plan.allocations).toEqual([
      { feeId: 'a', amountCents: 10n },
      { feeId: 'b', amountCents: 20n },
    ]);
    expect(plan.unappliedCents).toBe(970n);
  });

  it('a refund is negative, newest first, and bounded by what was paid', () => {
    const plan = planRefund(25n, [
      { feeId: 'old', paidCents: 40n },
      { feeId: 'new', paidCents: 10n },
    ]);
    expect(plan.allocations).toEqual([
      { feeId: 'new', amountCents: -10n },
      { feeId: 'old', amountCents: -15n },
    ]);
    expect(() => planRefund(100n, [{ feeId: 'x', paidCents: 10n }])).toThrow(
      /only 10 has been paid/,
    );
  });
});
