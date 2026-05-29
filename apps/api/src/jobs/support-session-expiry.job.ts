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
 */
export async function sweepExpiredSupportSessions(ctx: JobContext): Promise<JobResult> {
  const now = new Date();
  const expired = await controlDb.supportSession.findMany({
    where: { endedAt: null, expiresAt: { lt: now } },
    select: { id: true, tenantId: true, _count: { select: { actions: true } } },
  });
  if (expired.length === 0) return { message: 'no expired sessions', counts: { ended: 0 } };

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
  return {
    message: `ended ${ended} expired session(s); notified ${notified}`,
    counts: { ended, notified, considered: expired.length },
  };
}
