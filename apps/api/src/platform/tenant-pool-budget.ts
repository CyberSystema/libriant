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
 * peaks add up, and the remainder is slack for the overlap while a recreated
 * API container's old backends close.
 *
 * NOT slack for a second full API instance — that would need a share of about
 * 0.35 each. See DEFAULT_API_INSTANCES and the aggregate planner below, which
 * is where the total is finally added up.
 */
const ROLE_SHARE: Record<TenantPoolRole, number> = { api: 0.7, worker: 0.25 };

/**
 * How many TenantPrismaService instances can be alive at once in the worker.
 *
 * Each per-tenant sweep constructs its OWN TenantPrismaService and only
 * destroys it in its `finally`, so its whole LRU is held for the length of the
 * run. The worker's share is therefore divided this many ways rather than
 * handed to each sweep in full.
 *
 * FOUR because that is `concurrency: 4` on the scheduled-jobs BullMQ worker
 * (scheduled-jobs.runner.ts) — NOT because there are four sweeps. This comment
 * used to enumerate "fine accrual, member notifications, reservation pickup
 * expiry, book-metadata refresh", which stopped being the whole list the moment
 * retention-sweep and storage-usage-recompute were added; the enumeration was
 * wrong and the number stayed right, which is the worst of both. The concurrency
 * is what bounds the overlap, so raising it there without raising it here
 * silently doubles the worker's real peak — and `tenant-pool-budget.spec.ts`
 * fails when the two disagree.
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

// ---------------------------------------------------------------------------
// The AGGREGATE budget — every process together, against one server.
// ---------------------------------------------------------------------------

/**
 * How many API instances can hold tenant connections at the same time.
 *
 * ONE, and that is a fact about this deployment rather than an optimistic
 * default. `scripts/deploy-on-host.sh` recreates the stack with
 * `dc up -d --force-recreate`, and Compose's recreate is stop-then-start: the
 * old `api` container is down before the new one is up. There is no window in
 * which two full API pools exist — only a brief overlap while the old
 * container's backends close, which is what the 30-connection reserve and the
 * 5 % left unclaimed by ROLE_SHARE are for.
 *
 * Set `API_INSTANCES` if that ever changes. It is worth knowing what the answer
 * would be: at the shipped numbers, TWO api instances put the fleet 62
 * connections over `max_connections=200`, and `tenant-pool-budget.spec.ts`
 * asserts that so nobody scales out and discovers it from a `FATAL: sorry, too
 * many clients already` at the worst moment.
 */
const DEFAULT_API_INSTANCES = 1;

/**
 * Tenant connections the worker holds OUTSIDE the sweeps' shared LRU.
 *
 * `planTenantPool('worker', …)` sizes only the TenantPrismaService the
 * scheduled sweeps share. Three other consumers open tenant connections of
 * their own and are invisible to it:
 *
 *   import       one Prisma client per batch, `concurrency: 1`, pinned to
 *                `maxPoolSize: 1` (it walks one tenant's rows in order)
 *   maintenance  one Prisma client per tenant, `concurrency: 1`, likewise pinned
 *   export       one raw `pg` client per job, `concurrency: 1`
 *
 * Three, therefore — and they are counted here rather than left out, because
 * "every individual plan says it is within budget" is exactly how the total
 * went unchecked the first time. Each is pinned to a single connection at its
 * own call site; if any of them ever raises its concurrency or its pool, this
 * number has to move with it.
 */
const WORKER_STANDALONE_TENANT_CLIENTS = 3;

export type FleetConnectionPlan = {
  serverMaxConnections: number;
  reserved: number;
  apiInstances: number;
  api: TenantPoolPlan;
  worker: TenantPoolPlan;
  /** Every process's tenant peak, added up. */
  tenantPeak: number;
  /** `tenantPeak` plus the reserve — what the server must actually be able to hold. */
  totalPeak: number;
  /** `serverMaxConnections − totalPeak`. Negative means over-committed. */
  headroom: number;
  /** Connections ONE tenant's login role can attract across the whole fleet. */
  perTenantPeak: number;
  /** The `CONNECTION LIMIT` provisioning sets on each tenant login role. */
  perTenantLimit: number;
  /** Empty when the budget fits. Each entry names a ceiling that is crossed. */
  problems: string[];
};

/**
 * The whole fleet's connection arithmetic, in one place, so it can be asserted.
 *
 * WHY THIS EXISTS. `planTenantPool` above answers "how much may THIS process
 * spend", and it answers it correctly — but nothing added the answers up. The
 * API's share and the worker's share are computed from the same server ceiling
 * by two independent calls that never meet, so a change to either one (a bigger
 * LRU, a fifth concurrent sweep, a second API replica) could push the total
 * past `max_connections` with every individual plan still reporting itself
 * within budget. That is the same shape as performance-06 itself: a limit each
 * component believed it was respecting, and no one place where the total was
 * written down.
 *
 * Phase 4 added a second ceiling on top of it. Every tenant database now has
 * its own login role with `CONNECTION LIMIT`, so a single busy library can be
 * refused connections while the server as a whole is nowhere near full — a
 * failure that looks nothing like exhaustion and would be diagnosed as one.
 * `perTenantPeak` is what that limit has to cover.
 *
 * Pure, with every input explicit, so `tenant-pool-budget.spec.ts` can assert
 * the shipped defaults fit AND that a deliberately over-committed configuration
 * is reported rather than clamped into silence.
 */
