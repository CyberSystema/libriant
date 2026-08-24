import { controlDb } from '@libriant/db-control';
import { Logger } from '@nestjs/common';
import { createStorageDriver } from '../storage/drivers/create-driver.js';
import { describeError } from './job-error.js';
import type { JobResult } from './jobs.types.js';

/**
 * Orphaned-upload cleanup sweep.
 *
 * `LocalDriver.put()` writes each upload to a `<target>.tmp-<hex>` file then
 * atomic-renames it into place; a crash between write and rename leaves the
 * `.tmp-*` behind. A prior fix already excludes those partials from the
 * recompute byte count (so they don't erode the tenant's quota), but nothing
 * deleted them — they accumulate on disk forever. This walks every active
 * tenant's storage tree and removes temps older than `maxAgeMs` (default 30
 * min). The age gate keeps in-flight uploads (fresh mtime) safe.
 *
 * Per-tenant, like the other sweeps: one tenant's bad storage URL or I/O error
 * is logged and skipped, never aborting the rest. Object-store backends (S3)
 * upload atomically and have no temps, so their driver's `sweepStaleTemps` is a
 * no-op — the loop stays uniform with no backend branching here.
 */
const DEFAULT_MAX_AGE_MS = 30 * 60_000;
const logger = new Logger('StorageTempCleanup');

export async function sweepStaleStorageTemps(maxAgeMs = DEFAULT_MAX_AGE_MS): Promise<JobResult> {
  const tenants = await controlDb.tenant.findMany({
    where: { status: 'active' },
    select: { id: true, slug: true, storageUrl: true },
  });

  let removed = 0;
  let failed = 0;
  for (const t of tenants) {
    try {
      const driver = createStorageDriver(t.storageUrl);
      removed += await driver.sweepStaleTemps(maxAgeMs);
    } catch (err) {
      failed++;
      logger.warn(`temp sweep failed for tenant=${t.slug}: ${describeError(err)}`);
    }
  }

  return {
    message:
      removed === 0
        ? `${tenants.length} tenant(s) scanned; no stale upload temps to remove`
        : `removed ${removed} stale upload temp(s) across ${tenants.length} tenant(s)`,
    counts: { removed, tenantsScanned: tenants.length, tenantsFailed: failed },
  };
}
