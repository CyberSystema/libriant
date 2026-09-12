/**
 * Orchestrator that joins the three layers — parse → map → engine — into a
 * single pass over a file's rows. Used by both the dry-run (validate) and the
 * commit phases; the only difference is `ctx.dryRun`.
 *
 * Callbacks let the caller (the BullMQ worker) stream per-row issues to the
 * `import_row_issues` table and update progress without holding every row
 * result in memory.
 *
 * ## Why the loop no longer names its engine (2.0 phase 20c)
 *
 * There are two engines now — `ImportEngine` writes the seven 1.0 tables,
 * `ImportEngineV2` writes `lbr2` through the services — and exactly one row
 * loop, because everything around the write is identical: the same mapping, the
 * same issue streaming, the same progress ping, the same mid-run cancel. A
 * second copy of this loop would be the place the two engines silently stopped
 * counting a `skipped` row the same way.
 *
 * So {@link runRows} takes anything with a `processRow`, and
 * {@link executeImport} stays exactly what it was: the 1.0 façade, constructing
 * and initialising `ImportEngine`. Its three specs and its signature are
 * unchanged.
 */
import type { ImportEntityKind } from '@libriant/db-control';
import type { ColumnMapping } from '../mapping/auto-map.js';
import { mapRow, type MappedRow } from '../mapping/row-mapper.js';
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

/**
 * The one thing {@link runRows} needs of an engine.
 *
 * Deliberately narrower than either engine: `init()` is not here because only
 * the 1.0 engine has pre-run state to load (field definitions, the tenant's
 * currency, the quota ceiling), and an `init()` on the 2.0 engine that existed
 * only to satisfy an interface would be a method whose whole job is to be
 * empty. Whoever constructs an engine initialises it.
 */
export type RowEngine = {
  processRow(row: MappedRow): Promise<EngineRowResult>;
};

const PROGRESS_EVERY = 50;

/** Walk a parsed file through one engine, tallying as it goes. */
export async function runRows(
  engine: RowEngine,
  kind: ImportEntityKind,
  table: ParsedTable,
  mapping: ColumnMapping,
  cb: ExecuteCallbacks = {},
): Promise<ImportSummary> {
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

/** The 1.0 path: build the engine that writes `books`/`members`/… and run it. */
export async function executeImport(
  kind: ImportEntityKind,
  table: ParsedTable,
  mapping: ColumnMapping,
  ctx: EngineContext,
  cb: ExecuteCallbacks = {},
): Promise<ImportSummary> {
  const engine = new ImportEngine(kind, ctx);
  await engine.init();
  return runRows(engine, kind, table, mapping, cb);
}
