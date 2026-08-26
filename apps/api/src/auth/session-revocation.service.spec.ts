import { beforeEach, describe, expect, it, vi } from 'vitest';

const { userUpdate } = vi.hoisted(() => ({ userUpdate: vi.fn() }));

vi.mock('@libriant/db-control', () => ({ controlDb: { user: { update: userUpdate } } }));
vi.mock('../config/env.js', () => ({
  loadEnv: () => ({ sessionAbsoluteMaxTtlSec: 90 * 24 * 60 * 60 }),
}));

import { SessionRevocationService } from './session-revocation.service.js';

const NOW_SEC = Math.floor(Date.now() / 1000);

/** A live "remember me" session: started an hour ago, 30 days to run. */
function session(over: Record<string, unknown> = {}) {
  return {
    sub: 'u1',
    tid: 't1',
    role: 'owner' as const,
    sid: 'sid-abc',
    ist: NOW_SEC - 3600,
    iat: NOW_SEC - 3600,
    exp: NOW_SEC + 30 * 24 * 60 * 60,
    ...over,
  };
}

function makeService(over: { set?: unknown; del?: unknown } = {}) {
  const redis = {
    client: {
      set: (over.set ?? vi.fn().mockResolvedValue('OK')) as ReturnType<typeof vi.fn>,
      get: vi.fn(),
      del: (over.del ?? vi.fn().mockResolvedValue(1)) as ReturnType<typeof vi.fn>,
    },
  };
  return { svc: new SessionRevocationService(redis as never), redis };
}

describe('SessionRevocationService.revokeSession (authn-authz-02)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('denylists the session id and does NOT touch the account', async () => {
    const { svc, redis } = makeService();

    expect(await svc.revokeSession(session() as never)).toBe('session');

    const [key, value, ex, ttl] = redis.client.set.mock.calls[0] as [
      string,
      string,
      string,
      number,
    ];
    expect(key).toBe('session:revoked:sid-abc');
    expect(value).toBe('1');
    expect(ex).toBe('EX');
    // Signing out at the desk must not sign the same person out on their phone,
    // so nothing writes sessionsValidAfter on this path.
    expect(userUpdate).not.toHaveBeenCalled();
    // The entry has to outlive the LONGEST token that can carry this sid: the
    // 90-day absolute cap measured from the session start, not the 30 days this
    // particular token has left, because sliding re-issue keeps extending exp.
    expect(ttl).toBeGreaterThan(30 * 24 * 60 * 60);
    expect(ttl).toBeCloseTo(90 * 24 * 60 * 60 - 3600, -2);
  });

  it('escalates to an account-wide revocation when the denylist write fails', async () => {
    // The lesson of authn-authz-10: a control whose only store is Redis and
    // which reports success when Redis refuses is not a control. A failed
    // denylist write must sign the user out of MORE, not less.
    const { svc } = makeService({ set: vi.fn().mockRejectedValue(new Error('redis down')) });

    expect(await svc.revokeSession(session() as never)).toBe('account');
    expect(userUpdate).toHaveBeenCalledWith({
      where: { id: 'u1' },
      data: { sessionsValidAfter: expect.any(Date) },
    });
  });

  it('escalates for a legacy token that has no session id', async () => {
    // Tokens minted before the `sid` claim cannot be named individually. The
    // wrong answer is to no-op, which is the original defect.
    const { svc, redis } = makeService();

    expect(await svc.revokeSession(session({ sid: undefined }) as never)).toBe('account');
    expect(redis.client.set).not.toHaveBeenCalled();
    expect(userUpdate).toHaveBeenCalledTimes(1);
  });

  it('floors the TTL rather than asking Redis for a negative expiry', async () => {
    const { svc, redis } = makeService();
    // Already past the absolute cap and past exp — still denylist it.
    await svc.revokeSession(
      session({ ist: NOW_SEC - 200 * 24 * 60 * 60, exp: NOW_SEC - 10 }) as never,
    );
    const ttl = (redis.client.set.mock.calls[0] as unknown[])[3] as number;
    expect(ttl).toBe(60);
  });
});

describe('SessionRevocationService.isRevoked', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reports a denylisted session', async () => {
    const { svc, redis } = makeService();
    redis.client.get.mockResolvedValue('1');
    expect(await svc.isRevoked('sid-abc')).toBe(true);
    expect(redis.client.get).toHaveBeenCalledWith('session:revoked:sid-abc');
  });

  it('fails OPEN when Redis is unreachable', async () => {
    // Deliberate: refusing every request during a Redis outage would sign out
    // every library on the platform. The gap is covered by the fallback above —
    // a logout performed DURING the outage lands in Postgres instead.
    const { svc, redis } = makeService();
    redis.client.get.mockRejectedValue(new Error('redis down'));
    expect(await svc.isRevoked('sid-abc')).toBe(false);
  });
});
