import { Inject, Injectable, Logger } from '@nestjs/common';
import { LRUCache } from 'lru-cache';
import { controlDb, type Prisma } from '@libriant/db-control';
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

/**
 * The Tenant columns the cached context is built from. A write to any of them
 * has to drop the cache; a write to anything else (branding, the free profile
 * fields, the storage counter) does not, and paying a Redis round trip for
 * those would be noise. `updateTenant()` reads this list rather than keeping a
 * second copy of it in a comment somewhere.
 */
const TENANT_SELECT = {
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

const CACHED_COLUMNS: ReadonlySet<string> = new Set(Object.keys(TENANT_SELECT));

function touchesCachedContext(data: Prisma.TenantUpdateInput): boolean {
  return Object.keys(data).some((column) => CACHED_COLUMNS.has(column));
}

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
   *
   * tenant-isolation-07 is what that "MUST call this" is worth on its own: the
   * library-rename approval wrote `tenants.name` and never called it, and every
   * process kept the old name for the rest of the TTL. Prefer
   * {@link updateTenant} / {@link invalidateById} below, which do not depend on
   * the next caller reading this paragraph.
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

  /**
   * Write a tenant row THROUGH the resolver so the cached copy cannot outlive
   * it. Prefer this to `controlDb.tenant.update` anywhere a tenant row changes.
   *
   * tenant-isolation-05 / -07: `invalidate()` has existed all along and its own
   * docblock has always said to call it; the approval path that renames a
   * library did not, and there is no reason to think the next writer will
   * either. Here the write and the invalidation are the same call, and which
   * columns need one is read off {@link TENANT_SELECT} — the very list the
   * cached context is built from — so a column added to the cache is covered
   * the day it is added, by nobody in particular.
   *
   * Returns the identifying columns only. Never widen this select to the whole
   * row: `dbUrl` is the fleet's superuser credential (tenant-isolation-03), and
   * a convenience field on a helper this central is how it ends up in a log
   * line or a JSON response.
   */
  async updateTenant(
    tenantId: string,
    data: Prisma.TenantUpdateInput,
  ): Promise<{ id: string; slug: string; name: string; status: TenantContext['status'] }> {
    // The cache keys are derived from `slug` and `customSubdomain`, and BOTH
    // are writable columns — so on a rename the row this write returns names
    // the NEW keys, and the entry an existing process is serving from is filed
    // under the OLD ones. Invalidating only the post-update values left the old
    // slug resolving the pre-rename context for the full TTL: the trap laid
    // inside the helper whose docblock says to prefer it to
    // `controlDb.tenant.update` precisely so nobody has to think about this.
    //
    // Read before, invalidate both. The extra SELECT is paid only on the writes
    // that touch a cached column — not on the branding and profile edits, which
    // are the common ones.
    const before = touchesCachedContext(data)
      ? await controlDb.tenant.findUnique({
          where: { id: tenantId },
          select: { slug: true, customSubdomain: true },
        })
      : null;
    const row = await controlDb.tenant.update({
      where: { id: tenantId },
      data,
      select: { id: true, slug: true, name: true, status: true, customSubdomain: true },
    });
    if (touchesCachedContext(data)) {
      await this.invalidate({ slug: row.slug, customSubdomain: row.customSubdomain });
      if (before && (before.slug !== row.slug || before.customSubdomain !== row.customSubdomain)) {
        await this.invalidate(before);
      }
    }
    return { id: row.id, slug: row.slug, name: row.name, status: row.status };
  }

  /**
   * Drop the cached context for a tenant known only by its id — the shape a
   * caller is left with once its own transaction has committed and it no longer
   * holds the slug.
   *
   * Invalidating from INSIDE that transaction was tried and rejected: it is
   * worse than not invalidating at all, because a concurrent request repopulates
   * the entry from the pre-commit row and the stale value then lives a full TTL
   * instead of the remainder of one.
   */
  async invalidateById(tenantId: string): Promise<void> {
    const row = await controlDb.tenant.findUnique({
      where: { id: tenantId },
      select: { slug: true, customSubdomain: true },
    });
    if (!row) return;
    await this.invalidate(row);
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
      select: TENANT_SELECT,
    });
    return row ? this.rowToContext(row, 'path') : null;
  }

  private async lookupBySubdomain(subdomain: string): Promise<TenantContext | null> {
    const row = await controlDb.tenant.findFirst({
      where: { customSubdomain: subdomain },
      select: TENANT_SELECT,
    });
    return row ? this.rowToContext(row, 'subdomain') : null;
  }

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
