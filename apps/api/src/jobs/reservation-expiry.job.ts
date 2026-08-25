import { controlDb } from '@libriant/db-control';
import { Logger } from '@nestjs/common';
import { TenantPrismaService } from '../tenancy/tenant-prisma.service.js';
import type { TenantContext } from '../tenancy/tenant-context.js';
import { describeError } from './job-error.js';
import type { JobResult } from './jobs.types.js';

/**
 * 14 deferred — "reservation pickup-expiry job".
 *
 * Walks every active tenant. For each, opens the tenant Prisma client
 * (cached LRU under the hood) and marks every reservation where
 * `status='ready'` and `expiresAt < now` as `expired`, then rebalances
 * the queue so the next held copy gets offered.
 *
 * Why iterate tenants from the worker rather than expose a global
 * cron: every tenant has its own physical DB, so a single SELECT
 * doesn't work; we need a connection per tenant anyway. The
 * TenantPrismaService LRU keeps connection counts bounded (default
 * 50 hot clients).
 *
 * The queue-promotion logic is intentionally re-implemented inline
 * here rather than calling `ReservationsService.expire(tenant, id)` —
 * the service requires a full Nest module graph (tenant prisma +
 * field defs + audit), and the worker process intentionally skips Nest
 * DI. The two implementations are short + use the same DB columns; if
 * the inline one drifts, the unit test pins the contract.
 */
const logger = new Logger('ReservationExpirySweeper');

export async function sweepExpiredReservationPickups(): Promise<JobResult> {
  const tenants = await controlDb.tenant.findMany({
    where: { status: 'active' },
    select: {
      id: true,
      slug: true,
      name: true,
      defaultLocale: true,
      status: true,
      dbUrl: true,
      storageUrl: true,
      customSubdomain: true,
      tags: true,
    },
  });

  const tenantPrisma = new TenantPrismaService('worker');
  let total = 0;
  let promoted = 0;
  let failed = 0;
  // reliability-07 at row granularity: see `expireOneTenant`.
  let rowsFailed = 0;

  try {
    for (const t of tenants) {
      // The one-connection-per-tenant pin lives in the service's 'worker' role
      // now, not in this URL (performance-06: the old `connection_limit=1`
      // query parameter was silently ignored by Prisma 7's driver adapter).
      const ctx: TenantContext = {
        ...t,
        resolvedFrom: 'path',
      };
      try {
        const result = await expireOneTenant(ctx, tenantPrisma);
        total += result.expired;
        promoted += result.promoted;
        rowsFailed += result.failed;
      } catch (err) {
        failed++;
        logger.warn(`sweep failed for tenant=${t.slug}: ${describeError(err)}`);
      }
    }
  } finally {
    // Force-close every cached client so we don't leak Postgres connections
    // when the worker keeps the LRU warm for an idle cron.
    await tenantPrisma.onModuleDestroy().catch(() => undefined);
  }

  const summary =
    total === 0
      ? `${tenants.length} tenant(s) scanned; no pickups to expire`
      : `expired ${total} pickup(s) (${promoted} queue-promoted) across ${tenants.length} tenant(s)`;

  return {
    // Say it in the handler's own message too, not only via the runner's
    // `FAILED —` suffix: this string is what the log line shows, and
    // "no pickups to expire" next to a pile of failed expiries is the exact
    // sentence that hid the problem.
    message: rowsFailed === 0 ? summary : `${summary}; ${rowsFailed} reservation(s) failed`,
    counts: {
      expired: total,
      promoted,
      tenantsScanned: tenants.length,
      tenantsFailed: failed,
      rowsFailed,
    },
  };
}

/**
 * Expire (and re-promote behind) every overdue pickup for one tenant.
 *
 * Returns `failed` alongside the work done. reliability-07 was fixed at the
 * TENANT loop above, but the identical lie survived one level down: the
 * per-reservation `catch` here only emitted a `logger.warn`, bumped nothing,
 * and never reached the tenant-level catch. A tenant whose every expiry
 * transaction threw — a deadlock storm, a broken CHECK, a lock timeout —
 * therefore returned `{ expired: 0 }` and the sweep reported
 * "N tenant(s) scanned; no pickups to expire", green, forever. Rows the loop
 * attempted and could not complete are now counted, and `rowsFailed` is a
 * `…Failed` key, so the runner marks the run not-ok (see jobs.types.ts).
 */
