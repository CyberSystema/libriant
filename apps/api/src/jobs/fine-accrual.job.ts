import { controlDb } from '@libriant/db-control';
import { Logger } from '@nestjs/common';
import { Prisma, type TenantPrismaClient } from '@libriant/db-tenant';
import { TenantPrismaService } from '../tenancy/tenant-prisma.service.js';
import { TENANT_CONTEXT_SELECT, tenantContextFrom } from '../tenancy/tenant-db-url.js';
import type { TenantContext } from '../tenancy/tenant-context.js';
import { describeError } from './job-error.js';
import type { JobResult } from './jobs.types.js';

/**
 * Overdue-fine accrual sweep.
 *
 * Until now a fine was only created when a book was *returned* late. This walks
 * every active tenant and, for each still-active overdue loan, opens (or grows)
 * a single outstanding fine reflecting the amount accrued so far
 * (`daysOverdue * finePerDayCents`, capped by `fineCapCents`). That makes the
 * running total visible before return.
 *
 * One outstanding fine per loan (keyed by `loanId`), so this is idempotent — a
 * re-run just re-sets the amount. The return flow (LoansService.return)
 * finalises the same fine instead of creating a duplicate.
 *
 * Mirrors the reservation-expiry sweeper's per-tenant pattern (each tenant has
 * its own physical DB, so we need a client per tenant; the TenantPrismaService
 * LRU bounds connection counts).
 *
 * PER-JOB-TENANTPRISMA-CONN-MULTIPLY (performance-06): each per-tenant sweep
 * spins up its own TenantPrismaService LRU and holds it for the whole run, and
 * four heavy sweeps fire on the same hour. This used to be "mitigated" by a
 * helper that appended `connection_limit=1` to the tenant URL — a parameter
 * Prisma's OLD Rust engine understood and the Prisma 7 driver adapter does not.
 * Measured: 5 connections with the parameter present, 5 without it, and 1 only
 * when `maxPoolSize` is actually passed to the adapter. The URL pin is gone;
 * the sweep now constructs its service with the `'worker'` role, which is what
 * makes the pool one connection deep and the LRU small enough that four
 * overlapping sweeps still fit the budget (platform/tenant-pool-budget.ts).
 */
const MS_PER_DAY = 86_400_000;
const logger = new Logger('FineAccrualSweeper');

export async function sweepFineAccrual(): Promise<JobResult> {
  const tenants = await controlDb.tenant.findMany({
    where: { status: 'active' },
    select: TENANT_CONTEXT_SELECT,
  });

  const tenantPrisma = new TenantPrismaService('worker');
  let touched = 0;
  let failed = 0;
  try {
    for (const t of tenants) {
      // Constructed INSIDE the per-tenant try. `tenantContextFrom` throws for a
      // tenant with no sealed database credential (tenant-isolation-02), and a
      // throw out here would end the sweep for EVERY library at the first
      // un-backfilled one — turning a single tenant's missing row into a
      // fleet-wide outage of the nightly job. The counter below is what that
      // case is for.
      try {
        const ctx: TenantContext = tenantContextFrom(t);
        touched += await accrueOneTenant(ctx, tenantPrisma);
      } catch (err) {
        failed++;
        logger.warn(`accrual failed for tenant=${t.slug}: ${describeError(err)}`);
      }
    }
  } finally {
    await tenantPrisma.onModuleDestroy().catch(() => undefined);
  }

  return {
    message:
      touched === 0
        ? `${tenants.length} tenant(s) scanned; no fines to accrue`
        : `accrued/updated ${touched} fine(s) across ${tenants.length} tenant(s)`,
    counts: { fines: touched, tenantsScanned: tenants.length, tenantsFailed: failed },
  };
}

