import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the workspace DB package so we don't reach a real Postgres.
// `vi.hoisted` exposes the mock fns to the (also-hoisted) `vi.mock`
// factory — direct top-level consts would still be in the TDZ when the
// factory runs.
const { findUnique, findFirst, update } = vi.hoisted(() => ({
  findUnique: vi.fn(),
  findFirst: vi.fn(),
  update: vi.fn(),
}));
// Spread the real module: `rowToContext` composes the runtime url from the
// sealed credential now, so the sealing helpers have to be the real ones.
// `controlDb` is a lazy Proxy, so pulling in the barrel constructs no client.
vi.mock('@libriant/db-control', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@libriant/db-control')>()),
  controlDb: {
    tenant: { findUnique, findFirst, update },
  },
}));

// `loadEnv` reads process.env at first call and caches inside the module.
// For tests we just need it to be cheap + deterministic. The fallback is
// CLOSED, as outside development: a resolver that quietly handed back the
// superuser url for a tenant with no credential would satisfy every other
// assertion in this file.
vi.mock('../config/env.js', () => ({
  loadEnv: () => ({
    tenantCacheTtlSec: 60,
    redisUrl: 'redis://localhost:6379',
    ...TEST_TENANT_DB_ENV,
  }),
}));

import type { Redis } from 'ioredis';
import { tenantLoginRole } from '@libriant/db-control';
import { TEST_TENANT_DB_ENV, testSealedCredential } from './__fixtures__/tenant-credential.js';
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

/**
 * tenant-isolation-03: the fixture carries a REAL-SHAPED superuser URL, with a
 * password, on purpose. The previous `postgresql://x/y` had no credential in
 * it, so a test asserting "the cache holds no password" would have passed
 * against the very code that leaked one.
 */
const SUPERUSER_DB_URL = 'postgresql://libriant:s3cr3t-pg-pw@postgres:5432/tenant_tnt1';
const TENANT_STORAGE_URL = 'file:///srv/libriant/storage/tnt-1';

/**
 * tenant-isolation-02: the row carries a real sealed credential, because since
 * phase 4 `rowToContext` composes the context's `dbUrl` from it. A fixture
 * without one would exercise the fail-closed branch and nothing else.
 */
const TENANT_ROLE = tenantLoginRole('tnt-1', 'a');
const TENANT_RUNTIME_PASSWORD = 'ab'.repeat(32);
const SEALED = testSealedCredential('tnt-1', TENANT_RUNTIME_PASSWORD);

/** What `rowToContext` composes: the same endpoint and database, tenant role. */
function runtimeUrlOn(hostPort = 'postgres:5432') {
  return `postgresql://${TENANT_ROLE}:${TENANT_RUNTIME_PASSWORD}@${hostPort}/tenant_tnt1`;
}

function tenantRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'tnt-1',
    slug: 'acme',
    name: 'Acme Public Library',
    defaultLocale: 'el',
    status: 'active',
    dbUrl: SUPERUSER_DB_URL,
    storageUrl: TENANT_STORAGE_URL,
    customSubdomain: null,
    tags: [],
    dbCredentials: SEALED,
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

  it('never writes dbUrl / storageUrl into the shared Redis cache', async () => {
    findUnique.mockResolvedValue(tenantRow());

    const result = await service.resolveBySlug('acme');

    // The caller still gets the addresses — they come from the process-local
    // map — and `dbUrl` is now the tenant's OWN credential, not the superuser
    // string the row carries (tenant-isolation-02).
    expect(result?.dbUrl).toBe(runtimeUrlOn());
    expect(result?.dbUrl).not.toContain('s3cr3t-pg-pw');
    expect(result?.storageUrl).toBe(TENANT_STORAGE_URL);

    // …but the bytes that reached Redis carry neither the fields nor the secret.
    const raw = redis.store.get('tenant:slug:acme') ?? '';
    expect(raw).not.toBe('');
    expect(raw).not.toContain('s3cr3t-pg-pw');
    expect(raw).not.toContain(TENANT_RUNTIME_PASSWORD);
    expect(raw).not.toContain('dbUrl');
    expect(raw).not.toContain('storageUrl');
    // Nor the sealed credential itself, which is now joined onto the same row.
    expect(raw).not.toContain('encryptedPwd');
    expect(raw).not.toContain('dbCredentials');
    const cached = JSON.parse(raw);
    expect(cached.tenant).not.toHaveProperty('dbUrl');
    expect(cached.tenant).not.toHaveProperty('storageUrl');
    expect(cached.tenant).not.toHaveProperty('dbCredentials');
    // The routing/identity fields the middleware needs are still shared.
    expect(cached.tenant.status).toBe('active');
    expect(cached.tenant.slug).toBe('acme');
  });

  it('re-reads the control DB when another process warmed Redis but this one has no addresses', async () => {
    // Exactly the cross-process case: the shared entry exists, the local
    // address map does not. Returning the cached half alone would hand the
    // middleware a context with `dbUrl: undefined` and every tenant query in
    // the process would fail — so this MUST fall through to the DB.
    redis.store.set(
      'tenant:slug:acme',
      JSON.stringify({
        found: true,
        tenant: {
          id: 'tnt-1',
          slug: 'acme',
          name: 'Acme Public Library',
          defaultLocale: 'el',
          status: 'active',
          customSubdomain: null,
          tags: [],
        },
      }),
    );
    findUnique.mockResolvedValue(tenantRow());

    const result = await service.resolveBySlug('acme');

    expect(findUnique).toHaveBeenCalledTimes(1);
    expect(result?.dbUrl).toBe(runtimeUrlOn());
    // …and the second call is served entirely from cache again.
    const again = await service.resolveBySlug('acme');
    expect(findUnique).toHaveBeenCalledTimes(1);
    expect(again?.dbUrl).toBe(runtimeUrlOn());
  });

  it('forgets the local addresses on invalidate, so a relocate is not served stale', async () => {
    findUnique.mockResolvedValue(tenantRow());
    await service.resolveBySlug('acme');

    await service.invalidate({ slug: 'acme' });

    const moved = tenantRow({ dbUrl: 'postgresql://libriant:s3cr3t-pg-pw@pg2:5432/tenant_tnt1' });
    findUnique.mockResolvedValue(moved);
    const after = await service.resolveBySlug('acme');
    // The relocate moved the HOST; the credential is still the tenant's own.
    expect(after?.dbUrl).toBe(runtimeUrlOn('pg2:5432'));
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

describe('TenantResolverService with Redis unavailable', () => {
  /**
   * BOOT-01: this resolver runs inside SystemModeMiddleware for every
   * `/t/<slug>/*` request, so an unguarded `redis.client.get()` meant a Redis
   * restart 500'd every tenant route — staff could not check a book out —
   * rather than degrading to a control-DB lookup.
   */
  function deadRedis() {
    const boom = () => {
      throw new Error("Stream isn't writeable and enableOfflineQueue options is false");
    };
    return {
      client: {
        get: vi.fn(boom),
        set: vi.fn(boom),
        del: vi.fn(boom),
      } as unknown as Redis,
    };
  }

  beforeEach(() => {
    findUnique.mockReset();
    findFirst.mockReset();
  });

  it('resolves the tenant from the control DB instead of throwing', async () => {
    findUnique.mockResolvedValue(tenantRow());
    const service = new TenantResolverService(deadRedis() as never);

    const result = await service.resolveBySlug('acme');

    expect(result?.id).toBe('tnt-1');
  });

  it('does not turn the outage into a control-DB lookup per request', async () => {
    findUnique.mockResolvedValue(tenantRow());
    const service = new TenantResolverService(deadRedis() as never);

    await service.resolveBySlug('acme');
    await service.resolveBySlug('acme');
    await service.resolveBySlug('acme');

    expect(findUnique).toHaveBeenCalledTimes(1);
  });

  it('still surfaces a failed invalidate — a stale suspended tenant is not safe', async () => {
    const service = new TenantResolverService(deadRedis() as never);

    await expect(service.invalidate({ slug: 'acme' })).rejects.toThrow(/Stream isn't writeable/);
  });
});

/**
 * tenant-isolation-05 / -07: the write-through path. `invalidate()` works and
 * always has — what kept failing is a caller writing the row and not calling
 * it, so what these cover is that the resolver decides, from the column list
 * the cache is built out of, rather than the caller remembering.
 */
describe('TenantResolverService.updateTenant', () => {
  beforeEach(() => {
    findUnique.mockReset();
    findFirst.mockReset();
    update.mockReset();
  });

  it('drops the cached context when the write touches a cached column', async () => {
    const redis = makeFakeRedis();
    const service = new TenantResolverService({ client: redis.client } as never);
    findUnique.mockResolvedValue(tenantRow());
    await service.resolveBySlug('acme');
    expect(redis.store.has('tenant:slug:acme')).toBe(true);

    update.mockResolvedValue({
      id: 'tnt-1',
      slug: 'acme',
      name: 'Renamed Library',
      status: 'active',
      customSubdomain: 'acme',
    });
    await service.updateTenant('tnt-1', { name: 'Renamed Library' });

    // Both keys the tenant could be reached by, not just the slug one.
    expect(redis.store.has('tenant:slug:acme')).toBe(false);
    expect(redis.store.has('tenant:sub:acme')).toBe(false);
    // …and the next resolve re-reads the row, so the new name is served at once.
    findUnique.mockResolvedValue(tenantRow({ name: 'Renamed Library' }));
    expect((await service.resolveBySlug('acme'))?.name).toBe('Renamed Library');
  });

  it('leaves the cache alone for a column the context never carried', async () => {
    const redis = makeFakeRedis();
    const del = vi.spyOn(redis.client, 'del');
    const service = new TenantResolverService({ client: redis.client } as never);
    findUnique.mockResolvedValue(tenantRow());
    await service.resolveBySlug('acme');

    update.mockResolvedValue({
      id: 'tnt-1',
      slug: 'acme',
      name: 'Acme Public Library',
      status: 'active',
      customSubdomain: null,
    });
    await service.updateTenant('tnt-1', { publicPhone: '+30 210 0000000' });

    // A library editing its public phone number is a common, unremarkable
    // write; making it evict every process's tenant context would trade one
    // bug for a needless control-DB read on the next request everywhere.
    expect(del).not.toHaveBeenCalled();
    expect(redis.store.has('tenant:slug:acme')).toBe(true);
  });

  it('drops the OLD keys too when the write renames the slug or subdomain', async () => {
    const redis = makeFakeRedis();
    const service = new TenantResolverService({ client: redis.client } as never);
    findUnique.mockResolvedValue(tenantRow({ customSubdomain: 'acme-lib' }));
    await service.resolveBySlug('acme');
    await service.resolveBySubdomain('acme-lib');
    expect(redis.store.has('tenant:slug:acme')).toBe(true);
    expect(redis.store.has('tenant:sub:acme-lib')).toBe(true);

    // The rename itself: `findUnique` is now the pre-update read, `update`
    // returns the post-update row.
    findUnique.mockResolvedValue({ slug: 'acme', customSubdomain: 'acme-lib' });
    update.mockResolvedValue({
      id: 'tnt-1',
      slug: 'acme-public',
      name: 'Acme Public Library',
      status: 'active',
      customSubdomain: 'acme-public',
    });
    await service.updateTenant('tnt-1', { slug: 'acme-public', customSubdomain: 'acme-public' });

    // Invalidating only the post-update values leaves the address a librarian
    // still has bookmarked serving the pre-rename context for a full TTL.
    expect(redis.store.has('tenant:slug:acme')).toBe(false);
    expect(redis.store.has('tenant:sub:acme-lib')).toBe(false);
  });

  it('never selects the tenant addresses back out of the row it writes', async () => {
    const redis = makeFakeRedis();
    const service = new TenantResolverService({ client: redis.client } as never);
    update.mockResolvedValue({
      id: 'tnt-1',
      slug: 'acme',
      name: 'Acme Public Library',
      status: 'suspended',
      customSubdomain: null,
    });

    const result = await service.updateTenant('tnt-1', { status: 'suspended' });

    // tenant-isolation-03: `dbUrl` is the fleet's superuser credential. A
    // helper this central must not hand it back for a caller to log or return.
    const select = update.mock.calls[0]?.[0]?.select ?? {};
    expect(select).not.toHaveProperty('dbUrl');
    expect(select).not.toHaveProperty('storageUrl');
    expect(result).not.toHaveProperty('dbUrl');
    expect(result.status).toBe('suspended');
  });
});

describe('TenantResolverService.invalidateById', () => {
  beforeEach(() => {
    findUnique.mockReset();
    findFirst.mockReset();
    update.mockReset();
  });

  it('resolves the keys from the row so a post-commit caller needs only the id', async () => {
    const redis = makeFakeRedis();
    redis.store.set('tenant:slug:acme', '{}');
    redis.store.set('tenant:sub:acme-lib', '{}');
    const service = new TenantResolverService({ client: redis.client } as never);
    findUnique.mockResolvedValue({ slug: 'acme', customSubdomain: 'acme-lib' });

    await service.invalidateById('tnt-1');

    expect(redis.store.has('tenant:slug:acme')).toBe(false);
    expect(redis.store.has('tenant:sub:acme-lib')).toBe(false);
  });

  it('is a no-op for a tenant that no longer exists', async () => {
    const redis = makeFakeRedis();
    const del = vi.spyOn(redis.client, 'del');
    const service = new TenantResolverService({ client: redis.client } as never);
    findUnique.mockResolvedValue(null);

    await service.invalidateById('gone');

    expect(del).not.toHaveBeenCalled();
  });
});
