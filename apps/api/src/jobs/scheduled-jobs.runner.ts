import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { loadEnv } from '../config/env.js';
import type { JobContext, ScheduledJob } from './jobs.types.js';

const QUEUE_NAME = 'scheduled';
const QUEUE_PREFIX = 'lbr-bull';

/** One job's last run outcome, surfaced via /healthz. `ok: false` rows let
 *  ops see ongoing failures without scraping stderr (SCHEDULED-LASTRESULT). */
export type ScheduledJobResult = { at: string; message: string; ok: boolean };

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
  ctx: JobContext,
): Promise<ScheduledJobsHandle> {
  const env = loadEnv();
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
        const result = await def.handler(ctx);
        lastResults[job.name] = {
          at: new Date().toISOString(),
          message: result.message,
          ok: true,
        };
        const elapsedMs = Date.now() - startedAt;
        // eslint-disable-next-line no-console
        console.log(`[scheduled] ${job.name} (${elapsedMs}ms): ${result.message}`);
      } catch (err) {
        // SCHEDULED-LASTRESULT-MASKS-FAILURE: record the failure in the health
        // surface too (not just the `worker.on('failed')` stderr line) so an
        // ongoing failure — e.g. an unreachable tenant DB — is visible in
        // /healthz instead of silently masked by the last success.
        lastResults[job.name] = {
          at: new Date().toISOString(),
          message: `FAILED: ${(err as Error).message}`,
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
    },
  };
}
