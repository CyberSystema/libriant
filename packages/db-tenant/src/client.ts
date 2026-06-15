// Each tenant has its own Prisma client, instantiated with that tenant's
// `db_url` (from the control plane). This file exports a FACTORY — the
// actual per-tenant caching, LRU eviction, and graceful shutdown live in
// `TenantPrismaService` (added in Step 6). For now: a typed factory and a
// disposer.
//
// Prisma 7 connects through a driver adapter, so each tenant's connection
// string is handed to a fresh `@prisma/adapter-pg` instance instead of the
// old `datasources` constructor option.
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../node_modules/.prisma/tenant-client/index.js';
export type TenantPrismaClient = PrismaClient;

/**
 * Default per-client pool ceiling. Matches the documented `connection_limit=5`
 * intent in TenantPrismaService — for the pilot (5–20 tenants on one Postgres)
 * each tenant client keeps at most 5 connections so the API + worker don't
 * exhaust Postgres `max_connections`. Env-tunable so the worker (which holds
 * one client at a time) can run leaner than the API.
 */
const DEFAULT_TENANT_POOL_MAX = 5;

function resolveMaxPoolSize(explicit?: number): number {
  if (typeof explicit === 'number' && Number.isFinite(explicit) && explicit > 0) {
    return Math.floor(explicit);
  }
  const fromEnv = Number(process.env.TENANT_DB_POOL_MAX);
  if (Number.isFinite(fromEnv) && fromEnv > 0) {
    return Math.floor(fromEnv);
  }
  return DEFAULT_TENANT_POOL_MAX;
}

export type MakeTenantClientOptions = {
  /** Per-tenant Postgres URL. Required. */
  databaseUrl: string;
  /** Override Prisma's log targets. Default: warn + error. */
  log?: ('query' | 'info' | 'warn' | 'error')[];
  /**
   * Max Postgres connections this client's pool may open. Defaults to
   * `TENANT_DB_POOL_MAX` (env) or {@link DEFAULT_TENANT_POOL_MAX}. Callers such
   * as the worker can pass a smaller value than the API.
   */
  maxPoolSize?: number;
};

/**
 * Build a brand-new PrismaClient bound to a tenant database URL. Callers
 * own the lifecycle — remember to `await client.$disconnect()` when done.
 */
export function makeTenantPrismaClient(opts: MakeTenantClientOptions): TenantPrismaClient {
  // jobs-new-Tenant PrismaPg pool: cap the underlying pg pool so reality
  // matches the documented connection_limit=5 — without `max`, pg defaults to
  // ~10 connections per client and exhausts Postgres at half the tenant count.
  const adapter = new PrismaPg({
    connectionString: opts.databaseUrl,
    max: resolveMaxPoolSize(opts.maxPoolSize),
  });
  return new PrismaClient({
    adapter,
    log: opts.log ?? ['warn', 'error'],
    errorFormat: 'minimal',
  });
}

/**
 * Gracefully close a tenant client (typically called on process shutdown
 * or LRU eviction).
 */
export async function disconnectTenantClient(client: TenantPrismaClient): Promise<void> {
  await client.$disconnect();
}