async function accrueOneTenant(
  ctx: TenantContext,
  tenantPrisma: TenantPrismaService,
): Promise<number> {
  const client = tenantPrisma.getClient(ctx);
  const settings = await client.tenantSetting.findUnique({ where: { id: 1 } });
  const perDay = settings?.finePerDayCents ?? 0;
  // Skip libraries that switched overdue fines off, or charge nothing per day.
  if (!settings?.overdueFinesEnabled || perDay <= 0) return 0;
  const cap = settings?.fineCapCents ?? 0;
  const currency = settings?.currency ?? 'EUR';
  const now = new Date();

  // What each loan has ALREADY settled — paid at the desk or written off.
  //
  // Without this the sweep silently undoes the fines module. A librarian voids
  // a fine that was raised in error on a book still out on loan; tonight this
  // job finds no outstanding fine for that loan, recomputes the full running
  // total from scratch, and opens the same charge again. The member's write-off
  // lasts until 03:00. Same for a payment taken while the book is still out:
  // the sweep would re-bill the days that were just paid for.
  //
  // The invariant, shared with LoansService.returnLoan:
  //   outstanding for a loan  =  total accrued − already settled.
  //
  // One grouped query for the whole tenant rather than an IN-list keyed on the
  // overdue loans: `fines` is small (only overdue/lost loans ever produce a
  // row), and a big library can carry six figures of overdue loans, which is
  // well past what belongs in a bind-parameter list.
  const settledByLoan = new Map<string, number>();
  const settledRows = await client.fine.groupBy({
    by: ['loanId'],
    where: { status: { in: ['paid', 'waived'] }, loanId: { not: null } },
    _sum: { amountCents: true },
  });
  for (const row of settledRows) {
    if (row.loanId) settledByLoan.set(row.loanId, row._sum.amountCents ?? 0);
  }

  let touched = 0;
  let cursor: OverdueCursor | null = null;
  for (;;) {
    const page = await overduePage(client, now, cursor);
    if (page.length === 0) break;
    touched += await accrueBatch(client, page, { now, perDay, cap, currency, settledByLoan });
    if (page.length < OVERDUE_PAGE_SIZE) break;
    const last = page[page.length - 1]!;
    cursor = { dueAt: last.dueAt, id: last.id };
  }
  return touched;
}

type OverdueLoan = { id: string; memberId: string; dueAt: Date };
type OverdueCursor = { dueAt: Date; id: string };

/**
 * One page of still-open overdue loans, oldest first (performance-08).
 *
 * Raw rather than `loan.findMany({ cursor })` for two reasons, both measured
 * on the audit's 2M-row loans table (200,000 open, 15,000 overdue):
 *
 *   - A true row-value predicate `("dueAt","id") > ($1,$2)` is a start key.
 *     Prisma's `cursor` renders an OR-of-subselects that Postgres cannot use
 *     as one (performance-03), so page N would re-walk pages 1..N-1.
 *   - `status = 'active'::"LoanStatus"` is a foldable constant. Prisma emits
 *     `status = CAST($1::text AS "LoanStatus")`, and because `enum_in` is only
 *     STABLE the planner cannot fold that — the same reason the tenant schema
 *     stopped using a partial index for this predicate.
 *
 * Plan (EXPLAIN ANALYZE, BUFFERS, page size 500):
 *   page 1:  Index Scan using loans_status_dueAt_id_idx   Buffers: shared hit=239
 *   page N:  Index Scan using loans_dueAt_idx             Buffers: shared hit=245
 * versus the unbounded `findMany` this replaces, which returned all 15,000 rows
 * into one JS array in a single trip. The rows still have to be read; what
 * changes is that memory is now bounded by the page, not by how far behind the
 * library is on its overdues.
 */
const OVERDUE_PAGE_SIZE = 500;

async function overduePage(
  client: TenantPrismaClient,
  now: Date,
  cursor: OverdueCursor | null,
): Promise<OverdueLoan[]> {
  // `now` is bound rather than calling now() in SQL, so every page of the sweep
  // and the daysOverdue arithmetic below agree on one instant — otherwise a
  // sweep straddling midnight would bill two different day counts.
  const after = cursor
    ? Prisma.sql`AND ("dueAt", "id") > (${cursor.dueAt}, ${cursor.id})`
    : Prisma.empty;
  return client.$queryRaw<OverdueLoan[]>(
    Prisma.sql`SELECT "id", "memberId", "dueAt"
                 FROM "loans"
                WHERE "status" = 'active'::"LoanStatus"
                  AND "dueAt" < ${now}
                  ${after}
                ORDER BY "dueAt" ASC, "id" ASC
                LIMIT ${OVERDUE_PAGE_SIZE}`,
  );
}

/**
 * Accrue one page.
 *
 * This used to be three sequential round trips PER LOAN — `loan.findUnique`,
 * `fine.findFirst`, and a `fine.updateMany`/`create` — on a pool that is one
 * connection deep in the worker, with every tenant swept sequentially in the
 * same hourly tick.
 *
 * Measured on the audit's Institutional-sized tenant (2,000,000 loans, 200,000
 * open, 15,000 overdue), counting statements off Prisma's own query event log,
 * READS ONLY — no writes, so this is the floor, paid every hour:
 *
 *   old shape: 15,000 rows buffered in one array; 1.94 statements/loan,
 *              extrapolated to 29,042 statements and 9,179 ms
 *   new shape: never more than 500 rows in memory; 92 statements, 326 ms
 *
 * Now it is a fixed FOUR statements per page regardless of page size:
 * one status re-read, one fine lookup, one batched UPDATE, one batched INSERT.
 * Every guard the per-row version had is preserved — see below.
 */
