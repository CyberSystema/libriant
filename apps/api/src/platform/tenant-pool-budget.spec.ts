import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CLIENTS_PER_TENANT,
  planTenantPool,
  planFleetConnections,
  describeTenantPoolPlan,
  describeFleetConnectionPlan,
} from './tenant-pool-budget.js';
import { DEFAULT_ROLE_LIMITS } from '@libriant/db-control';

/**
 * performance-06. Two things are worth guarding here, and they are different
 * kinds of thing:
 *
 *   1. the arithmetic — that the numbers the API and the worker are allowed to
 *      reach actually add up to less than the server has;
 *   2. the WIRING — that the four cron sweeps ask for the worker plan. The
 *      previous mitigation for this exact finding compiled, was documented in
 *      four files, and did nothing, because the thing that was supposed to
 *      apply it never ran. A unit test that only exercised the planner would
 *      have passed just as happily then.
 */

const SHIPPED_MAX_CONNECTIONS = 200; // infra/compose/docker-compose.prod.yml
const SHIPPED_CACHE_SIZE = 50; // TENANT_CLIENT_CACHE_SIZE default, env.ts
const SHIPPED_POOL_MAX = 5; // TENANT_DB_POOL_MAX default, packages/db-tenant

describe('planTenantPool (performance-06 arithmetic)', () => {
  it('keeps API + worker peaks together under the shipped max_connections', () => {
    const api = planTenantPool({
      role: 'api',
      requestedCacheSize: SHIPPED_CACHE_SIZE,
      requestedPoolMax: SHIPPED_POOL_MAX,
    });
    const worker = planTenantPool({
      role: 'worker',
      requestedCacheSize: SHIPPED_CACHE_SIZE,
      requestedPoolMax: SHIPPED_POOL_MAX,
    });
    // The audited number was 50 x 5 = 250 against max_connections=200.
    expect(SHIPPED_CACHE_SIZE * SHIPPED_POOL_MAX).toBeGreaterThan(SHIPPED_MAX_CONNECTIONS);
    expect(api.peakConnections + worker.peakConnections).toBeLessThan(SHIPPED_MAX_CONNECTIONS);
  });

  it('pins the worker to ONE connection per tenant client — the pin the URL never applied', () => {
    const worker = planTenantPool({
      role: 'worker',
      requestedCacheSize: SHIPPED_CACHE_SIZE,
      requestedPoolMax: SHIPPED_POOL_MAX,
    });
    expect(worker.poolMax).toBe(1);
    // Four sweeps can overlap, each with its own service instance.
    expect(worker.concurrentInstances).toBe(4);
    expect(worker.peakConnections).toBe(worker.clientCacheSize * 4);
    expect(worker.peakConnections).toBeLessThanOrEqual(worker.budget);
  });

  it('shrinks the POOL, not the tenant cache, when the budget is tight', () => {
    const plan = planTenantPool({
      role: 'api',
      requestedCacheSize: 50,
      requestedPoolMax: 5,
      serverMaxConnections: 200,
    });
    expect(plan.clientCacheSize).toBe(50);
    expect(plan.poolMax).toBeLessThan(5);
    expect(plan.clientCacheSize * plan.poolMax).toBeLessThanOrEqual(plan.perInstanceBudget);
  });

  it('gives back the operator’s numbers untouched when they already fit', () => {
    const plan = planTenantPool({
      role: 'api',
      requestedCacheSize: 10,
      requestedPoolMax: 5,
      serverMaxConnections: 200,
    });
    expect(plan.poolMax).toBe(5);
    expect(plan.clientCacheSize).toBe(10);
    expect(plan.clamped).toEqual([]);
  });

  it('never returns zero and never overspends its slice, for absurd inputs', () => {
    for (const [cache, pool, max] of [
      [10_000, 100, 200],
      [1, 1, 1],
      [0, 0, 40],
      [500, 500, 32],
      [50, 5, 1000],
    ] as const) {
      for (const role of ['api', 'worker'] as const) {
        const plan = planTenantPool({
          role,
          requestedCacheSize: cache,
          requestedPoolMax: pool,
          serverMaxConnections: max,
        });
        const label = `${role} cache=${cache} pool=${pool} max=${max}`;
        expect(plan.poolMax, label).toBeGreaterThanOrEqual(1);
        expect(plan.clientCacheSize, label).toBeGreaterThanOrEqual(1);
        // The invariant that always holds: ONE service instance stays inside
        // the slice it was given. (On a server with a single connection there
        // is no plan that lets four sweeps run at once — that is a broken
        // deployment, not something the planner can arithmetic its way out of,
        // and clamping to 1x1 is the most it can honestly do.)
        expect(plan.clientCacheSize * plan.poolMax, label).toBeLessThanOrEqual(
          plan.perInstanceBudget,
        );
      }
    }
  });

  it('fits the whole role inside max_connections on any realistically-sized server', () => {
    for (const max of [64, 100, 200, 500, 1000]) {
      const api = planTenantPool({
        role: 'api',
        requestedCacheSize: 50,
        requestedPoolMax: 5,
        serverMaxConnections: max,
      });
      const worker = planTenantPool({
        role: 'worker',
        requestedCacheSize: 50,
        requestedPoolMax: 5,
        serverMaxConnections: max,
      });
      expect(api.peakConnections + worker.peakConnections, `max_connections=${max}`).toBeLessThan(
        max,
      );
    }
  });

  it('reports what it clamped, so the boot log carries the real numbers', () => {
    const plan = planTenantPool({ role: 'worker', requestedCacheSize: 50, requestedPoolMax: 5 });
    const line = describeTenantPoolPlan(plan);
    expect(line).toContain('tenant pool [worker]');
    expect(line).toContain('clamped:');
    expect(line).toContain('max_connections 200');
  });
});

