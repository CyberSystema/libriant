import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { loadEnv } from '../config/env.js';
import { NotifyService } from '../platform/notify.service.js';
import { RedisService } from '../platform/redis.service.js';
import { describeError } from './job-error.js';
import type { JobContext, JobResult, JobRunnerContext, ScheduledJob } from './jobs.types.js';

const QUEUE_NAME = 'scheduled';
const QUEUE_PREFIX = 'lbr-bull';

/**
 * How many times a scheduled tick may run before BullMQ gives up on it.
 *
 * reliability-20: the scheduler template used to carry only
 * `{ removeOnComplete, removeOnFail }`. BullMQ's default is `attempts: 1`, so
 * nothing was ever retried — while the worker body below re-threw with the
 * comment "so BullMQ marks the job failed + retries". It did not retry, and the
 * comment told every maintainer since that it did.
 *
 * Whether that matters depends on the interval. The registry's hourly jobs are
 * the ones that hurt: a two-second Postgres blip at the top of the hour cost
 * `member-notifications` a whole hour, so a hold that went ready at 10:00
 * reached the member at 12:00 — and `fine-accrual` an hour of staleness at the
 * desk. Three attempts turn that into a ~30-second delay.
 *
 * Deliberately NOT the other half of the pair the finding offered ("or correct
 * the comment to say recovery is the next tick"): every job here is an
 * idempotent sweep, so re-running one is free, and free recovery inside the
 * minute beats documented recovery in an hour.
 */
const SCHEDULED_JOB_ATTEMPTS = 3;

/**
 * Exponential backoff delay for a job that ticks every `intervalMs`.
 *
 * The constraint is that the whole retry chain has to finish inside ONE
 * interval, or the last retry of tick N lands on top of tick N+1 and two copies
 * of the same sweep run against the same tenant databases. BullMQ's exponential
 * strategy fires at `delay`, then `2 * delay`, so `SCHEDULED_JOB_ATTEMPTS = 3`
 * spends `3 * delay` in total: at the cap that is 30 s, half of the 60 s
 * shortest interval in the registry.
 *
 * Derived from the interval rather than hard-coded at 10 s so it stays true
 * without anyone rechecking it — registering a job that ticks every 15 s would
 * otherwise silently reintroduce the overlap, and this is exactly the class of
 * comment-that-stops-being-true the finding is about.
 */
function retryBackoffMs(intervalMs: number): number {
  return Math.max(1_000, Math.min(10_000, Math.floor(intervalMs / 6)));
}

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

/**
 * How long this process stays quiet about a job it has already announced on
 * the operator's phone.
 *
 * The push wired into `worker.on('failed')` below is the first thing in this
 * repository that reaches a person without them going and looking —
 * launch-readiness-06 measured the detection time for anything breaking here
 * as "until the sole operator next looks", which the handbook sets at weekly.
 * That makes the VOLUME question the whole design, and the answer is already
 * written in the comment on {@link BACKLOG_KEYS} just above: an alert that is
 * always firing gets silenced, and a silenced channel carries exactly as much
 * information as no channel. On a phone the silencing is one tap, and nothing
 * in this file can detect that it happened.
 *
 * So the cooldown is per job NAME and it is long. Every job in the registry is
 * an idempotent sweep on its own interval, so a broken one is broken for
 * hours: the second, third and hundredth exhaustion inside a working day are
 * the same fact told again. Six hours bounds the worst case — every one of the
 * eleven registered jobs failing continuously for a day — at 11 × 4 = 44
 * pushes. At one hour it would be 264.
 *
 * The eleven-at-once case (Postgres gone) stays loud on purpose: eleven
 * notifications in the first minutes say "nothing is working", which is true,
 * and then it goes quiet instead of repeating itself all day.
 *
 * DELIBERATELY NOT reset when the job next succeeds, which is the obvious
 * refinement and the wrong one. `support-session-expiry` ticks every 60 s, so
 * a sweep flapping between success and failure would announce itself every
 * other tick — 720 times a day, which is precisely the muting this constant
 * exists to prevent. A flapper is announced once and then read on /healthz
 * like every other ongoing condition.
 */
const JOB_ANNOUNCE_COOLDOWN_MS = 6 * 60 * 60_000;

/**
 * Does this failure earn a push, and record that it got one.
 *
 * Two gates, and the first is the one that matters: a job is announced only
 * once BullMQ has spent the WHOLE retry budget on the tick. reliability-20
 * gave every tick three attempts backing off by intervalMs/6 exactly because a
 * two-second Postgres blip at the top of the hour is not an incident —
 * announcing the first attempt would push for every blip the retries exist to
 * absorb, and would make the phone busiest during the outages it rides out.
 *
 * `|| 1` on both fields rather than `??`, for the same reason the log line
 * below carries the same comment: BullMQ stores an absent retry budget as
 * `attempts: 0`, so `??` would compare against zero and make every FIRST
 * failure look like an exhausted one.
 *
 * Exported, and taking its clock and its map as arguments, so the decision can
 * be driven without a Redis — which is the only kind of test this file's suite
 * can run.
 */
export function shouldAnnounceJobFailure(
  job: { name?: string; attemptsMade?: number; attempts?: number },
  announcedAt: Map<string, number>,
  now: number = Date.now(),
): boolean {
  const name = job.name;
  if (!name) return false;
  if ((job.attemptsMade || 1) < (job.attempts || 1)) return false;
  const last = announcedAt.get(name);
  if (last !== undefined && now - last < JOB_ANNOUNCE_COOLDOWN_MS) return false;
  announcedAt.set(name, now);
  return true;
}

