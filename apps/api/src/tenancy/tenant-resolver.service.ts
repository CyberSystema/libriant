import { Inject, Injectable, Logger } from '@nestjs/common';
import { LRUCache } from 'lru-cache';
import { controlDb } from '@libriant/db-control';
import { FailOpenMemo, RedisService } from '../platform/redis.service.js';
import { loadEnv } from '../config/env.js';
import type { TenantContext } from './tenant-context.js';

/**
 * The half of a {@link TenantContext} that is safe to put in Redis.
 *
 * tenant-isolation-03. `resolveCached()` used to JSON-serialise the WHOLE
 * context into `lbr:tenant:slug:<slug>` on every cache miss — `dbUrl` included.
 * Because every tenant database is opened with the same Postgres SUPERUSER role
 * (tenant-isolation-02), that string is the fleet's master database credential
 * in plaintext, and the audit dumped it verbatim out of the running Redis:
 *
 *   {"found":true,"tenant":{…,"dbUrl":"postgresql://libriant:auditpw@…","…"}}
 *
 * The production Redis runs with `--appendonly yes` and no `requirepass`, so
 * that credential also lands in the `redis_data` AOF on disk, in a store that
 * needs no Postgres authentication to read.
 *
 * Nothing in the request path needs `dbUrl` to be SHARED between processes —
 * only to be fast within one. So the cross-process cache now carries the
 * routing/identity fields only, and the two address fields live in a
 * process-local map (below). Omitting them from the type rather than deleting
 * them at the call site is deliberate: a future field added to TenantContext
 * cannot silently leak into Redis, because this type has to be widened by hand.
 */
type CachedTenant = Omit<TenantContext, 'dbUrl' | 'storageUrl' | 'resolvedFrom'>;

/** The per-tenant addresses that must never leave this process. */
type TenantAddresses = Pick<TenantContext, 'dbUrl' | 'storageUrl'>;

type CacheValue =
  | { found: true; tenant: CachedTenant }
  /** Negative cache: prevents a tight-loop bcrypt-grade lookup against
   *  the control DB for a slug that doesn't exist. */
  | { found: false };

// Exported so other call sites that already hold the shared Redis client (e.g.
// the admin hard-delete path, TEN-03) can DEL the exact same keys this resolver
// writes, instead of re-deriving the namespace and risking drift.
export const SLUG_KEY = (slug: string) => `tenant:slug:${slug}`;
export const SUBDOMAIN_KEY = (sub: string) => `tenant:sub:${sub}`;
/** Short TTL for negative entries so an admin creating the tenant doesn't
 *  have to wait for the positive TTL to expire. */
const NEGATIVE_TTL_SEC = 30;
/**
 * How long a resolution Redis refused to store survives in-process. Only
 * consulted while Redis is erroring (BOOT-01) — see `readCache` below.
 */
const DEGRADED_MEMO_MS = 5_000;

/**
 * Ceiling on the process-local address map. Bounded because the key space is
 * attacker-influenced (any slug in a URL), and an unbounded Map keyed on that
 * is a memory-growth primitive. Comfortably above the fleet size for years.
 */
const ADDRESS_CACHE_MAX = 2_000;

@Injectable()
export class TenantResolverService {
  private readonly logger = new Logger(TenantResolverService.name);
  private readonly ttlSec: number;
  /** Populated only when Redis I/O throws — see FailOpenMemo. */
  private readonly degraded = new FailOpenMemo<CacheValue>(DEGRADED_MEMO_MS);
  /**
   * tenant-isolation-03: `dbUrl` / `storageUrl`, in memory, in THIS process
   * only, keyed by the same cache key as the Redis entry so `invalidate()`
   * clears both with one key list. Same TTL as the Redis entry, so the two
   * expire together and a relocate cannot be served from here after the shared
   * cache has already forgotten it.
   */
  private readonly addresses: LRUCache<string, TenantAddresses>;

  constructor(@Inject(RedisService) private readonly redis: RedisService) {
    this.ttlSec = loadEnv().tenantCacheTtlSec;
    this.addresses = new LRUCache<string, TenantAddresses>({
      max: ADDRESS_CACHE_MAX,
      ttl: this.ttlSec * 1000,
      ttlAutopurge: false,
      updateAgeOnGet: false,
    });
  }

  /**
   * Resolve by URL slug (`/t/<slug>/...`). Returns null if no such tenant.
   */
  async resolveBySlug(slug: string): Promise<TenantContext | null> {
    return this.resolveCached(SLUG_KEY(slug), () => this.lookupBySlug(slug), 'path');
  }

  /**
   * Resolve by custom subdomain (Host header). Returns null if no tenant
   * has opted in to that subdomain.
   */
  async resolveBySubdomain(subdomain: string): Promise<TenantContext | null> {
    return this.resolveCached(
      SUBDOMAIN_KEY(subdomain),
      () => this.lookupBySubdomain(subdomain),
      'subdomain',
    );
  }

