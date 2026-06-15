import { Inject, Injectable, Logger } from '@nestjs/common';
import { controlDb } from '@libriant/db-control';
import { RedisService } from '../platform/redis.service.js';
import { loadEnv } from '../config/env.js';
import type { TenantContext } from './tenant-context.js';

type CacheValue =
  | { found: true; tenant: TenantContext }
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

@Injectable()
export class TenantResolverService {
  private readonly logger = new Logger(TenantResolverService.name);
  private readonly ttlSec: number;

  constructor(@Inject(RedisService) private readonly redis: RedisService) {
    this.ttlSec = loadEnv().tenantCacheTtlSec;
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
      // Always overwrite resolvedFrom with the access path actually used —
      // a tenant might be reachable via both, but this request hit one of them.
      return { ...cached.tenant, resolvedFrom };
    }

    const tenant = await lookup();
    if (!tenant) {
      await this.writeCache(cacheKey, { found: false }, NEGATIVE_TTL_SEC);
      return null;
    }
    await this.writeCache(cacheKey, { found: true, tenant }, this.ttlSec);
    return { ...tenant, resolvedFrom };
  }

  private async readCache(key: string): Promise<CacheValue | null> {
    const raw = await this.redis.client.get(key);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as CacheValue;
    } catch {
      // Garbage in the cache → drop it.
      await this.redis.client.del(key);
      return null;
    }
  }

  private async writeCache(key: string, value: CacheValue, ttlSec: number): Promise<void> {
    await this.redis.client.set(key, JSON.stringify(value), 'EX', ttlSec);
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
