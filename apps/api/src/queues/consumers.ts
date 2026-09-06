import { startEmailWorker } from '../email/email-worker.js';
import type { EmailService } from '../email/email.service.js';
import { EMAIL_QUEUE_NAME } from '../email/email.service.js';
import { makeImportWorkerDeps, startImportWorker } from '../import/import-worker.js';
import { IMPORT_QUEUE_NAME } from '../import/import.constants.js';
import { startMaintenanceWorker } from '../maintenance/maintenance-worker.js';
import { MAINTENANCE_QUEUE_NAME } from '../maintenance/maintenance.constants.js';
import { startExportWorker } from '../export/export-worker.js';
import { EXPORT_QUEUE_NAME } from '../export/export.constants.js';
import { SCHEDULED_JOBS } from '../jobs/registry.js';
import { SCHEDULED_QUEUE_NAME, startScheduledJobs } from '../jobs/scheduled-jobs.runner.js';
import type { RedisService } from '../platform/redis.service.js';

/**
 * The queue consumers the worker process hosts — declared once.
 *
 * ## The failure this exists for (REL-04)
 *
 * `worker.ts` listed its consumers FOUR times: the `/healthz` queues map, the
 * `/readyz` readiness expression, the `/metrics` in-flight gauges, and the
 * shutdown `Promise.all`. The audit found the readiness expression naming three
 * of the five — `maintenanceWorker` and `exportWorker` were declared, started
 * and tracked, and simply missing from the one list that decides whether the
 * orchestrator pulls a broken worker out of service. Readiness was a boot-time
 * latch: a dead consumer, or a post-boot Redis partition, still answered 200.
 *
 * That was fixed by editing the expression, which fixes the instance and not
 * the shape. Four hand-maintained copies of one list will disagree again — the
 * next queue is added to three of them, and the omission is invisible because
 * each list still reads as complete on its own.
 *
 * So there is one list. `worker.ts` iterates it; the four surfaces are derived
 * from the same array, and a consumer added here appears in all of them or in
 * none.
 *
 * ## Why `name` is the BullMQ queue name and nothing else
 *
 * It is also the `/healthz` key and the `queue=` label on
 * `libriant_worker_jobs_running`. Those were three separately-typed strings
 * that happened to agree; a dashboard or an alert keyed on the label had no
 * guarantee it named a real queue. One field, used three ways, cannot drift.
 */

/** The shape every consumer handle must expose for the worker to supervise it. */
export type ConsumerHandle = {
  /**
   * The BullMQ worker.
   *
   * REQUIRED, not optional. `ScheduledJobsHandle` used to omit it, and
   * `worker.ts`'s liveness helper read a missing `worker` as "assume running" —
   * so the one consumer that could not be checked was silently exempt from the
   * readiness check that exists to catch a dead consumer.
   */
  worker: { isRunning(): boolean };
  /** Jobs currently executing. Rendered as `libriant_worker_jobs_running`. */
  inFlight(): number;
  stop(): Promise<void>;
  /** Scheduled jobs only: per-job last result, surfaced on `/healthz`. */
  lastResults?(): Record<string, unknown>;
};

/** Everything a consumer may need at start-up. Shared across the process. */
export type ConsumerDeps = {
  redis: RedisService;
  emails: EmailService;
};

export type QueueConsumer = {
  /** The BullMQ queue name. Also the /healthz key and the `queue` metric label. */
  readonly name: string;
  /**
   * What stops working when this consumer is down. Printed by the worker at
   * boot and quoted in the readiness failure, so the operator reading a 503
   * learns which capability is missing rather than a queue name.
   */
  readonly purpose: string;
  start(deps: ConsumerDeps): Promise<ConsumerHandle>;
};

export const WORKER_CONSUMERS: readonly QueueConsumer[] = [
  {
    name: EMAIL_QUEUE_NAME,
    purpose: 'sends every queued e-mail — password resets, hold-ready notices, support sessions',
    start: () => startEmailWorker(),
  },
  {
    name: SCHEDULED_QUEUE_NAME,
    purpose: 'runs every cron sweep — fine accrual, pickup expiry, retention, notifications',
    // `redis` as well as `emails`. `JobRunnerContext.redis` is optional and the
    // runner falls back to `new RedisService()` when it is absent — an extra
    // connection nothing counts, in the one phase whose acceptance criterion is
    // an asserted aggregate connection budget. rel-16 is the other half of the
    // same argument: a sweep that mints its own client loses the race against
    // `enableOfflineQueue: false` and retries nothing.
    start: (deps) => startScheduledJobs(SCHEDULED_JOBS, { emails: deps.emails, redis: deps.redis }),
  },
  {
    name: IMPORT_QUEUE_NAME,
    purpose: 'validates and commits bulk imports a librarian has already uploaded',
    start: (deps) => startImportWorker(makeImportWorkerDeps(deps.redis)),
  },
  {
    name: MAINTENANCE_QUEUE_NAME,
    purpose: 'runs operator maintenance — diagnostics, tenant migrations, fix, vacuum',
    start: (deps) => startMaintenanceWorker({ redis: deps.redis }),
  },
  {
    name: EXPORT_QUEUE_NAME,
    purpose: 'produces database exports a platform admin or a library has requested',
    start: () => startExportWorker(),
  },
] as const;

/**
 * Every queue name, for the tests and for anything that needs the list without
 * pulling in the start functions.
 */
export const WORKER_QUEUE_NAMES: readonly string[] = WORKER_CONSUMERS.map((c) => c.name);

// A consumer registered twice would start twice against the same queue and
// double every job's concurrency. Cheap to assert at module load.
{
  const seen = new Set<string>();
  for (const c of WORKER_CONSUMERS) {
    if (seen.has(c.name)) throw new Error(`Queue "${c.name}" is registered twice.`);
    seen.add(c.name);
  }
}
