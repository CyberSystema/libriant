import { promises as fs } from 'node:fs';
import { Logger } from '@nestjs/common';
import { controlDb } from '@libriant/db-control';
import { purgeJobArtifacts } from '../export/export-processors.js';
import type { JobResult } from './jobs.types.js';

/**
 * Export-file cleanup sweep.
 *
 * Database exports (ExportModule) write a file to the shared storage volume and
 * stamp the job with `expiresAt` (~24h out). Nothing purged them yet — this
 * sweep deletes the file for every expired job and nulls the file columns. The
 * row is kept as history; the download endpoint already returns a friendly 404
 * once `filePath` is gone.
 *
 * It also reclaims orphans (EXP-003): a job that crashed mid-run can leave a
 * partial `${jobId}.*` artifact on disk with no `filePath` recorded, and stick
 * forever at status='running'/'queued'. We sweep those by jobId regardless of
 * `filePath`, and time out runs that never finished so the row reflects reality.
 */
const logger = new Logger('ExportCleanupSweeper');

/** A job still 'running'/'queued' past this age is presumed dead (worker crash). */
const STALE_RUN_MS = 60 * 60 * 1000; // 1h — far longer than any healthy export

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
      // Also remove any sibling artifacts (e.g. leftover temp dumps) by jobId.
      await purgeJobArtifacts(job.id);
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

  // EXP-003: jobs stuck running/queued past the timeout are presumed crashed —
  // reclaim their on-disk artifacts and mark them failed so they don't hang
  // "running" forever with no recovery signal.
  let recovered = 0;
  const stuck = await controlDb.exportJob.findMany({
    where: {
      status: { in: ['running', 'queued'] },
      createdAt: { lt: new Date(now.getTime() - STALE_RUN_MS) },
    },
    select: { id: true },
  });
  for (const job of stuck) {
    try {
      await purgeJobArtifacts(job.id);
      await controlDb.exportJob.update({
        where: { id: job.id },
        data: {
          status: 'failed',
          finishedAt: now,
          filePath: null,
          fileBytes: null,
          error: 'Export timed out or the worker stopped before it finished.',
        },
      });
      recovered++;
    } catch (err) {
      failed++;
      logger.warn(`failed to reclaim stuck export ${job.id}: ${(err as Error).message}`);
    }
  }

  const parts: string[] = [];
  if (deleted > 0) parts.push(`purged ${deleted} expired export file(s)`);
  if (recovered > 0) parts.push(`reclaimed ${recovered} stuck export(s)`);
  return {
    message: parts.length === 0 ? 'no expired export files to purge' : parts.join('; '),
    counts: { purged: deleted, recovered, failed },
  };
}
