import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client as PgClient } from 'pg';
import { TenantProvisioningService } from '../../src/provisioning/tenant-provisioning.service.js';
import { declareBillingPosture } from './billing-posture.js';

declareBillingPosture(
  'unenforced',
  'This provisions a database and reads pg_indexes. No plan gate is exercised, so it runs ' +
    'the shipped configuration.',
);

/**
 * performance-05 — the index the quota count needs, proved present on a
 * database this product actually provisions.
 *
 * `BooksService.create` counts the live catalogue inside the insert's own
 * transaction, behind `pg_advisory_xact_lock('quota:<tenant>:max_books:')`,
 * whenever the tenant has a finite `max_books`. Nothing indexed
 * `"archivedAt" IS NULL`, so that count was a sequential scan of `books` — on
 * the audit's 400,000-title fixture, 10,526 shared buffers and 61.9 ms per book
 * catalogued, through a 128 MB shared_buffers pool every library on the box
 * shares. With `books_active_idx` the same statement is an Index Only Scan at
 * 1,536 buffers and 23.8 ms.
 *
 * WHY THIS TEST IS SHAPED THIS WAY. An index that exists in a migration file is
 * not an index a library has; the thing that has to be true is that
 * `TenantProvisioningService.provision()` — the method signup calls, which
 * shells out to `prisma migrate deploy` — leaves it behind. So this drives that
 * method against a real, throwaway database rather than reading the .sql.
 *
 * And existence is not enough either. The long note in
 * 20260824170000_loans_overdue_index records a partial index that was created,
 * looked correct, and could never be chosen, because Prisma renders the enum in
 * its predicate as `CAST($1::text AS "LoanStatus")` and the planner will not
 * fold a STABLE `enum_in` to a constant for the partial-index prover. The
 * second assertion below is against exactly that failure: it asks the planner,
 * on the literal SQL Prisma emits for `book.count`, whether it can use the
 * index — which it can only answer yes to if the predicate is provable.
 */
const provisioning = new TenantProvisioningService();
const tenantId = `perf05${randomBytes(8).toString('hex')}`;
let dbUrl = '';

/** The statement Prisma emits for `book.count({ where: { archivedAt: null } })`. */
const COUNT_SQL =
  'SELECT COUNT(*) FROM (SELECT "public"."books"."id" FROM "public"."books" ' +
  'WHERE "public"."books"."archivedAt" IS NULL OFFSET 0) AS "sub"';

/** Run `sql` on a fresh connection, after any `setup` statements on the same one. */
async function query<T = Record<string, unknown>>(sql: string, setup: string[] = []): Promise<T[]> {
  const client = new PgClient({ connectionString: dbUrl });
  await client.connect();
  try {
    for (const s of setup) await client.query(s);
    return (await client.query(sql)).rows as T[];
  } finally {
    await client.end();
  }
}

beforeAll(async () => {
  const placement = await provisioning.provision({ tenantId, cellId: 'cell-eu-1' });
  dbUrl = placement.dbUrl;
}, 180_000);

afterAll(async () => {
  await provisioning.teardown(tenantId).catch(() => undefined);
}, 60_000);

describe('performance-05 — a provisioned tenant carries books_active_idx', () => {
  it('creates the index, with the predicate the count is written against', async () => {
    const rows = await query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
        WHERE tablename = 'books' AND indexname = 'books_active_idx'`,
    );
    expect(rows).toHaveLength(1);
    // The predicate has to be the one `BooksService` and `QUOTA_COUNTERS` ask
    // for. A partial index on anything else is an index this query cannot use.
    expect(rows[0]!.indexdef).toContain('("archivedAt" IS NULL)');
    expect(rows[0]!.indexdef).toContain('USING btree (id)');
  });

  it('is a plan the planner can actually reach for the count the app issues', async () => {
    // The tenant is empty, so on cost alone Postgres will always prefer a
    // sequential scan of a zero-page heap — the question here is not "is it
    // cheapest" but "is it eligible", i.e. can the partial-index prover
    // discharge the predicate. Taking the sequential scan off the table is how
    // you ask that question; if the predicate were unprovable the plan would
    // fall back to `Seq Scan` regardless of the setting, exactly as the
    // `loans_active_dueAt_idx` case did.
    const plan = await query<{ 'QUERY PLAN': string }>(`EXPLAIN ${COUNT_SQL}`, [
      'SET enable_seqscan = off',
    ]);
    const text = plan.map((r) => r['QUERY PLAN']).join('\n');
    expect(text, `planner would not use books_active_idx:\n${text}`).toContain('books_active_idx');
  });
});
