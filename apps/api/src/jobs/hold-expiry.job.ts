import { controlDb } from '@libriant/db-control';
import { Logger } from '@nestjs/common';
import { RedisService } from '../platform/redis.service.js';
import { PolicySnapshotService } from '../policy/policy-snapshot.service.js';
import { TenantClockService } from '../policy/tenant-clock.service.js';
import { TenantAuditService } from '../tenancy/tenant-audit.service.js';
import { TenantPrismaService } from '../tenancy/tenant-prisma.service.js';
import { TENANT_CONTEXT_SELECT, tenantContextFrom } from '../tenancy/tenant-db-url.js';
import type { TenantActor } from '../tenancy/tenant-actor.js';
import type { TenantContext } from '../tenancy/tenant-context.js';
import { ItemStatusService } from '../items/item-status.service.js';
import { ItemTransfersService } from '../items/item-transfers.service.js';
import { HoldArrivalService } from '../holds/hold-arrival.service.js';
import { HoldShelfService } from '../holds/hold-shelf.service.js';
import { describeError } from './job-error.js';
import type { JobResult } from './jobs.types.js';

/**
 * The two ways a request ends without anybody collecting anything (2.0 phase 17).
 *
 *   SHELF     the copy sat on the hold shelf until `shelf_expires_at` and nobody
 *             came. The request expires, the copy comes off the shelf, and — the
 *             part that matters — it is offered straight to the next reader in
 *             the queue, because a book leaving the hold shelf is exactly a book
 *             being returned.
 *   REQUEST   the request was never filled at all. `unfilled_request_expiry` is
 *             the answer for a reader who asked for a book the library has since
 *             withdrawn: the shelf expiry cannot help them, because it needs a
 *             copy to have arrived.
 *
 * ## ONE job, two sweeps, and why they are not two jobs
 *
 * They run at the same cadence, they read the same table, and the second one's
 * work is created by the first: expiring a shelf request can leave a copy that
 * makes another request fillable, and expiring an unfilled request can shorten
 * the queue the promoter is about to walk. Splitting them across two schedules
 * would make the order they ran in an accident of BullMQ timing, and the order
 * is the difference between a reader being told today and being told tomorrow.
 *
 * ## The service graph is built by hand, and torn down in a `finally`
 *
 * A worker tick has no Nest container. `marc-lock-expiry.job.ts` already
 * constructs `TenantAuditService` this way; this one needs six more, and the
 * chain is written out rather than hidden behind a helper so that the day a
 * constructor gains a parameter, the build breaks HERE rather than at 03:00.
 *
 * `PolicySnapshotService` holds a Redis subscription and a pool, so both it and
 * `RedisService` are destroyed in the `finally` — a sweep that leaked either
 * would keep the worker process alive after a graceful shutdown.
 *
 * ## The actor is the system, and it is named
 *
 * `actorType: 'system'` with the job's own name as the actor id, the shape
 * `marc-lock-expiry.job.ts` already uses. An expiry is not something a librarian
 * did, and attributing it to whoever last logged in is how an audit trail
 * becomes a thing nobody trusts.
 */
const logger = new Logger('HoldExpirySweeper');

export const HOLD_EXPIRY_JOB = 'hold-expiry';
export const HOLD_EXPIRY_COUNTS = {
  shelfExpired: 'shelfExpired',
  promoted: 'promoted',
  requestsExpired: 'requestsExpired',
} as const;

const SYSTEM: TenantActor = {
  userId: null,
  actorId: HOLD_EXPIRY_JOB,
  actorType: 'system',
  supportSessionId: null,
};

export async function sweepHoldExpiry(): Promise<JobResult> {
  const tenants = await controlDb.tenant.findMany({
    where: { status: 'active' },
    select: TENANT_CONTEXT_SELECT,
  });

  const redis = new RedisService();
  const tenantPrisma = new TenantPrismaService('worker');
  const clock = new TenantClockService();
  const audit = new TenantAuditService(tenantPrisma);
  const snapshots = new PolicySnapshotService(redis, tenantPrisma);
  const status = new ItemStatusService(tenantPrisma, clock);
  const arrivals = new HoldArrivalService();
  const transfers = new ItemTransfersService(
    tenantPrisma,
    audit,
    clock,
    status,
    snapshots,
    arrivals,
  );
  const shelf = new HoldShelfService(
    tenantPrisma,
    audit,
    clock,
    snapshots,
    status,
    transfers,
    arrivals,
  );

  let shelfExpired = 0;
  let promoted = 0;
  let requestsExpired = 0;
  let failed = 0;

  try {
    for (const t of tenants) {
      // Constructed INSIDE the per-tenant try, like every other fleet sweep:
      // `tenantContextFrom` throws for a tenant with no sealed credential, and a
      // throw out here would end the sweep for EVERY library at the first
      // un-backfilled one.
      try {
        const ctx: TenantContext = tenantContextFrom(t);
        const shelfRun = await shelf.expireShelf(ctx, SYSTEM);
        shelfExpired += shelfRun.expired;
        promoted += shelfRun.promoted;
        requestsExpired += (await shelf.expireRequests(ctx, SYSTEM)).expired;
      } catch (err) {
        failed++;
        logger.warn(`hold expiry failed for tenant=${t.slug}: ${describeError(err)}`);
      }
    }
  } finally {
    await snapshots.onModuleDestroy().catch(() => undefined);
    await tenantPrisma.onModuleDestroy().catch(() => undefined);
    await redis.onModuleDestroy().catch(() => undefined);
  }

  return {
    message:
      `${shelfExpired} hold(s) expired off the shelf (${promoted} copy(ies) went straight to the ` +
      `next reader), ${requestsExpired} unfilled request(s) expired, across ${tenants.length} ` +
      'tenant(s)',
    counts: {
      [HOLD_EXPIRY_COUNTS.shelfExpired]: shelfExpired,
      [HOLD_EXPIRY_COUNTS.promoted]: promoted,
      [HOLD_EXPIRY_COUNTS.requestsExpired]: requestsExpired,
      tenantsScanned: tenants.length,
      tenantsFailed: failed,
    },
  };
}