describe('worker wiring (the half that was missing last time)', () => {
  const jobsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'jobs');

  it('every per-tenant sweep constructs TenantPrismaService with the worker role', () => {
    const offenders: string[] = [];
    let constructions = 0;
    for (const file of readdirSync(jobsDir)) {
      if (!file.endsWith('.job.ts')) continue;
      const src = readFileSync(path.join(jobsDir, file), 'utf8');
      for (const m of src.matchAll(/new TenantPrismaService\(([^)]*)\)/g)) {
        constructions++;
        if (m[1]!.trim() !== "'worker'")
          offenders.push(`${file}: new TenantPrismaService(${m[1]})`);
      }
    }
    // If this ever finds nothing, the sweeps stopped using the service and this
    // test has quietly become vacuous — fail rather than pass on an empty set.
    expect(constructions).toBeGreaterThanOrEqual(4);
    expect(offenders).toEqual([]);
  });

  it("the sweep-overlap divisor equals the scheduled worker's BullMQ concurrency", () => {
    // WORKER_CONCURRENT_SWEEPS is 4 because `concurrency: 4` bounds how many
    // sweeps can hold a TenantPrismaService at once — not because there happen
    // to be four sweeps. Raising the concurrency to chase a backlog would
    // silently double the worker's real connection peak, and nothing else in
    // the repository connects the two numbers.
    const runner = readFileSync(path.join(jobsDir, 'scheduled-jobs.runner.ts'), 'utf8');
    const m = /concurrency:\s*(\d+)/.exec(runner);
    expect(m, 'scheduled-jobs.runner.ts no longer sets a BullMQ concurrency').toBeTruthy();
    const plan = planTenantPool({ role: 'worker', requestedCacheSize: 8, requestedPoolMax: 1 });
    expect(
      plan.concurrentInstances,
      `WORKER_CONCURRENT_SWEEPS (${plan.concurrentInstances}) must match the runner's ` +
        `concurrency (${m![1]})`,
    ).toBe(Number(m![1]));
  });

  it('no job still appends the connection_limit URL parameter Prisma 7 ignores', () => {
    // Comments are allowed to name it — they explain why it is gone. Only CODE
    // must be free of it, so strip comments before looking.
    const stripComments = (s: string) =>
      s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
    for (const file of readdirSync(jobsDir)) {
      if (!file.endsWith('.ts')) continue;
      const src = stripComments(readFileSync(path.join(jobsDir, file), 'utf8'));
      expect(src, `${file} still pins connection_limit in the URL`).not.toMatch(
        /connection_limit=/,
      );
    }
  });
});

