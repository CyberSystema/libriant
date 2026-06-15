import {
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { controlDb } from '@libriant/db-control';
import { EffectivePlanService } from '../plans/effective-plan.service.js';
import type { TenantContext } from '../tenancy/tenant-context.js';
import { ALLOWED_TYPES, rejectedMessage } from './allowed-types.js';
import { createStorageDriver } from './drivers/create-driver.js';
import type { ResourceType, StorageDriver, StoredFile } from './drivers/storage-driver.js';

/**
 * Tenant-facing storage facade.
 *
 * Responsibilities:
 *   - Pick the right driver per tenant from `tenants.storage_url` scheme
 *     (`file://` → LocalDriver, `s3://` → S3Driver). Drivers are cached
 *     per tenantId so the same instance handles multiple reqs.
 *   - Reject disallowed MIME types per resource (cover, members, …).
 *   - Reject uploads that would exceed `max_storage_mb`. Checks
 *     `(currentBytes + newBytes)` so a single big upload can't slip past
 *     the limit.
 *   - Maintain `tenants.storageUsedBytes` (+= on put, -= on delete) so
 *     quota checks are O(1) instead of walking the FS.
 *   - Provide `recomputeUsage(tenantId)` to reconcile drift (run nightly
 *     in prod; here for ad-hoc fixes today).
 *
 * Storage refs are RELATIVE strings like `covers/<id>.jpg`. They never
 * include the tenant id or any path piece — the tenant is implicit in
 * which driver instance is invoked. Stored unchanged on entity rows
 * (e.g. `books.coverAssetRef`).
 */
@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);
  /** tenantId → cached driver instance, keyed alongside the storage URL. */
  private readonly driverCache = new Map<string, { url: string; driver: StorageDriver }>();

  constructor(@Inject(EffectivePlanService) private readonly effective: EffectivePlanService) {}

  /** Upload bytes for a tenant. Enforces MIME + plan quota. */
  async put(
    tenant: TenantContext,
    input: {
      resourceType: ResourceType;
      data: Buffer;
      contentType: string;
      originalName?: string;
    },
  ): Promise<StoredFile> {
    // 1. MIME whitelist per resource.
    if (!ALLOWED_TYPES[input.resourceType]?.includes(input.contentType.toLowerCase())) {
      throw new UnsupportedMediaTypeException(
        rejectedMessage(input.resourceType, input.contentType),
      );
    }

    // 2. Effective quota — `max_storage_mb` from the plan/override layer.
    //    `0` is a legitimate "no storage allowed" value; treat it as deny.
    const limitMb = await this.effective.getInt(tenant.id, 'max_storage_mb');
    const limitBytes = BigInt(limitMb) * 1024n * 1024n;
    const newSize = BigInt(input.data.byteLength);

    // STG-03: reserve the quota atomically *before* writing to disk. A plain
    // read-then-write (SELECT used + IF check + INCREMENT) is a TOCTOU race —
    // N concurrent uploads all read the same `used` and each individually pass
    // the check, letting a tenant blow past `max_storage_mb` by (N × bytes).
    // The conditional UPDATE below admits a request only if it still fits under
    // the limit at the moment the row is locked, so the counter can never be
    // reserved beyond `limitBytes`. 0 rows updated ⇒ the upload doesn't fit.
    const reserved = await controlDb.$executeRaw`
      UPDATE tenants
      SET "storageUsedBytes" = "storageUsedBytes" + ${newSize}
      WHERE id = ${tenant.id}
        AND "storageUsedBytes" + ${newSize} <= ${limitBytes}
    `;
    if (reserved === 0) {
      const currentBytes = await this.currentUsedBytes(tenant.id);
      throw new HttpException(
        {
          statusCode: HttpStatus.PAYMENT_REQUIRED,
          error: 'Payment Required',
          message: "You've reached your library's storage limit for this plan.",
          feature: 'max_storage_mb',
          limit: limitMb,
          usedMb: Number((currentBytes + 1024n * 1024n - 1n) / (1024n * 1024n)),
          attemptedAddBytes: input.data.byteLength,
        },
        HttpStatus.PAYMENT_REQUIRED,
      );
    }

    // 3. Write through the driver. The quota is already reserved, so if the
    //    disk write fails we must roll the reservation back (floored at 0 per
    //    STG-05) — otherwise an aborted upload permanently steals quota.
    const driver = this.driverFor(tenant);
    let stored: StoredFile;
    try {
      stored = await driver.put(input);
    } catch (err) {
      await this.releaseReservedBytes(tenant.id, newSize, 'put-rollback');
      throw err;
    }

    // 4. Reconcile the reservation to the *actual* bytes the driver wrote, if
    //    they differ from what we reserved. Normally identical; this keeps the
    //    counter honest without a second full recompute. Best-effort — the
    //    nightly recompute (and `recomputeUsage` below) is the backstop.
    const actual = BigInt(stored.sizeBytes);
    if (actual !== newSize) {
      const delta = actual - newSize;
      if (delta > 0n) {
        await controlDb.tenant
          .update({
            where: { id: tenant.id },
            data: { storageUsedBytes: { increment: delta } },
          })
          .catch((err: unknown) =>
            this.logger.warn(
              `Failed to reconcile storageUsedBytes for ${tenant.id}: ${err instanceof Error ? err.message : err}`,
            ),
          );
      } else {
        await this.releaseReservedBytes(tenant.id, -delta, 'put-reconcile');
      }
    }

    return stored;
  }

  /** Read a stored file's bytes. */
  async get(tenant: TenantContext, ref: string): Promise<Buffer> {
    const driver = this.driverFor(tenant);
    try {
      return await driver.get(ref);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'EPERM') {
        throw new NotFoundException(`File not found.`);
      }
      throw err;
    }
  }

  /** Stat — useful for the demo controller's listing and for tests. */
  async stat(tenant: TenantContext, ref: string) {
    const driver = this.driverFor(tenant);
    try {
      return await driver.stat(ref);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'EPERM') {
        throw new NotFoundException(`File not found.`);
      }
      throw err;
    }
  }

  /** Soft-equivalent: delete the file + decrement the counter. */
  async delete(tenant: TenantContext, ref: string): Promise<void> {
    const driver = this.driverFor(tenant);
    // Stat first so we know how many bytes we're freeing. Tolerate
    // missing files — the user already removed it some other way.
    let size = 0;
    try {
      const s = await driver.stat(ref);
      size = s.sizeBytes;
    } catch {
      /* ignore — fall through to delete which is idempotent */
    }
    await driver.delete(ref);
    if (size > 0) {
      // STG-05: floor the decrement at 0. A plain `{ decrement }` can drive the
      // counter negative under drift (double-delete, recompute lag), which then
      // silently inflates the effective quota. `GREATEST(0, …)` keeps it sane.
      await this.releaseReservedBytes(tenant.id, BigInt(size), 'delete');
    }
  }

  /**
   * Decrement `storageUsedBytes` by `bytes`, floored at 0. Used to free quota
   * on delete and to roll back a failed/over-reserved upload (STG-03/STG-05).
   * Best-effort: a failure leaves the counter high until the nightly recompute,
   * which is the conservative direction (never lets a tenant over-allocate).
   */
  private async releaseReservedBytes(
    tenantId: string,
    bytes: bigint,
    reason: string,
  ): Promise<void> {
    await controlDb.$executeRaw`
        UPDATE tenants
        SET "storageUsedBytes" = GREATEST(0, "storageUsedBytes" - ${bytes})
        WHERE id = ${tenantId}
      `.catch((err: unknown) =>
      this.logger.warn(
        `Failed to release storageUsedBytes (${reason}) for ${tenantId}: ${err instanceof Error ? err.message : err}`,
      ),
    );
  }

  /** Walk the driver and overwrite `storageUsedBytes` to the true value. */
  async recomputeUsage(tenant: TenantContext): Promise<bigint> {
    const driver = this.driverFor(tenant);
    const total = BigInt(await driver.totalBytes());
    await controlDb.tenant.update({
      where: { id: tenant.id },
      data: { storageUsedBytes: total },
    });
    return total;
  }

  // --- internals ---------------------------------------------------------

  private async currentUsedBytes(tenantId: string): Promise<bigint> {
    const row = await controlDb.tenant.findUnique({
      where: { id: tenantId },
      select: { storageUsedBytes: true },
    });
    return row?.storageUsedBytes ?? 0n;
  }

  /** Cache + return the right driver for this tenant's storage URL. */
  private driverFor(tenant: TenantContext): StorageDriver {
    const cached = this.driverCache.get(tenant.id);
    if (cached && cached.url === tenant.storageUrl) return cached.driver;
    const driver = this.makeDriver(tenant.storageUrl);
    this.driverCache.set(tenant.id, { url: tenant.storageUrl, driver });
    return driver;
  }

  private makeDriver(storageUrl: string): StorageDriver {
    return createStorageDriver(storageUrl);
  }
}
