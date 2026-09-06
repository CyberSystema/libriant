import { beforeAll, describe, expect, it } from 'vitest';
import { resetOutboxCensus, seedOutboxCensusForTest } from '../email/outbox-census.js';
import { allMetrics } from '../observability/metrics.registry.js';
import { planTenantPool } from '../platform/tenant-pool-budget.js';
import { WORKER_CONSUMERS, type ConsumerHandle } from './consumers.js';
import {
  consumerIsUp,
  healthzQueues,
  initialConsumerStates,
  jobResults,
  readiness,
  renderWorkerMetrics,
  type ConsumerState,
} from './worker-surface.js';

/**
 * The assertions the four hand-written lists in `worker.ts` could never make
 * about themselves.
 *
 * REL-04 was a list of five consumers written out four times, with one copy
 * naming three. Nothing failed, because each copy read as complete on its own —
 * the defect only existed in the relationship between them, and no test could
 * see it because `worker.ts` is a process entry point that opens sockets and
 * calls `process.exit`.
 *
 * So the surfaces are pure functions over one array, and these are the
 * cross-surface properties: every registered consumer in every surface, every
 * declared worker metric in the exposition.
 */

const PLAN = planTenantPool({ role: 'worker', requestedCacheSize: 8, requestedPoolMax: 1 });

/** A handle whose worker reports the given liveness. */
function handle(isRunning: boolean, inFlight = 0, lastResults?: Record<string, unknown>) {
  const h: ConsumerHandle = {
    worker: { isRunning: () => isRunning },
    inFlight: () => inFlight,
    stop: async () => undefined,
  };
  return lastResults ? { ...h, lastResults: () => lastResults } : h;
}

/** Every consumer started and running. */
function allUp(): ConsumerState[] {
  return WORKER_CONSUMERS.map((consumer) => ({
    consumer,
    handle: handle(true, 0, {
      'fine-accrual': { at: new Date(1_700_000_000_000).toISOString(), message: 'ok', ok: true },
    }),
  }));
}

describe('the consumer registry', () => {
  it('registers at least the five consumers the worker has always hosted', () => {
    expect(WORKER_CONSUMERS.map((c) => c.name).sort()).toEqual([
      'email-outbox',
      'export',
      'import',
      'maintenance',
      'scheduled',
    ]);
  });

  it('gives every consumer a purpose an operator can act on', () => {
    // The /readyz body quotes these. "not_ready" sends someone to the logs;
    // "produces database exports…" tells them what has stopped.
    for (const c of WORKER_CONSUMERS) {
      expect(c.purpose.length, `${c.name} has no purpose`).toBeGreaterThan(20);
    }
  });
});

describe('readiness', () => {
  it('is not ready until every registered consumer has started', () => {
    // The boot state. Previously `!!handle` on three of five, which is how a
    // worker with two dead consumers answered 200.
    const r = readiness(initialConsumerStates());
    expect(r.ready).toBe(false);
    expect(r.down.map((d) => d.queue).sort()).toEqual(WORKER_CONSUMERS.map((c) => c.name).sort());
  });

  it('is ready when all of them are running', () => {
    expect(readiness(allUp()).ready).toBe(true);
  });

  it.each(WORKER_CONSUMERS.map((c) => c.name))(
    'returns 503 material when the %s consumer dies — one case per registered consumer',
    (name) => {
      // Parameterised over the registry, not over a list written here: a
      // consumer added tomorrow gets this test for free, which is the whole
      // point. REL-04 was two consumers nobody thought to add to a list.
      const states = allUp().map((s) =>
        s.consumer.name === name ? { ...s, handle: handle(false) } : s,
      );
      const r = readiness(states);
      expect(r.ready).toBe(false);
      expect(r.down).toEqual([
        { queue: name, purpose: WORKER_CONSUMERS.find((c) => c.name === name)!.purpose },
      ]);
    },
  );

  it('treats a handle whose worker has stopped as down, not as present', () => {
    // The exact wording of the finding: "the checks only assert the start
    // promise resolved once at boot — no liveness re-check". A closed BullMQ
    // worker keeps its handle.
    expect(consumerIsUp({ consumer: WORKER_CONSUMERS[0]!, handle: handle(false) })).toBe(false);
    expect(consumerIsUp({ consumer: WORKER_CONSUMERS[0]!, handle: null })).toBe(false);
    expect(consumerIsUp({ consumer: WORKER_CONSUMERS[0]!, handle: handle(true) })).toBe(true);
  });
});

