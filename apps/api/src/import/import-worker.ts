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
import {
  disconnectTenantClient,
  makeTenantPrismaClient,
  makeTenantPrismaClientV2,
  v2SchemaFor,
} from '@libriant/db-tenant';
import { loadEnv } from '../config/env.js';
import { EffectivePlanService } from '../plans/effective-plan.service.js';
import { PlatformSettingsService } from '../platform-settings/platform-settings.service.js';
import { RedisService } from '../platform/redis.service.js';
import {
  TENANT_CONTEXT_SELECT,
  runtimeDbUrl,
  tenantContextFrom,
} from '../tenancy/tenant-db-url.js';
import { executeImport, runRows } from './engine/runner.js';
import type { EngineContext, EngineRowResult } from './engine/import-engine.js';
import { makeImportEngineV2 } from './engine/import-engine-v2.wiring.js';
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
    select: TENANT_CONTEXT_SELECT,
  });
  if (!tenant) {
    await fail(batchId, 'Tenant no longer exists.');
    return;
  }

  const dryRun = phase === 'validate';

  // WHICH SCHEMA THIS LIBRARY IS ON (2.0 phase 20c).
  //
  // `tenant_schema_state.schemaMajor` is the fleet flag `tenant-upgrade-v2.ts`
  // stamps after it commits a cutover, and its model comment is the contract:
  // "1 = the pre-2.0 shape; the 2.0 upgrade sets 2". Reading it here is not a
  // feature flag and not a rollout decision — it is the only correct answer.
  // After the cutover the 1.0 tables are in `v1_archive`, so `ImportEngine`
  // would not write the wrong data, it would fail on every row with "relation
  // does not exist"; before the cutover `ImportEngineV2` would write into a
  // schema no screen in the product reads yet. There is no tenant for which
  // either choice is a matter of taste.
  //
  // Defaulting to 1 when the row is absent is deliberate: every database that
  // has never been upgraded is 1 by definition, and the upsert that sets 2 runs
  // AFTER the upgrade transaction commits — so "no row" and "row says 1" mean
  // the same thing and a missing row must never be read as "probably 2.0".
  const schemaState = await controlDb.tenantSchemaState.findUnique({
    where: { tenantId: batch.tenantId },
    select: { schemaMajor: true },
  });
  const v2 = (schemaState?.schemaMajor ?? 1) >= 2;

  // performance-06's arithmetic, applied here too: this consumer runs at
  // `concurrency: 1` and walks ONE tenant's rows sequentially, so one
  // connection is all it can use. Without `maxPoolSize` the pool defaults to 5
  // — five connections held for the length of a 250 000-row import, outside
  // the budget `resolveTenantPoolPlan` computes for the sweeps and counted by
  // nobody.
  //
  // The 2.0 client is opened on the same terms and only when it will be used.
  // `makeImportEngineV2` hands both to the services rather than letting a
  // `TenantPrismaService` open a pool of its own, which would be a fifth
  // concurrent holder of the worker's share — the budget divides it four ways.
  const databaseUrl = runtimeDbUrl(tenant);
  const client = makeTenantPrismaClient({ databaseUrl, maxPoolSize: 1 });
  const clientV2 = v2
    ? makeTenantPrismaClientV2({
        databaseUrl,
        maxPoolSize: 1,
        // This worker is the one place that knew the tenant's schema before
        // 20f existed. Now it says so to the client as well, instead of
        // letting it default to the pre-cutover `lbr2`.
        v2Schema: v2SchemaFor(schemaState?.schemaMajor),
      })
    : null;

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

    const cb = { onRow, onProgress, shouldAbort: () => canceledMidRun };
    if (clientV2 === null) {
      await executeImport(batch.entityKind, table, batch.mappingJson as ColumnMapping, ctx, cb);
    } else {
      // 003 / 040 $a — the library's MARC organisation code, which is what a
      // record says about where it was catalogued. Taken from whichever branch
      // declares one; `LBR-<slug>` is the fallback BECAUSE that is exactly what
      // `tenant-upgrade-v2.ts` writes into the records it carries forward, and
      // a library whose upgraded records and imported records disagreed about
      // their own 003 would be reporting two different cataloguing agencies.
      const withCode = await clientV2.branch.findFirst({
        where: { marcOrgCode: { not: null }, archivedAt: null },
        select: { marcOrgCode: true },
        orderBy: { id: 'asc' },
      });
      const built = await makeImportEngineV2({
        kind: batch.entityKind,
        // The flag this worker already read, now carried on the context so the
        // 2.0 client binds to the schema this library actually has (20f).
        tenant: tenantContextFrom(tenant, 'path', schemaState?.schemaMajor ?? 1),
        // The librarian who started the import, so the audit row the service
        // writes names a person rather than the queue. `system` only when the
        // batch predates the column or the user has since been deleted.
        actor: {
          userId: batch.createdByUserId,
          actorId: batch.createdByUserId ?? 'system',
          actorType: batch.createdByUserId === null ? 'system' : 'user',
          supportSessionId: null,
        },
        duplicateMode: batch.duplicateMode,
        dryRun,
        orgCode: withCode?.marcOrgCode ?? `LBR-${tenant.slug}`,
        client,
        clientV2,
        plans: deps.effective,
      });
      try {
        await runRows(
          built.engine,
          batch.entityKind,
          table,
          batch.mappingJson as ColumnMapping,
          cb,
        );
      } finally {
        await built.close();
      }
    }
    await flushIssues();

    if (canceledMidRun) {
      // Leave status 'canceled'; record what we managed.
      await controlDb.importBatch.update({
        where: { id: batchId },
        data: {
          ...finalCounts(tally, dryRun),
          issuesTruncated: truncated,
          finishedAt: new Date(),
          // input-and-files-06: `stagingPath` is the record of "these bytes are
          // on the shared volume". Blank it in the SAME write that deletes them
          // or the staging budget keeps charging the tenant for a file that no
          // longer exists — and `requireRunnable` keeps offering a re-run that
          // can only die on ENOENT.
          //
          // A CANCELLED batch is terminal in both phases: `requireRunnable`
          // rejects status `canceled`, so a cancelled DRY RUN's file could
          // never be used again either, and leaving it behind was a 64 MB leak
          // per cancelled validation.
          stagingPath: '',
        },
      });
      await deleteStaged(batch.stagingPath);
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
        ...(dryRun ? {} : { stagingPath: '' }),
      },
    });
    if (!dryRun) await deleteStaged(batch.stagingPath);
  } catch (err) {
    await flushIssues().catch(() => undefined);
    await fail(batchId, (err as Error).message);
  } finally {
    await disconnectTenantClient(client).catch(() => undefined);
    if (clientV2 !== null) await disconnectTenantClient(clientV2).catch(() => undefined);
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
