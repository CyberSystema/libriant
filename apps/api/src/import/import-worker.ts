/**
 * Worker-side consumer for the bulk-import queue.
 *
 * Runs in the separate worker process (see worker.ts). For each job it loads
 * the batch from the control plane, opens the tenant's DB client, re-reads the
 * staged file, and streams every row through the import engine — persisting
 * per-row issues (capped) and live progress to the batch row, and honoring a
 * mid-run cancel. The validate phase is a dry run (no writes); the commit
 * phase writes and then clears the staged file.
 *
 * `processImportJob` is exported standalone (not just behind BullMQ) so it can
 * be driven directly from tests and a cold-start recovery sweep.
 */
import { Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { controlDb } from '@libriant/db-control';
import type { FeatureKey } from '@libriant/shared';
import { disconnectTenantClient, makeTenantPrismaClient } from '@libriant/db-tenant';
import { loadEnv } from '../config/env.js';
import { EffectivePlanService } from '../plans/effective-plan.service.js';
import { PlatformSettingsService } from '../platform-settings/platform-settings.service.js';
import { RedisService } from '../platform/redis.service.js';
import { executeImport } from './engine/runner.js';
import type { EngineContext, EngineRowResult } from './engine/import-engine.js';
import { deleteStaged, readStaged } from './import-staging.js';
import {
  IMPORT_JOB_NAME,
  IMPORT_MAX_ISSUES,
  IMPORT_MAX_ROWS,
  IMPORT_QUEUE_NAME,
  IMPORT_QUEUE_PREFIX,
  type ImportJobData,
  type ImportPhase,
} from './import.constants.js';
import { parseByFormat } from './parsers/index.js';
import type { ColumnMapping } from './mapping/auto-map.js';
import type { SourceFormat } from './parsers/types.js';

export type ImportWorkerDeps = { effective: EffectivePlanService };

/** Process one validate/commit job. Safe to call directly (tests, recovery). */
export async function processImportJob(
  batchId: string,
  phase: ImportPhase,
  deps: ImportWorkerDeps,
): Promise<void> {
  const batch = await controlDb.importBatch.findUnique({ where: { id: batchId } });
  if (!batch) return;
  if (batch.status === 'canceled') return;
  if (!batch.mappingJson) {
    await fail(batchId, 'No column mapping was set.');
    return;
  }

  const tenant = await controlDb.tenant.findUnique({
    where: { id: batch.tenantId },
    select: { dbUrl: true },
  });
  if (!tenant) {
    await fail(batchId, 'Tenant no longer exists.');
    return;
  }

  const dryRun = phase === 'validate';
  const client = makeTenantPrismaClient({ databaseUrl: tenant.dbUrl });

  // Fresh issue list for this run.
  await controlDb.importRowIssue.deleteMany({ where: { batchId } });

  const ctx: EngineContext = {
    client,
    tenantId: batch.tenantId,
    getLimit: (feature: FeatureKey) => deps.effective.getInt(batch.tenantId, feature),
    duplicateMode: batch.duplicateMode,
    dryRun,
  };

  // Per-run state for issue capping, progress + cancel.
  let issuesStored = 0;
  let truncated = false;
  let canceledMidRun = false;
  let issueBuffer: Array<{
    batchId: string;
    phase: ImportPhase;
    rowNumber: number;
    severity: string;
    field: string | null;
    code: string;
    message: string;
  }> = [];
  const tally = { imported: 0, updated: 0, skipped: 0, errorRows: 0, warningRows: 0, total: 0 };

  const flushIssues = async () => {
    if (issueBuffer.length === 0) return;
    const rows = issueBuffer;
    issueBuffer = [];
    await controlDb.importRowIssue.createMany({ data: rows });
  };

  try {
    const data = await readStaged(batch.stagingPath);
    // Parse ONE row past the limit so we can tell "exactly at the cap" from
    // "over the cap" and refuse oversized files instead of OOMing the worker.
    const table = await parseByFormat(batch.format as SourceFormat, data, {
      encoding: batch.encoding ?? undefined,
      delimiter: batch.delimiter ?? undefined,
      sheetName: batch.sheetName ?? undefined,
      noHeader: !batch.hasHeaderRow,
      maxRows: IMPORT_MAX_ROWS + 1,
    });
    if (table.truncated || table.rows.length > IMPORT_MAX_ROWS) {
      throw new Error(
        `This file exceeds the ${IMPORT_MAX_ROWS.toLocaleString()}-row import limit. ` +
          `Split it into smaller files and import them separately.`,
      );
    }

    await controlDb.importBatch.update({
      where: { id: batchId },
      data: { totalRows: table.rows.length },
    });

    const onRow = async (r: EngineRowResult) => {
      tally.total++;
      if (r.outcome === 'imported') tally.imported++;
      else if (r.outcome === 'updated') tally.updated++;
      else if (r.outcome === 'skipped') tally.skipped++;
      else tally.errorRows++;
      if (r.issues.some((i) => i.severity === 'warning')) tally.warningRows++;

      for (const issue of r.issues) {
        if (issuesStored >= IMPORT_MAX_ISSUES) {
          truncated = true;
          break;
        }
        issueBuffer.push({
          batchId,
          phase,
          rowNumber: r.rowNumber,
          severity: issue.severity,
          field: issue.field,
          code: issue.code,
          message: issue.message.slice(0, 500),
        });
        issuesStored++;
      }
      if (issueBuffer.length >= 500) await flushIssues();
    };

    const onProgress = async () => {
      await flushIssues();
      const fresh = await controlDb.importBatch.findUnique({
        where: { id: batchId },
        select: { status: true },
      });
      if (fresh?.status === 'canceled') canceledMidRun = true;
      await controlDb.importBatch.update({
        where: { id: batchId },
        data: {
          validRows: tally.imported + tally.updated + tally.skipped,
          errorRows: tally.errorRows,
          warningRows: tally.warningRows,
          importedRows: dryRun ? 0 : tally.imported,
          updatedRows: dryRun ? 0 : tally.updated,
          skippedRows: dryRun ? 0 : tally.skipped,
        },
      });
    };

    await executeImport(batch.entityKind, table, batch.mappingJson as ColumnMapping, ctx, {
      onRow,
      onProgress,
      shouldAbort: () => canceledMidRun,
    });
    await flushIssues();

    if (canceledMidRun) {
      // Leave status 'canceled'; record what we managed.
      await controlDb.importBatch.update({
        where: { id: batchId },
        data: { ...finalCounts(tally, dryRun), issuesTruncated: truncated, finishedAt: new Date() },
      });
      if (!dryRun) await deleteStaged(batch.stagingPath);
      return;
    }

    const status = dryRun ? 'validated' : tally.errorRows > 0 ? 'partially_completed' : 'completed';
    await controlDb.importBatch.update({
      where: { id: batchId },
      data: {
        status,
        issuesTruncated: truncated,
        finishedAt: new Date(),
        ...finalCounts(tally, dryRun),
      },
    });
    if (!dryRun) await deleteStaged(batch.stagingPath);
  } catch (err) {
    await flushIssues().catch(() => undefined);
    await fail(batchId, (err as Error).message);
  } finally {
    await disconnectTenantClient(client).catch(() => undefined);
  }
}

function finalCounts(
  tally: {
    imported: number;
    updated: number;
    skipped: number;
    errorRows: number;
    warningRows: number;
    total: number;
  },
  dryRun: boolean,
) {
  return {
    totalRows: tally.total,
    validRows: tally.imported + tally.updated + tally.skipped,
    errorRows: tally.errorRows,
    warningRows: tally.warningRows,
    importedRows: dryRun ? 0 : tally.imported,
    updatedRows: dryRun ? 0 : tally.updated,
    skippedRows: dryRun ? 0 : tally.skipped,
  };
}

async function fail(batchId: string, message: string): Promise<void> {
  await controlDb.importBatch
    .update({
      where: { id: batchId },
      data: { status: 'failed', error: message.slice(0, 1000), finishedAt: new Date() },
    })
    .catch(() => undefined);
}

export type ImportWorkerHandle = {
  worker: Worker;
  inFlight(): number;
  stop(): Promise<void>;
};

export async function startImportWorker(deps: ImportWorkerDeps): Promise<ImportWorkerHandle> {
  const env = loadEnv();
  const connection = new Redis(env.redisUrl, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });
  let inFlight = 0;
  const worker = new Worker<ImportJobData>(
    IMPORT_QUEUE_NAME,
    async (job) => {
      if (job.name !== IMPORT_JOB_NAME) return;
      inFlight++;
      try {
        await processImportJob(job.data.batchId, job.data.phase, deps);
      } finally {
        inFlight--;
      }
    },
    // Concurrency 1: imports are heavy + a tenant's rows must commit in order
    // (references resolve against rows imported earlier in the same file).
    { connection, concurrency: 1, prefix: IMPORT_QUEUE_PREFIX },
  );
  worker.on('failed', (job, err) => {
    console.error(`[import-worker] job ${job?.id} failed: ${err.message}`);
  });
  // eslint-disable-next-line no-console
  console.log('[import-worker] started');

  return {
    worker,
    inFlight: () => inFlight,
    async stop() {
      await worker.close();
      await connection.quit();
    },
  };
}

/** Convenience for the worker process: build deps from a shared Redis. */
export function makeImportWorkerDeps(redis: RedisService): ImportWorkerDeps {
  return { effective: new EffectivePlanService(redis, new PlatformSettingsService(redis)) };
}
