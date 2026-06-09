import { Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { loadEnv } from '../config/env.js';
import type { RedisService } from '../platform/redis.service.js';
import {
  MAINTENANCE_JOB_NAME,
  MAINTENANCE_QUEUE_NAME,
  MAINTENANCE_QUEUE_PREFIX,
  type MaintenanceJobData,
} from './maintenance.constants.js';
import { processMaintenanceRun } from './maintenance-processors.js';

export type MaintenanceWorkerHandle = {
  worker: Worker;
  inFlight(): number;
  stop(): Promise<void>;
};

export type MaintenanceWorkerDeps = { redis: RedisService };

/**
 * Consumes the maintenance queue. Concurrency 1 — these jobs touch every DB
 * (migrations, VACUUM) and shouldn't pile up against each other.
 */
export async function startMaintenanceWorker(
  deps: MaintenanceWorkerDeps,
): Promise<MaintenanceWorkerHandle> {
  const env = loadEnv();
  const connection = new Redis(env.redisUrl, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });
  let inFlight = 0;
  const worker = new Worker<MaintenanceJobData>(
    MAINTENANCE_QUEUE_NAME,
    async (job) => {
      if (job.name !== MAINTENANCE_JOB_NAME) return;
      inFlight++;
      try {
        await processMaintenanceRun(job.data.runId, deps);
      } finally {
        inFlight--;
      }
    },
    { connection, concurrency: 1, prefix: MAINTENANCE_QUEUE_PREFIX },
  );
  worker.on('failed', (job, err) => {
    console.error(`[maintenance-worker] job ${job?.id} failed: ${err.message}`);
  });
  // eslint-disable-next-line no-console
  console.log('[maintenance-worker] started');

  return {
    worker,
    inFlight: () => inFlight,
    async stop() {
      await worker.close();
      await connection.quit();
    },
  };
}
