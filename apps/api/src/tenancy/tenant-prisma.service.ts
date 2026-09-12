import { Inject, Injectable, Logger, Optional, OnModuleDestroy } from '@nestjs/common';
import { LRUCache } from 'lru-cache';
import {
  makeTenantPrismaClient,
  makeTenantPrismaClientV2,
  v2SchemaFor,
  type TenantPrismaClient,
  type TenantPrismaClientV2,
} from '@libriant/db-tenant';
import { loadEnv } from '../config/env.js';
import {
  describeTenantPoolPlan,
  resolveTenantPoolPlan,
  TENANT_POOL_ROLE,
  type TenantPoolPlan,
  type TenantPoolRole,
} from '../platform/tenant-pool-budget.js';
import type { TenantContext } from './tenant-context.js';

/**
 * One cache entry per tenant, holding BOTH datamodels.
 *
 * Not two caches, deliberately. `assertUrlBelongsToTenant`, the
 * relocate-rebuild path and the eviction/disconnect story are each things that
 * must happen for a tenant, not for a client — and two caches means two places
 * that can disagree about which URL a tenant is on. A relocation that rebuilt
 * the 1.0 client and left a 2.0 client pointing at the old database would be a
 * cross-tenant read, which is the failure this service exists to prevent.
 *
 * The 2.0 client is built EAGERLY beside the 1.0 one rather than on first use,
 * so `clientsPerTenant: 2` in the connection budget is the truth rather than an
 * upper bound, and so a tenant's connection cost does not depend on which
 * endpoint happened to be called first.
 */
type Entry = {
  client: TenantPrismaClient;
  clientV2: TenantPrismaClientV2;
  dbUrl: string;
  /** Which schema `clientV2` was bound to, so a cutover invalidates it. */
  v2Schema: string;
};

/**
 * The database name a tenant id MUST map to.
 *
 * Kept byte-identical to `TenantProvisioningService.dbNameFor()` and to
 * `dbNameForTenant()` in scripts/_lib/cli.ts — the only three places a tenant
 * database is ever named, and `tenant-relocate.ts` moves the HOST while keeping
 * this name, so the mapping is a pure function of the id on every path in the
 * repo. Verified against the audit control plane: 47 of 47 tenant rows satisfy
 * it.
 */
function expectedDbName(tenantId: string): string {
  return `tenant_${tenantId.replace(/[^a-z0-9_]/gi, '_').toLowerCase()}`;
}

/**
 * tenant-isolation-02, the half that can be closed from here.
 *
 * Every tenant database is opened with the SAME Postgres superuser role — the
 * URL is built by swapping only the database name on `PG_SUPERUSER_URL`. The
 * audit demonstrated the consequence by connecting to library B's database with
 * the connection string held for library A and reading its members: the
 * separation between libraries is a physically separate database, enforced
 * ONLY by which connection string the application picks.
 *
 * The full fix (a per-tenant role, GRANTed to one database, with the secret in
 * the already-modelled `TenantDbCredential`) has to happen in provisioning and
 * needs a control-plane migration. What can be done HERE, on the hot path, is
 * to stop "which connection string the application picks" being unchecked: a
 * context that names tenant A but carries a URL pointing at any other database
 * is a bug or a poisoned cache, and it must not be allowed to quietly open and
 * read the wrong library's data.
 *
 * Fail CLOSED. A 500 for one tenant is recoverable; silently serving another
 * library's records is not, and it is the kind of defect nobody reports because
 * it looks like data that is simply there.
 *
 * The thrown message deliberately carries only the two database NAMES and the
 * tenant id — never the URL, which is a live superuser credential
 * (tenant-isolation-03) and would land in the log this error is written to.
 */
function assertUrlBelongsToTenant(tenantId: string, dbUrl: string): void {
  let dbName: string;
  try {
    dbName = new URL(dbUrl).pathname.replace(/^\//, '');
  } catch {
    throw new Error(
      `Refusing to open a tenant connection for ${tenantId}: its stored dbUrl is not a valid URL.`,
    );
  }
  const want = expectedDbName(tenantId);
  if (dbName !== want) {
    throw new Error(
      `Refusing to open a tenant connection for ${tenantId}: expected database "${want}" ` +
        `but the resolved context points at "${dbName}". This is a cross-tenant routing bug — ` +
        'the connection is NOT being opened.',
    );
  }
}

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
        // BOTH, or an eviction leaks a pool per tenant and the connection
        // budget silently stops describing reality.
        Promise.allSettled([entry.client.$disconnect(), entry.clientV2.$disconnect()])
          .then(() => this.logger.debug(`Disconnected tenant clients for ${key}`))
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
  getClient(ctx: Pick<TenantContext, 'id' | 'dbUrl' | 'schemaMajor'>): TenantPrismaClient {
    return this.entryFor(ctx).client;
  }

  /**
   * The same tenant database through the Libriant 2.0 datamodel.
   *
   * A separate client because the 2.0 tables live in their own Postgres schema
   * and their own generated Prisma client — see `packages/db-tenant/src/v2.ts`.
   * Same cache entry, same URL, same isolation guard.
   */
  getClientV2(ctx: Pick<TenantContext, 'id' | 'dbUrl' | 'schemaMajor'>): TenantPrismaClientV2 {
    return this.entryFor(ctx).clientV2;
  }

  private entryFor(ctx: Pick<TenantContext, 'id' | 'dbUrl' | 'schemaMajor'>): Entry {
    // Checked on EVERY call, not only on construction (tenant-isolation-02).
    // Gating it on the cache-miss path would make the guard's coverage depend
    // on cache state, which is exactly the kind of reasoning a cross-tenant
    // check should not require. One `new URL()` per request is microseconds.
    assertUrlBelongsToTenant(ctx.id, ctx.dbUrl);
    // KEYED ON THE SCHEMA AS WELL AS THE URL (2.0 phase 20f). A cutover changes
    // where this tenant's 2.0 tables are without changing its address, so a
    // cache that watched only the url would serve a promoted library a client
    // still bound to `lbr2` until the pod restarted.
    const v2Schema = v2SchemaFor(ctx.schemaMajor);
    const existing = this.cache.get(ctx.id);
    if (existing && existing.dbUrl === ctx.dbUrl && existing.v2Schema === v2Schema) {
      return existing;
    }
    if (existing) {
      this.logger.debug(`dbUrl or 2.0 schema changed for tenant ${ctx.id}; rebuilding clients.`);
      // Removing triggers `dispose`, which disconnects BOTH old clients.
      this.cache.delete(ctx.id);
    }
    const client = makeTenantPrismaClient({
      databaseUrl: ctx.dbUrl,
      maxPoolSize: this.plan.poolMax,
    });
    const clientV2 = makeTenantPrismaClientV2({
      databaseUrl: ctx.dbUrl,
      maxPoolSize: this.plan.poolMax,
      v2Schema,
    });
    const entry: Entry = { client, clientV2, dbUrl: ctx.dbUrl, v2Schema };
    this.cache.set(ctx.id, entry);
    this.logger.debug(`Created tenant clients for ${ctx.id} (cache size: ${this.cache.size}).`);
    return entry;
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
    await Promise.allSettled(
      entries.flatMap((e) => [e.client.$disconnect(), e.clientV2.$disconnect()]),
    );
    this.logger.log(`Disconnected ${entries.length} tenant client pair(s).`);
  }
}
