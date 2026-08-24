/**
 * How many Postgres connections this process is allowed to hold open against
 * tenant databases, and how to spend that allowance.
 *
 * WHY THIS EXISTS (performance-06). The code used to believe it had a
 * connection budget it did not have:
 *
 *   - `pinWorkerConnLimit()` appended `connection_limit=1` to the tenant URL and
 *     four cron sweeps documented that as their mitigation for
 *     "PER-JOB-TENANTPRISMA-CONN-MULTIPLY". `connection_limit` is a parameter of
 *     Prisma's OLD Rust engine. Under Prisma 7 driver adapters the pool size
 *     comes solely from `new PrismaPg({ connectionString, max })`, and node-pg
 *     ignores unknown query-string parameters, so the pin was decorative: the
 *     audit measured 5 open connections with the parameter present and 5
 *     without, and 1 only when `maxPoolSize` was actually passed.
 *
 *   - Independently, the API's ceiling was `TENANT_CLIENT_CACHE_SIZE` (50)
 *     × `TENANT_DB_POOL_MAX` (5) = 250 connections against a server configured
 *     with `max_connections = 200` (infra/compose/docker-compose.prod.yml). Past
 *     roughly 40 concurrently-active libraries the API alone could exhaust
 *     Postgres, and pgbouncer cannot absorb it because it fronts only the
 *     control database — tenant URLs are derived from `PG_SUPERUSER_URL` and go
 *     straight to `postgres:5432`.
 *
 * So the arithmetic is done here, once, explicitly, and the result is APPLIED
 * (TenantPrismaService passes `poolMax` to every client it builds and sizes its
 * LRU from `clientCacheSize`) rather than described in a comment.
 *
 * This function never throws. A boot guard that refuses to start on a
 * misconfigured number would turn a capacity problem into an outage; instead it
 * CLAMPS and reports what it clamped, and the caller logs that at warn level.
 */

/** Which process is asking. The two have very different access patterns. */
export type TenantPoolRole = 'api' | 'worker';

/**
 * DI token for {@link TenantPoolRole}. TenantPrismaService takes the role as an
 * OPTIONAL injected value, not a plain constructor argument: Nest resolves
 * constructor parameters from `design:paramtypes`, so a bare `role: string`
 * makes it look for a `String` provider and the whole API refuses to boot.
 */
export const TENANT_POOL_ROLE = Symbol('TENANT_POOL_ROLE');

export type TenantPoolPlan = {
  role: TenantPoolRole;
  /** Max distinct tenant clients held open at once by ONE service instance. */
  clientCacheSize: number;
  /** Max Postgres connections per tenant client. */
  poolMax: number;
  /** How many service instances of this role can be alive at the same time. */
  concurrentInstances: number;
  /** clientCacheSize × poolMax × concurrentInstances — the whole role's peak. */
  peakConnections: number;
  /** Connections the whole role is allowed to reach. */
  budget: number;
  /** budget ÷ concurrentInstances — what ONE service instance may spend. */
  perInstanceBudget: number;
  /** `max_connections` on the shared server, as configured for this process. */
  serverMaxConnections: number;
  /** Human-readable notes about anything that had to be reduced. */
  clamped: string[];
};

/**
 * Connections that are NOT available for tenant databases: Postgres'
 * `superuser_reserved_connections` (3), the control-plane Prisma pool, the
 * provisioning superuser client, pgbouncer's own server-side connections, and
 * enough headroom that an operator can still get a `psql` in during an
 * incident. 30 is deliberately generous — running out of connections is a
 * whole-platform outage, running a few short is a slow page.
 */
const DEFAULT_RESERVED_CONNECTIONS = 30;

/**
 * `max_connections` of the shared Postgres. MUST match what the server is
 * actually started with (infra/compose/docker-compose.prod.yml passes
 * `-c max_connections=200`); if the two ever disagree, this one being the
 * SMALLER of the pair is the safe direction.
 */
const DEFAULT_SERVER_MAX_CONNECTIONS = 200;

/**
 * Share of the tenant budget each role may claim. They add to less than 1: the
 * API and the worker are separate processes against the same server, so their
 * peaks add up, and the remainder is slack for a rolling deploy where an old
 * and a new API container overlap.
 */
const ROLE_SHARE: Record<TenantPoolRole, number> = { api: 0.7, worker: 0.25 };

/**
 * How many TenantPrismaService instances can be alive at once in the worker.
 *
 * Each per-tenant sweep constructs its OWN TenantPrismaService and only
 * destroys it in its `finally`, so its whole LRU is held for the length of the
 * run — and four of these sweeps (fine accrual, member notifications,
 * reservation pickup expiry, book-metadata refresh) can overlap on the hour.
 * The worker's share is therefore divided four ways rather than handed to each
 * sweep in full.
 */
const WORKER_CONCURRENT_SWEEPS = 4;

