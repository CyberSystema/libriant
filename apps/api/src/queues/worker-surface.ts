import { renderOutboxCensus } from '../email/outbox-census.js';
import { renderScheduledJobMetrics } from '../jobs/scheduled-jobs.runner.js';
import { metricHeader, metricLine } from '../observability/metrics.registry.js';
import type { TenantPoolPlan } from '../platform/tenant-pool-budget.js';
import { WORKER_CONSUMERS, type ConsumerHandle, type QueueConsumer } from './consumers.js';

/**
 * The worker's three HTTP surfaces, derived from ONE list.
 *
 * `worker.ts` is a process entry point: it opens sockets, registers signal
 * handlers and calls `process.exit`, so nothing can import it and no test can
 * drive it. That is why REL-04 was possible at all — the readiness expression
 * that omitted two consumers was in a file with no unit-test seam, and the only
 * way to notice was to read all four lists and compare them by eye.
 *
 * So the rendering lives here, as pure functions over a list of consumer
 * states, and `worker.ts` becomes the part that cannot be tested and does
 * nothing interesting: build the states, hand them to these three functions,
 * write the response.
 *
 * `worker-surface.spec.ts` then asserts the property the four hand-written
 * lists could never assert about themselves — that every registered consumer
 * appears in every surface, and every metric the registry declares for this
 * process is actually rendered.
 */

/** A registered consumer plus whatever its start promise produced. */
export type ConsumerState = {
  readonly consumer: QueueConsumer;
  /** null until `start()` resolves, and null for ever if it rejected. */
  readonly handle: ConsumerHandle | null;
  /**
   * True once `start()` has REJECTED.
   *
   * Without it, a consumer whose start threw is indistinguishable from one that
   * has not finished booting: both have a null handle, and /healthz would read
   * `starting` for the rest of the process's life. §7.4 of the runbook is a
   * list of health surfaces that lie, and this would have been the next entry.
   *
   * Note what does NOT set it: an unreachable Redis. `new Worker(...)` does not
   * await a connection, so every `start*` function resolves against a dead
   * Redis and the consumer reports `running`. That state is caught by
   * `/readyz`'s ping and by LibriantWorkerDown, not here — this flag is for a
   * start that threw, which in practice means bad configuration.
   */
  readonly failed?: boolean;
};

/** Build the initial (nothing started yet) state list. */
export function initialConsumerStates(): ConsumerState[] {
  return WORKER_CONSUMERS.map((consumer) => ({ consumer, handle: null }));
}

/**
 * Is this consumer actually consuming?
 *
 * Not `handle !== null`. That is a boot-time latch — the audit's exact words —
 * and it is true for a consumer whose BullMQ worker has since been closed.
 *
 * WHAT THIS DOES NOT PROVE, because a readiness check that overstates itself is
 * the thing REL-04 was: `isRunning()` reports whether the worker's own run loop
 * is active, NOT whether Redis is reachable. The connections are built with
 * `maxRetriesPerRequest: null`, so a post-boot partition queues commands for
 * ever and this stays true. That half is covered separately and deliberately —
 * `worker.ts` ANDs a live `redis.ping()` into `/readyz`, and
 * `libriant_worker_consumer_up` is paired with `LibriantWorkerDown` in
 * alerts.yml. Between them: "the process is gone", "Redis is gone" and "this
 * one consumer stopped" are three states with three answers.
 */
export function consumerIsUp(state: ConsumerState): boolean {
  return !!state.handle && state.handle.worker.isRunning();
}

/** `/healthz` — every registered queue, whether or not it started. */
export function healthzQueues(states: readonly ConsumerState[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const s of states) {
    out[s.consumer.name] = s.failed
      ? 'failed'
      : !s.handle
        ? 'starting'
        : consumerIsUp(s)
          ? 'running'
          : 'stopped';
  }
  return out;
}

/**
 * `/readyz` — ready only when EVERY registered consumer is running.
 *
 * Returns the names that are not, so the 503 body says which capability is
 * missing. An operator reading `not_ready` learns nothing; one reading
 * `export: produces database exports…` knows what to look at.
 */
export function readiness(states: readonly ConsumerState[]): {
  ready: boolean;
  down: Array<{ queue: string; purpose: string }>;
} {
  const down = states
    .filter((s) => !consumerIsUp(s))
    .map((s) => ({ queue: s.consumer.name, purpose: s.consumer.purpose }));
  return { ready: down.length === 0, down };
}

/**
 * Per-job results from every consumer that keeps any, merged.
 *
 * Only the scheduled-jobs consumer exposes `lastResults` today. Merging rather
 * than returning the first match is the difference between a second one being
 * ADDED and a second one being silently ignored — and this file exists because
 * a list that silently ignored two of five entries shipped.
 */
export function jobResults(states: readonly ConsumerState[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const s of states) Object.assign(out, s.handle?.lastResults?.() ?? {});
  return out;
}

/**
 * `/metrics` — the whole worker exposition.
 *
 * Every block a scrape should contain is assembled HERE, and
 * `worker-surface.spec.ts` asserts that the output names every metric the
 * registry declares with `source: 'worker'`.
 *
 * That assertion is not hypothetical. `renderScheduledJobMetrics` was written
 * for reliability-07, exported, unit-tested, and documented with the sentence
 * "worker.ts just concatenates the string" — and worker.ts never called it. So
 * `libriant_worker_job_last_ok` was a metric with a passing test, a docblock
 * describing its alert, and no series in Prometheus, for as long as nobody
 * checked the two files against each other.
 */
export function renderWorkerMetrics(input: {
  states: readonly ConsumerState[];
  plan: TenantPoolPlan;
  uptimeSeconds: number;
}): string {
  const { states, plan, uptimeSeconds } = input;
  const lines: string[] = [
    ...metricHeader('libriant_worker_uptime_seconds'),
    metricLine('libriant_worker_uptime_seconds', uptimeSeconds),
    ...metricHeader('libriant_worker_jobs_running'),
    ...states.map((s) =>
      metricLine('libriant_worker_jobs_running', s.handle?.inFlight() ?? 0, {
        queue: s.consumer.name,
      }),
    ),
    // The readiness decision, as a number. /readyz answers one orchestrator;
    // this answers every dashboard and is what an alert can sit on — a consumer
    // that dies at 02:00 pulls the container out of service, and without this
    // series nothing afterwards says WHICH one, or for how long.
    ...metricHeader('libriant_worker_consumer_up'),
    ...states.map((s) =>
      metricLine('libriant_worker_consumer_up', consumerIsUp(s) ? 1 : 0, {
        queue: s.consumer.name,
      }),
    ),
    ...metricHeader('libriant_worker_tenant_conn_peak'),
    metricLine('libriant_worker_tenant_conn_peak', plan.peakConnections),
    ...metricHeader('libriant_worker_tenant_conn_budget'),
    metricLine('libriant_worker_tenant_conn_budget', plan.budget),
    // reliability-10: abandoned ('dead') outbox rows had no surface anywhere —
    // no endpoint, no metric, no alert, just one console.error in a rolling
    // Docker log. These gauges are the surface.
    ...renderOutboxCensus(),
    // reliability-07's other half, finally reaching a scrape.
    renderScheduledJobMetrics(
      jobResults(states) as Parameters<typeof renderScheduledJobMetrics>[0],
    ),
  ];
  return lines.join('\n');
}
