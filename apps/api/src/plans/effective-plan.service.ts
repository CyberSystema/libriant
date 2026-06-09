import { Inject, Injectable, Logger } from '@nestjs/common';
import { controlDb } from '@libriant/db-control';
import type { FeatureKey } from '@libriant/shared';
import { RedisService } from '../platform/redis.service.js';
import { PlatformSettingsService } from '../platform-settings/platform-settings.service.js';
import { loadEnv } from '../config/env.js';
import type { EffectivePlan, EffectiveSource, EffectiveValue } from './effective-plan.types.js';

/**
 * Shape of one row returned by the resolver SQL — everything needed to
 * pick the effective value for a single feature.
 */
type Row = {
  feature_key: string;
  feature_type: 'int' | 'bool' | 'text';
  default_int: number | null;
  default_bool: boolean | null;
  default_text: string | null;
  unit: string | null;
  plan_int: number | null;
  plan_bool: boolean | null;
  plan_text: string | null;
  override_int: number | null;
  override_bool: boolean | null;
  override_text: string | null;
  override_note: string | null;
  plan_id: string | null;
  plan_slug: string | null;
  plan_name: string | null;
};

const CACHE_KEY = (tenantId: string) => `plan:effective:${tenantId}`;

/** Effectively-infinite ceiling for every int limit when billing is off. */
const UNLIMITED_INT = Number.MAX_SAFE_INTEGER;
const FREE_NOTE = 'Included — subscriptions are currently disabled.';

/**
 * Copy of `plan` with every gate on and every limit lifted — returned for all
 * tenants when `BILLING_ENABLED=false`, so the whole product is free. Bool
 * features become true, int limits become unlimited; text values pass through.
 */
function unlimitedPlan(plan: EffectivePlan): EffectivePlan {
  const features: Record<string, EffectiveValue> = {};
  for (const [key, v] of Object.entries(plan.features)) {
    if (v.type === 'bool') {
      features[key] = { ...v, value: true, source: 'override', note: FREE_NOTE };
    } else if (v.type === 'int') {
      features[key] = { ...v, value: UNLIMITED_INT, source: 'override', note: FREE_NOTE };
    } else {
      features[key] = v;
    }
  }
  return { ...plan, features };
}

/**
 * Resolves the effective plan for a tenant by walking the three layers:
 *
 *     override  →  plan_feature_values  →  plan_features default
 *
 * One SQL roundtrip pulls every feature in one go via LEFT JOINs. The
 * result is cached in Redis as a single blob keyed by tenantId. Cache is
 * invalidated whenever ANY of:
 *   - the tenant's subscription changes (different plan)
 *   - a plan_feature_value on the tenant's plan changes
 *   - a tenant_plan_override for the tenant changes (created / edited / expired)
 *
 * For MVP we expose `invalidate(tenantId)` and call it from the few places
 * that mutate those rows (signup, the admin override editor in Step 18,
 * Stripe webhooks in Step 16).
 */
@Injectable()
export class EffectivePlanService {
  private readonly logger = new Logger(EffectivePlanService.name);
  private readonly ttlSec: number;

  constructor(
    @Inject(RedisService) private readonly redis: RedisService,
    @Inject(PlatformSettingsService) private readonly settings: PlatformSettingsService,
  ) {
    this.ttlSec = loadEnv().tenantCacheTtlSec;
  }

  /** Full effective plan for the tenant. Cached. */
  async getEffectivePlan(tenantId: string): Promise<EffectivePlan> {
    let plan = await this.readCache(tenantId);
    if (!plan) {
      plan = await this.loadFromDb(tenantId);
      await this.writeCache(tenantId, plan);
    }
    // Subscriptions disabled → every tenant gets everything. Applied at read
    // time (the per-tenant cache keeps the real plan) so flipping the master
    // switch in the admin panel takes effect within the toggle's own short
    // cache window, not after each tenant's plan TTL.
    const billingEnabled = await this.settings.billingEnabled();
    return billingEnabled ? plan : unlimitedPlan(plan);
  }

  /** Convenience: read one feature as a boolean. False if missing/not-bool. */
  async getBool(tenantId: string, key: FeatureKey | string): Promise<boolean> {
    const plan = await this.getEffectivePlan(tenantId);
    const v = plan.features[key];
    return v?.type === 'bool' ? v.value : false;
  }

  /** Convenience: read one feature as an integer. Throws if missing/not-int. */
  async getInt(tenantId: string, key: FeatureKey | string): Promise<number> {
    const plan = await this.getEffectivePlan(tenantId);
    const v = plan.features[key];
    if (v?.type !== 'int') {
      throw new Error(`Feature "${key}" is not an integer for tenant ${tenantId}.`);
    }
    return v.value;
  }

  /** Drop the cached plan for a tenant. Call after any layer changes. */
  async invalidate(tenantId: string): Promise<void> {
    await this.redis.client.del(CACHE_KEY(tenantId));
    this.logger.debug(`Invalidated effective-plan cache for ${tenantId}`);
  }

