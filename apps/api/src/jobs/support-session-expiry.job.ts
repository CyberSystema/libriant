import { controlDb } from '@libriant/db-control';
import { SupportNotificationsService } from '../support/support-notifications.service.js';
import type { JobContext, JobResult } from './jobs.types.js';

/**
 * 18a deferred — "support-session auto-expiry sweeper" (originally
 * called out as `session-expiry.job.ts` in the plan's critical-files
 * list).
 *
 * Finds every support session where `expiresAt < now` and `endedAt
 * IS NULL`, ends each one with reason `expired`, and fires the same
 * `sessionEnded` notification the controller fires when an admin or
 * library ends the session manually.
 *
 * Race-safe: the `updateMany` uses `endedAt: null` as a guard so a
 * concurrent end (admin or library) wins cleanly and the sweeper
 * skips emitting a duplicate notification. The notification itself
 * is idempotent via the `support.session.ended:<sessionId>` key
 * (Step 18a + 18d).
 *
 * SUPPORT-EXPIRY-NOTIFY-AFTER-COMMIT: the row is stamped `endedAt`
 * before the (error-swallowed) notification enqueue, so a lost enqueue
 * (Redis/DB blip inside `SupportNotificationsService`) would never be
 * retried — once `endedAt` is set the main query skips the row forever.
 * To close that gap, after ending sessions we re-scan recently-expired
 * sessions whose `support.session.ended:<id>` outbox row is missing and
 * re-enqueue. The enqueue is idempotent, so re-firing one that did land
 * is a cheap no-op (alreadyExisted), but a genuinely-lost one recovers.
 */

/** How far back to re-scan ended sessions for a missing notification. Comfortably
 *  wider than the 60s sweep interval so a lost enqueue gets several chances. */
const NOTIFY_BACKFILL_WINDOW_MS = 60 * 60_000;

export async function sweepExpiredSupportSessions(ctx: JobContext): Promise<JobResult> {
  const now = new Date();
  const expired = await controlDb.supportSession.findMany({
    where: { endedAt: null, expiresAt: { lt: now } },
    select: { id: true, tenantId: true, _count: { select: { actions: true } } },
  });

  const notifs = new SupportNotificationsService(ctx.emails);
  let ended = 0;
  let notified = 0;
  for (const s of expired) {
    const update = await controlDb.supportSession.updateMany({
      where: { id: s.id, endedAt: null },
      data: { endedAt: now, endedReason: 'expired' },
    });
    if (update.count === 0) continue; // lost race to admin/library end
    ended++;
    await notifs.sessionEnded({
      sessionId: s.id,
      tenantId: s.tenantId,
      endedReason: 'expired',
      actionCount: s._count.actions,
    });
    notified++;
  }

  // Backfill: re-enqueue the end notification for any recently-expired session
  // whose outbox row never landed (e.g. a transient enqueue failure on a prior
  // run, where `endedAt` was already committed). Idempotent, so safe to re-run.
  let reNotified = 0;
  const since = new Date(now.getTime() - NOTIFY_BACKFILL_WINDOW_MS);
  const recentlyEnded = await controlDb.supportSession.findMany({
    where: { endedReason: 'expired', endedAt: { not: null, gte: since } },
    select: { id: true, tenantId: true, _count: { select: { actions: true } } },
  });
  if (recentlyEnded.length > 0) {
    const present = await controlDb.emailOutbox.findMany({
      where: {
        idempotencyKey: { in: recentlyEnded.map((s) => `support.session.ended:${s.id}`) },
      },
      select: { idempotencyKey: true },
    });
    const haveNotif = new Set(present.map((r) => r.idempotencyKey));
    for (const s of recentlyEnded) {
      if (haveNotif.has(`support.session.ended:${s.id}`)) continue;
      await notifs.sessionEnded({
        sessionId: s.id,
        tenantId: s.tenantId,
        endedReason: 'expired',
        actionCount: s._count.actions,
      });
      reNotified++;
    }
  }

  if (expired.length === 0 && reNotified === 0) {
    return { message: 'no expired sessions', counts: { ended: 0 } };
  }
  return {
    message: `ended ${ended} expired session(s); notified ${notified}; re-notified ${reNotified}`,
    counts: { ended, notified, reNotified, considered: expired.length },
  };
}
