import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { loadEnv } from '../config/env.js';
import { RedisService } from '../platform/redis.service.js';
import { describeError } from './job-error.js';
import type { JobContext, JobResult, JobRunnerContext, ScheduledJob } from './jobs.types.js';

const QUEUE_NAME = 'scheduled';
const QUEUE_PREFIX = 'lbr-bull';

/**
 * Does this count key mean "a unit of work THIS RUN attempted threw"?
 *
 * SCHEDULED-TENANTSFAILED-DISCARDED: every multi-tenant sweep catches
 * per-tenant errors, bumps a counter and carries on, so the handler resolves
 * normally even when 100% of tenants failed. The runner used to store only
 * `result.message` with a hard-coded `ok: true`, and those messages read as
 * clean successes ("49 tenant(s) scanned; no member reminders due"). That is
 * what hid a member-notifications job which had never once succeeded. A
 * non-zero value under such a key makes the run NOT ok.
 *
 * A convention (`…Failed`) rather than the hard-coded
 * `['tenantsFailed','failed','stillFailing']` it replaces, because that list
 * was opt-IN: a sweep left the health signal simply by naming its counter
 * something nobody had added, and a 100%-failed run read clean again. With a
 * suffix the default direction is "counted", and a new sweep has to work at
 * being silent. `rowsFailed`, `tenantsFailed`, `retryFailed` all match.
 *
 * `failed` (bare) is grandfathered: export-file-cleanup uses it as its
 * per-run failure counter and it is not ours to rename here.
 */
const RUN_FAILURE_SUFFIX = /Failed$/;
const LEGACY_RUN_FAILURE_KEYS = new Set(['failed']);

function isRunFailureKey(key: string): boolean {
  return RUN_FAILURE_SUFFIX.test(key) || LEGACY_RUN_FAILURE_KEYS.has(key);
}

/**
 * Count keys that describe a BACKLOG — work a sweep has deliberately stopped
 * retrying because it is not going to start working — rather than a failed run.
 * Printed in the message so an operator sees the pile, never flips `ok`.
 *
 * WHY the distinction exists: `stillFailing` used to sit in the failure list,
 * so ONE poisoned `stripe_webhook_events` row pinned stripe-webhook-retry at
 * `ok:false` every five minutes, forever. An alert that is always firing gets
 * silenced, and a silenced alert is the same blindness reliability-07 was
 * about, approached from the other side — "always red" and "never red" carry
 * identical information. "This run broke" and "there is a pile nobody has
 * cleared" are different facts and need different signals.
 *
 * The corollary is a duty on the sweeps, not on this file: a handler that
 * cannot process an item must eventually move it OUT of its retry set and
 * report it here, instead of re-failing on it every tick. stripe-retry.job.ts
 * does that with an age-based give-up budget.
 */
const BACKLOG_KEYS = new Set(['abandoned', 'backlog', 'stuck']);

/** One job's last run outcome, surfaced via /healthz. `ok: false` rows let
 *  ops see ongoing failures without scraping stderr (SCHEDULED-LASTRESULT). */
export type ScheduledJobResult = {
  at: string;
  message: string;
  ok: boolean;
  /** The handler's own counters, verbatim — dropping these is what let a
   *  100%-failed sweep look healthy. */
  counts?: Record<string, number>;
};

/**
 * Turn a handler's own result into the row /healthz shows. Exported for the
 * spec: this is the whole of the "did the run actually work?" decision, and
 * getting it wrong is invisible in production until a librarian complains.
 */
export function toScheduledJobResult(result: JobResult): ScheduledJobResult {
  const entries = Object.entries(result.counts ?? {}).filter(([, n]) => n > 0);
  const failures = entries.filter(([k]) => isRunFailureKey(k));
  const backlog = entries.filter(([k]) => BACKLOG_KEYS.has(k));
  const render = (pairs: [string, number][]) => pairs.map(([k, n]) => `${k}=${n}`).join(', ');

  const parts = [result.message];
  if (failures.length) parts.push(`FAILED — ${render(failures)}`);
  // Reported alongside a clean run on purpose: the pile is real and an
  // operator should see it, but it is not this run's failure.
  if (backlog.length) parts.push(`backlog — ${render(backlog)}`);

  return {
    at: new Date().toISOString(),
    message: parts.join('; '),
    ok: failures.length === 0,
    ...(result.counts ? { counts: result.counts } : {}),
  };
}

