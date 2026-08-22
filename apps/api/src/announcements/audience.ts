import { BadRequestException } from '@nestjs/common';

/**
 * Audience-targeting filter shape. Exactly ONE of the four kinds. The
 * admin composer surfaces a typed picker; the API normalizes everything
 * into one of these four discriminated unions.
 */
export type AudienceFilter =
  | { kind: 'all' }
  | { kind: 'tenant_ids'; tenantIds: string[] }
  | { kind: 'plan_slugs'; planSlugs: string[] }
  | { kind: 'tags'; tags: string[] };

/**
 * What we store in the JSONB column. Keeps the wire format flat (matches
 * the plan's documented shape: `{ all: true } | { tenant_ids: [...] } |
 * { plan_slugs: [...] } | { tags: [...] }`) but parses into a discriminated
 * union so service code doesn't have to special-case undefined keys.
 */
export type AudienceFilterJson =
  { all: true } | { tenant_ids: string[] } | { plan_slugs: string[] } | { tags: string[] };

export function audienceToJson(f: AudienceFilter): AudienceFilterJson {
  switch (f.kind) {
    case 'all':
      return { all: true };
    case 'tenant_ids':
      return { tenant_ids: f.tenantIds };
    case 'plan_slugs':
      return { plan_slugs: f.planSlugs };
    case 'tags':
      return { tags: f.tags };
  }
}

export function audienceFromJson(raw: unknown): AudienceFilter {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>;
    if (obj.all === true) return { kind: 'all' };
    if (Array.isArray(obj.tenant_ids)) {
      return {
        kind: 'tenant_ids',
        tenantIds: obj.tenant_ids.filter((v): v is string => typeof v === 'string'),
      };
    }
    if (Array.isArray(obj.plan_slugs)) {
      return {
        kind: 'plan_slugs',
        planSlugs: obj.plan_slugs.filter((v): v is string => typeof v === 'string'),
      };
    }
    if (Array.isArray(obj.tags)) {
      return { kind: 'tags', tags: obj.tags.filter((v): v is string => typeof v === 'string') };
    }
  }
  throw new BadRequestException(
    'Audience must be one of: { all: true }, { tenant_ids: [...] }, { plan_slugs: [...] }, or { tags: [...] }.',
  );
}

/**
 * Validate a user-submitted audience payload. Lightweight — heavy lifting
 * (do these tenant ids / plan slugs exist?) happens in the service when
 * we cross-check against the DB. This just sanity-checks the SHAPE +
 * minimum size so a typo in the composer doesn't ship as a no-op audience.
 */
export function validateAudience(f: AudienceFilter): void {
  switch (f.kind) {
    case 'all':
      return;
    case 'tenant_ids':
      if (f.tenantIds.length === 0) {
        throw new BadRequestException('Pick at least one library when targeting specific tenants.');
      }
      return;
    case 'plan_slugs':
      if (f.planSlugs.length === 0) {
        throw new BadRequestException('Pick at least one plan when targeting by plan.');
      }
      return;
    case 'tags':
      if (f.tags.length === 0) {
        throw new BadRequestException('Pick at least one tag when targeting by tag.');
      }
      return;
  }
}
