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
import { EffectivePlanService, isUnlimitedInt } from '../plans/effective-plan.service.js';
import type { TenantContext } from '../tenancy/tenant-context.js';
import { ALLOWED_TYPES, rejectedMessage } from './allowed-types.js';
import { assertBytesMatchContentType } from './content-sniff.js';
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
    // input-and-files-09: and the bytes have to back the claim up. The check
    // above tests a string the client chose, so an HTML page sent as image/png
    // used to be stored as a book cover. Every upload path — covers, member
    // photos, branding logos, the storage endpoint — funnels through this
    // method, so this is the one place it has to be for all of them.
    assertBytesMatchContentType(input.contentType, input.data);

    // 2. Effective quota — `max_storage_mb` from the plan/override layer.
    //    `0` is a legitimate "no storage allowed" value; treat it as deny.
    const limitMb = await this.effective.getInt(tenant.id, 'max_storage_mb');
    const newSize = BigInt(input.data.byteLength);
    // data-integrity-01: with subscriptions off — the configuration we launch
    // in — every int limit resolves to the UNLIMITED_INT sentinel, and the byte
    // ceiling it scales up to (9444732965739289378816) is ~1024× the int8
    // maximum. Prisma binds it into the reservation below as an int8, so
    // Postgres refused the statement with SQLSTATE 22003 and every single
    // upload — covers, member photos, logos, MARC — came back as an opaque 500.
    const unlimited = isUnlimitedInt(limitMb);
    // "Unlimited" is a business statement, not a physical one: the counter is
    // still an int8. The first fix dropped the predicate entirely on this path,
    // which moved the same SQLSTATE 22003 from the comparison into the addition
    // — reproduced against real Postgres by setting the counter to
    // 9223372036854775807 and running the unconditional UPDATE. So there is
    // ALWAYS a ceiling; on the unlimited path it is simply what the column can
    // hold. ~8 EiB is not a quota anyone can reach by uploading covers, so this
    // never refuses a legitimate upload — reaching it means the counter is
    // corrupt, which is handled distinctly below.
    const ceilingBytes = unlimited ? INT8_MAX : quotaCeilingBytes(limitMb);

    // STG-03: reserve the quota atomically *before* writing to disk. A plain
    // read-then-write (SELECT used + IF check + INCREMENT) is a TOCTOU race —
    // N concurrent uploads all read the same `used` and each individually pass
    // the check, letting a tenant blow past `max_storage_mb` by (N × bytes).
    // The conditional UPDATE below admits a request only if it still fits under
    // the limit at the moment the row is locked, so the counter can never be
    // reserved beyond the ceiling. 0 rows updated ⇒ the upload doesn't fit.
    //
    // The predicate is written SUBTRACTIVELY (`used <= ceiling - newSize`) and
    // not as `used + newSize <= ceiling`, because the addition is itself an int8
    // expression: with `used` near the maximum, Postgres raises 22003 evaluating
    // the guard that exists to prevent the overflow. `ceiling - newSize` cannot
    // overflow (both operands are in range and newSize >= 0); it merely goes
    // negative when the upload alone exceeds the ceiling, which correctly
    // matches no rows. The SET expression is only evaluated for rows that
    // already passed the qualification, so `used + newSize` there is bounded by
    // the ceiling and safe.
    // Both operands of the subtraction are BOUND PARAMETERS, so they carry no
    // type into the planner and Postgres refuses the statement outright with
    // 42725 `operator is not unique: unknown - unknown` — every upload a 500,
    // which is the very symptom this whole block exists to remove. The
    // addition above is fine without a cast only because the column on its
    // left supplies the type. Casting explicitly is also the honest thing to
    // write: these are int8 values and the arithmetic below depends on them
    // being evaluated as int8.
    const reserved = await controlDb.$executeRaw`
      UPDATE tenants
      SET "storageUsedBytes" = "storageUsedBytes" + ${newSize}::bigint
      WHERE id = ${tenant.id}
        AND "storageUsedBytes" <= ${ceilingBytes}::bigint - ${newSize}::bigint
    `;
    if (reserved === 0) {
      // Three different situations produce zero rows; telling them apart is the
      // whole job of this branch. Getting it wrong once already shipped a 402
      // "you've reached your storage limit" to librarians whose tenant row had
      // been deleted out from under a still-cached resolver entry.
      const currentBytes = await this.currentUsedBytes(tenant.id);
      if (currentBytes === null) {
        // 1. The tenant row is gone (a stale resolver cache still points at it).
        //    Not a quota problem, in either posture — say so.
        throw new NotFoundException('Library not found.');
      }
      if (unlimited) {
        // 2. No business quota, so the only predicate left is the int8 ceiling:
        //    the counter is at ~8 EiB. No library has that many bytes, so this
        //    means `storageUsedBytes` is corrupt (a runaway reconcile, a bad
        //    manual UPDATE) and `recomputeUsage()` is the repair. Fail CLOSED
        //    rather than reserving anyway: an upload admitted here would have to
        //    skip the counter, and a counter nobody maintains is how the quota
        //    stops being enforced for everyone once billing is switched on.
        //    507 (not 402) because there is no plan to upgrade to, and it is a
        //    server-side data fault: the exception filter turns it into a
        //    support code, which is the right thing to hand a librarian.
        this.logger.error(
          `storageUsedBytes for tenant ${tenant.id} is ${currentBytes} — within ${newSize} ` +
            `bytes of the int8 maximum. The counter is corrupt; run recomputeUsage().`,
        );
        throw new HttpException(
          {
            statusCode: HttpStatus.INSUFFICIENT_STORAGE,
            error: 'InsufficientStorage',
            message: "Your library's storage accounting needs repair before new uploads.",
          },
          HttpStatus.INSUFFICIENT_STORAGE,
        );
      }
      // 3. A real, finite plan quota refused the upload.
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
        // Saturating add, for the same reason the reservation is subtractive:
        // a plain `{ increment }` is `used + delta` in int8 and raises 22003 at
        // the top of the range. This path is best-effort (the failure is only
        // logged), but a throw here would still surface as a 500 on an upload
        // that has already succeeded on disk — so clamp instead, and let the
        // nightly recompute be the repair.
        await controlDb.$executeRaw`
            UPDATE tenants
            SET "storageUsedBytes" = CASE
              WHEN "storageUsedBytes" <= ${INT8_MAX} - ${delta}
              THEN "storageUsedBytes" + ${delta}
              ELSE ${INT8_MAX}
            END
            WHERE id = ${tenant.id}
          `.catch((err: unknown) =>
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

  /**
   * The tenant's counter, or `null` when the tenant row does not exist.
   *
   * The null is load-bearing: `?? 0n` here would collapse "no such library"
   * into "using 0 bytes", which is exactly how the zero-rows-updated branch in
   * `put` used to answer a deleted tenant with a 402 about a storage quota.
   */
  private async currentUsedBytes(tenantId: string): Promise<bigint | null> {
    const row = await controlDb.tenant.findUnique({
      where: { id: tenantId },
      select: { storageUsedBytes: true },
    });
    return row?.storageUsedBytes ?? null;
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

/** `tenants."storageUsedBytes"` is a BIGINT; nothing compared against it may exceed this. */
const INT8_MAX = 9223372036854775807n;

/**
 * MB → the byte ceiling bound into the reservation predicate, clamped to what
 * the column can actually hold.
 *
 * Second line of defence behind the `unlimited` branch (data-integrity-01): any
 * limit above ~8 EiB binds an out-of-range int8 and fails the whole upload with
 * SQLSTATE 22003 instead of simply never being reached. Today only the
 * unlimited sentinel gets that big (the plan and override columns are int4),
 * but a quota that size is "no realistic ceiling" either way — clamping keeps a
 * future wider column, or a new sentinel, from resurrecting a
 * 500-on-every-upload bug. Note that clamping the CEILING is not on its own
 * enough: see the subtractive predicate in `put`, because the addition inside
 * the guard overflows before the comparison is ever made.
 */
function quotaCeilingBytes(limitMb: number): bigint {
  const bytes = BigInt(Math.max(0, Math.trunc(limitMb))) * 1024n * 1024n;
  return bytes > INT8_MAX ? INT8_MAX : bytes;
}
