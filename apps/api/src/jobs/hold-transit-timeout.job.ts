import { controlDb } from '@libriant/db-control';
import { Logger } from '@nestjs/common';
import { TenantPrismaService } from '../tenancy/tenant-prisma.service.js';
import { TENANT_CONTEXT_SELECT, tenantContextFrom } from '../tenancy/tenant-db-url.js';
import type { TenantContext } from '../tenancy/tenant-context.js';
import { describeError } from './job-error.js';
import type { JobResult } from './jobs.types.js';

/**
 * A copy that was sent for a reader and never arrived (2.0 phase 17).
 *
 * ## IT REPORTS. IT DOES NOT CANCEL ANYTHING.
 *
 * §8 risk 7's rule, applied to a van instead of a ledger: "alerts rather than
 * self-heals (self-healing hides the bug that caused the drift)". A transfer
 * that has passed its `expected_by` is a physical fact nobody in the software
 * can fix — the book is in a crate, on a shelf at the wrong branch, or lost —
 * and a job that cancelled the request would tell the reader their book is not
 * coming while the van driver still has it in the boot. What a librarian needs
 * is the LIST, which is what this produces, plus a number an operator can alert
 * on when one branch quietly stops unpacking its deliveries.
 *
 * ## THE PREDICATE, and the half of it that is not obvious
 *
 *   hold_id IS NOT NULL      the copy is travelling FOR SOMEBODY. A late float
 *                            or a late rebalancing move is phase 23's problem
 *                            and has no reader waiting at the far end.
 *   received_at IS NULL      it has not arrived.
 *   cancelled_at IS NULL     the transfer was not called off.
 *   expected_by < now()      it is late.
 *
 * The first condition is the one to keep. `expected_by IS NOT NULL AND
 * expected_by < now()` on its own is a perfectly reasonable transit-desk query
 * and it belongs to phase 23's transit desk, which owns routing, floating and
 * every transfer that has no hold behind it. Counting those here would put a
 * float that is a day late into the same number as a reader who has been
 * standing at a desk since Tuesday, and the alert would then be about neither.
 *
 * ## No lock, no transaction, no write
 *
 * It reads. Nothing in this file may take an advisory lock, and there is nothing
 * for one to protect: the answer is a snapshot of a list that a librarian is
 * about to act on by walking to a crate.
 *
 * ## "NOW" IS BOUND FROM NODE, NEVER `pg_catalog.now()`
 *
 * MEASURED during phase 17, on a host whose Postgres session `TimeZone` is
 * `Europe/Athens`:
 *
 *     js now                       2026-09-10T10:48:29.401Z
 *     node-pg reads pg now()       2026-09-10T10:48:29.503Z
 *     node-pg reads a Prisma write 2026-09-10T07:48:29.401Z   <- three hours early
 *     Prisma  reads its own write  2026-09-10T10:48:29.401Z
 *     Prisma  reads pg now()       2026-09-10T13:48:29.507Z   <- three hours late
 *
 * Prisma's pg adapter encodes and decodes `timestamptz` as if the JS Date's UTC
 * wall clock were LOCAL time, in both directions — so Prisma agrees with itself
 * and disagrees with the server by the session offset. Every comparison in this
 * repository is Prisma-frame on both sides and therefore correct; a predicate
 * that puts a Prisma-written COLUMN beside a server-side `now()` is wrong by
 * that offset, silently, and only on a host that is not UTC. CI's Postgres is
 * UTC, which is exactly why nobody has seen it.
 *
 * So this file binds the instant from Node and never names `now()` in SQL. The
 * underlying defect is recorded in the phase-17 divergence-log entry; it is
 * older than this phase, it is not this phase's to fix, and it is not this
 * phase's to make worse either.
 */
const logger = new Logger('HoldTransitTimeout');

export const HOLD_TRANSIT_TIMEOUT_JOB = 'hold-transit-timeout';
export const HOLD_TRANSIT_TIMEOUT_COUNTS = {
  overdue: 'overdue',
  oldestDays: 'oldestDays',
} as const;

export async function checkHoldTransitTimeouts(): Promise<JobResult> {
  const tenants = await controlDb.tenant.findMany({
    where: { status: 'active' },
    select: TENANT_CONTEXT_SELECT,
  });

  const tenantPrisma = new TenantPrismaService('worker');
  let overdue = 0;
  let oldestDays = 0;
  let failed = 0;

  try {
    for (const t of tenants) {
      try {
        const ctx: TenantContext = tenantContextFrom(t);
        const client = tenantPrisma.getClientV2(ctx);
        const now = new Date();
        // COUNT and the EARLIEST due date, and the days are worked out in Node.
        //
        // `EXTRACT(epoch FROM …)` is a SQL CONSTRUCT with its own grammar, not a
        // function — `pg_catalog.extract(...)` is a syntax error, the same trap
        // COALESCE and NULLIF set and that this repository has now paid for
        // three times. `pg_catalog.date_part` is the real function and would
        // work; subtracting two instants in JavaScript is clearer still, and it
        // is safe here for the one reason it is usually not: both sides are
        // instants read in the SAME frame, and the result is an elapsed
        // duration rather than a fabricated date.
        const rows = await client.$queryRaw<{ n: bigint; oldest: Date | null }[]>`
          SELECT pg_catalog.count(*) AS n,
                 pg_catalog.min(expected_by) AS oldest
            FROM lbr2.item_transfers
           WHERE hold_id IS NOT NULL
             AND received_at IS NULL
             AND cancelled_at IS NULL
             AND expected_by IS NOT NULL
             AND expected_by < ${now}`;
        const n = Number(rows[0]?.n ?? 0);
        overdue += n;
        const oldest = rows[0]?.oldest ?? null;
        if (oldest !== null) {
          oldestDays = Math.max(
            oldestDays,
            Math.floor((now.getTime() - oldest.getTime()) / 86_400_000),
          );
        }
        if (n > 0) {
          logger.warn(
            `${n} copy(ies) sent for a reader have passed their expected arrival at tenant=` +
              `${t.slug}; the oldest is ${oldestDays} day(s) late`,
          );
        }
      } catch (err) {
        failed++;
        logger.warn(`hold transit check failed for tenant=${t.slug}: ${describeError(err)}`);
      }
    }
  } finally {
    await tenantPrisma.onModuleDestroy().catch(() => undefined);
  }

  return {
    message:
      overdue === 0
        ? `no overdue hold transits across ${tenants.length} tenant(s)`
        : `${overdue} overdue hold transit(s) across ${tenants.length} tenant(s), oldest ` +
          `${oldestDays} day(s) late`,
    counts: {
      [HOLD_TRANSIT_TIMEOUT_COUNTS.overdue]: overdue,
      [HOLD_TRANSIT_TIMEOUT_COUNTS.oldestDays]: oldestDays,
      tenantsScanned: tenants.length,
      tenantsFailed: failed,
    },
  };
}
