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
import { PG_SESSION_OPTIONS } from '@libriant/shared/postgres-session';
import { PrismaClient } from '../node_modules/.prisma/tenant-client/index.js';
import { PrismaClient as PrismaClientV2 } from '../node_modules/.prisma/tenant-v2-client/index.js';
import { V2_SCHEMA } from './v2.js';
export type TenantPrismaClient = PrismaClient;
/** The Libriant 2.0 client, bound to the `lbr2` schema. */
export type TenantPrismaClientV2 = PrismaClientV2;

/**
 * Default per-client pool ceiling. Matches the documented `connection_limit=5`
 * intent in TenantPrismaService — for the pilot (5–20 tenants on one Postgres)
 * each tenant client keeps at most 5 connections so the API + worker don't
 * exhaust Postgres `max_connections`. Env-tunable so the worker (which holds
 * one client at a time) can run leaner than the API.
 */
const DEFAULT_TENANT_POOL_MAX = 5;

/**
 * THE UTC SESSION, and why it is on the adapter rather than on the URL.
 *
 * `@prisma/adapter-pg` requires a UTC session and does not say so;
 * `packages/shared/src/postgres-session.ts` carries the measurement and the
 * whole argument. Both halves of its `timestamptz` handling assume it, and both
 * are silent when it is false — so a non-UTC session stores every instant wrong
 * by the offset while every comparison inside the application still agrees with
 * itself.
 *
 * This option is the BACKSTOP, not the mechanism. The mechanism is
 * `ALTER DATABASE … SET TimeZone TO 'UTC'`, applied at provisioning, which also
 * covers `prisma migrate deploy`, `psql` and `pg_dump`. What the option adds is
 * everything the mechanism cannot reach: a database somebody forgot to pin, a
 * cluster this product did not create, a restored dump, a customer's own
 * Postgres in a self-hosted install. MEASURED: a startup option is
 * `PGC_S_CLIENT` and OUTRANKS the per-database `PGC_S_DATABASE`, so against a
 * database pinned to `Asia/Kolkata` a connection carrying this still reports
 * `UTC`.
 *
 * IT MUST NEVER MOVE ONTO THE URL. `withV2Schema` (`./v2.ts`) puts the schema on
 * with `searchParams.set`, and `URLSearchParams` re-serialises a space as `+`:
 * MEASURED, `?options=-c%20timezone%3DUTC` survives one `set()` as
 * `options=-c+timezone%3DUTC`, which node-pg accepts silently and libpq answers
 * with `FATAL: unrecognized configuration parameter "+timezone"` — so psql,
 * pg_dump and the migrate CLI would break while the app looked fine.
 * `check:session-timezone` rule R4 refuses it.
 */

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
    options: PG_SESSION_OPTIONS,
  });
  return new PrismaClient({
    adapter,
    log: opts.log ?? ['warn', 'error'],
    errorFormat: 'minimal',
  });
}

/**
 * The same tenant database, through the 2.0 datamodel.
 *
 * ## The schema is an ADAPTER option, and nothing else works
 *
 * `packages/db-tenant/src/v2.ts` exports `withV2Schema`, which puts
 * `?schema=lbr2` on the URL. That is correct for the Prisma CLI — `migrate
 * deploy` reads it, creates the schema and keeps its `_prisma_migrations`
 * inside it — and it does NOTHING at runtime. Measured against this generated
 * client, three ways:
 *
 *   bare url, no adapter option        -> search_path is `"$user", public`;
 *                                         marcRecord.count() fails on
 *                                         `public.marc_records`
 *   url + `?schema=lbr2`, no option    -> IDENTICAL failure
 *   bare url + `{ schema: 'lbr2' }`    -> works
 *
 * So the URL is passed through UNMODIFIED here and the schema is handed to
 * `PrismaPg`'s second argument. Running the runtime URL through `withV2Schema`
 * would be harmless but misleading — it would look like the thing making this
 * work.
 *
 * ## Raw SQL is NOT covered by that option
 *
 * Also measured: with `{ schema: 'lbr2' }` in force, `$queryRaw` still executes
 * at the session's default search_path, so `SELECT … FROM marc_records` throws
 * `relation "marc_records" does not exist`. Every hand-written statement in a
 * 2.0 service must say `lbr2.`. The model API is schema-aware; raw SQL is not.
 */
export function makeTenantPrismaClientV2(opts: MakeTenantClientOptions): TenantPrismaClientV2 {
  const adapter = new PrismaPg(
    {
      connectionString: opts.databaseUrl,
      max: resolveMaxPoolSize(opts.maxPoolSize),
      options: PG_SESSION_OPTIONS,
    },
    { schema: V2_SCHEMA },
  );
  return new PrismaClientV2({
    adapter,
    log: opts.log ?? ['warn', 'error'],
    errorFormat: 'minimal',
  });
}

/**
 * Gracefully close a tenant client (typically called on process shutdown
 * or LRU eviction).
 */
export async function disconnectTenantClient(
  client: TenantPrismaClient | TenantPrismaClientV2,
): Promise<void> {
  await client.$disconnect();
}
