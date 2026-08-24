import { sweepExpiredReservationPickups } from './reservation-expiry.job.js';
import { sweepExpiredSupportSessions } from './support-session-expiry.job.js';
import { sweepFailedStripeWebhooks } from './stripe-retry.job.js';
import { sweepFineAccrual } from './fine-accrual.job.js';
import { sweepExpiredExports } from './export-cleanup.job.js';
import { publishDueAnnouncements } from './announcement-publish.job.js';
import { refreshBookMetadata } from './book-metadata-refresh.job.js';
import { sendMemberNotifications } from './member-notifications.job.js';
import { sweepStaleStorageTemps } from './storage-temp-cleanup.job.js';
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
    // Takes the ctx for its Redis client: a sweep that mints its own loses the
    // race against `enableOfflineQueue: false` and retries nothing (rel-16).
    handler: (ctx) => sweepFailedStripeWebhooks(ctx),
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
  {
    // 6h: book metadata is near-static, so this is a slow backfill — fill the
    // gaps OpenLibrary can cover without hammering their free API.
    name: 'book-metadata-refresh',
    intervalMs: 6 * 60 * 60_000,
    handler: () => refreshBookMetadata(),
  },
  {
    // Hourly: prompt enough for hold-ready pickups, and due-soon/overdue are
    // day-grained so re-runs within a day are idempotent no-ops (the email
    // pipeline dedups on idempotencyKey).
    name: 'member-notifications',
    intervalMs: 60 * 60_000,
    // Same reason as stripe-webhook-retry: use the runner's warm Redis client.
    handler: (ctx) => sendMemberNotifications(ctx),
  },
  {
    // Hourly: best-effort disk cleanup of crash-orphaned upload temps. Each tick
    // walks every active tenant's storage tree, so it's a filesystem sweep
    // rather than a DB query — hourly keeps orphans from lingering without
    // re-walking constantly (temps only appear on a crash mid-upload, so the
    // working set is normally empty). Default 30-min staleness skips in-flight
    // writes; idempotent — a re-run with nothing stale removes nothing.
    name: 'storage-temp-cleanup',
    intervalMs: 60 * 60_000,
    handler: () => sweepStaleStorageTemps(),
  },
];
