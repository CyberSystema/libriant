import { sweepExpiredReservationPickups } from './reservation-expiry.job.js';
import { sweepExpiredMarcLocks } from './marc-lock-expiry.job.js';
import { sweepExpiredSupportSessions } from './support-session-expiry.job.js';
import { sweepFailedStripeWebhooks } from './stripe-retry.job.js';
import { sweepFineAccrual } from './fine-accrual.job.js';
import { sweepExpiredExports } from './export-cleanup.job.js';
import { publishDueAnnouncements } from './announcement-publish.job.js';
import { refreshBookMetadata } from './book-metadata-refresh.job.js';
import { sendMemberNotifications } from './member-notifications.job.js';
import { sweepStaleStorageTemps } from './storage-temp-cleanup.job.js';
import { recomputeStorageUsage } from './storage-usage-recompute.job.js';
import { sweepRetention } from './retention.job.js';
import { CATALOG_VERIFY_JOB, verifyCatalogProjections } from './catalog-verify.job.js';
import { PARTITION_MAINTENANCE_JOB, maintainPartitions } from './partition-maintenance.job.js';
import {
  CIRCULATION_ROLLUP_JOB,
  rollUpCirculationStatistics,
} from './circulation-statistics-rollup.job.js';
import { HOLD_EXPIRY_JOB, sweepHoldExpiry } from './hold-expiry.job.js';
import { HOLD_TRANSIT_TIMEOUT_JOB, checkHoldTransitTimeouts } from './hold-transit-timeout.job.js';
import type { ScheduledJob } from './jobs.types.js';