/**
 * Render `lastResults()` as Prometheus exposition text.
 *
 * reliability-07's other half: the runner now knows whether each run worked,
 * but nothing exported it, so the only place that truth existed was the
 * worker's /healthz JSON — which no alert rule can read (infra/monitoring/
 * alerts.yml has no rule that could reference a job). `libriant_worker_job_*`
 * is the surface an alert can finally sit on.
 *
 * Lives here rather than in worker.ts so the ok/counts contract and its
 * exposition stay in one file; worker.ts just concatenates the string.
 *
 * A job that has never run in this process emits nothing at all rather than a
 * fabricated 1 or 0 — "no series" is honest about a worker that just booted,
 * where `last_ok 1` would be a lie and `last_ok 0` a false alarm. Pair the
 * gauge with `libriant_worker_job_last_run_timestamp_seconds` in the alert so
 * "stopped running entirely" is detectable too.
 */
export function renderScheduledJobMetrics(results: Record<string, ScheduledJobResult>): string {
  const lines: string[] = [
    '# HELP libriant_worker_job_last_ok Whether the last run of this scheduled job completed without failed units of work.',
    '# TYPE libriant_worker_job_last_ok gauge',
  ];
  for (const [job, row] of Object.entries(results)) {
    lines.push(`libriant_worker_job_last_ok{job="${escapeLabel(job)}"} ${row.ok ? 1 : 0}`);
  }
  lines.push(
    "# HELP libriant_worker_job_last_run_timestamp_seconds Unix time of this job's last completed run.",
    '# TYPE libriant_worker_job_last_run_timestamp_seconds gauge',
  );
  for (const [job, row] of Object.entries(results)) {
    const at = Date.parse(row.at);
    if (Number.isNaN(at)) continue;
    lines.push(
      `libriant_worker_job_last_run_timestamp_seconds{job="${escapeLabel(job)}"} ${Math.round(at / 1000)}`,
    );
  }
  lines.push(
    "# HELP libriant_worker_job_count The handler's own counters from its last run (tenantsFailed, rowsFailed, abandoned, …).",
    '# TYPE libriant_worker_job_count gauge',
  );
  for (const [job, row] of Object.entries(results)) {
    for (const [count, value] of Object.entries(row.counts ?? {})) {
      lines.push(
        `libriant_worker_job_count{job="${escapeLabel(job)}",count="${escapeLabel(count)}"} ${value}`,
      );
    }
  }
  lines.push('');
  return lines.join('\n');
}