/**
 * Gate, compose and send — the whole of what a broken sweep puts on a phone.
 *
 * THE ERROR TEXT IS NOT IN THE MESSAGE, and its absence is the design. A Prisma
 * connect failure quotes the DATABASE_URL and an ioredis one quotes the Redis
 * URL; both carry a password, into a message that leaves the country, is
 * retained by ntfy.sh and — on a public topic — is readable by anyone who
 * guesses the string. The job NAME is a static identifier out of registry.ts
 * and names no tenant and no person; that, plus where to look, is the whole
 * doorbell. NotifyService redacts as a backstop, but a call site that leans on
 * the backstop is a call site that will eventually outsmart it.
 *
 * `warn`, not `error`: `error` is the only level a handset can be told to let
 * through do-not-disturb, and a sweep that will re-run on its own interval is
 * not worth 03:00. It is worth today.
 *
 * Exported so the gate, the wording and the send can be driven together
 * without a Redis — `startScheduledJobs` needs one and this decision does not.
 */
export function announceJobFailure(
  notifier: Pick<NotifyService, 'sendDetached'>,
  job: { name?: string; attemptsMade?: number; attempts?: number },
  announcedAt: Map<string, number>,
  now: number = Date.now(),
): void {
  if (!shouldAnnounceJobFailure(job, announcedAt, now)) return;
  const hours = JOB_ANNOUNCE_COOLDOWN_MS / 3_600_000;
  notifier.sendDetached({
    level: 'warn',
    title: `Scheduled job failing: ${job.name}`,
    body:
      `${job.name} used all ${job.attempts || 1} attempts of one tick and gave up. ` +
      'Fines, holds, member notices, retention and cleanup all run on these sweeps. ' +
      "The worker's /healthz has the last result for every job and its container log has " +
      `the error — deliberately not repeated here. Nothing more about this job for ${hours} hours.`,
    tags: ['gear'],
  });
}

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
    // changes. The template carries the name the Worker switches on below, and
    // the retry budget every produced job inherits.
    await queue.upsertJobScheduler(
      j.name,
      { every: j.intervalMs },
      {
        name: j.name,
        opts: {
          removeOnComplete: 100,
          removeOnFail: 100,
          attempts: SCHEDULED_JOB_ATTEMPTS,
          backoff: { type: 'exponential', delay: retryBackoffMs(j.intervalMs) },
        },
      },
    );
  }

  const lastResults: Record<string, ScheduledJobResult> = {};
  let inFlight = 0;
  /**
   * Job name → when this process last put that job on the operator's phone.
   *
   * Per runner rather than per module so two runners in one process (only the
   * tests do that) cannot silence each other, and so the state dies with the
   * handle. It is in-memory on purpose: a restart re-arms the announcement,
   * which is the right direction — a worker that has just crashed and come
   * back is a worker whose next failure is worth hearing about again.
   */
  const announcedAt = new Map<string, number>();
  /**
   * Constructed here, not injected: this file is started from worker.ts with a
   * hand-built context and there is no Nest container in that process at all.
   * NotifyService needs no collaborators, is off unless NTFY_TOPIC is set, and
   * never throws.
   */
  const notifier = new NotifyService();

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
        // Re-throw so BullMQ marks the attempt failed and retries it — up to
        // SCHEDULED_JOB_ATTEMPTS, backing off by retryBackoffMs. Before
        // reliability-20 the template carried no `attempts`, so this line
        // marked the tick failed and recovery waited for the next interval.
        throw err;
      } finally {
        inFlight--;
      }
    },
    { connection: workerConnection, prefix: QUEUE_PREFIX, concurrency: 4 },
  );

  worker.on('failed', (job, err) => {
    // Name the attempt. With retries on (reliability-20) this line fires once
    // per attempt, and "3/3" versus "1/3" is the difference between a sweep
    // that is down and one that rode out a blip.
    // `|| 1`, not `?? 1`: BullMQ stores an absent retry budget as `attempts: 0`,
    // so `??` rendered "attempt 1/0" — which is how this line read for every
    // failure before reliability-20.
    const attempt = `${job?.attemptsMade || 1}/${job?.opts.attempts || 1}`;
    console.error(`[scheduled] ${job?.name} failed (attempt ${attempt}): ${err.message}`);

    // …and, once the retries are spent, tell a person. The line above goes to
    // stderr in a rolling container log which, per launch-readiness-06, nobody
    // reads until the weekly sweep; `libriant_worker_job_last_ok` is exported
    // but infra/monitoring/alerts.yml has no rule pointed at it, so today a
    // sweep can stop working and stay stopped with nobody told.
    //
    // Wrapped, because "a notification must never break the thing it reports
    // on" has to hold here whatever NotifyService does: an exception escaping a
    // BullMQ event listener is an unhandled rejection in the worker process,
    // which is a notifier that kills the jobs it was installed to watch.
    try {
      announceJobFailure(
        notifier,
        { name: job?.name, attemptsMade: job?.attemptsMade, attempts: job?.opts.attempts },
        announcedAt,
      );
    } catch (notifyErr) {
      console.error(`[scheduled] job-failure notification dropped: ${describeError(notifyErr)}`);
    }
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
