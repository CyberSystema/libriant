export const EXPORT_QUEUE_NAME = 'export';
export const EXPORT_JOB_NAME = 'run';
export const EXPORT_QUEUE_PREFIX = 'lbr-bull';

export type ExportJobData = { jobId: string };

/** How long a produced export file is kept before a cleanup sweep may purge it. */
export const EXPORT_TTL_HOURS = 24;

/**
 * The longest a single export run may take. ONE number, shared by the two
 * places that used to guess at it independently:
 *
 *   - export-processors.ts ENFORCES it (per-batch deadline check, and
 *     `execFile`'s own timeout for pg_dump), so a run cannot exceed it;
 *   - export-cleanup.job.ts REAPS past it, in the confidence that anything
 *     older is dead rather than merely slow.
 *
 * They were two independent constants before: the reaper's comment claimed 1 h
 * was "far longer than any healthy export" while MAX_EXPORT_ROWS had been
 * raised to 25,000,000 to make an Institutional library's ~6M rows exportable
 * at all. A healthy multi-hour export was therefore reapable mid-run — the
 * sweep would delete the artifacts a live worker was still writing and mark the
 * job failed. Deriving both from one constant makes the reaper's claim true by
 * construction instead of by comment.
 *
 * 4 hours: at the ~5k rows/s an end-to-end cursor→CSV→zip run sustains, 25M
 * rows lands near 90 minutes, so this leaves comfortable headroom for a slow
 * disk or a busy database while still bounding the REPEATABLE READ snapshot a
 * run holds open against the tenant database's vacuum.
 */
export const EXPORT_MAX_RUNTIME_MS = 4 * 60 * 60 * 1000;

/**
 * How long a job may sit in `queued` before the sweep calls it lost.
 *
 * Separate from the runtime budget because the export queue has a single slot:
 * a queued job is legitimately waiting behind other people's exports, and
 * reaping it for being old would punish it for the queue working as designed.
 * Sized at three back-to-back maximum-length runs — a backlog deeper than that
 * means the queue is wedged, not busy, and the job is better failed than left
 * pending forever.
 */
export const EXPORT_MAX_QUEUED_MS = 3 * EXPORT_MAX_RUNTIME_MS;
