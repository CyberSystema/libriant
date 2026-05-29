import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the workspace DB package so we don't reach a real Postgres.
// `vi.hoisted` exposes the mock fns to the (also-hoisted) `vi.mock`
// factory — direct top-level consts would still be in the TDZ when the
// factory runs.
const { findUnique, findFirst } = vi.hoisted(() => ({
  findUnique: vi.fn(),
  findFirst: vi.fn(),
}));
vi.mock('@libriant/db-control', () => ({
  controlDb: {
    tenant: { findUnique, findFirst },
  },
}));

// `loadEnv` reads process.env at first call and caches inside the module.
// For tests we just need it to be cheap + deterministic.
vi.mock('../config/env.js', () => ({
  loadEnv: () => ({ tenantCacheTtlSec: 60, redisUrl: 'redis://localhost:6379' }),
}));

import type { Redis } from 'ioredis';
import { TenantResolverService } from './tenant-resolver.service.js';

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
    async del(...keys: string[]) {
      let n = 0;
      for (const k of keys) if (store.delete(k)) n++;
      return n;
    },
  } as unknown as Redis;
  return { client, store };
}

function tenantRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'tnt-1',
    slug: 'acme',
    name: 'Acme Public Library',
    defaultLocale: 'el',
    status: 'active',
    dbUrl: 'postgresql://x/y',
    storageUrl: 'file:///srv/libriant/storage/tnt-1',
    customSubdomain: null,
    tags: [],
    ...overrides,
  };
}

describe('TenantResolverService.resolveBySlug', () => {
  let redis: ReturnType<typeof makeFakeRedis>;
  let service: TenantResolverService;

  beforeEach(() => {
    findUnique.mockReset();
    findFirst.mockReset();
    redis = makeFakeRedis();
    service = new TenantResolverService({ client: redis.client } as never);
  });

  it('returns null + writes a negative cache entry when slug is unknown', async () => {
    findUnique.mockResolvedValue(null);

    const result = await service.resolveBySlug('ghost');

    expect(result).toBeNull();
    expect(findUnique).toHaveBeenCalledTimes(1);
    // Negative cache entry stored as `{ found: false }` so a follow-up
    // lookup short-circuits without hitting the DB again.
    expect(redis.store.get('tenant:slug:ghost')).toBe(JSON.stringify({ found: false }));
  });

  it('returns the row + writes a positive cache entry on a fresh lookup', async () => {
    findUnique.mockResolvedValue(tenantRow());

    const result = await service.resolveBySlug('acme');

    expect(result).not.toBeNull();
    expect(result?.id).toBe('tnt-1');
    expect(result?.resolvedFrom).toBe('path');
    const cached = JSON.parse(redis.store.get('tenant:slug:acme') ?? '{}');
    expect(cached.found).toBe(true);
    expect(cached.tenant?.id).toBe('tnt-1');
  });

  it('hits the cache on the second call — no extra DB query', async () => {
    findUnique.mockResolvedValue(tenantRow());

    await service.resolveBySlug('acme');
    await service.resolveBySlug('acme');

    expect(findUnique).toHaveBeenCalledTimes(1);
  });

  it('negative cache short-circuits the next lookup', async () => {
    findUnique.mockResolvedValue(null);

    await service.resolveBySlug('ghost');
    await service.resolveBySlug('ghost');

    expect(findUnique).toHaveBeenCalledTimes(1);
  });

  it('overwrites `resolvedFrom` on a cache hit so the right access path is reported', async () => {
    // Seed positive cache via the first lookup
    findUnique.mockResolvedValue(tenantRow());
    const first = await service.resolveBySlug('acme');
    expect(first?.resolvedFrom).toBe('path');

    // Second lookup uses the cached row but reports the path it came in on.
    const second = await service.resolveBySlug('acme');
    expect(second?.resolvedFrom).toBe('path');
  });

  it('drops + re-fetches when the cache value is garbage JSON', async () => {
    redis.store.set('tenant:slug:acme', 'this is not json');
    findUnique.mockResolvedValue(tenantRow());

    const result = await service.resolveBySlug('acme');

    expect(result?.id).toBe('tnt-1');
    expect(findUnique).toHaveBeenCalledTimes(1);
    // The garbage entry should have been overwritten with the real one.
    const cached = JSON.parse(redis.store.get('tenant:slug:acme') ?? '{}');
    expect(cached.found).toBe(true);
  });
});

describe('TenantResolverService.invalidate', () => {
  it('deletes both slug + subdomain keys when both are provided', async () => {
    const redis = makeFakeRedis();
    redis.store.set('tenant:slug:acme', '{}');
    redis.store.set('tenant:sub:acme', '{}');
    const service = new TenantResolverService({ client: redis.client } as never);

    await service.invalidate({ slug: 'acme', customSubdomain: 'acme' });

    expect(redis.store.has('tenant:slug:acme')).toBe(false);
    expect(redis.store.has('tenant:sub:acme')).toBe(false);
  });

  it('is a no-op when neither is provided', async () => {
    const redis = makeFakeRedis();
    redis.store.set('tenant:slug:acme', '{}');
    const service = new TenantResolverService({ client: redis.client } as never);

    await service.invalidate({ slug: undefined, customSubdomain: null });

    expect(redis.store.has('tenant:slug:acme')).toBe(true);
  });
});
