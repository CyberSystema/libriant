import { controlDb } from '@libriant/db-control';
import type { TenantPrismaClient } from '@libriant/db-tenant';
import type { FeatureKey } from '@libriant/shared';
import type { TenantContext } from '../tenancy/tenant-context.js';
import { isUnlimitedInt } from './effective-plan.service.js';
import type { EffectivePlan, EffectiveSource } from './effective-plan.types.js';
import { countUsage, KNOWN_QUOTA_KEYS } from './quota-counters.js';

/**
 * One quota line: what the plan allows, and how much of it is spent.
 *
 * `unlimited` exists so no reader has to compare `limit` against
 * `Number.MAX_SAFE_INTEGER` itself. That sentinel is a magnitude, and doing
 * arithmetic on it is what made every upload 500 (data-integrity-01); a
 * browser doing `used / limit` for a progress bar would land in the same trap
 * with a bar that is permanently 0%.
 */
export type UsageRow = {
  feature: FeatureKey;
  limit: number;
  /** `null` when no counter is registered for this key — never "zero used". */
  used: number | null;
  unlimited: boolean;
  unit: string | null;
  source: EffectiveSource;
};

/**
 * Count every int feature that has a counter, against the limits in `plan`.
 *
 * Both the librarian's own usage screen and the operator's fleet pre-flight go
 * through here, deliberately: they must count the way the 402 counts. The
 * refusal is `QuotaInterceptor` reading `QUOTA_COUNTERS[feature]`, so a
 * pre-flight that reimplemented the arithmetic in SQL would be answering a
 * different question from the one a librarian meets at the cap.
 *
 * Which `plan` is passed decides what the numbers MEAN. `getEffectivePlan`
 * returns the free-mode rewrite while subscriptions are off (every limit is the
 * unlimited sentinel); `getPlanAsContracted` returns the limits that bite the
 * moment the switch is flipped. The pre-flight wants the second one.
 */
export async function collectUsage(
  plan: EffectivePlan,
  ctx: { tenant: Pick<TenantContext, 'id' | 'dbUrl'>; tenantClient: TenantPrismaClient },
): Promise<UsageRow[]> {
  const rows: UsageRow[] = [];
  for (const key of KNOWN_QUOTA_KEYS) {
    const fv = plan.features[key];
    if (fv?.type !== 'int') continue;
    const used = await countUsage(key, { ...ctx, controlDb });
    rows.push({
      feature: key,
      limit: fv.value,
      used,
      unlimited: isUnlimitedInt(fv.value),
      unit: fv.unit ?? null,
      source: fv.source,
    });
  }
  return rows;
}

/** The lines a tenant is already at or past. Empty means "nothing would refuse". */
export function breaches(rows: UsageRow[]): UsageRow[] {
  // `>=`, not `>`: QuotaInterceptor refuses at `used >= limit`, so a library
  // sitting exactly on its cap is already unable to add the next book. An
  // operator told "nobody is over" about that library would be wrong on the
  // Monday morning this check exists to prevent.
  return rows.filter((r) => !r.unlimited && r.used !== null && r.used >= r.limit);
}
