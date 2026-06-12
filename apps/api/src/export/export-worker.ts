import { Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { loadEnv } from '../config/env.js';
import {
  EXPORT_JOB_NAME,
  EXPORT_QUEUE_NAME,
  EXPORT_QUEUE_PREFIX,
  type ExportJobData,
} from './export.constants.js';
import { processExportJob } from './export-processors.js';

export type ExportWorkerHandle = {
  worker: Worker;
  inFlight(): number;
  stop(): Promise<void>;
};

/** Consumes the export queue. Concurrency 1 — exports are I/O heavy (full DB
 *  reads + zip) and shouldn't pile up. */
export async function startExportWorker(): Promise<ExportWorkerHandle> {
  const env = loadEnv();
  const connection = new Redis(env.redisUrl, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });
  let inFlight = 0;
  const worker = new Worker<ExportJobData>(
    EXPORT_QUEUE_NAME,
    async (job) => {
      if (job.name !== EXPORT_JOB_NAME) return;
      inFlight++;
      try {
        await processExportJob(job.data.jobId);
      } finally {
        inFlight--;
      }
    },
    { connection, concurrency: 1, prefix: EXPORT_QUEUE_PREFIX },
  );
  worker.on('failed', (job, err) => {
    console.error(`[export-worker] job ${job?.id} failed: ${err.message}`);
  });
  // eslint-disable-next-line no-console
  console.log('[export-worker] started');

  return {
    worker,
    inFlight: () => inFlight,
    async stop() {
      await worker.close();
      await connection.quit();
    },
  };
}
