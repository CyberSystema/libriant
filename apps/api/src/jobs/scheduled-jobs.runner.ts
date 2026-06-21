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
 * registers every entry in `jobs`. Repeat-job dedup is keyed on
 * `(name, intervalMs)` so re-running this with the same config is a
 * no-op; changes to the interval get reconciled by removing any
 * repeat-job entry whose name no longer matches the current registry.
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

  // Reconcile schedules: remove any repeat-job whose key doesn't match a
  // currently-registered entry. Stale schedules can otherwise linger after
  // a deploy that removed or renamed a job — silently firing forever.
  const existing = await queue.getRepeatableJobs();
  const wantedKeys = new Set(jobs.map((j) => repeatKey(j.name, j.intervalMs)));
  for (const e of existing) {
    // BullMQ types `every` as `string | number | undefined` (it accepts
    // both raw ms and stringified ms). Normalise before comparison.
    const everyMs = typeof e.every === 'string' ? Number(e.every) : (e.every ?? 0);
    const k = repeatKey(e.name, everyMs);
    if (!wantedKeys.has(k)) {
      await queue.removeRepeatableByKey(e.key);
      // eslint-disable-next-line no-console
      console.log(`[scheduled] removed stale repeat job ${e.name}`);
    }
  }
  for (const j of jobs) {
    await queue.add(
      j.name,
      {},
      {
        repeat: { every: j.intervalMs },
        // No `jobId` — BullMQ infers a stable key from (name, repeat opts).
        removeOnComplete: 100,
        removeOnFail: 100,
      },
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

function repeatKey(name: string, intervalMs: number): string {
  return `${name}:${intervalMs}`;
}
