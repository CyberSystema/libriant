/**
 * Shape of an entry registered with the scheduled-jobs runner.
 *
 * Handlers return a small result so the runner can log a single line per
 * tick (`[jobs] support-session-expiry: ended 2 expired session(s)`).
 * Errors are caught by the runner — handlers should just throw and
 * BullMQ records the failure for the next tick.
 */
export type JobResult = {
  /** Free-form short status line for logging. */
  message: string;
  /** Counts that get bumped on `libriant_worker_jobs_total{job=...}` later. */
  counts?: Record<string, number>;
};

/**
 * The collaborator bag every handler receives. Kept narrow so it's
 * obvious what jobs are allowed to do — the worker process is the only
 * place these get instantiated, so the only way to add a new global
 * capability is to extend this shape (which forces a docs read).
 */
export interface JobContext {
  /** EmailService for outgoing transactional notifications (18d). */
  emails: import('../email/email.service.js').EmailService;
}

export type ScheduledJob = {
  /** Unique stable name. Used as the BullMQ `jobId` for the scheduler entry. */
  name: string;
  /** How often to fire, in ms. */
  intervalMs: number;
  /** Run the work. Resolves with a 1-line summary; throws on failure. */
  handler: (ctx: JobContext) => Promise<JobResult>;
};
