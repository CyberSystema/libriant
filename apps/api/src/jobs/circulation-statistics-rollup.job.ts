import { controlDb } from '@libriant/db-control';
import { Logger } from '@nestjs/common';
import { TenantPrismaService } from '../tenancy/tenant-prisma.service.js';
import { TENANT_CONTEXT_SELECT, tenantContextFrom } from '../tenancy/tenant-db-url.js';
import type { TenantContext } from '../tenancy/tenant-context.js';
import { describeError } from './job-error.js';
import type { JobResult } from './jobs.types.js';

/**
 * Rebuild `circulation_statistics` from `loan_events`.
 *
 * ## Why the counters are not incremented in the checkout transaction
 *
 * They could be, in one `INSERT … ON CONFLICT DO UPDATE`, and it would be
 * simpler. It would also put a HOT ROW inside the exact transaction this phase
 * is accepted on — "one-open-loan-per-item holds under 25-way concurrent
 * checkout of the SAME item" — so all 25 would additionally serialise on one
 * statistics row, for a number nobody reads until the end of the month. And it
 * would spend one of the twelve statements a checkin is allowed.
 *
 * The deeper reason is repairability. A rollup recomputed from the event log can
 * be REPAIRED — re-run it and the number is right. A counter incremented
 * in-transaction can only ever be believed: if it is wrong there is nothing to
 * compare it against and no way back. §8 risk 7 makes the same argument about the
 * fee ledger's reconciliation, and the same conclusion follows here.
 *
 * ## The current month AND the previous one
 *
 * The previous month is still moving on the 1st: a Saturday return synced on
 * Monday the 2nd carries `effective_at` in the old month and belongs in its
 * figures. Two months is what covers every realistic sync lag; a device offline
 * for longer than that is a reconciliation report (phase 78), not a statistic.
 *
 * ## It groups on `effective_at`, never `occurred_at`
 *
 * A month's statistics are about what the library DID that month. The wand that
 * synced on the 2nd did its work in the month before, and counting it in the new
 * one would move a loan between two ISO 2789 returns depending on when a battery
 * was charged.
 */
const logger = new Logger('CirculationStatisticsRollup');

export const CIRCULATION_ROLLUP_JOB = 'circulation-statistics-rollup';
export const CIRCULATION_ROLLUP_COUNTS = { buckets: 'buckets' } as const;

export async function rollUpCirculationStatistics(): Promise<JobResult> {
  const tenants = await controlDb.tenant.findMany({
    where: { status: 'active' },
    select: TENANT_CONTEXT_SELECT,
  });

  const tenantPrisma = new TenantPrismaService('worker');
  let buckets = 0;
  let failed = 0;

  try {
    for (const t of tenants) {
      try {
        const ctx: TenantContext = tenantContextFrom(t);
        const client = tenantPrisma.getClientV2(ctx);
        for (const offset of [-1, 0]) {
          buckets += await rollMonth(client, offset);
        }
      } catch (err) {
        failed++;
        logger.warn(`statistics rollup failed for tenant=${t.slug}: ${describeError(err)}`);
      }
    }
  } finally {
    await tenantPrisma.onModuleDestroy().catch(() => undefined);
  }

  return {
    message: `${buckets} bucket(s) rebuilt across ${tenants.length} tenant(s), for this month and last`,
    counts: {
      [CIRCULATION_ROLLUP_COUNTS.buckets]: buckets,
      tenantsScanned: tenants.length,
      tenantsFailed: failed,
    },
  };
}

type RawClient = { $executeRaw(q: TemplateStringsArray, ...v: unknown[]): Promise<number> };

/**
 * One month, recomputed from scratch and upserted.
 *
 * ## The arbiter is four plain scalars, and every part of that is forced
 *
 * A partitioned table's unique index must contain every partitioning column
 * (`0A000`), so `period_start` leads. An `ON CONFLICT` arbiter carrying an enum
 * predicate raises `42P10` through Prisma's parameterised cast while working by
 * hand in psql — measured in phase 15 — so there is no `kind` enum anywhere near
 * this statement and the counters are COLUMNS. And all four dimensions are NOT
 * NULL, because a unique index treats two NULLs as distinct and a nullable
 * dimension would silently accumulate duplicate buckets, which a dashboard
 * renders as a plausible number.
 *
 * ## `DO UPDATE SET … = EXCLUDED.…`, not `+ EXCLUDED.…`
 *
 * Assignment, not accumulation. This is a RECOMPUTE: running it three times must
 * give the same answer as running it once, or the job is a counter with extra
 * steps and every retried tick inflates the month.
 *
 * ## Raw SQL, and it has to be
 *
 * Prisma has no `INSERT … SELECT`, no `FILTER`, and no way to name a conflict
 * target on a partitioned table's composite primary key. A per-bucket read then
 * upsert would be N round trips for a month of a large library; this is one.
 */
async function rollMonth(client: RawClient, monthOffset: number): Promise<number> {
  return client.$executeRaw`
    INSERT INTO lbr2.circulation_statistics
           (period_start, branch_id, item_type_id, patron_category_id,
            checkouts, renewals, returns, computed_at)
    SELECT pg_catalog.date_trunc('month', pg_catalog.now())::date
             + (${monthOffset} * INTERVAL '1 month'),
           e.branch_id,
           l.item_type_id_applied,
           l.patron_category_id_applied,
           pg_catalog.count(*) FILTER (WHERE e.kind = 'checked_out'),
           pg_catalog.count(*) FILTER (WHERE e.kind = 'renewed'),
           pg_catalog.count(*) FILTER (WHERE e.kind = 'returned'),
           pg_catalog.now()
      FROM lbr2.loan_events e
      JOIN lbr2.loans l ON l.id = e.loan_id
     WHERE e.effective_at >= (pg_catalog.date_trunc('month', pg_catalog.now())
                              + (${monthOffset} * INTERVAL '1 month'))
       AND e.effective_at <  (pg_catalog.date_trunc('month', pg_catalog.now())
                              + ((${monthOffset} + 1) * INTERVAL '1 month'))
     GROUP BY e.branch_id, l.item_type_id_applied, l.patron_category_id_applied
    ON CONFLICT (period_start, branch_id, item_type_id, patron_category_id)
    DO UPDATE SET checkouts   = EXCLUDED.checkouts,
                  renewals    = EXCLUDED.renewals,
                  returns     = EXCLUDED.returns,
                  computed_at = EXCLUDED.computed_at`;
}
