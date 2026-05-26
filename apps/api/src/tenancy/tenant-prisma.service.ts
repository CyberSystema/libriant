import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { LRUCache } from 'lru-cache';
import { makeTenantPrismaClient, type TenantPrismaClient } from '@libriant/db-tenant';
import { loadEnv } from '../config/env.js';
import type { TenantContext } from './tenant-context.js';

type Entry = {
  client: TenantPrismaClient;
  dbUrl: string;
};

/**
 * Per-tenant Prisma client pool.
 *
 * Each tenant has its own database. Opening a fresh connection on every
 * request would crush Postgres, so we keep a hot LRU of `PrismaClient`
 * instances keyed by `tenantId`. When a client is evicted (idle TTL or
 * cache pressure), its connection is released.
 *
 * Invariants enforced here:
 *   - One client per tenantId in the cache at a time.
 *   - If `dbUrl` changes for a tenant (re-shard, relocate), the next
 *     getClient() call recreates the client against the new URL.
 *   - All cached clients are disconnected on graceful shutdown.
 *
 * Pooling note: each PrismaClient maintains its own internal pool. For the
 * pilot (5–20 tenants on one Postgres) we keep `connection_limit=5` by
 * default — tuneable per-tenant via env if a single tenant gets noisy.
 */
@Injectable()
export class TenantPrismaService implements OnModuleDestroy {
  private readonly logger = new Logger(TenantPrismaService.name);
  private readonly cache: LRUCache<string, Entry>;

  constructor() {
    const env = loadEnv();
    this.cache = new LRUCache<string, Entry>({
      max: env.tenantClientCacheSize,
      ttl: env.tenantClientIdleMs,
      ttlAutopurge: false,
      updateAgeOnGet: true,
      // Called on eviction or explicit delete — disconnect *async* but
      // we don't await (LRU dispose can't be async).
      dispose: (entry: Entry, key: string) => {
        entry.client
          .$disconnect()
          .then(() => this.logger.debug(`Disconnected tenant client for ${key}`))
          .catch((err: unknown) =>
            this.logger.warn(
              `Disconnect failed for ${key}: ${err instanceof Error ? err.message : err}`,
            ),
          );
      },
    });
  }

  /**
   * Get (or lazily create) the Prisma client for this tenant. Re-creates
   * the client if the cached one points at a different DB URL — which
   * happens after a tenant relocation.
   */
  getClient(ctx: Pick<TenantContext, 'id' | 'dbUrl'>): TenantPrismaClient {
    const existing = this.cache.get(ctx.id);
    if (existing && existing.dbUrl === ctx.dbUrl) {
      return existing.client;
    }
    if (existing) {
      this.logger.debug(`dbUrl changed for tenant ${ctx.id}; rebuilding client.`);
      // Removing triggers `dispose` which disconnects the old client.
      this.cache.delete(ctx.id);
    }
    const client = makeTenantPrismaClient({ databaseUrl: ctx.dbUrl });
    this.cache.set(ctx.id, { client, dbUrl: ctx.dbUrl });
    this.logger.debug(`Created tenant client for ${ctx.id} (cache size: ${this.cache.size}).`);
    return client;
  }

  /** Force-eviction (e.g. when an admin archives a tenant). */
  forget(tenantId: string): void {
    this.cache.delete(tenantId);
  }

  /** Diagnostic counter — exposed via /metrics later. */
  size(): number {
    return this.cache.size;
  }

  async onModuleDestroy() {
    // Disconnect everything synchronously on shutdown.
    const entries = Array.from(this.cache.values());
    this.cache.clear();
    await Promise.allSettled(entries.map((e) => e.client.$disconnect()));
    this.logger.log(`Disconnected ${entries.length} tenant client(s).`);
  }
}
