import type { FeatureKey } from '@libriant/shared';

/**
 * The resolved value of a single feature for a tenant, including which
 * layer it came from. Carrying `source` makes the admin UI's "Plan editor"
 * obvious — librarians and Libriant staff alike can see at a glance why
 * a tenant has the value they do.
 */
export type EffectiveSource = 'override' | 'plan' | 'default';

export type EffectiveValueInt = {
  type: 'int';
  value: number;
  source: EffectiveSource;
  note?: string | null;
  /** Optional unit hint from the catalog (`count`, `mb`, `days`, `seats`). */
  unit?: string | null;
};

export type EffectiveValueBool = {
  type: 'bool';
  value: boolean;
  source: EffectiveSource;
  note?: string | null;
};

export type EffectiveValueText = {
  type: 'text';
  value: string | null;
  source: EffectiveSource;
  note?: string | null;
};

export type EffectiveValue = EffectiveValueInt | EffectiveValueBool | EffectiveValueText;

/**
 * The full picture for a tenant at one moment in time. `plan` is null
 * when the tenant has no subscription yet — every value then resolves to
 * the catalog default.
 */
export type EffectivePlan = {
  tenantId: string;
  plan: { id: string; slug: string; name: string } | null;
  /** Feature key → effective value. Keyed by `FeatureKey` from `@libriant/shared`
   *  but typed loosely here so unknown / future keys don't break the type. */
  features: Record<string, EffectiveValue>;
};

/** Type-narrowing helpers used by guards / interceptors. */
export function isInt(value: EffectiveValue): value is EffectiveValueInt {
  return value.type === 'int';
}
export function isBool(value: EffectiveValue): value is EffectiveValueBool {
  return value.type === 'bool';
}

/** Read a feature value as a boolean (false if the key is missing or not a bool). */
export function readBool(plan: EffectivePlan, key: FeatureKey | string): boolean {
  const v = plan.features[key];
  return v?.type === 'bool' ? v.value : false;
}

/** Read a feature value as an integer (returns null if the key isn't an int). */
export function readInt(plan: EffectivePlan, key: FeatureKey | string): number | null {
  const v = plan.features[key];
  return v?.type === 'int' ? v.value : null;
}