/** Prometheus label values escape backslash, double quote and newline. */
function escapeLabel(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

export type ScheduledJobsHandle = {
  /** Counter the worker exposes via /metrics. */
  inFlight(): number;
  /** Job name → last result snapshot, for /healthz introspection. */
  lastResults(): Record<string, ScheduledJobResult>;
  stop(): Promise<void>;
};

/**
 * Boots a BullMQ producer + worker for the scheduled-jobs queue and
 * registers every entry in `jobs` as a BullMQ Job Scheduler keyed on the job
 * NAME, so re-running this with the same config is a no-op and an interval
 * change is an upsert in place. Any scheduler whose id is no longer in the
 * registry is removed, so a renamed or deleted job stops firing at the next
 * boot rather than lingering forever.
 *
 * The runner has its own Redis socket (BullMQ insists — sharing the
 * RedisService client breaks LUA script ownership), and uses the same
 * `lbr-bull` prefix the email queue uses so all of BullMQ's keys live
 * in one neat namespace.
 */
export async function startScheduledJobs(
  jobs: ScheduledJob[],
  ctx: JobRunnerContext,
): Promise<ScheduledJobsHandle> {
  const env = loadEnv();
  // Handlers get a client that has been connected since boot. When the caller
  // doesn't hand one over we own one for the runner's whole lifetime. What a
  // handler must never do is mint its own per tick: the client disables the
  // offline queue, so its first command rejects while the socket is still
  // connecting (reliability-01 / -16).
  const redis = ctx.redis ?? new RedisService();
  const ownedRedis = ctx.redis ? null : redis;
  const jobCtx: JobContext = { ...ctx, redis };
  // A9-04: a BullMQ blocking Worker monopolizes its socket with blocking
  // commands (BZPOPMIN etc.); sharing that socket with the producer Queue can
  // stall enqueues/reconciliation. Give each its OWN connection (BullMQ's own
  // guidance), mirroring the email worker.
  const redisOpts = { maxRetriesPerRequest: null, enableReadyCheck: false } as const;
  const queueConnection = new Redis(env.redisUrl, redisOpts);
  const workerConnection = new Redis(env.redisUrl, redisOpts);
  const queue = new Queue(QUEUE_NAME, { connection: queueConnection, prefix: QUEUE_PREFIX });

  // Reconcile schedules: remove any scheduler that no longer corresponds to a
  // registered job. Stale schedules can otherwise linger after a deploy that
  // removed or renamed one — silently firing forever.
  //
  // BullMQ 6 replaced the legacy repeatable-job API (queue.add({repeat}),
  // getRepeatableJobs, removeRepeatableByKey) with Job Schedulers, which are
  // identified by an id WE choose rather than by a key BullMQ derives from
  // (name, repeat opts). That is a straight simplification here: the interval
  // no longer participates in identity, so changing a job's interval is an
  // upsert in place instead of remove-then-add.
  const existing = await queue.getJobSchedulers();
  const wanted = new Set(jobs.map((j) => j.name));
  for (const e of existing) {
    if (!wanted.has(e.key)) {
      await queue.removeJobScheduler(e.key);
      // eslint-disable-next-line no-console
      console.log(`[scheduled] removed stale scheduler ${e.key}`);
    }
  }
  for (const j of jobs) {
    // Scheduler id == job name, so it is stable across deploys and interval
    // changes. The template carries the name the Worker switches on below.
    await queue.upsertJobScheduler(
      j.name,
      { every: j.intervalMs },
      { name: j.name, opts: { removeOnComplete: 100, removeOnFail: 100 } },
    );
  }

  const lastResults: Record<string, ScheduledJobResult> = {};
  let inFlight = 0;

  const worker = new Worker(
    QUEUE_NAME,
    async (job) => {
      const def = jobs.find((j) => j.name === job.name);
      if (!def) {
        // Unknown job — likely a leftover from a deploy. Drop it.
        return;
      }
      inFlight++;
      const startedAt = Date.now();
      try {
        const row = toScheduledJobResult(await def.handler(jobCtx));
        lastResults[job.name] = row;
        const elapsedMs = Date.now() - startedAt;
        const line = `[scheduled] ${job.name} (${elapsedMs}ms): ${row.message}`;
        // A partially-failed sweep is a warning, not an info line: it is the
        // only trace before anyone reads /healthz.
        if (!row.ok) {
          console.warn(line);
        } else {
          // eslint-disable-next-line no-console
          console.log(line);
        }
      } catch (err) {
        // SCHEDULED-LASTRESULT-MASKS-FAILURE: record the failure in the health
        // surface too (not just the `worker.on('failed')` stderr line) so an
        // ongoing failure — e.g. an unreachable tenant DB — is visible in
        // /healthz instead of silently masked by the last success.
        lastResults[job.name] = {
          at: new Date().toISOString(),
          message: `FAILED: ${describeError(err)}`,
          ok: false,
        };
        throw err; // re-throw so BullMQ marks the job failed + retries
      } finally {
        inFlight--;
      }
    },
    { connection: workerConnection, prefix: QUEUE_PREFIX, concurrency: 4 },
  );

  worker.on('failed', (job, err) => {
    console.error(`[scheduled] ${job?.name} failed: ${err.message}`);
  });

  // eslint-disable-next-line no-console
  console.log(
    `[scheduled] started — ${jobs.length} job(s): ${jobs
      .map((j) => `${j.name}@${Math.round(j.intervalMs / 1000)}s`)
      .join(', ')}`,
  );

  return {
    inFlight: () => inFlight,
    lastResults: () => ({ ...lastResults }),
    async stop() {
      await worker.close();
      await queue.close();
      await queueConnection.quit();
      await workerConnection.quit();
      // Only ours — a client handed in through the context belongs to the
      // caller and is still in use by whatever else shares it.
      await ownedRedis?.onModuleDestroy();
    },
  };
}