  // --- internals ---------------------------------------------------------

  private async loadFromDb(tenantId: string): Promise<EffectivePlan> {
    // Single SQL traverses all three layers and emits one row per feature.
    // Expired overrides are filtered out at the join.
    const rows = (await controlDb.$queryRawUnsafe(
      `
      SELECT
        pf.key                    AS feature_key,
        pf.type::text             AS feature_type,
        pf."defaultInt"           AS default_int,
        pf."defaultBool"          AS default_bool,
        pf."defaultText"          AS default_text,
        pf.unit                   AS unit,
        pfv."valueInt"            AS plan_int,
        pfv."valueBool"           AS plan_bool,
        pfv."valueText"           AS plan_text,
        tpo."valueInt"            AS override_int,
        tpo."valueBool"           AS override_bool,
        tpo."valueText"           AS override_text,
        tpo.note                  AS override_note,
        p.id                      AS plan_id,
        p.slug                    AS plan_slug,
        p.name                    AS plan_name
      FROM plan_features pf
      LEFT JOIN subscriptions s
        ON s."tenantId" = $1
       AND (
         -- Fully active: paid up, in trial, or grandfathered.
         s.status IN ('active', 'trialing')
         -- Past-due during the grace window keeps full feature access so a
         -- transient card decline does not immediately yank features. Once
         -- graceUntil passes, the join falls off and resolution drops to
         -- the conservative plan_features default row (effectively Starter)
         -- until payment recovers.
         OR (s.status = 'past_due' AND s."graceUntil" IS NOT NULL AND s."graceUntil" > NOW())
       )
       -- Manual subscriptions are active only while paidUntil has not
       -- expired. If a manual library has not paid the next invoice yet,
       -- they fall through to defaults the moment paidUntil < NOW().
       AND (s."billingMode" <> 'manual' OR s."paidUntil" IS NULL OR s."paidUntil" > NOW())
      LEFT JOIN plans p ON p.id = s."planId"
      LEFT JOIN plan_feature_values pfv
        ON pfv."planId" = s."planId"
       AND pfv."featureKey" = pf.key
      LEFT JOIN tenant_plan_overrides tpo
        ON tpo."tenantId" = $1
       AND tpo."featureKey" = pf.key
       AND (tpo."expiresAt" IS NULL OR tpo."expiresAt" > NOW())
      ORDER BY pf."sortOrder", pf.key;
      `,
      tenantId,
    )) as Row[];

    const features: Record<string, EffectiveValue> = {};
    let plan: EffectivePlan['plan'] = null;
    for (const r of rows) {
      if (!plan && r.plan_id && r.plan_slug && r.plan_name) {
        plan = { id: r.plan_id, slug: r.plan_slug, name: r.plan_name };
      }
      features[r.feature_key] = this.resolveRow(r);
    }
    return { tenantId, plan, features };
  }

  /** Compose one feature's value from the row's three layers. */
  private resolveRow(r: Row): EffectiveValue {
    // The DB CHECK constraint guarantees exactly-one-non-null for plan and
    // override columns where present, but we still need to branch on type.
    if (r.feature_type === 'int') {
      const value = r.override_int ?? r.plan_int ?? r.default_int;
      const source = this.sourceFor(r.override_int, r.plan_int);
      return {
        type: 'int',
        value: value ?? 0,
        source,
        unit: r.unit ?? null,
        note: source === 'override' ? r.override_note : null,
      };
    }
    if (r.feature_type === 'bool') {
      const value = r.override_bool ?? r.plan_bool ?? r.default_bool;
      const source = this.sourceFor(r.override_bool, r.plan_bool);
      return {
        type: 'bool',
        value: value ?? false,
        source,
        note: source === 'override' ? r.override_note : null,
      };
    }
    const value = r.override_text ?? r.plan_text ?? r.default_text;
    const source = this.sourceFor(r.override_text, r.plan_text);
    return {
      type: 'text',
      value,
      source,
      note: source === 'override' ? r.override_note : null,
    };
  }

  private sourceFor(overrideVal: unknown, planVal: unknown): EffectiveSource {
    if (overrideVal !== null && overrideVal !== undefined) return 'override';
    if (planVal !== null && planVal !== undefined) return 'plan';
    return 'default';
  }

  private async readCache(tenantId: string): Promise<EffectivePlan | null> {
    const raw = await this.redis.client.get(CACHE_KEY(tenantId));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as EffectivePlan;
    } catch {
      await this.redis.client.del(CACHE_KEY(tenantId));
      return null;
    }
  }

  private async writeCache(tenantId: string, plan: EffectivePlan): Promise<void> {
    await this.redis.client.set(CACHE_KEY(tenantId), JSON.stringify(plan), 'EX', this.ttlSec);
  }
}