describe('healthz', () => {
  it('names every registered queue, and distinguishes starting from stopped', () => {
    const states = allUp().map((s, i) =>
      i === 0 ? { ...s, handle: null } : i === 1 ? { ...s, handle: handle(false) } : s,
    );
    const q = healthzQueues(states);
    expect(Object.keys(q).sort()).toEqual(WORKER_CONSUMERS.map((c) => c.name).sort());
    expect(q[WORKER_CONSUMERS[0]!.name]).toBe('starting');
    expect(q[WORKER_CONSUMERS[1]!.name]).toBe('stopped');
    expect(q[WORKER_CONSUMERS[2]!.name]).toBe('running');
  });

  it('distinguishes a consumer that FAILED to start from one still starting', () => {
    // Both have a null handle. Reporting `starting` for ever would put this
    // surface straight into the runbook's "health surfaces that lie" table.
    const states = initialConsumerStates().map((s, i) => (i === 0 ? { ...s, failed: true } : s));
    const q = healthzQueues(states);
    expect(q[WORKER_CONSUMERS[0]!.name]).toBe('failed');
    expect(q[WORKER_CONSUMERS[1]!.name]).toBe('starting');
    // …and both are down for readiness purposes.
    expect(readiness(states).down.length).toBe(WORKER_CONSUMERS.length);
  });

  it('uses the BullMQ queue name as the key, so a dashboard label names a real queue', () => {
    const q = healthzQueues(allUp());
    for (const c of WORKER_CONSUMERS) expect(q).toHaveProperty(c.name);
  });
});

describe('the worker exposition', () => {
  let body: string;

  beforeAll(() => {
    // The census gauges are absent until the first pass completes against the
    // control database — deliberately, and LibriantEmailOutboxCensusMissing is
    // the rule for that state. Seed one so the completeness assertion below can
    // be TOTAL rather than carrying an exception for the two metrics whose
    // renderer is the hardest to reach.
    seedOutboxCensusForTest({
      at: 1_700_000_000_000,
      byStatus: { pending: 0, sending: 0, delivered: 0, failed: 0, dead: 0 },
      oldestPendingSeconds: 0,
    });
    body = renderWorkerMetrics({ states: allUp(), plan: PLAN, uptimeSeconds: 42 });
    resetOutboxCensus();
  });

  it('renders EVERY metric the registry declares for this process', () => {
    // The assertion that would have caught reliability-07's second half.
    // `renderScheduledJobMetrics` was exported, unit-tested and documented as
    // being concatenated by worker.ts — and worker.ts never called it, so
    // libriant_worker_job_last_ok had a green test and no series for as long
    // as nobody read the two files together.
    const missing = allMetrics()
      .filter((m) => m.source === 'worker')
      .map((m) => m.name)
      .filter((name) => !body.includes(name));
    expect(
      missing,
      `declared for the worker but absent from /metrics: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('emits a HELP and a TYPE line for every metric it renders', () => {
    for (const m of allMetrics().filter((m) => m.source === 'worker')) {
      expect(body).toContain(`# HELP ${m.name} ${m.help}`);
      expect(body).toContain(`# TYPE ${m.name} ${m.type}`);
    }
  });

  it('renders one in-flight and one up series per registered consumer', () => {
    for (const c of WORKER_CONSUMERS) {
      expect(body).toContain(`libriant_worker_jobs_running{queue="${c.name}"} 0`);
      expect(body).toContain(`libriant_worker_consumer_up{queue="${c.name}"} 1`);
    }
  });

  it('reports a dead consumer as 0 while the process keeps answering', () => {
    // The state /readyz reports as 503 and Prometheus never scrapes. This gauge
    // is the only record of WHICH consumer it was.
    const states = allUp().map((s, i) => (i === 3 ? { ...s, handle: handle(false) } : s));
    const text = renderWorkerMetrics({ states, plan: PLAN, uptimeSeconds: 1 });
    expect(text).toContain(`libriant_worker_consumer_up{queue="${WORKER_CONSUMERS[3]!.name}"} 0`);
  });

  it('carries the connection plan it is actually running under', () => {
    expect(body).toContain(`libriant_worker_tenant_conn_peak ${PLAN.peakConnections}`);
    expect(body).toContain(`libriant_worker_tenant_conn_budget ${PLAN.budget}`);
  });

  it('survives a worker that has started nothing', () => {
    // A worker that cannot reach Redis still has to answer /metrics — that is
    // exactly when an operator needs the scrape (reliability-10).
    const text = renderWorkerMetrics({
      states: initialConsumerStates(),
      plan: PLAN,
      uptimeSeconds: 0,
    });
    for (const c of WORKER_CONSUMERS) {
      expect(text).toContain(`libriant_worker_consumer_up{queue="${c.name}"} 0`);
    }
  });
});

describe('job results', () => {
  it('merges every consumer that keeps them, rather than taking the first', () => {
    // Only the scheduled consumer exposes lastResults today. Taking the first
    // match would make a second one silently invisible — which is the shape of
    // the defect this whole file exists to prevent.
    const states = WORKER_CONSUMERS.map((consumer, i) => ({
      consumer,
      handle: handle(true, 0, i === 1 ? { a: 1 } : i === 3 ? { b: 2 } : undefined),
    }));
    expect(jobResults(states)).toEqual({ a: 1, b: 2 });
  });

  it('is empty, not undefined, when nothing has started', () => {
    expect(jobResults(initialConsumerStates())).toEqual({});
  });
});
