/** Shared constants for the operator-maintenance queue. Mirrors the import
 *  queue's BullMQ naming (`lbr-bull` prefix, one job name). */
export const MAINTENANCE_QUEUE_NAME = 'maintenance';
export const MAINTENANCE_JOB_NAME = 'run';
export const MAINTENANCE_QUEUE_PREFIX = 'lbr-bull';

export type MaintenanceJobData = { runId: string };

/** One issue surfaced by a diagnostics scan. */
export type MaintenanceIssue = {
  severity: 'error' | 'warning' | 'info';
  /** Human-readable target, e.g. "control DB" or "tenant: acme". */
  target: string;
  message: string;
};

/** One target's outcome for migrate / fix / vacuum runs. */
export type MaintenanceTargetResult = {
  target: string;
  ok: boolean;
  summary: string;
};
