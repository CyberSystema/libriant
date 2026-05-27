import { SetMetadata } from '@nestjs/common';
import type { FeatureKey } from '@libriant/shared';

/** Metadata keys read by PlanGuard / QuotaInterceptor. */
export const REQUIRES_FEATURE_KEY = 'libriant:requires_feature';
export const REQUIRES_QUOTA_KEY = 'libriant:requires_quota';

/**
 * Gate a route on a boolean feature being enabled for the current tenant.
 * Use on toggles like `reservations_enabled`, `bulk_import_enabled`, etc.
 *
 * If the feature resolves to false (override < plan < default), the
 * PlanGuard returns 402 with a structured payload the UI can use to
 * render a clear "upgrade your plan" message.
 */
export const RequiresFeature = (feature: FeatureKey) => SetMetadata(REQUIRES_FEATURE_KEY, feature);

/**
 * Gate a create-style route on a numeric quota — the current usage of
 * `feature` (per `QUOTA_COUNTERS`) must be strictly less than the
 * effective limit. Used for `max_books`, `max_members`, etc.
 *
 * Runs BEFORE the handler. If the limit is met or exceeded, the
 * QuotaInterceptor returns 402 with `{ feature, limit, used }`.
 */
export const RequiresQuota = (feature: FeatureKey) => SetMetadata(REQUIRES_QUOTA_KEY, feature);
