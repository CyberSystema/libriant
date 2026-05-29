import { HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import type { TenantPrismaClient } from '@libriant/db-tenant';
import type { FeatureKey } from '@libriant/shared';
import { EffectivePlanService } from '../plans/effective-plan.service.js';

/**
 * Just enough of a tenant Prisma (transaction) client to take an advisory
 * lock. Accepting this narrow shape lets `enforceWithinTx` be called with
 * either the full client or a `$transaction` callback's `tx`.
 */
type LockableTx = Pick<TenantPrismaClient, '$executeRaw'>;

/**
 * Integer-quota enforcement for resources that live in the tenant DB
 * (`max_books`, `max_members`, `max_custom_collections`, and the
 * context-aware `max_custom_fields_per_entity` / `max_records_per_collection`).
 *
 * Concurrency: a naive "count, check, then insert" is a TOCTOU race — N
 * parallel creates all read the same sub-limit count and all insert, landing
 * the tenant past its plan ceiling. `enforceWithinTx` closes that window by
 * running the count + the caller's insert inside ONE tenant-DB transaction,
 * serialized by a transaction-scoped Postgres advisory lock keyed on
 * `(tenant, feature, context)`. The lock auto-releases at commit/rollback and
 * only blocks other creates competing for the *same* quota — creates of a
 * different resource, tenant, or collection never wait on each other.
 *
 * Limits still resolve through `EffectivePlanService` (control DB / Redis
 * cache) so per-tenant overrides and plan changes flow through unchanged.
 */
@Injectable()
export class QuotaService {
  constructor(@Inject(EffectivePlanService) private readonly effective: EffectivePlanService) {}

  /**
   * Race-safe enforcement. Call from inside a tenant `$transaction` whose
   * callback also performs the insert:
   *
   *   await client.$transaction(async (tx) => {
   *     await quota.enforceWithinTx(tx, {
   *       tenantId, featureKey: 'max_books',
   *       count: () => tx.book.count({ where: { archivedAt: null } }),
   *     });
   *     return tx.book.create({ data });
   *   });
   *
   * The advisory lock is taken first, so the `count` and the subsequent
   * insert observe a serialized view per quota key.
   */
  async enforceWithinTx(
    tx: LockableTx,
    input: {
      tenantId: string;
      featureKey: FeatureKey;
      /** Disambiguates per-context quotas (e.g. one collection's records). */
      lockContext?: string;
      /** Free-form tag echoed back to the UI on a 402. */
      context?: Record<string, unknown>;
      /** Counts current usage INSIDE `tx`. */
      count: () => Promise<number>;
    },
  ): Promise<void> {
    const lockKey = `quota:${input.tenantId}:${input.featureKey}:${input.lockContext ?? ''}`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;
    const used = await input.count();
    await this.assertWithinLimit(input.tenantId, input.featureKey, used, input.context);
  }

  /**
   * Throw a 402 (with feature/limit/used/context for the UI) when usage is
   * at or past the effective limit. `context` disambiguates which slice of a
   * context-aware quota tripped (e.g. `entity_kind=book`, `collection_slug=dvds`).
   */
  private async assertWithinLimit(
    tenantId: string,
    featureKey: FeatureKey,
    usedCount: number,
    context?: Record<string, unknown>,
  ): Promise<void> {
    const limit = await this.effective.getInt(tenantId, featureKey);
    if (usedCount >= limit) {
      const plan = await this.effective.getEffectivePlan(tenantId);
      throw new HttpException(
        {
          statusCode: HttpStatus.PAYMENT_REQUIRED,
          error: 'Payment Required',
          message: "You've reached your library's limit for this plan.",
          feature: featureKey,
          limit,
          used: usedCount,
          currentPlan: plan.plan?.slug ?? null,
          context: context ?? null,
        },
        HttpStatus.PAYMENT_REQUIRED,
      );
    }
  }
}