async function accrueBatch(
  client: TenantPrismaClient,
  page: OverdueLoan[],
  opts: {
    now: Date;
    perDay: number;
    cap: number;
    currency: string;
    settledByLoan: Map<string, number>;
  },
): Promise<number> {
  const ids = page.map((l) => l.id);

  // Re-read the loans: a concurrent return/lost flow may have closed one and
  // finalised its fine between the page query and here. Don't resurrect or
  // overwrite a fine for a loan that is no longer active (that would revert the
  // return-flow amount). Same guard as before, one statement instead of N.
  const stillActive = new Set(
    (
      await client.loan.findMany({
        where: { id: { in: ids }, status: 'active' },
        select: { id: true },
      })
    ).map((r) => r.id),
  );

  const existingByLoan = new Map<string, { id: string; amountCents: number }>();
  for (const f of await client.fine.findMany({
    where: { loanId: { in: ids }, status: 'outstanding' },
    select: { id: true, loanId: true, amountCents: true },
  })) {
    if (f.loanId) existingByLoan.set(f.loanId, { id: f.id, amountCents: f.amountCents });
  }

  const updIds: string[] = [];
  const updAmounts: number[] = [];
  const updReasons: string[] = [];
  const creates: Array<{
    memberId: string;
    loanId: string;
    amountCents: number;
    currency: string;
    reason: string;
    status: 'outstanding';
  }> = [];

  for (const loan of page) {
    if (!stillActive.has(loan.id)) continue;
    const daysOverdue = Math.floor((opts.now.getTime() - loan.dueAt.getTime()) / MS_PER_DAY);
    if (daysOverdue <= 0) continue;
    const raw = daysOverdue * opts.perDay;
    const accrued = opts.cap > 0 ? Math.min(raw, opts.cap) : raw;
    const amount = Math.max(0, accrued - (opts.settledByLoan.get(loan.id) ?? 0));
    // Nothing left to bill — either nothing accrued, or the member has already
    // settled everything this loan has run up so far.
    if (amount <= 0) continue;
    const reason = `${daysOverdue} day(s) overdue`;

    const existing = existingByLoan.get(loan.id);
    if (existing) {
      if (existing.amountCents !== amount) {
        updIds.push(existing.id);
        updAmounts.push(amount);
        updReasons.push(reason);
      }
    } else {
      creates.push({
        memberId: loan.memberId,
        loanId: loan.id,
        amountCents: amount,
        currency: opts.currency,
        reason,
        status: 'outstanding',
      });
    }
  }

  let touched = 0;

  if (updIds.length > 0) {
    // One UPDATE … FROM unnest(...) for the whole page. `int[]` for the amounts
    // — money is integer subunits and must never go near a float. Still
    // status-guarded, so a fine the return flow resolved between the read above
    // and this write is left alone, exactly as the per-row updateMany was.
    // `updatedAt` is set explicitly: Prisma's `@updatedAt` is applied by the
    // query engine and does NOT fire on raw SQL, and the column is NOT NULL
    // with no database default.
    touched += await client.$executeRaw(
      Prisma.sql`UPDATE "fines" AS f
                    SET "amountCents" = v.amount,
                        "reason"      = v.reason,
                        "updatedAt"   = ${opts.now}
                   FROM unnest(${updIds}::text[], ${updAmounts}::int[], ${updReasons}::text[])
                        AS v(id, amount, reason)
                  WHERE f."id" = v.id
                    AND f."status" = 'outstanding'::"FineStatus"`,
    );
  }

  if (creates.length > 0) {
    // `skipDuplicates` is the batch form of the P2002 tolerance the per-row
    // create had: a concurrent return/accrual that already opened the
    // outstanding fine wins the `fines_one_outstanding_per_loan` unique index,
    // and that single fine is the desired outcome. `count` is the number of
    // rows that really landed, so `touched` keeps its old meaning.
    const res = await client.fine.createMany({ data: creates, skipDuplicates: true });
    touched += res.count;
  }

  return touched;
}
