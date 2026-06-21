import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { queryRawUnsafe, subscriptionFindUnique, env } = vi.hoisted(() => ({
  queryRawUnsafe: vi.fn(),
  // The TTL clamp (PQF-3 extended) reads the subscription's grace/paidUntil
  // boundaries; default to "no subscription" so the clamp is a no-op here.
  subscriptionFindUnique: vi.fn().mockResolvedValue(null),
  env: { tenantCacheTtlSec: 60, billingEnabled: true },
}));
vi.mock('@libriant/db-control', () => ({
  controlDb: {
    $queryRawUnsafe: queryRawUnsafe,
    subscription: { findUnique: subscriptionFindUnique },
  },
}));
vi.mock('../config/env.js', () => ({
  loadEnv: () => env,
}));

import type { Redis } from 'ioredis';
import { EffectivePlanService } from './effective-plan.service.js';

function makeFakeRedis() {
  const store = new Map<string, string>();
  const client = {
    async get(k: string) {
      return store.get(k) ?? null;
    },
    async set(k: string, v: string) {
      store.set(k, v);
      return 'OK';
    },
    async del(k: string) {
      return store.delete(k) ? 1 : 0;
    },
  } as unknown as Redis;
  return { client, store };
}

/**
 * One SQL row per feature, as emitted by the resolver query. The override
 * + plan + default columns + plan metadata stand in for the three layers
 * the service walks.
 */
function row(opts: {
  key: string;
  type: 'int' | 'bool' | 'text';
  override?: number | boolean | string | null;
  plan?: number | boolean | string | null;
  def?: number | boolean | string | null;
  planSlug?: string | null;
  planName?: string | null;
  unit?: string | null;
  note?: string | null;
}) {
  const baseInt = { default_int: null, plan_int: null, override_int: null };
  const baseBool = { default_bool: null, plan_bool: null, override_bool: null };
  const baseText = { default_text: null, plan_text: null, override_text: null };
  const typed =
    opts.type === 'int'
      ? {
          default_int: (opts.def ?? null) as number | null,
          plan_int: (opts.plan ?? null) as number | null,
          override_int: (opts.override ?? null) as number | null,
        }
      : opts.type === 'bool'
        ? {
            default_bool: (opts.def ?? null) as boolean | null,
            plan_bool: (opts.plan ?? null) as boolean | null,
            override_bool: (opts.override ?? null) as boolean | null,
          }
        : {
            default_text: (opts.def ?? null) as string | null,
            plan_text: (opts.plan ?? null) as string | null,
            override_text: (opts.override ?? null) as string | null,
          };
  return {
    feature_key: opts.key,
    feature_type: opts.type,
    unit: opts.unit ?? null,
    override_note: opts.note ?? null,
    plan_id: opts.planSlug ? 'plan-id' : null,
    plan_slug: opts.planSlug ?? null,
    plan_name: opts.planName ?? null,
    ...baseInt,
    ...baseBool,
    ...baseText,
    ...typed,
  };
}