/**
 * The AGGREGATE, which nothing added up before 2.0 phase 5.
 *
 * `planTenantPool` answers "how much may THIS process spend" and answers it
 * correctly, but the API's share and the worker's share are computed by two
 * independent calls that never meet. A bigger LRU, a fifth concurrent sweep or
 * a second API replica could push the total past `max_connections` with every
 * individual plan still reporting itself within budget — the same shape as
 * performance-06 itself.
 *
 * Phase 4 added a second ceiling on top: every tenant database has its own
 * login role with a `CONNECTION LIMIT`, so one busy library can be refused
 * connections while the server as a whole is nowhere near full. That failure
 * looks nothing like exhaustion and would be diagnosed as one.
 */
describe('planFleetConnections (the aggregate budget)', () => {
  const shipped = () =>
    planFleetConnections({
      requestedCacheSize: SHIPPED_CACHE_SIZE,
      requestedPoolMax: SHIPPED_POOL_MAX,
      serverMaxConnections: SHIPPED_MAX_CONNECTIONS,
      perTenantConnectionLimit: DEFAULT_ROLE_LIMITS.connectionLimit,
    });

  it('the shipped configuration fits, with the reserve intact', () => {
    const plan = shipped();
    expect(plan.problems, describeFleetConnectionPlan(plan)).toEqual([]);
    expect(plan.headroom).toBeGreaterThanOrEqual(0);
    expect(plan.totalPeak).toBeLessThanOrEqual(SHIPPED_MAX_CONNECTIONS);
  });

  it('models ONE api instance, because Compose recreate is stop-then-start', () => {
    // Not an optimistic default: `dc up -d --force-recreate` takes the old
    // container down before the new one comes up, so two full API pools never
    // coexist. The reserve covers the overlap while the old backends close.
    const plan = shipped();
    expect(plan.apiInstances).toBe(1);
    // The three standalone tenant clients (import, maintenance, export) are in
    // the total too — they are outside the sweeps' shared LRU and the per-role
    // planner cannot see them.
    expect(plan.tenantPeak).toBe(
      plan.api.peakConnections * plan.apiInstances + plan.worker.peakConnections + 3,
    );
  });

  it('says out loud that scaling to two API containers does NOT fit today', () => {
    // Written down rather than discovered from `FATAL: sorry, too many clients
    // already` on the day someone scales out. At the shipped numbers a second
    // instance costs another 100 connections against a 200-connection server
    // that is already holding 132 — ROLE_SHARE would have to drop to about 0.35
    // per role, or max_connections rise, first.
    const two = planFleetConnections({
      requestedCacheSize: SHIPPED_CACHE_SIZE,
      requestedPoolMax: SHIPPED_POOL_MAX,
      serverMaxConnections: SHIPPED_MAX_CONNECTIONS,
      apiInstances: 2,
      perTenantConnectionLimit: DEFAULT_ROLE_LIMITS.connectionLimit,
    });
    expect(two.problems.join(' ')).toContain('over-committed');
    expect(two.headroom).toBeLessThan(0);
  });

  it("one library's worst case stays under the CONNECTION LIMIT its role carries", () => {
    // The phase-4 ceiling. `perTenantPeak` is what a single hot tenant can
    // attract across every process at once; exceeding the role's limit refuses
    // that library while the cluster is fine.
    const plan = shipped();
    expect(plan.perTenantPeak).toBeLessThanOrEqual(plan.perTenantLimit);
    expect(plan.perTenantLimit).toBe(DEFAULT_ROLE_LIMITS.connectionLimit);
  });

  it('REPORTS an over-committed server rather than clamping it into silence', () => {
    // A tiny server with a large reserve: the per-role planner still returns a
    // plan (it never throws — that would turn a capacity problem into an
    // outage), so the only way anyone learns is this list.
    const plan = planFleetConnections({
      requestedCacheSize: 200,
      requestedPoolMax: 20,
      serverMaxConnections: 40,
      reservedConnections: 35,
      apiInstances: 4,
      perTenantConnectionLimit: DEFAULT_ROLE_LIMITS.connectionLimit,
    });
    expect(plan.problems.length).toBeGreaterThan(0);
    expect(describeFleetConnectionPlan(plan)).toContain('OVER BUDGET');
  });

  it('names the per-tenant ceiling separately from the server one', () => {
    // A limit of 2 cannot cover even one API instance's pool, and the message
    // has to say so — "connection refused for this library" and "the server is
    // full" are different incidents with different fixes.
    const plan = planFleetConnections({
      requestedCacheSize: SHIPPED_CACHE_SIZE,
      requestedPoolMax: SHIPPED_POOL_MAX,
      serverMaxConnections: SHIPPED_MAX_CONNECTIONS,
      perTenantConnectionLimit: 2,
    });
    expect(plan.problems.join(' ')).toContain('CONNECTION LIMIT');
    expect(plan.problems.join(' ')).toContain('refused while the server has room');
  });

  it('describes itself with every number an operator would otherwise compute', () => {
    const text = describeFleetConnectionPlan(shipped());
    expect(text).toContain('fleet connections:');
    expect(text).toContain(`of ${SHIPPED_MAX_CONNECTIONS}`);
    expect(text).toContain('per tenant');
  });

  // -- phase 10: two datamodels, two pools per tenant -----------------------

  describe('two Prisma clients per tenant', () => {
    it('keeps the peak inside the per-instance budget when a second client lands', () => {
      // Phase 10 gives every cached tenant a SECOND client, because the 2.0
      // datamodel lives in its own Postgres schema and its own generated
      // client. Each opens its own pool, so the naive arithmetic doubles.
      const one = planTenantPool({ role: 'api', requestedCacheSize: 20, requestedPoolMax: 5 });
      const two = planTenantPool({
        role: 'api',
        requestedCacheSize: 20,
        requestedPoolMax: 5,
        clientsPerTenant: 2,
      });

      // Assert on peakConnections, not on poolMax: a test that pinned poolMax
      // would pass while the box quietly opened twice its budget.
      expect(one.peakConnections).toBeLessThanOrEqual(one.perInstanceBudget);
      expect(two.peakConnections).toBeLessThanOrEqual(two.perInstanceBudget);

      // And the clamp actually bit — without it this would be 200 against a
      // server max_connections of 200, i.e. the whole box refusing connections
      // rather than one slow endpoint.
      expect(two.poolMax).toBeLessThan(one.poolMax);
      expect(two.clamped.join(' ')).toContain('client(s)');
    });

    it('reports the real peak rather than the single-client one', () => {
      const plan = planTenantPool({
        role: 'api',
        requestedCacheSize: 4,
        requestedPoolMax: 2,
        clientsPerTenant: 2,
      });
      expect(plan.clientsPerTenant).toBe(2);
      expect(plan.peakConnections).toBe(
        plan.clientCacheSize * plan.poolMax * plan.clientsPerTenant * plan.concurrentInstances,
      );
    });

    it('the worker yields cache size, not pool depth, to fit two clients', () => {
      // A sweep is sequential, so poolMax is already 1 and cannot give. The
      // cache is what has to shrink.
      const plan = planTenantPool({
        role: 'worker',
        requestedCacheSize: 20,
        requestedPoolMax: 5,
        clientsPerTenant: 2,
      });
      expect(plan.poolMax).toBe(1);
      expect(plan.peakConnections).toBeLessThanOrEqual(
        plan.perInstanceBudget * plan.concurrentInstances,
      );
    });

    it('CLIENTS_PER_TENANT is what the running services actually use', () => {
      // The constant exists so phase 20 has one place to change when the 1.0
      // datamodel is deleted. If it ever disagrees with reality the budget is a
      // fiction, so pin it.
      expect(CLIENTS_PER_TENANT).toBe(2);
    });
  });
});
