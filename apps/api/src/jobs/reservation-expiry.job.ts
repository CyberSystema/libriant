import { controlDb } from '@libriant/db-control';
import { Logger } from '@nestjs/common';
import { TenantPrismaService } from '../tenancy/tenant-prisma.service.js';
import type { TenantContext } from '../tenancy/tenant-context.js';
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

  const tenantPrisma = new TenantPrismaService();
  let total = 0;
  let promoted = 0;
  let failed = 0;

  try {
    for (const t of tenants) {
      const ctx: TenantContext = { ...t, resolvedFrom: 'path' };
      try {
        const result = await expireOneTenant(ctx, tenantPrisma);
        total += result.expired;
        promoted += result.promoted;
      } catch (err) {
        failed++;
        logger.warn(`sweep failed for tenant=${t.slug}: ${(err as Error).message}`);
      }
    }
  } finally {
    // Force-close every cached client so we don't leak Postgres connections
    // when the worker keeps the LRU warm for an idle cron.
    await tenantPrisma.onModuleDestroy().catch(() => undefined);
  }

  return {
    message:
      total === 0
        ? `${tenants.length} tenant(s) scanned; no pickups to expire`
        : `expired ${total} pickup(s) (${promoted} queue-promoted) across ${tenants.length} tenant(s)`,
    counts: { expired: total, promoted, tenantsScanned: tenants.length, tenantsFailed: failed },
  };
}

async function expireOneTenant(
  ctx: TenantContext,
  tenantPrisma: TenantPrismaService,
): Promise<{ expired: number; promoted: number }> {
  const client = tenantPrisma.getClient(ctx);
  const now = new Date();

  const overdue = await client.reservation.findMany({
    where: { status: 'ready', expiresAt: { lt: now } },
    select: { id: true, bookId: true, fulfilledByCopyId: true },
  });
  if (overdue.length === 0) return { expired: 0, promoted: 0 };

  const settings = await client.tenantSetting.findUnique({ where: { id: 1 } });
  const holdPickupHours = settings?.holdPickupHours ?? 48;
  const MS_PER_HOUR = 60 * 60 * 1000;

  let expired = 0;
  let promoted = 0;

  for (const r of overdue) {
    try {
      await client.$transaction(async (tx) => {
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
        await tx.reservation.update({
          where: { id: next.id },
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
        expired++;
        promoted++;
      });
    } catch (err) {
      logger.warn(`reservation ${r.id} expire failed: ${(err as Error).message}`);
    }
  }

  return { expired, promoted };
}
