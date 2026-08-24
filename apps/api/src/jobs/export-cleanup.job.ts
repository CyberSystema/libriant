import { promises as fs } from 'node:fs';
import { Logger } from '@nestjs/common';
import { controlDb } from '@libriant/db-control';
import { purgeJobArtifacts } from '../export/export-processors.js';
import { EXPORT_MAX_QUEUED_MS, EXPORT_MAX_RUNTIME_MS } from '../export/export.constants.js';
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

/**
 * When a job that never finished is presumed dead — and why the two states are
 * measured differently.
 *
 * This used to be one hour, keyed on `createdAt`, with a comment claiming an
 * hour was "far longer than any healthy export". That stopped being true the
 * moment MAX_EXPORT_ROWS was raised to 25,000,000 so an Institutional library
 * (≈6M rows) could export at all: a perfectly healthy multi-hour run would be
 * swept mid-flight — `purgeJobArtifacts` deleting the spool files the live
 * worker was still writing, and the row marked failed underneath it.
 *
 * So the reaper no longer guesses. `EXPORT_MAX_RUNTIME_MS` is ENFORCED by the
 * processor (per-batch deadline; `execFile` timeout for pg_dump), so a run past
 * it is genuinely dead rather than slow. The grace covers the gap between the
 * deadline firing and the failure being written.
 *
 * `running` is measured from `startedAt`, not `createdAt`: the queue has a
 * single slot, so `createdAt` includes however long the job waited behind other
 * people's exports — time the run itself never had. `queued` gets its own,
 * larger budget for the same reason (see EXPORT_MAX_QUEUED_MS).
 */
const STALE_RUN_GRACE_MS = 10 * 60 * 1000;
const STALE_RUN_MS = EXPORT_MAX_RUNTIME_MS + STALE_RUN_GRACE_MS;

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
  //
  // The two states are measured from different clocks; see STALE_RUN_MS. A
  // `running` row with a null `startedAt` should not exist (the processor sets
  // it in the same update that sets the status), but if one does, fall back to
  // `createdAt` so it is still reclaimable rather than immortal.
  const runDeadline = new Date(now.getTime() - STALE_RUN_MS);
  const queueDeadline = new Date(now.getTime() - EXPORT_MAX_QUEUED_MS);
  let recovered = 0;
  const stuck = await controlDb.exportJob.findMany({
    where: {
      OR: [
        {
          status: 'running',
          OR: [
            { startedAt: { lt: runDeadline } },
            { startedAt: null, createdAt: { lt: runDeadline } },
          ],
        },
        { status: 'queued', createdAt: { lt: queueDeadline } },
      ],
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