describe('EffectivePlanService.getEffectivePlan', () => {
  let redis: ReturnType<typeof makeFakeRedis>;
  let service: EffectivePlanService;

  beforeEach(() => {
    queryRawUnsafe.mockReset();
    env.billingEnabled = true;
    redis = makeFakeRedis();
    service = new EffectivePlanService(
      { client: redis.client } as never,
      { billingEnabled: async () => env.billingEnabled } as never,
    );
  });

  it('resolves override > plan > default for an int feature and records the source', async () => {
    queryRawUnsafe.mockResolvedValue([
      row({
        key: 'max_books',
        type: 'int',
        def: 100,
        plan: 500,
        override: 999,
        note: 'beta deal',
        planSlug: 'community',
        planName: 'Community',
      }),
    ]);

    const plan = await service.getEffectivePlan('tnt-1');

    expect(plan.features.max_books).toEqual({
      type: 'int',
      value: 999,
      source: 'override',
      unit: null,
      note: 'beta deal',
    });
    expect(plan.plan).toEqual({ id: 'plan-id', slug: 'community', name: 'Community' });
  });

  it('falls through to plan value when no override exists', async () => {
    queryRawUnsafe.mockResolvedValue([
      row({ key: 'max_books', type: 'int', def: 100, plan: 500, planSlug: 'community' }),
    ]);

    const plan = await service.getEffectivePlan('tnt-1');

    expect(plan.features.max_books).toMatchObject({ value: 500, source: 'plan', note: null });
  });

  it('falls through to default when neither override nor plan applies', async () => {
    queryRawUnsafe.mockResolvedValue([row({ key: 'max_books', type: 'int', def: 100 })]);

    const plan = await service.getEffectivePlan('tnt-1');

    expect(plan.features.max_books).toMatchObject({ value: 100, source: 'default' });
    expect(plan.plan).toBeNull();
  });

  it('handles bool + text feature types', async () => {
    queryRawUnsafe.mockResolvedValue([
      row({ key: 'reservations_enabled', type: 'bool', def: false, plan: true }),
      row({ key: 'priority_support', type: 'text', def: null, plan: 'business-hours' }),
    ]);

    const plan = await service.getEffectivePlan('tnt-1');

    expect(plan.features.reservations_enabled).toMatchObject({ type: 'bool', value: true });
    expect(plan.features.priority_support).toMatchObject({
      type: 'text',
      value: 'business-hours',
    });
  });

  it('caches on first read; second call does no DB query', async () => {
    queryRawUnsafe.mockResolvedValue([row({ key: 'max_books', type: 'int', def: 100 })]);

    await service.getEffectivePlan('tnt-1');
    await service.getEffectivePlan('tnt-1');

    expect(queryRawUnsafe).toHaveBeenCalledTimes(1);
  });

  it('invalidate() drops the cache so the next call hits DB again', async () => {
    queryRawUnsafe.mockResolvedValue([row({ key: 'max_books', type: 'int', def: 100 })]);

    await service.getEffectivePlan('tnt-1');
    await service.invalidate('tnt-1');
    await service.getEffectivePlan('tnt-1');

    expect(queryRawUnsafe).toHaveBeenCalledTimes(2);
  });

  it('survives garbage in the cache by re-reading from DB', async () => {
    redis.store.set('plan:effective:tnt-1', 'not json');
    queryRawUnsafe.mockResolvedValue([row({ key: 'max_books', type: 'int', def: 100 })]);

    const plan = await service.getEffectivePlan('tnt-1');

    expect(plan.features.max_books).toMatchObject({ value: 100 });
    expect(queryRawUnsafe).toHaveBeenCalledTimes(1);
  });
});

describe('EffectivePlanService convenience helpers', () => {
  it('getBool returns false when the feature is missing', async () => {
    queryRawUnsafe.mockResolvedValue([]);
    const redis = makeFakeRedis();
    const service = new EffectivePlanService(
      { client: redis.client } as never,
      { billingEnabled: async () => env.billingEnabled } as never,
    );

    expect(await service.getBool('tnt-1', 'nope_enabled')).toBe(false);
  });

  it('getInt throws when the feature is not an int', async () => {
    queryRawUnsafe.mockResolvedValue([
      row({ key: 'reservations_enabled', type: 'bool', def: true }),
    ]);
    const redis = makeFakeRedis();
    const service = new EffectivePlanService(
      { client: redis.client } as never,
      { billingEnabled: async () => env.billingEnabled } as never,
    );

    await expect(service.getInt('tnt-1', 'reservations_enabled')).rejects.toThrow(/not an integer/);
  });
});

describe('EffectivePlanService with BILLING_ENABLED=false (everything free)', () => {
  beforeEach(() => {
    queryRawUnsafe.mockReset();
    env.billingEnabled = false;
  });
  afterEach(() => {
    env.billingEnabled = true;
  });

  it('turns on every gate and lifts every limit for all tenants', async () => {
    queryRawUnsafe.mockResolvedValue([
      row({ key: 'max_books', type: 'int', def: 100, plan: 500, planSlug: 'community' }),
      row({ key: 'reservations_enabled', type: 'bool', def: false, plan: false }),
      row({ key: 'priority_support', type: 'text', def: 'none' }),
    ]);
    const redis = makeFakeRedis();
    const service = new EffectivePlanService(
      { client: redis.client } as never,
      { billingEnabled: async () => env.billingEnabled } as never,
    );

    const plan = await service.getEffectivePlan('tnt-1');
    expect(plan.features.max_books).toMatchObject({ value: Number.MAX_SAFE_INTEGER });
    expect(plan.features.reservations_enabled).toMatchObject({ value: true });
    // text features are untouched
    expect(plan.features.priority_support).toMatchObject({ value: 'none' });
    // convenience accessors agree
    expect(await service.getBool('tnt-1', 'reservations_enabled')).toBe(true);
    expect(await service.getInt('tnt-1', 'max_books')).toBe(Number.MAX_SAFE_INTEGER);
  });
});
