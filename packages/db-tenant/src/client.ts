// Each tenant has its own Prisma client, instantiated with that tenant's
// `db_url` (from the control plane). This file exports a FACTORY — the
// actual per-tenant caching, LRU eviction, and graceful shutdown live in
// `TenantPrismaService` (added in Step 6). For now: a typed factory and a
// disposer.
import { PrismaClient } from '../node_modules/.prisma/tenant-client/index.js';
export type TenantPrismaClient = PrismaClient;

export type MakeTenantClientOptions = {
  /** Per-tenant Postgres URL. Required. */
  databaseUrl: string;
  /** Override Prisma's log targets. Default: warn + error. */
  log?: ('query' | 'info' | 'warn' | 'error')[];
};

/**
 * Build a brand-new PrismaClient bound to a tenant database URL. Callers
 * own the lifecycle — remember to `await client.$disconnect()` when done.
 */
export function makeTenantPrismaClient(opts: MakeTenantClientOptions): TenantPrismaClient {
  return new PrismaClient({
    datasources: { db: { url: opts.databaseUrl } },
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
