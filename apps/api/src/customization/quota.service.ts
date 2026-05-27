import { HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import type { FeatureKey } from '@libriant/shared';
import { EffectivePlanService } from '../plans/effective-plan.service.js';

/**
 * Quota gates that the route-level `QuotaInterceptor` can't easily handle.
 *
 * The interceptor is great for "total resource count vs. effective limit"
 * — `max_books`, `max_members`, `max_custom_collections`. But some of our
 * limits are CONTEXT-aware:
 *
 *   - `max_custom_fields_per_entity` is per `entity_kind`
 *   - `max_records_per_collection` is per `collection_id`
 *
 * Services count the right thing themselves and call `enforce()`. We
 * still go through the same `EffectivePlanService` so overrides and plan
 * upgrades flow through without code changes.
 */
@Injectable()
export class QuotaService {
  constructor(@Inject(EffectivePlanService) private readonly effective: EffectivePlanService) {}

  /**
   * Reject the action if `usedCount` is already at or past the effective
   * limit for `featureKey`. `context` is a free-form tag the UI uses to
   * disambiguate which slice of the quota tripped (e.g. `entity_kind=book`
   * or `collection_slug=dvds`).
   */
  async enforce(input: {
    tenantId: string;
    featureKey: FeatureKey;
    usedCount: number;
    context?: Record<string, unknown>;
  }): Promise<void> {
    const limit = await this.effective.getInt(input.tenantId, input.featureKey);
    if (input.usedCount >= limit) {
      const plan = await this.effective.getEffectivePlan(input.tenantId);
      throw new HttpException(
        {
          statusCode: HttpStatus.PAYMENT_REQUIRED,
          error: 'Payment Required',
          message: "You've reached your library's limit for this plan.",
          feature: input.featureKey,
          limit,
          used: input.usedCount,
          currentPlan: plan.plan?.slug ?? null,
          context: input.context ?? null,
        },
        HttpStatus.PAYMENT_REQUIRED,
      );
    }
  }
}
