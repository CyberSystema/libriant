import { beforeEach, describe, expect, it, vi } from 'vitest';

// Hoisted mock fns: vitest pulls vi.mock() above all imports, so factory
// closures need their captured vars also hoisted.
const { sessionFindMany, sessionUpdateMany, tenantFindUnique, outboxFindMany, emailEnqueue } =
  vi.hoisted(() => ({
    sessionFindMany: vi.fn(),
    sessionUpdateMany: vi.fn(),
    tenantFindUnique: vi.fn(),
    outboxFindMany: vi.fn(),
    emailEnqueue: vi.fn().mockResolvedValue({ outboxId: 'o-1', alreadyExisted: false }),
  }));

vi.mock('@libriant/db-control', () => ({
  controlDb: {
    supportSession: { findMany: sessionFindMany, updateMany: sessionUpdateMany },
    tenant: { findUnique: tenantFindUnique },
    emailOutbox: { findMany: outboxFindMany },
  },
}));
vi.mock('../config/env.js', () => ({
  loadEnv: () => ({
    supportKeyTtlSec: 3600,
    publicAppUrl: 'https://libriant.app',
  }),
}));

import { sweepExpiredSupportSessions } from './support-session-expiry.job.js';
import type { EmailService } from '../email/email.service.js';

function ctx() {
  return { emails: { enqueue: emailEnqueue } as unknown as EmailService };
}

describe('sweepExpiredSupportSessions', () => {
  beforeEach(() => {
    sessionFindMany.mockReset();
    sessionUpdateMany.mockReset();
    tenantFindUnique.mockReset();
    outboxFindMany.mockReset();
    emailEnqueue.mockClear();
    // Default: no recently-ended sessions need a backfill notification. The
    // `recentlyEnded` re-scan (SUPPORT-EXPIRY-NOTIFY-AFTER-COMMIT) is the
    // SECOND supportSession.findMany call; tests that want it return rows
    // override with a second `mockResolvedValueOnce`.
    sessionFindMany.mockResolvedValue([]);
    outboxFindMany.mockResolvedValue([]);
    tenantFindUnique.mockResolvedValue({
      id: 't-a',
      slug: 'acme',
      name: 'Acme',
      primaryEmail: 'ops@acme.test',
      defaultLocale: 'en',
    });
  });

  it('returns a no-op summary when nothing is expired or owed a backfill', async () => {
    const result = await sweepExpiredSupportSessions(ctx());

    expect(result).toEqual({
      message: 'no expired sessions',
      counts: { ended: 0 },
    });
    expect(sessionUpdateMany).not.toHaveBeenCalled();
    expect(emailEnqueue).not.toHaveBeenCalled();
  });

  it('ends each expired session and fires one notification per ended row', async () => {
    sessionFindMany.mockReset();
    sessionFindMany
      .mockResolvedValueOnce([
        { id: 's-1', tenantId: 't-a', _count: { actions: 3 } },
        { id: 's-2', tenantId: 't-b', _count: { actions: 0 } },
      ])
      .mockResolvedValueOnce([]); // recentlyEnded backfill scan: nothing owed
    sessionUpdateMany.mockResolvedValue({ count: 1 });

    const result = await sweepExpiredSupportSessions(ctx());

    expect(result.counts?.ended).toBe(2);
    expect(result.counts?.notified).toBe(2);
    expect(sessionUpdateMany).toHaveBeenCalledTimes(2);
    expect(emailEnqueue).toHaveBeenCalledTimes(2);
    // Notification idempotency key matches 18a/18d contract.
    expect(emailEnqueue.mock.calls[0]![0]).toMatchObject({
      idempotencyKey: 'support.session.ended:s-1',
      kind: 'support_session_ended',
    });
  });

  it('skips the notification when the row was already ended by someone else (race)', async () => {
    sessionFindMany.mockReset();
    sessionFindMany
      .mockResolvedValueOnce([{ id: 's-1', tenantId: 't-a', _count: { actions: 1 } }])
      .mockResolvedValueOnce([]);
    sessionUpdateMany.mockResolvedValue({ count: 0 }); // lost the race

    const result = await sweepExpiredSupportSessions(ctx());

    expect(result.counts?.ended).toBe(0);
    expect(result.counts?.notified).toBe(0);
    expect(emailEnqueue).not.toHaveBeenCalled();
  });

  it('reports tenants we did process even when one notification enqueue throws', async () => {
    sessionFindMany.mockReset();
    sessionFindMany
      .mockResolvedValueOnce([
        { id: 's-1', tenantId: 't-a', _count: { actions: 1 } },
        { id: 's-2', tenantId: 't-b', _count: { actions: 1 } },
      ])
      .mockResolvedValueOnce([]);
    sessionUpdateMany.mockResolvedValue({ count: 1 });
    // The notifications service catches per-call failures internally
    // and logs them — so even if enqueue throws, the sweeper still
    // counts the ended row.
    emailEnqueue.mockRejectedValueOnce(new Error('email exploded'));

    const result = await sweepExpiredSupportSessions(ctx());

    expect(result.counts?.ended).toBe(2);
    expect(result.counts?.notified).toBe(2);
  });

  it('re-enqueues the end notification for a recently-ended session whose outbox row is missing', async () => {
    // No newly-expired sessions this tick, but one recently-ended `expired`
    // session never got its notification row (SUPPORT-EXPIRY-NOTIFY-AFTER-COMMIT).
    sessionFindMany.mockReset();
    sessionFindMany
      .mockResolvedValueOnce([]) // expired-and-not-yet-ended: none
      .mockResolvedValueOnce([
        { id: 's-9', tenantId: 't-a', _count: { actions: 2 } }, // recently ended
      ]);
    outboxFindMany.mockResolvedValue([]); // outbox row absent → notification owed

    const result = await sweepExpiredSupportSessions(ctx());

    expect(result.counts?.ended).toBe(0);
    expect(result.counts?.reNotified).toBe(1);
    expect(emailEnqueue).toHaveBeenCalledTimes(1);
    expect(emailEnqueue.mock.calls[0]![0]).toMatchObject({
      idempotencyKey: 'support.session.ended:s-9',
    });
  });

  it('does NOT re-enqueue when the outbox row already exists', async () => {
    sessionFindMany.mockReset();
    sessionFindMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 's-9', tenantId: 't-a', _count: { actions: 2 } }]);
    outboxFindMany.mockResolvedValue([{ idempotencyKey: 'support.session.ended:s-9' }]);

    const result = await sweepExpiredSupportSessions(ctx());

    // Nothing ended and nothing re-notified → the no-op summary path.
    expect(result.counts?.reNotified ?? 0).toBe(0);
    expect(emailEnqueue).not.toHaveBeenCalled();
  });
});
