import { sweepExpiredReservationPickups } from './reservation-expiry.job.js';
import { sweepExpiredSupportSessions } from './support-session-expiry.job.js';
import { sweepFailedStripeWebhooks } from './stripe-retry.job.js';
import { sweepFineAccrual } from './fine-accrual.job.js';
import { sweepExpiredExports } from './export-cleanup.job.js';
import { publishDueAnnouncements } from './announcement-publish.job.js';
import type { ScheduledJob } from './jobs.types.js';

/**
 * The actual cron registry — add a new background job here. Names are
 * stable + canonical: changing one renames the BullMQ schedule, which
 * the runner reconciles (old name removed, new name registered).
 *
 * Frequency cheatsheet:
 *   60 s   — user-facing state cleanup (sessions, holds).
 *   5 min  — best-effort retry of failed integrations.
 *  60 min  — nightly-ish stats jobs (none today).
 *  24 h    — heavy batch (none today).
 */
export const SCHEDULED_JOBS: ScheduledJob[] = [
  {
    name: 'support-session-expiry',
    intervalMs: 60_000,
    handler: sweepExpiredSupportSessions,
  },
  {
    name: 'reservation-pickup-expiry',
    intervalMs: 60_000,
    handler: () => sweepExpiredReservationPickups(),
  },
  {
    name: 'stripe-webhook-retry',
    intervalMs: 5 * 60_000,
    handler: () => sweepFailedStripeWebhooks(),
  },
  {
    // Hourly: fines only change at day boundaries, so re-running within a day
    // is a cheap idempotent no-op; hourly keeps it fresh + survives restarts.
    name: 'fine-accrual',
    intervalMs: 60 * 60_000,
    handler: () => sweepFineAccrual(),
  },
  {
    name: 'export-file-cleanup',
    intervalMs: 60 * 60_000,
    handler: () => sweepExpiredExports(),
  },
  {
    // 60s: scheduled announcements should go live promptly at publishAt.
    name: 'announcement-publish',
    intervalMs: 60_000,
    handler: () => publishDueAnnouncements(),
  },
];