  /**
   * Invalidate every cache key that could point at a given tenant. Called
   * from the admin UI / provisioning script whenever a tenant row changes.
   *
   * TEN-04: the cached context includes `status` (active/suspended/archived).
   * Any future code that mutates a tenant's status (suspend / archive /
   * reactivate, or a billing past_due → suspend transition) MUST call this, or
   * every API process will keep serving the stale status for up to the cache
   * TTL. Relocate, tenant-tags, and hard-delete already do.
   */
  async invalidate(opts: { slug?: string; customSubdomain?: string | null }): Promise<void> {
    const keys: string[] = [];
    if (opts.slug) keys.push(SLUG_KEY(opts.slug));
    if (opts.customSubdomain) keys.push(SUBDOMAIN_KEY(opts.customSubdomain));
    if (keys.length) {
      this.degraded.delete(...keys);
      // The process-local address map is keyed the same way, so a relocate that
      // moves `dbUrl` cannot be served from it after this call either.
      for (const k of keys) this.addresses.delete(k);
      // Deliberately NOT fail-open: this is the call that stops a suspended or
      // relocated tenant being served from cache (TEN-03 / TEN-04), so the
      // caller must learn that the invalidation did not happen.
      await this.redis.client.del(...keys);
      this.logger.debug(`Invalidated ${keys.length} cache key(s).`);
    }
  }

  // --- internals ---------------------------------------------------------

  private async resolveCached(
    cacheKey: string,
    lookup: () => Promise<TenantContext | null>,
    resolvedFrom: TenantContext['resolvedFrom'],
  ): Promise<TenantContext | null> {
    const cached = await this.readCache(cacheKey);
    if (cached) {
      if (!cached.found) return null;
      const addresses = this.addresses.get(cacheKey);
      // A positive shared entry with no local addresses means this process has
      // never resolved (or has since forgotten) this tenant — another API
      // container warmed Redis, or we restarted. That is a MISS here, not an
      // error: fall through to the control-plane lookup, which repopulates
      // both halves. It costs one control-DB read per tenant per process per
      // TTL, which is the price of the credential not being in Redis.
      if (addresses) {
        // Always overwrite resolvedFrom with the access path actually used —
        // a tenant might be reachable via both, but this request hit one of them.
        return { ...cached.tenant, ...addresses, resolvedFrom };
      }
    }

    const tenant = await lookup();
    if (!tenant) {
      await this.writeCache(cacheKey, { found: false }, NEGATIVE_TTL_SEC);
      return null;
    }
    // Destructured rather than deleted so TypeScript, not vigilance, is what
    // keeps `dbUrl`/`storageUrl` out of the value handed to Redis.
    //
    // Note the ordering property this gives every EXISTING invalidation path
    // for free: the local map is consulted ONLY after a positive Redis hit, so
    // a caller that deletes the Redis key directly — admin hard-delete
    // (admin-tenants.controller.ts), tenant-relocate.ts, storage-migrate.ts —
    // forces a control-plane lookup here, which overwrites the local entry.
    // None of them needs to learn about this cache.
    const { dbUrl, storageUrl, resolvedFrom: _ignored, ...shareable } = tenant;
    this.addresses.set(cacheKey, { dbUrl, storageUrl });
    await this.writeCache(cacheKey, { found: true, tenant: shareable }, this.ttlSec);
    return { ...tenant, resolvedFrom };
  }

  /**
   * Fail-open: a Redis error is reported as a cache miss so the caller falls
   * through to the control-plane lookup. BOOT-01 — this runs inside
   * SystemModeMiddleware on every `/t/<slug>/*` request, so an unguarded GET
   * here meant an unreachable Redis 500'd every tenant route rather than
   * degrading them to a control-DB read.
   */
  private async readCache(key: string): Promise<CacheValue | null> {
    let raw: string | null;
    try {
      raw = await this.redis.client.get(key);
    } catch (err) {
      this.logger.warn(
        `Redis read failed (${(err as Error).message}) — resolving the tenant from the DB.`,
      );
      return this.degraded.get(key);
    }
    if (!raw) return null;
    try {
      return JSON.parse(raw) as CacheValue;
    } catch {
      // Garbage in the cache → drop it (best-effort: see above).
      await this.redis.client.del(key).catch(() => undefined);
      return null;
    }
  }

  private async writeCache(key: string, value: CacheValue, ttlSec: number): Promise<void> {
    try {
      await this.redis.client.set(key, JSON.stringify(value), 'EX', ttlSec);
    } catch {
      // Redis wouldn't take it — hold it in-process for a few seconds so the
      // outage costs one control-DB lookup per slug, not one per request.
      this.degraded.set(key, value);
    }
  }

  private async lookupBySlug(slug: string): Promise<TenantContext | null> {
    const row = await controlDb.tenant.findUnique({
      where: { slug },
      select: this.tenantSelect,
    });
    return row ? this.rowToContext(row, 'path') : null;
  }

  private async lookupBySubdomain(subdomain: string): Promise<TenantContext | null> {
    const row = await controlDb.tenant.findFirst({
      where: { customSubdomain: subdomain },
      select: this.tenantSelect,
    });
    return row ? this.rowToContext(row, 'subdomain') : null;
  }

  private readonly tenantSelect = {
    id: true,
    slug: true,
    name: true,
    defaultLocale: true,
    status: true,
    dbUrl: true,
    storageUrl: true,
    customSubdomain: true,
    tags: true,
  } as const;

  private rowToContext(
    row: {
      id: string;
      slug: string;
      name: string;
      defaultLocale: string;
      status: TenantContext['status'];
      dbUrl: string;
      storageUrl: string;
      customSubdomain: string | null;
      tags: string[];
    },
    resolvedFrom: TenantContext['resolvedFrom'],
  ): TenantContext {
    return { ...row, resolvedFrom };
  }
}
