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
import { LocalDriver } from './drivers/local-driver.js';
import { S3Driver } from './drivers/s3-driver.js';
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
    const currentBytes = await this.currentUsedBytes(tenant.id);
    const newSize = BigInt(input.data.byteLength);
    if (currentBytes + newSize > limitBytes) {
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

    // 3. Write through the driver.
    const driver = this.driverFor(tenant);
    const stored = await driver.put(input);

    // 4. Bookkeeping — bump the counter. Best-effort: if this fails the
    //    file is on disk but the counter is stale; the nightly recompute
    //    job (and `recomputeUsage` below) reconciles.
    await controlDb.tenant
      .update({
        where: { id: tenant.id },
        data: { storageUsedBytes: { increment: stored.sizeBytes } },
      })
      .catch((err: unknown) =>
        this.logger.warn(
          `Failed to bump storageUsedBytes for ${tenant.id}: ${err instanceof Error ? err.message : err}`,
        ),
      );

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
      await controlDb.tenant
        .update({
          where: { id: tenant.id },
          data: { storageUsedBytes: { decrement: size } },
        })
        .catch((err: unknown) =>
          this.logger.warn(
            `Failed to decrement storageUsedBytes for ${tenant.id}: ${err instanceof Error ? err.message : err}`,
          ),
        );
    }
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
    if (storageUrl.startsWith('file://')) return new LocalDriver(storageUrl);
    if (storageUrl.startsWith('s3://')) return new S3Driver(storageUrl);
    throw new Error(`Unsupported storage URL scheme: "${storageUrl}"`);
  }
}
