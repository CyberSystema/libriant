/**
 * Shape of an entry registered with the scheduled-jobs runner.
 *
 * Handlers return a small result so the runner can log a single line per
 * tick (`[jobs] support-session-expiry: ended 2 expired session(s)`).
 * Errors are caught by the runner — handlers should just throw. BullMQ retries
 * the tick (see SCHEDULED_JOB_ATTEMPTS in scheduled-jobs.runner.ts), which is
 * only safe because every job here is an idempotent sweep; a handler that is
 * not re-runnable does not belong in this registry.
 */
export type JobResult = {
  /** Free-form short status line for logging. */
  message: string;
  /**
   * Named counters for the run. Surfaced verbatim on the worker's /healthz
   * next to the message, and exported per-job on /metrics.
   *
   * Two naming rules, both read by `toScheduledJobResult` in
   * scheduled-jobs.runner.ts — get them wrong and the health surface lies:
   *
   *   1. Anything this run ATTEMPTED and could not complete goes in a counter
   *      whose name ends in `Failed` (`tenantsFailed`, `rowsFailed`,
   *      `retryFailed`). Non-zero makes the run NOT ok. This applies at EVERY
   *      granularity: a per-row `catch` that only logs is the same lie as a
   *      per-tenant one, just further down — reservation-expiry reported clean
   *      successes for a tenant in which every single expiry threw.
   *   2. Work deliberately NOT attempted because it is known-stuck (a poison
   *      row a sweep has given up retrying) goes in `abandoned` / `backlog` /
   *      `stuck`. Those are printed for the operator but do NOT flip `ok`,
   *      because a job that is permanently red tells you exactly as much as
   *      one that is permanently green.
   *
   * Everything else is informational (`tenantsScanned`, `expired`, …).
   */
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
  /**
   * A Redis client that is already connected.
   *
   * Handlers must NOT do `new RedisService()`: the client is built with
   * `enableOfflineQueue: false`, so the first command on a socket that is
   * still `connecting` rejects with "Stream isn't writeable…". Every job that
   * minted its own client lost that race on every tick (reliability-01 / -16).
   * This one is owned by the process that started the runner and outlives any
   * single tick — so a handler shares it and never calls `onModuleDestroy()`
   * on it.
   */
  redis: import('../platform/redis.service.js').RedisService;
}

/**
 * What `startScheduledJobs` accepts. `redis` is optional here only so the
 * embedding process can leave it out and let the runner own a long-lived
 * client of its own; handlers always get one.
 */
export type JobRunnerContext = Omit<JobContext, 'redis'> & Partial<Pick<JobContext, 'redis'>>;

export type ScheduledJob = {
  /** Unique stable name. Used as the BullMQ `jobId` for the scheduler entry. */
  name: string;
  /** How often to fire, in ms. */
  intervalMs: number;
  /** Run the work. Resolves with a 1-line summary; throws on failure. */
  handler: (ctx: JobContext) => Promise<JobResult>;
};
