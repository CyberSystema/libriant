import { controlDb } from '@libriant/db-control';
import type { TenantPrismaClient, TenantPrismaClientV2 } from '@libriant/db-tenant';
import type { FeatureKey } from '@libriant/shared';
import type { TenantContext } from '../tenancy/tenant-context.js';

/**
 * Inputs available to every quota counter. We pass clients explicitly
 * (not as services) so counters stay pure functions — they're easy to
 * test, and adding a new counter is just one entry below.
 */
export type QuotaCounterCtx = {
  /**
   * Narrower than the full `TenantContext` on purpose: the counters read only
   * the id and the database address, and the fleet-wide pre-flight
   * (`AdminPlanUsageController`) has to count for a tenant that is not on the
   * current request and so has no resolved context at all. A request handler
   * still passes its whole `req.tenant`.
   */
  tenant: Pick<TenantContext, 'id' | 'dbUrl' | 'schemaMajor'>;
  tenantClient: TenantPrismaClient;
  /**
   * The 2.0 client, for the counters whose resource moved (2.0 phase 20g).
   *
   * `max_books` and `max_members` counted `books` and `members` — tables the
   * cutover archives — while the write surface that creates their 2.0
   * equivalents enforced no ceiling at all. So the count and the enforcement
   * were BOTH pointed at the wrong datamodel, in opposite directions: usage
   * read a table nobody was writing, and the writers had no limit.
   */
  tenantClientV2: TenantPrismaClientV2;
  controlDb: typeof controlDb;
};

export type QuotaCounter = (ctx: QuotaCounterCtx) => Promise<number>;

/**
 * Feature key → "how many of this resource does the tenant currently have".
 *
 * Counters operate on the tenant DB unless the resource lives on the
 * control plane (staff_seats, storage_used_bytes). To add a new quota:
 *   1. add the feature key to `@libriant/shared/features.ts`
 *   2. seed it via the control-plane seed
 *   3. add a row here
 *   4. mark the relevant endpoint with `@RequiresQuota('your_key')`
 */
export const QUOTA_COUNTERS: Partial<Record<FeatureKey, QuotaCounter>> = {
  // BIBLIOGRAPHIC RECORDS ONLY — `marc_records` also holds authority, holdings
  // and classification records, and counting those would bill a library for its
  // own headings. Matches the predicate `BibWriteService.create` enforces, which
  // is the property that makes usage and the ceiling agree.
  max_books: async ({ tenantClientV2 }) =>
    tenantClientV2.marcRecord.count({ where: { kind: 'bibliographic', deletedAt: null } }),

  // `closed` is 2.0's word for the reader who left; `PatronStatus` has no
  // `archived` value because archiving is `archived_at`. An erased reader is a
  // row the library is required to keep and is not billed for.
  max_members: async ({ tenantClientV2 }) =>
    tenantClientV2.patron.count({
      where: { archivedAt: null, erasedAt: null, status: { not: 'closed' } },
    }),

  max_custom_collections: async ({ tenantClient }) =>
    tenantClient.collection.count({ where: { archivedAt: null } }),

  staff_seats: async ({ tenant }) =>
    controlDb.user.count({ where: { tenantId: tenant.id, status: 'active' } }),

  // Read the cached counter on `tenants.storageUsedBytes` (the StorageService
  // maintains it on every put/delete; `recomputeUsage` reconciles drift).
  // We round UP to the nearest MB so a 1.2 MB tenant reports `2 MB` — matches
  // how `max_storage_mb` limits are stated.
  max_storage_mb: async ({ tenant }) => {
    const row = await controlDb.tenant.findUnique({
      where: { id: tenant.id },
      select: { storageUsedBytes: true },
    });
    const bytes = row?.storageUsedBytes ?? 0n;
    return Number((bytes + 1024n * 1024n - 1n) / (1024n * 1024n));
  },
};

/**
 * What's the current usage? Returns `null` when no counter is registered
 * for this feature key (typically because the feature is a non-quota
 * gate like `reservations_enabled`).
 */
export async function countUsage(
  key: FeatureKey | string,
  ctx: QuotaCounterCtx,
): Promise<number | null> {
  const counter = QUOTA_COUNTERS[key as FeatureKey];
  if (!counter) return null;
  return counter(ctx);
}

export const KNOWN_QUOTA_KEYS = Object.keys(QUOTA_COUNTERS) as FeatureKey[];
