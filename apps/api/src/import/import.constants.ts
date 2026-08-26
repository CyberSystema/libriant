/** Shared constants for the bulk-import queue + staging. */
export const IMPORT_QUEUE_NAME = 'import';
export const IMPORT_JOB_NAME = 'process';
export const IMPORT_QUEUE_PREFIX = 'lbr-bull';

/** Hard ceiling on an uploaded import file (64 MB). Multer rejects larger. */
export const IMPORT_MAX_UPLOAD_BYTES = 64 * 1024 * 1024;

/**
 * input-and-files-06 — THE STAGING BUDGET.
 *
 * A staged upload lives at `STORAGE_ROOT/_imports/<batchId>.<ext>` and is
 * DELIBERATELY excluded from the tenant's `max_storage_mb` quota (see
 * import-staging.ts) so a migration file doesn't eat the library's own storage
 * allowance. That exclusion was the whole defence: nothing else bounded it.
 * Any owner/admin — or an honest librarian retrying a failing import twenty
 * times — could park 64 MB per attempt, forever, on the volume that also holds
 * EVERY other tenant's covers and photos and every export artifact. Exports
 * have had a cleanup sweeper since day one; imports had none, and the one job
 * that visits abandoned batches (`sweepStuckBatches`) deliberately KEEPS the
 * file so a re-run works.
 *
 * So: a per-tenant budget on upload, and a sweeper for what slips past it.
 *
 * The two limits bind in different places on purpose — the count stops a
 * retry storm of small files, the byte budget stops a couple of huge ones.
 */
export const IMPORT_MAX_STAGED_BATCHES = 3;
export const IMPORT_MAX_STAGED_BYTES = 128 * 1024 * 1024;

/**
 * How long an un-run staged upload survives before the sweeper deletes the
 * FILE (the batch row and its issue report stay, so the history is intact).
 * Comfortably longer than a librarian's coffee break and shorter than the
 * overnight window in which an abandoned 64 MB file would otherwise become
 * permanent.
 */
export const IMPORT_STAGING_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Batch states in which a staged file is expected to exist on disk. Everything
 * else either never had one or had it deleted on finish — and since the
 * deleting paths now blank `stagingPath` too, a non-empty `stagingPath` in one
 * of these states means "bytes on the shared volume, right now".
 */
export const IMPORT_STAGED_STATUSES = [
  'uploaded',
  'validating',
  'validated',
  'committing',
  'failed',
  // `canceled` is here as a backstop, not because a cancelled batch should keep
  // a file: `ImportService.cancel` deletes it when the batch was not running,
  // and the worker deletes it when it was. But cancelling an `uploaded` batch
  // used to be a silent bypass of every limit here — the row left the counted
  // states while the 64 MB stayed on disk — so if a crash ever lands between
  // the delete and the DB write, the tenant is charged for it rather than
  // handed a free slot.
  'canceled',
] as const;

/**
 * Hard ceiling on rows in a single import. The upload-byte cap bounds the
 * *compressed* input, but a spreadsheet (xlsx is a zip) can decompress to far
 * more rows than its file size suggests, and the worker holds every parsed row
 * in memory — so an unbounded parse can OOM the worker (taking all queued jobs
 * with it). We parse one row past this cap; if the file has more, the batch
 * fails with a clear "split the file" message rather than silently dropping
 * rows or running the process out of memory.
 */
export const IMPORT_MAX_ROWS = 250_000;

/** Hard ceiling on columns in a single import — guards pathologically wide sheets. */
export const IMPORT_MAX_COLUMNS = 512;

/** Cap on how many per-row issues we persist for one batch (very dirty file). */
export const IMPORT_MAX_ISSUES = 5000;

/**
 * A8-01: ceiling on the TOTAL declared uncompressed size of an .xlsx (a zip)
 * before we let exceljs inflate it. A decompression bomb is a tiny upload that
 * inflates to gigabytes, OOM-ing the shared worker (V8 aborts the process —
 * uncatchable — taking every queue down). We read the zip central directory
 * (sizes only, no inflation) and reject anything whose declared expansion
 * exceeds this. 512 MB comfortably covers a legitimate 64 MB-on-disk workbook
 * (xlsx XML compresses ~5–15×) while blocking pathological ratios.
 */
export const IMPORT_MAX_XLSX_UNCOMPRESSED_BYTES = 512 * 1024 * 1024;

export type ImportPhase = 'validate' | 'commit';

export type ImportJobData = {
  batchId: string;
  phase: ImportPhase;
};

/** File extension to stage an upload under, by source format. */
export function stagingExtFor(format: string): string {
  switch (format) {
    case 'tsv':
      return 'tsv';
    case 'xlsx':
      return 'xlsx';
    case 'marc':
      return 'mrc';
    case 'marcxml':
      return 'xml';
    default:
      return 'csv';
  }
}
