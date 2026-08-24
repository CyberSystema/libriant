import { Inject, Injectable, Logger, Optional, OnModuleDestroy } from '@nestjs/common';
import { LRUCache } from 'lru-cache';
import { makeTenantPrismaClient, type TenantPrismaClient } from '@libriant/db-tenant';
import { loadEnv } from '../config/env.js';
import {
  describeTenantPoolPlan,
  resolveTenantPoolPlan,
  TENANT_POOL_ROLE,
  type TenantPoolPlan,
  type TenantPoolRole,
} from '../platform/tenant-pool-budget.js';
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
 * Pooling note (performance-06): each PrismaClient maintains its own pool, and
 * the number of connections this service can hold is `cache.max × pool.max`.
 * That product used to be 50 × 5 = 250 against a server started with
 * `max_connections = 200`, i.e. the API alone could exhaust Postgres for every
 * tenant on the box — while four worker sweeps believed they were pinned to one
 * connection each by a `connection_limit=1` URL parameter that Prisma 7's
 * driver adapter does not read. Both numbers now come from
 * {@link resolveTenantPoolPlan}, and both are APPLIED here: `poolMax` is passed
 * to every client this service builds, and the LRU is sized from the same plan.
 *
 * `role` tells the planner which process this is: the worker's four concurrent
 * sweeps and the API's single long-lived instance have opposite shapes. It is
 * an OPTIONAL injected token rather than a plain constructor argument because
 * Nest reads `design:paramtypes` and would otherwise try to resolve a `String`
 * provider and refuse to boot the API entirely. The worker sweeps construct the
 * service by hand and pass `'worker'` positionally; the API gets the default,
 * and `platform/tenant-pool-budget.spec.ts` fails if a sweep ever forgets.
 */
@Injectable()
export class TenantPrismaService implements OnModuleDestroy {
  private readonly logger = new Logger(TenantPrismaService.name);
  private readonly cache: LRUCache<string, Entry>;
  private readonly plan: TenantPoolPlan;

  constructor(@Optional() @Inject(TENANT_POOL_ROLE) roleToken?: TenantPoolRole) {
    const role: TenantPoolRole = roleToken ?? 'api';
    const env = loadEnv();
    this.plan = resolveTenantPoolPlan(role, env.tenantClientCacheSize);
    const describe = describeTenantPoolPlan(this.plan);
    if (this.plan.clamped.length) this.logger.warn(describe);
    else this.logger.log(describe);
    this.cache = new LRUCache<string, Entry>({
      max: this.plan.clientCacheSize,
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
    const client = makeTenantPrismaClient({
      databaseUrl: ctx.dbUrl,
      maxPoolSize: this.plan.poolMax,
    });
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

  /** The connection budget this instance is running under. Read by /metrics. */
  poolPlan(): TenantPoolPlan {
    return this.plan;
  }

  async onModuleDestroy() {
    // Disconnect everything synchronously on shutdown.
    const entries = Array.from(this.cache.values());
    this.cache.clear();
    await Promise.allSettled(entries.map((e) => e.client.$disconnect()));
    this.logger.log(`Disconnected ${entries.length} tenant client(s).`);
  }
}
