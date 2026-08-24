import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { planTenantPool, describeTenantPoolPlan } from './tenant-pool-budget.js';

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
