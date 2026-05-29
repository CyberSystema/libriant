/**
 * Pure aggregation for the fleet overview — kept side‑effect‑free so it can
 * be unit‑tested without a DB. `FleetService` gathers the rows + platform
 * stats; this turns the per‑tenant rows into the census totals an operator
 * reads to judge capacity.
 */

export type FleetTenantRow = {
  id: string;
  slug: string;
  name: string;
  /** TenantStatus: 'active' | 'suspended' | 'archived'. */
  status: string;
  cellSlug: string;
  /** Plan slug, or null if the tenant has no subscription row. */
  planSlug: string | null;
  /** Tracked storage usage in bytes (from `tenants.storageUsedBytes`). */
  storageBytes: number;
  /** Live `pg_database_size` of this tenant's DB in bytes (0 if not found). */
  dbBytes: number;
  createdAt: Date;
};

export type FleetCensus = {
  total: number;
  byStatus: Record<string, number>;
  byPlan: Record<string, number>;
  byCell: Record<string, number>;
  totalStorageBytes: number;
  totalDbBytes: number;
  oldestCreatedAt: string | null;
  newestCreatedAt: string | null;
};

export function summarizeTenants(rows: FleetTenantRow[]): FleetCensus {
  const byStatus: Record<string, number> = {};
  const byPlan: Record<string, number> = {};
  const byCell: Record<string, number> = {};
  let totalStorageBytes = 0;
  let totalDbBytes = 0;
  let oldest: number | null = null;
  let newest: number | null = null;

  for (const r of rows) {
    byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
    const plan = r.planSlug ?? 'none';
    byPlan[plan] = (byPlan[plan] ?? 0) + 1;
    byCell[r.cellSlug] = (byCell[r.cellSlug] ?? 0) + 1;
    totalStorageBytes += r.storageBytes;
    totalDbBytes += r.dbBytes;
    const t = r.createdAt.getTime();
    if (oldest === null || t < oldest) oldest = t;
    if (newest === null || t > newest) newest = t;
  }

  return {
    total: rows.length,
    byStatus,
    byPlan,
    byCell,
    totalStorageBytes,
    totalDbBytes,
    oldestCreatedAt: oldest === null ? null : new Date(oldest).toISOString(),
    newestCreatedAt: newest === null ? null : new Date(newest).toISOString(),
  };
}

/** Human-friendly byte size, e.g. 1536 → "1.5 KB". Used by the CLI + UI. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** i;
  const text =
    value >= 100 || i === 0 ? String(Math.round(value)) : value.toFixed(1).replace(/\.0$/, '');
  return `${text} ${units[i]}`;
}
