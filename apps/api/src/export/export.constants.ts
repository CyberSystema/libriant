export const EXPORT_QUEUE_NAME = 'export';
export const EXPORT_JOB_NAME = 'run';
export const EXPORT_QUEUE_PREFIX = 'lbr-bull';

export type ExportJobData = { jobId: string };

/** How long a produced export file is kept before a cleanup sweep may purge it. */
export const EXPORT_TTL_HOURS = 24;
