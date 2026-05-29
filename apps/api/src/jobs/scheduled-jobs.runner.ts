import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { loadEnv } from '../config/env.js';
import type { JobContext, ScheduledJob } from './jobs.types.js';

const QUEUE_NAME = 'scheduled';
const QUEUE_PREFIX = 'lbr-bull';

export type ScheduledJobsHandle = {
  /** Counter the worker exposes via /metrics. */
  inFlight(): number;
  /** Job name → last result snapshot, for /healthz introspection. */
  lastResults(): Record<string, { at: string; message: string }>;
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
  const connection = new Redis(env.redisUrl, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });
  const queue = new Queue(QUEUE_NAME, { connection, prefix: QUEUE_PREFIX });

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

  const lastResults: Record<string, { at: string; message: string }> = {};
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
        };
        const elapsedMs = Date.now() - startedAt;
        // eslint-disable-next-line no-console
        console.log(`[scheduled] ${job.name} (${elapsedMs}ms): ${result.message}`);
      } finally {
        inFlight--;
      }
    },
    { connection, prefix: QUEUE_PREFIX, concurrency: 4 },
  );

  worker.on('failed', (job, err) => {
    // eslint-disable-next-line no-console
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
      await connection.quit();
    },
  };
}

function repeatKey(name: string, intervalMs: number): string {
  return `${name}:${intervalMs}`;
}
