import { renderOutboxCensus } from '../email/outbox-census.js';
import { renderScheduledJobMetrics } from '../jobs/scheduled-jobs.runner.js';
import { CATALOG_VERIFY_COUNTS, CATALOG_VERIFY_JOB } from '../jobs/catalog-verify.job.js';
import {
  PARTITION_MAINTENANCE_COUNTS,
  PARTITION_MAINTENANCE_JOB,
} from '../jobs/partition-maintenance.job.js';
import { HOLD_EXPIRY_COUNTS, HOLD_EXPIRY_JOB } from '../jobs/hold-expiry.job.js';
import { LEDGER_RECONCILE_COUNTS, LEDGER_RECONCILE_JOB } from '../jobs/ledger-reconcile.job.js';
import {
  HOLD_TRANSIT_TIMEOUT_COUNTS,
  HOLD_TRANSIT_TIMEOUT_JOB,
} from '../jobs/hold-transit-timeout.job.js';
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
    ...renderPartitionMetrics(jobResults(states)),
    ...renderHoldMetrics(jobResults(states)),
    ...renderLedgerMetrics(jobResults(states)),
    ...renderCatalogProjectionMetrics(jobResults(states)),
  ];
  return lines.join('\n');
}

/**
 * Projection drift, lifted out of the nightly verify's counters.
 *
 * `libriant_worker_job_count{sweep="catalog-projection-verify",count="drift"}`
 * already carries this number, so a second series needs a reason. It has one:
 * that gauge is declared `alert: false` on the argument that no single threshold
 * means the same thing across twelve different handlers, and drift here is not a
 * handler statistic — it is the OPAC serving something the record does not say.
 * That deserves a rule of its own, and a rule needs a series whose meaning does
 * not depend on a label value.
 *
 * The HEADERS are emitted unconditionally and the SAMPLES only after a run. A
 * gauge that reported 0 before the sweep had ever executed would read as
 * "verified, nothing wrong" during exactly the window in which nothing has been
 * verified; absent data leaves the alert without an opinion, which is the honest
 * state.
 */
function renderCatalogProjectionMetrics(results: Record<string, unknown>): string[] {
  // Every string here comes from `catalog-verify.job.ts`. Three literals used to
  // have to agree by hand — the registry name, the handler's `counts` keys and
  // these lookups — and renaming any of them silently deleted the only series
  // `LibriantCatalogProjectionDrift` reads.
  const run = results[CATALOG_VERIFY_JOB] as { counts?: Record<string, number> } | undefined;
  const counts = run?.counts;
  // `metric` is typed as the registry's own union rather than `string`, so a
  // metric name that is not declared is a compile error here — the same
  // guarantee `metricLine` gives every other block in this file.
  const sample = (metric: Parameters<typeof metricLine>[0], key: string) =>
    counts && typeof counts[key] === 'number' ? [metricLine(metric, counts[key])] : [];
  return [
    ...metricHeader('libriant_catalog_projection_drift_total'),
    ...sample('libriant_catalog_projection_drift_total', CATALOG_VERIFY_COUNTS.drift),
    ...metricHeader('libriant_catalog_projection_scanned_total'),
    ...sample('libriant_catalog_projection_scanned_total', CATALOG_VERIFY_COUNTS.scanned),
  ];
}

/**
 * How much partition window is left (2.0 phase 16).
 *
 * Same shape and the same reason as the block above: three literals — the
 * registry name, the handler's `counts` keys and these lookups — used to have to
 * agree by hand, and renaming any of them silently deleted the only series the
 * alert reads. Every string here comes from `partition-maintenance.job.ts`.
 *
 * ABSENT rather than zero when the sweep has not run. A gauge that read 0 before
 * the first tick would page for "no partition window" on every worker restart,
 * which is the same lie the catalog block above avoids by the same means: absent
 * data leaves the alert without an opinion, which is the honest state.
 */
