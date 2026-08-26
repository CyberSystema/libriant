import { controlDb } from '@libriant/db-control';
import { Logger } from '@nestjs/common';
import { createStorageDriver } from '../storage/drivers/create-driver.js';
import { describeError } from './job-error.js';
import type { JobResult } from './jobs.types.js';

/**
 * Orphaned-upload cleanup sweep.
 *
 * `LocalDriver.put()` stages each upload in the tenant's `_tmp/` directory then
 * atomic-renames it into place; a crash between write and rename leaves the
 * `.tmp-*` behind. A prior fix already excludes those partials from the
 * recompute byte count (so they don't erode the tenant's quota), but nothing
 * deleted them — they accumulate on disk forever. This asks every active
 * tenant's driver to drop temps older than `maxAgeMs` (default 30 min). The age
 * gate keeps in-flight uploads (fresh mtime) safe.
 *
 * performance-16: each tenant costs ONE directory read, of a directory that is
 * empty except after a crash. It used to recurse the tenant's whole tree —
 * hourly, per tenant, allocating a Dirent for every file the library owns, to
 * find nothing. Measured on a 120,000-file tenant: 83.3 ms per tenant per
 * tick, against 0.45 ms cold / 0.22 ms warm now.
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
