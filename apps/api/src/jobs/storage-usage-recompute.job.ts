import { controlDb } from '@libriant/db-control';
import { Logger } from '@nestjs/common';
import { StorageService } from '../storage/storage.service.js';
import { EffectivePlanService } from '../plans/effective-plan.service.js';
import { PlatformSettingsService } from '../platform-settings/platform-settings.service.js';
import { RedisService } from '../platform/redis.service.js';
import { TENANT_CONTEXT_SELECT, tenantContextFrom } from '../tenancy/tenant-db-url.js';
import type { TenantContext } from '../tenancy/tenant-context.js';
import { describeError } from './job-error.js';
import type { JobContext, JobResult } from './jobs.types.js';

/**
 * The nightly `storageUsedBytes` recompute (data-integrity-12).
 *
 * `StorageService` keeps a cached byte counter on `tenants.storageUsedBytes` so
 * a quota check is one column read instead of a walk of the tenant's whole
 * storage tree. Three separate comments in that file justify best-effort error
 * handling by deferring to a nightly recompute — line 30 "run nightly in prod",
 * line 181 "the nightly recompute (and `recomputeUsage` below) is the
 * backstop", line 268 "let the nightly recompute be the repair" — and no such
 * job existed. `recomputeUsage` had exactly one caller in the tree, the storage
 * demo controller.
 *
 * WHY THAT MATTERS TO A LIBRARY. The drift is one-directional. The reservation
 * (`put`, the conditional UPDATE) is a hard `$executeRaw` whose failure
 * propagates, so the counter can never end up LOW. Every decrement is
 * best-effort: `releaseReservedBytes` swallows its error into a `.catch` that
 * logs and carries on, and so does the over-reservation reconcile. So the
 * counter only ever sticks HIGH — a cover upload that failed mid-write, a
 * delete whose control-plane UPDATE lost its connection, a file removed from
 * the volume by hand — and each one permanently subtracts from what the library
 * can still store. The end state is a 402 that quotes a usage figure nothing on
 * disk supports, with no operator command to correct it.
 *
 * WHAT IT DOES. Walks active tenants, calls `StorageService.recomputeUsage`
 * (the method those comments name — deliberately not a second copy of the same
 * arithmetic, so the truth stays defined in exactly one place), and reports how
 * many counters it had to move.
 *
 * 24 h, not hourly: `recomputeUsage` walks every file in a tenant's tree, so
 * this is the heaviest sweep in the registry, and the drift it repairs is
 * measured in "since somebody's disk hiccuped", not minutes.
 *
 * SAFE TO RE-RUN. It overwrites a derived value with what is actually on the
 * volume; a second run in a row writes the same number.
 */
const logger = new Logger('StorageUsageRecompute');

export async function recomputeStorageUsage(ctx?: JobContext): Promise<JobResult> {
  const tenants = await controlDb.tenant.findMany({
    where: { status: 'active' },
    select: { ...TENANT_CONTEXT_SELECT, storageUsedBytes: true },
  });

  // Same rule as every other sweep: never mint a Redis client and use it in the
  // same breath. The client is built with `enableOfflineQueue: false`, so the
  // first command on a still-connecting socket rejects and the whole tick falls
  // into the catch (reliability-01 / -16). Prefer the runner's warm client.
  //
  // Nothing on the recompute path reads a plan — `recomputeUsage` only touches
  // the driver and the control row — but StorageService is constructed with an
  // EffectivePlanService, and building a half-real one here is how the next
  // person to add a plan read to that path gets a null-pointer at 03:00.
  const redis = ctx?.redis ?? new RedisService();
  const ownedRedis = ctx?.redis ? null : redis;

  let corrected = 0;
  let tenantsFailed = 0;
  let bytesReclaimed = 0n;
  try {
    await redis.ready();
    const storage = new StorageService(
      new EffectivePlanService(redis, new PlatformSettingsService(redis)),
    );
    for (const t of tenants) {
      const { storageUsedBytes: before, ...rest } = t;
      // Constructed INSIDE the per-tenant try. `tenantContextFrom` throws for a
      // tenant with no sealed database credential (tenant-isolation-02), and a
      // throw out here would end the sweep for EVERY library at the first
      // un-backfilled one — turning a single tenant's missing row into a
      // fleet-wide outage of the nightly job. The counter below is what that
      // case is for.
      try {
        const tenantCtx: TenantContext = tenantContextFrom(rest);
        const after = await storage.recomputeUsage(tenantCtx);
        if (after === before) continue;
        corrected++;
        if (before > after) bytesReclaimed += before - after;
        logger.log(
          `tenant=${t.slug}: storageUsedBytes ${before} → ${after} ` +
            `(${before > after ? 'reclaimed' : 'reconciled up'} ${abs(after - before)} bytes)`,
        );
      } catch (err) {
        // A `…Failed` counter so a tenant whose volume is unreachable makes the
        // run NOT ok on /healthz and on libriant_worker_job_last_ok, instead of
        // the sweep reporting a clean "0 corrected" forever.
        tenantsFailed++;
        logger.warn(`storage recompute failed for tenant=${t.slug}: ${describeError(err)}`);
      }
    }
  } finally {
    await ownedRedis?.onModuleDestroy().catch(() => undefined);
  }

  return {
    message:
      corrected === 0
        ? `${tenants.length} tenant(s) scanned; every storage counter already matched the volume`
        : `corrected ${corrected} storage counter(s) across ${tenants.length} tenant(s); ` +
          `${bytesReclaimed} byte(s) of phantom usage handed back`,
    counts: {
      tenantsScanned: tenants.length,
      corrected,
      // Clamped into a JS number for the metric: a gauge is what this is for,
      // and a library's phantom usage is never near 2^53 bytes.
      bytesReclaimed: Number(bytesReclaimed),
      tenantsFailed,
    },
  };
}

function abs(n: bigint): bigint {
  return n < 0n ? -n : n;
}