function renderPartitionMetrics(results: Record<string, unknown>): string[] {
  const run = results[PARTITION_MAINTENANCE_JOB] as { counts?: Record<string, number> } | undefined;
  const counts = run?.counts;
  const sample = (metric: Parameters<typeof metricLine>[0], key: string) =>
    counts && typeof counts[key] === 'number' ? [metricLine(metric, counts[key])] : [];
  return [
    ...metricHeader('libriant_partition_headroom_months'),
    ...sample('libriant_partition_headroom_months', PARTITION_MAINTENANCE_COUNTS.minHeadroomMonths),
    ...metricHeader('libriant_partitions_created_total'),
    ...sample('libriant_partitions_created_total', PARTITION_MAINTENANCE_COUNTS.created),
  ];
}

/**
 * The hold shelf and the van (2.0 phase 17).
 *
 * The same shape as the two blocks above, and the same reason: three literals —
 * the registry name, the handler's `counts` keys and these lookups — used to
 * have to agree by hand, and renaming any of them silently deleted the only
 * series an alert reads. Every string here comes from `hold-expiry.job.ts` and
 * `hold-transit-timeout.job.ts`.
 *
 * ABSENT rather than zero before the first tick. `libriant_hold_transit_overdue_total`
 * is alerted, and a gauge that read 0 on a worker that has not swept yet would
 * be an assertion that no crate is late — made by a process that has not looked.
 */
/**
 * Ledger drift, one series per identity (2.0 phase 18).
 *
 * THREE LABELS, ONE METRIC, because the three identities fail for different
 * reasons and need different repairs — an operator's first question is which of
 * them broke — while the alert only ever asks whether any of them is non-zero.
 *
 * ABSENT rather than zero before the first run, for the reason the hold block
 * below states: this gauge is alerted, and a 0 emitted by a worker that has not
 * reconciled yet is an assertion that the library's books balance, made by a
 * process that has not looked.
 */
function renderLedgerMetrics(results: Record<string, unknown>): string[] {
  const run = results[LEDGER_RECONCILE_JOB] as { counts?: Record<string, number> } | undefined;
  const counts = run?.counts;
  // The HELP and TYPE lines are emitted whether or not the job has run; only
  // the SERIES is absent before the first reconciliation. The worker-surface
  // suite asserts completeness totally — every metric the registry declares for
  // this process must appear in the body — and an early return here would have
  // made this metric declared, alerted and invisible.
  const at = (key: string, identity: string): string[] =>
    counts !== undefined && typeof counts[key] === 'number'
      ? [metricLine('libriant_circ_ledger_drift_total', counts[key], { identity })]
      : [];
  return [
    ...metricHeader('libriant_circ_ledger_drift_total'),
    ...at(LEDGER_RECONCILE_COUNTS.unbalanced, 'transaction_unbalanced'),
    ...at(LEDGER_RECONCILE_COUNTS.feeCounterDrift, 'fee_allocation_mismatch'),
    ...at(LEDGER_RECONCILE_COUNTS.accountBalanceDrift, 'account_balance_mismatch'),
  ];
}

function renderHoldMetrics(results: Record<string, unknown>): string[] {
  const expiry = results[HOLD_EXPIRY_JOB] as { counts?: Record<string, number> } | undefined;
  const transit = results[HOLD_TRANSIT_TIMEOUT_JOB] as
    { counts?: Record<string, number> } | undefined;
  const from =
    (counts: Record<string, number> | undefined) =>
    (metric: Parameters<typeof metricLine>[0], key: string) =>
      counts && typeof counts[key] === 'number' ? [metricLine(metric, counts[key])] : [];
  const e = from(expiry?.counts);
  const t = from(transit?.counts);
  return [
    ...metricHeader('libriant_hold_shelf_expired_total'),
    ...e('libriant_hold_shelf_expired_total', HOLD_EXPIRY_COUNTS.shelfExpired),
    ...metricHeader('libriant_hold_shelf_promoted_total'),
    ...e('libriant_hold_shelf_promoted_total', HOLD_EXPIRY_COUNTS.promoted),
    ...metricHeader('libriant_hold_transit_overdue_total'),
    ...t('libriant_hold_transit_overdue_total', HOLD_TRANSIT_TIMEOUT_COUNTS.overdue),
    ...metricHeader('libriant_hold_transit_overdue_oldest_days'),
    ...t('libriant_hold_transit_overdue_oldest_days', HOLD_TRANSIT_TIMEOUT_COUNTS.oldestDays),
  ];
}
