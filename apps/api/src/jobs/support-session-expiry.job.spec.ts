import { beforeEach, describe, expect, it, vi } from 'vitest';

// Hoisted mock fns: vitest pulls vi.mock() above all imports, so factory
// closures need their captured vars also hoisted.
const { sessionFindMany, sessionUpdateMany, tenantFindUnique, emailEnqueue } = vi.hoisted(() => ({
  sessionFindMany: vi.fn(),
  sessionUpdateMany: vi.fn(),
  tenantFindUnique: vi.fn(),
  emailEnqueue: vi.fn().mockResolvedValue({ outboxId: 'o-1', alreadyExisted: false }),
}));

vi.mock('@libriant/db-control', () => ({
  controlDb: {
    supportSession: { findMany: sessionFindMany, updateMany: sessionUpdateMany },
    tenant: { findUnique: tenantFindUnique },
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
    emailEnqueue.mockClear();
  });

  it('returns a no-op summary when nothing is expired', async () => {
    sessionFindMany.mockResolvedValue([]);

    const result = await sweepExpiredSupportSessions(ctx());

    expect(result).toEqual({
      message: 'no expired sessions',
      counts: { ended: 0 },
    });
    expect(sessionUpdateMany).not.toHaveBeenCalled();
    expect(emailEnqueue).not.toHaveBeenCalled();
  });

  it('ends each expired session and fires one notification per ended row', async () => {
    sessionFindMany.mockResolvedValue([
      { id: 's-1', tenantId: 't-a', _count: { actions: 3 } },
      { id: 's-2', tenantId: 't-b', _count: { actions: 0 } },
    ]);
    sessionUpdateMany.mockResolvedValue({ count: 1 });
    tenantFindUnique.mockResolvedValue({
      id: 't-a',
      slug: 'acme',
      name: 'Acme',
      primaryEmail: 'ops@acme.test',
      defaultLocale: 'en',
    });

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
    sessionFindMany.mockResolvedValue([{ id: 's-1', tenantId: 't-a', _count: { actions: 1 } }]);
    sessionUpdateMany.mockResolvedValue({ count: 0 }); // lost the race
    tenantFindUnique.mockResolvedValue({
      id: 't-a',
      slug: 'acme',
      name: 'Acme',
      primaryEmail: 'ops@acme.test',
      defaultLocale: 'en',
    });

    const result = await sweepExpiredSupportSessions(ctx());

    expect(result.counts?.ended).toBe(0);
    expect(result.counts?.notified).toBe(0);
    expect(emailEnqueue).not.toHaveBeenCalled();
  });

  it('reports tenants we did process even when one notification enqueue throws', async () => {
    sessionFindMany.mockResolvedValue([
      { id: 's-1', tenantId: 't-a', _count: { actions: 1 } },
      { id: 's-2', tenantId: 't-b', _count: { actions: 1 } },
    ]);
    sessionUpdateMany.mockResolvedValue({ count: 1 });
    tenantFindUnique.mockResolvedValue({
      id: 't-a',
      slug: 'acme',
      name: 'Acme',
      primaryEmail: 'ops@acme.test',
      defaultLocale: 'en',
    });
    // The notifications service catches per-call failures internally
    // and logs them — so even if enqueue throws, the sweeper still
    // counts the ended row.
    emailEnqueue.mockRejectedValueOnce(new Error('email exploded'));

    const result = await sweepExpiredSupportSessions(ctx());

    expect(result.counts?.ended).toBe(2);
    expect(result.counts?.notified).toBe(2);
  });
});
