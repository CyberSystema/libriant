/**
 * Orchestrator that joins the three layers — parse → map → engine — into a
 * single pass over a file's rows. Used by both the dry-run (validate) and the
 * commit phases; the only difference is `ctx.dryRun`.
 *
 * Callbacks let the caller (the BullMQ worker) stream per-row issues to the
 * `import_row_issues` table and update progress without holding every row
 * result in memory.
 */
import type { ImportEntityKind } from '@libriant/db-control';
import type { ColumnMapping } from '../mapping/auto-map.js';
import { mapRow } from '../mapping/row-mapper.js';
import type { ParsedTable } from '../parsers/types.js';
import {
  ImportEngine,
  type EngineContext,
  type EngineRowResult,
  type ImportSummary,
} from './import-engine.js';

export type ExecuteCallbacks = {
  /** Called once per row with its outcome + issues. May persist/inspect. */
  onRow?: (result: EngineRowResult) => Promise<void> | void;
  /** Throttled progress ping (rows processed, total). */
  onProgress?: (done: number, total: number) => Promise<void> | void;
  /** Polled between rows; returning true aborts the run cleanly. */
  shouldAbort?: () => boolean | Promise<boolean>;
};

const PROGRESS_EVERY = 50;

export async function executeImport(
  kind: ImportEntityKind,
  table: ParsedTable,
  mapping: ColumnMapping,
  ctx: EngineContext,
  cb: ExecuteCallbacks = {},
): Promise<ImportSummary> {
  const engine = new ImportEngine(kind, ctx);
  await engine.init();

  const summary: ImportSummary = {
    total: 0,
    imported: 0,
    updated: 0,
    skipped: 0,
    errorRows: 0,
    warningRows: 0,
  };
  const total = table.rows.length;
  let done = 0;

  for (const raw of table.rows) {
    if (cb.shouldAbort && (await cb.shouldAbort())) break;
    const mapped = mapRow(kind, mapping, raw);
    const result = await engine.processRow(mapped);

    summary.total++;
    switch (result.outcome) {
      case 'imported':
        summary.imported++;
        break;
      case 'updated':
        summary.updated++;
        break;
      case 'skipped':
        summary.skipped++;
        break;
      case 'error':
        summary.errorRows++;
        break;
    }
    if (result.issues.some((i) => i.severity === 'warning')) summary.warningRows++;

    if (cb.onRow) await cb.onRow(result);
    done++;
    if (cb.onProgress && done % PROGRESS_EVERY === 0) await cb.onProgress(done, total);
  }
  if (cb.onProgress) await cb.onProgress(done, total);
  return summary;
}