export function planFleetConnections(input: {
  requestedCacheSize: number;
  requestedPoolMax: number;
  serverMaxConnections?: number;
  reservedConnections?: number;
  apiInstances?: number;
  perTenantConnectionLimit: number;
}): FleetConnectionPlan {
  const serverMaxConnections = Math.max(
    1,
    Math.floor(input.serverMaxConnections ?? DEFAULT_SERVER_MAX_CONNECTIONS),
  );
  const reserved = Math.max(
    0,
    Math.floor(input.reservedConnections ?? DEFAULT_RESERVED_CONNECTIONS),
  );
  const apiInstances = Math.max(1, Math.floor(input.apiInstances ?? DEFAULT_API_INSTANCES));
  const common = {
    requestedCacheSize: input.requestedCacheSize,
    requestedPoolMax: input.requestedPoolMax,
    serverMaxConnections,
    reservedConnections: reserved,
  };
  const api = planTenantPool({ role: 'api', ...common });
  const worker = planTenantPool({ role: 'worker', ...common });

  const tenantPeak =
    api.peakConnections * apiInstances + worker.peakConnections + WORKER_STANDALONE_TENANT_CLIENTS;
  const totalPeak = tenantPeak + reserved;
  const headroom = serverMaxConnections - totalPeak;

  // One library, at its worst: every API instance holding a full pool for it,
  // every concurrent worker sweep holding its own, AND the three standalone
  // consumers all working on that same library at once — an import running
  // while an operator vacuums it and an export reads it is unusual but
  // entirely possible, and it is the case where the per-role CONNECTION LIMIT
  // bites while the server as a whole is fine.
  const perTenantPeak =
    api.poolMax * apiInstances +
    worker.poolMax * worker.concurrentInstances +
    WORKER_STANDALONE_TENANT_CLIENTS;
  const perTenantLimit = Math.max(1, Math.floor(input.perTenantConnectionLimit));

  const problems: string[] = [];
  if (headroom < 0) {
    problems.push(
      `over-committed by ${-headroom}: ${apiInstances} api instance(s) × ${api.peakConnections} + ` +
        `worker ${worker.peakConnections} + ${WORKER_STANDALONE_TENANT_CLIENTS} standalone + ` +
        `${reserved} reserved = ${totalPeak} > max_connections ${serverMaxConnections}`,
    );
  }
  if (perTenantPeak > perTenantLimit) {
    problems.push(
      `one tenant can attract ${perTenantPeak} connections (${apiInstances} × ${api.poolMax} api + ` +
        `${worker.concurrentInstances} × ${worker.poolMax} sweeps + ` +
        `${WORKER_STANDALONE_TENANT_CLIENTS} standalone) but its role's CONNECTION LIMIT is ` +
        `${perTenantLimit} — that library would be refused while the server has room`,
    );
  }
  return {
    serverMaxConnections,
    reserved,
    apiInstances,
    api,
    worker,
    tenantPeak,
    totalPeak,
    headroom,
    perTenantPeak,
    perTenantLimit,
    problems,
  };
}

/** Environment-driven wrapper. Same env vars the per-role planner reads. */
export function resolveFleetConnectionPlan(
  requestedCacheSize: number,
  perTenantConnectionLimit: number,
): FleetConnectionPlan {
  return planFleetConnections({
    requestedCacheSize,
    requestedPoolMax: readInt('TENANT_DB_POOL_MAX', 5),
    serverMaxConnections: readInt('PG_MAX_CONNECTIONS', DEFAULT_SERVER_MAX_CONNECTIONS),
    reservedConnections: readInt('PG_RESERVED_CONNECTIONS', DEFAULT_RESERVED_CONNECTIONS),
    apiInstances: readInt('API_INSTANCES', DEFAULT_API_INSTANCES),
    perTenantConnectionLimit,
  });
}

/** One-line summary of the aggregate, for the boot log. */
export function describeFleetConnectionPlan(plan: FleetConnectionPlan): string {
  const base =
    `fleet connections: ${plan.apiInstances} × api ${plan.api.peakConnections} + ` +
    `worker ${plan.worker.peakConnections} + ${WORKER_STANDALONE_TENANT_CLIENTS} standalone + ` +
    `${plan.reserved} reserved = ${plan.totalPeak} ` +
    `of ${plan.serverMaxConnections} (headroom ${plan.headroom}); ` +
    `worst case per tenant ${plan.perTenantPeak} of a ${plan.perTenantLimit} role limit`;
  return plan.problems.length ? `${base}; OVER BUDGET: ${plan.problems.join('; ')}` : base;
}