/**
 * A sequential per-tenant sweep needs exactly one connection at a time, and
 * keeping more than a handful of tenant clients hot inside a single sweep buys
 * nothing (it visits each tenant once, in order). Capping the worker's LRU here
 * is what makes the four-way division above affordable.
 */
const WORKER_MAX_CLIENT_CACHE = 8;

const readInt = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
};

/**
 * Pure planner — all inputs explicit so the arithmetic can be unit-tested
 * without an environment.
 */
export function planTenantPool(input: {
  role: TenantPoolRole;
  requestedCacheSize: number;
  requestedPoolMax: number;
  serverMaxConnections?: number;
  reservedConnections?: number;
}): TenantPoolPlan {
  const { role } = input;
  const serverMaxConnections = Math.max(
    1,
    Math.floor(input.serverMaxConnections ?? DEFAULT_SERVER_MAX_CONNECTIONS),
  );
  const reserved = Math.max(
    0,
    Math.floor(input.reservedConnections ?? DEFAULT_RESERVED_CONNECTIONS),
  );
  const clamped: string[] = [];

  const owners = role === 'worker' ? WORKER_CONCURRENT_SWEEPS : 1;
  const shared = Math.max(1, serverMaxConnections - reserved);
  // Budget for the whole role, and the slice ONE service instance may spend.
  const budget = Math.max(1, Math.floor(shared * ROLE_SHARE[role]));
  const perInstanceBudget = Math.max(1, Math.floor(budget / owners));

  let cacheSize = Math.max(1, Math.floor(input.requestedCacheSize));
  let poolMax = Math.max(1, Math.floor(input.requestedPoolMax));

  if (role === 'worker') {
    if (poolMax > 1) {
      clamped.push(
        `poolMax ${poolMax}→1 (a per-tenant sweep is sequential; one connection is all it can use)`,
      );
      poolMax = 1;
    }
    if (cacheSize > WORKER_MAX_CLIENT_CACHE) {
      clamped.push(`clientCacheSize ${cacheSize}→${WORKER_MAX_CLIENT_CACHE} (worker cap)`);
      cacheSize = WORKER_MAX_CLIENT_CACHE;
    }
  }

  // The LRU size is a working-set decision the operator makes; the pool DEPTH
  // is what yields to the connection budget. Shrinking the cache instead would
  // make every request past the 20th tenant pay a fresh connect.
  if (cacheSize * poolMax > perInstanceBudget) {
    const fitted = Math.max(1, Math.floor(perInstanceBudget / cacheSize));
    if (fitted < poolMax) {
      clamped.push(
        `poolMax ${poolMax}→${fitted} so ${cacheSize} tenant clients × ${fitted} ≤ ${perInstanceBudget}`,
      );
      poolMax = fitted;
    }
  }
  // Only if a single connection per tenant client still overshoots does the
  // cache itself have to give — at that point the box simply cannot hold this
  // many tenants at once and thrashing is better than refusing connections.
  if (cacheSize * poolMax > perInstanceBudget) {
    const fitted = Math.max(1, perInstanceBudget);
    clamped.push(
      `clientCacheSize ${cacheSize}→${fitted} (budget ${perInstanceBudget} is below one per tenant)`,
    );
    cacheSize = fitted;
  }

  return {
    role,
    clientCacheSize: cacheSize,
    poolMax,
    concurrentInstances: owners,
    peakConnections: cacheSize * poolMax * owners,
    budget,
    perInstanceBudget,
    serverMaxConnections,
    clamped,
  };
}

/** Environment-driven wrapper used by TenantPrismaService and the worker boot. */
export function resolveTenantPoolPlan(
  role: TenantPoolRole,
  requestedCacheSize: number,
): TenantPoolPlan {
  return planTenantPool({
    role,
    requestedCacheSize,
    requestedPoolMax: readInt('TENANT_DB_POOL_MAX', 5),
    serverMaxConnections: readInt('PG_MAX_CONNECTIONS', DEFAULT_SERVER_MAX_CONNECTIONS),
    reservedConnections: readInt('PG_RESERVED_CONNECTIONS', DEFAULT_RESERVED_CONNECTIONS),
  });
}

/** One-line summary for the boot log, so the real numbers are observable. */
export function describeTenantPoolPlan(plan: TenantPoolPlan): string {
  const owners =
    plan.concurrentInstances > 1 ? ` × ${plan.concurrentInstances} concurrent sweep(s)` : '';
  const base =
    `tenant pool [${plan.role}]: ${plan.clientCacheSize} client(s) × ${plan.poolMax} connection(s)` +
    `${owners} = peak ${plan.peakConnections} of a ${plan.budget} budget` +
    ` (server max_connections ${plan.serverMaxConnections})`;
  return plan.clamped.length ? `${base}; clamped: ${plan.clamped.join('; ')}` : base;
}
