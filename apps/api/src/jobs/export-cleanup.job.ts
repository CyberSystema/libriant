import { promises as fs } from 'node:fs';
import { Logger } from '@nestjs/common';
import { controlDb } from '@libriant/db-control';
import type { JobResult } from './jobs.types.js';

/**
 * Export-file cleanup sweep.
 *
 * Database exports (ExportModule) write a file to the shared storage volume and
 * stamp the job with `expiresAt` (~24h out). Nothing purged them yet — this
 * sweep deletes the file for every expired job and nulls the file columns. The
 * row is kept as history; the download endpoint already returns a friendly 404
 * once `filePath` is gone.
 */
const logger = new Logger('ExportCleanupSweeper');

export async function sweepExpiredExports(): Promise<JobResult> {
  const now = new Date();
  const stale = await controlDb.exportJob.findMany({
    where: { expiresAt: { lt: now }, filePath: { not: null } },
    select: { id: true, filePath: true },
  });

  let deleted = 0;
  let failed = 0;
  for (const job of stale) {
    try {
      if (job.filePath) await fs.rm(job.filePath, { force: true });
      await controlDb.exportJob.update({
        where: { id: job.id },
        data: { filePath: null, fileBytes: null },
      });
      deleted++;
    } catch (err) {
      failed++;
      logger.warn(`failed to purge export ${job.id}: ${(err as Error).message}`);
    }
  }

  return {
    message:
      deleted === 0
        ? 'no expired export files to purge'
        : `purged ${deleted} expired export file(s)`,
    counts: { purged: deleted, failed },
  };
}