async function expireOneTenant(
  ctx: TenantContext,
  tenantPrisma: TenantPrismaService,
): Promise<{ expired: number; promoted: number; failed: number }> {
  const client = tenantPrisma.getClient(ctx);
  const now = new Date();

  const overdue = await client.reservation.findMany({
    where: { status: 'ready', expiresAt: { lt: now } },
    select: { id: true, bookId: true, fulfilledByCopyId: true },
  });
  if (overdue.length === 0) return { expired: 0, promoted: 0, failed: 0 };

  const settings = await client.tenantSetting.findUnique({ where: { id: 1 } });
  const holdPickupHours = settings?.holdPickupHours ?? 48;
  const MS_PER_HOUR = 60 * 60 * 1000;

  let expired = 0;
  let promoted = 0;
  let failed = 0;

  for (const r of overdue) {
    try {
      await client.$transaction(async (tx) => {
        // Serialize per-book hold promotion with the return path
        // (loans.service) and other expiry transactions — same lock key — so
        // find-next + promote is atomic and two paths can't both reserve a copy
        // for the queue head. Releases at COMMIT/ROLLBACK.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`book:${r.bookId}`}, 0))`;
        // Mark the expired hold + free its copy.
        const upd = await tx.reservation.updateMany({
          where: { id: r.id, status: 'ready' },
          data: { status: 'expired', queuePosition: null },
        });
        if (upd.count === 0) return; // race with admin expire

        if (r.fulfilledByCopyId) {
          // Guard on status: only free a copy that's actually held for this
          // pickup. Without the guard a copy a librarian just marked lost /
          // damaged would be clobbered back to 'available'.
          await tx.bookCopy.updateMany({
            where: { id: r.fulfilledByCopyId, status: 'reserved' },
            data: { status: 'available' },
          });
        }

        // Promote the next in queue, if any.
        const next = await tx.reservation.findFirst({
          where: { bookId: r.bookId, status: 'queued' },
          orderBy: { queuePosition: 'asc' },
        });
        if (!next) {
          expired++;
          return;
        }
        // Find an available copy of the same book to attach.
        const copy = await tx.bookCopy.findFirst({
          where: { bookId: r.bookId, status: 'available' },
        });
        if (!copy) {
          // No copies free yet — leave the queue intact, just bump
          // expired count and move on.
          expired++;
          return;
        }
        // Claim the copy with a compare-and-swap so a concurrent checkout or
        // promotion can't double-allocate the same physical copy.
        const claimed = await tx.bookCopy.updateMany({
          where: { id: copy.id, status: 'available' },
          data: { status: 'reserved' },
        });
        if (claimed.count === 0) {
          // Lost the race for this copy — leave the queue intact for the next
          // sweep rather than marking a hold ready against a copy we don't own.
          expired++;
          return;
        }
        // CAS the promotion: only promote while `next` is still 'queued'. A
        // concurrent cancel could have flipped it between the read above and
        // here — without this guard we'd resurrect a cancelled hold (and strand
        // the copy we just claimed). On a lost race, release the copy.
        const promotedNext = await tx.reservation.updateMany({
          where: { id: next.id, status: 'queued' },
          data: {
            status: 'ready',
            fulfilledByCopyId: copy.id,
            // MUST set readyAt — the hold-ready notification job only emails
            // reservations with readyAt != null. Without it the promoted
            // patron is never told their hold is waiting.
            readyAt: now,
            expiresAt: new Date(now.getTime() + holdPickupHours * MS_PER_HOUR),
            queuePosition: null,
          },
        });
        if (promotedNext.count === 0) {
          await tx.bookCopy.updateMany({
            where: { id: copy.id, status: 'reserved' },
            data: { status: 'available' },
          });
          expired++;
          return;
        }
        // circ-4: now that the head-of-queue moved out, everyone behind bumps up
        // one slot — same rebalance the service paths (reservations.service /
        // loans.service return) run, so all promotion paths keep queuePositions
        // contiguous and 1-based. Without it a cron-driven expiry leaves a gap.
        await tx.$executeRaw`
          UPDATE reservations
          SET "queuePosition" = "queuePosition" - 1, "updatedAt" = NOW() AT TIME ZONE 'UTC'
          WHERE "bookId" = ${r.bookId}
            AND status = 'queued'
            AND "queuePosition" > 0
        `;
        expired++;
        promoted++;
      });
    } catch (err) {
      failed++;
      // describeError, not `.message`: a Prisma client-initialisation error
      // carries an empty message, and "expire failed: " with nothing after the
      // colon is barely better than no line at all (see job-error.ts).
      logger.warn(
        `reservation ${r.id} expire failed for tenant=${ctx.slug}: ${describeError(err)}`,
      );
    }
  }

  return { expired, promoted, failed };
}
