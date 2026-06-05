/** Shared constants for the bulk-import queue + staging. */
export const IMPORT_QUEUE_NAME = 'import';
export const IMPORT_JOB_NAME = 'process';
export const IMPORT_QUEUE_PREFIX = 'lbr-bull';

/** Hard ceiling on an uploaded import file (64 MB). Multer rejects larger. */
export const IMPORT_MAX_UPLOAD_BYTES = 64 * 1024 * 1024;

/** Cap on how many per-row issues we persist for one batch (very dirty file). */
export const IMPORT_MAX_ISSUES = 5000;

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
