import { controlDb } from '@libriant/db-control';
import type { TenantPrismaClient } from '@libriant/db-tenant';
import type { FeatureKey } from '@libriant/shared';
import type { TenantContext } from '../tenancy/tenant-context.js';

/**
 * Inputs available to every quota counter. We pass clients explicitly
 * (not as services) so counters stay pure functions — they're easy to
 * test, and adding a new counter is just one entry below.
 */
export type QuotaCounterCtx = {
  tenant: TenantContext;
  tenantClient: TenantPrismaClient;
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
  max_books: async ({ tenantClient }) => tenantClient.book.count({ where: { archivedAt: null } }),

  max_members: async ({ tenantClient }) =>
    tenantClient.member.count({
      where: { archivedAt: null, status: { not: 'archived' } },
    }),

  max_custom_collections: async ({ tenantClient }) =>
    tenantClient.collection.count({ where: { archivedAt: null } }),

  staff_seats: async ({ tenant }) =>
    controlDb.user.count({ where: { tenantId: tenant.id, status: 'active' } }),

  // max_storage_mb lives in the storage layer (Step 10). Currently null
  // → reported as "—" in the usage UI; the interceptor refuses to gate
  // a feature with no counter (it would always pass otherwise, which is
  // surprising).
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