/**
 * The actual cron registry — add a new background job here. Names are
 * stable + canonical: changing one renames the BullMQ schedule, which
 * the runner reconciles (old name removed, new name registered).
 *
 * Frequency cheatsheet — what each band is FOR, and what is in it today:
 *   60 s   — user-facing state cleanup: support-session-expiry,
 *            reservation-pickup-expiry, announcement-publish.
 *   5 min  — best-effort retry of failed integrations: stripe-webhook-retry.
 *  60 min  — desk-facing sweeps that are cheap to re-run: fine-accrual,
 *            member-notifications, export-file-cleanup, storage-temp-cleanup.
 *   6 h    — polite backfill against a third-party API: book-metadata-refresh.
 *  24 h    — heavy batch: retention-sweep, storage-usage-recompute.
 *
 * Every interval here is also a retry budget: the runner gives each tick
 * SCHEDULED_JOB_ATTEMPTS attempts backing off by intervalMs/6, so the whole
 * chain finishes inside one interval and two copies of a sweep never overlap.
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
    // Five minutes, not one. This sweep is NOT what makes an expired lock
    // acquirable — that lives in the acquire predicate and needs no job — so
    // its only job is to write the audit row for a lock that lapsed and was
    // never touched again. Nothing waits on it, and running it every minute
    // would scan every tenant sixty times an hour to usually find nothing.
    name: 'marc-lock-expiry',
    intervalMs: 5 * 60_000,
    handler: () => sweepExpiredMarcLocks(),
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
    // Hourly: best-effort disk cleanup of crash-orphaned upload temps. Each
    // tick reads one staging directory per active tenant — the one `put()`
    // renames out of — so it is a handful of syscalls, not a tree walk
    // (performance-16). That is why hourly is affordable AND right: temps only
    // appear on a crash mid-upload, so the working set is normally empty, and
    // when it is not the orphan is gone within 90 minutes. Default 30-min
    // staleness skips in-flight writes; idempotent — a re-run with nothing
    // stale removes nothing.
    name: 'storage-temp-cleanup',
    intervalMs: 60 * 60_000,
    handler: () => sweepStaleStorageTemps(),
  },
  {
    // 24h: this is the storage-limitation job (GDPR Art. 5(1)(e)) and the only
    // thing in the product that deletes personal data on age — site
    // applications at the 12 months libriant.com promises, and each library's
    // audit log at the retention its plan sells. Daily because every period it
    // enforces is measured in months or days, so a finer cadence would only
    // re-scan the same rows; each tick is bounded and idempotent, so a restart
    // storm re-running it costs nothing.
    //
    // REGISTERED HERE ON PURPOSE: the first attempt at this finding shipped a
    // retention rule bolted onto the e-mail worker's recovery timer, where it
    // existed in no registry any operator would ever look at. If it is not in
    // this list, it does not exist.
    name: 'retention-sweep',
    intervalMs: 24 * 60 * 60_000,
    // Takes the ctx for the runner's warm Redis client (plan resolution).
    handler: (ctx) => sweepRetention(ctx),
  },
  {
    // 24h: this IS the "nightly recompute" that storage.service.ts names three
    // separate times as the backstop for its best-effort counter maintenance
    // (data-integrity-12). It never existed, so every swallowed decrement was
    // permanent and a library's usable storage only ever shrank. Each tick
    // walks every active tenant's whole storage tree, so it is the heaviest
    // sweep here; daily is the cadence the comments promise and the drift it
    // repairs is not minute-grained. Idempotent — it overwrites a derived
    // number with what is on the volume.
    name: 'storage-usage-recompute',
    intervalMs: 24 * 60 * 60_000,
    // Takes the ctx for the runner's warm Redis client (StorageService's
    // EffectivePlanService dependency).
    handler: (ctx) => recomputeStorageUsage(ctx),
  },
  {
    // 24h, and it is the heaviest sweep here: it re-projects every
    // bibliographic record in the fleet. Daily is not a compromise but the
    // right cadence — the projection is written inside the write transaction,
    // so it cannot drift by racing; the only thing that introduces drift is a
    // DEPLOY that changes the projector, and running hourly would re-read every
    // catalogue twenty-four times to find, on twenty-three of them, nothing.
    //
    // It never writes. Same rule as the ledger reconciliation (risk 7): a sweep
    // that silently repairs drift also silently hides the change that caused
    // it. Repair is `pnpm catalog:verify --repair`, run by a person.
    name: CATALOG_VERIFY_JOB,
    intervalMs: 24 * 60 * 60_000,
    handler: () => verifyCatalogProjections(),
  },
  {
    /**
     * Roll the monthly partition window forward (2.0 phase 16).
     *
     * DAILY, and the cadence is chosen from what it prevents rather than from
     * what it does. It almost always does nothing: the window is 24 months and
     * a month passes once a month. What it is guarding against is a `23514` on
     * an INSERT into `audit_log` or `circulation_statistics` when the window
     * finally runs out — which the baseline migration deliberately made LOUD,
     * naming this job and this phase as the reason nobody ever hears it.
     *
     * Hourly would re-read every partition catalogue in the fleet twenty-four
     * times a day to find nothing; weekly would leave a restored-from-backup
     * tenant with a stale window for a week.
     */
    name: PARTITION_MAINTENANCE_JOB,
    intervalMs: 24 * 60 * 60_000,
    handler: () => maintainPartitions(),
  },
  {
    /**
     * Rebuild `circulation_statistics` from `loan_events` (2.0 phase 16).
     *
     * Hourly, in the "desk-facing sweeps that are cheap to re-run" band, beside
     * `fine-accrual` — and for the same reason: it is a full RECOMPUTE of the
     * current and previous month, so re-running it within the hour is an
     * idempotent no-op and a missed tick catches up on the next one. A branch
     * manager looking at this month's figures at 16:00 should not be reading
     * yesterday's.
     */
    name: CIRCULATION_ROLLUP_JOB,
    intervalMs: 60 * 60_000,
    handler: () => rollUpCirculationStatistics(),
  },
  {
    /**
     * Expire hold-shelf and unfilled requests (2.0 phase 17).
     *
     * HOURLY, in the "desk-facing sweeps that are cheap to re-run" band, and
     * that band is chosen for a reason a daily sweep would get wrong: a shelf
     * expiry frees a COPY, and the reader behind it in the queue should be told
     * within the hour rather than at 03:00 the next morning. The sweep is
     * idempotent — every write re-checks that the request is still open — so a
     * missed tick catches up on the next one and a doubled tick does nothing.
     *
     * It is not in the 60 s band because nothing here is user-facing state
     * cleanup: a shelf expiry is a deadline that passed, and a reader who
     * arrives four minutes after it has still arrived after it.
     */
    name: HOLD_EXPIRY_JOB,
    intervalMs: 60 * 60_000,
    handler: () => sweepHoldExpiry(),
  },
  {
    /**
     * Copies sent for a reader that have not arrived (2.0 phase 17).
     *
     * DAILY, because it reports rather than repairs and the thing it reports on
     * moves at the speed of a van. Hourly would re-count the same crate
     * twenty-four times and produce an alert that flaps on nothing.
     */
    name: HOLD_TRANSIT_TIMEOUT_JOB,
    intervalMs: 24 * 60 * 60_000,
    handler: () => checkHoldTransitTimeouts(),
  },
];
