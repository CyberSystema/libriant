import { beforeEach, describe, expect, it, vi } from 'vitest';

const { tenantFindUnique, userFindFirst, userUpdate } = vi.hoisted(() => ({
  tenantFindUnique: vi.fn(),
  userFindFirst: vi.fn(),
  userUpdate: vi.fn(),
}));

vi.mock('@libriant/db-control', () => ({
  controlDb: {
    tenant: { findUnique: tenantFindUnique },
    user: { findFirst: userFindFirst, update: userUpdate },
  },
}));
vi.mock('../config/env.js', () => ({
  loadEnv: () => ({ maxFailedLogins: 5, loginLockoutMs: 15 * 60 * 1000 }),
}));

import { LoginService } from './login.service.js';

const TENANT = { id: 't1', slug: 'acme', name: 'Acme', defaultLocale: 'el', status: 'active' };

function makeUser(over: Record<string, unknown> = {}) {
  return {
    id: 'u1',
    email: 'librarian@acme.test',
    username: null,
    fullName: 'A Librarian',
    role: 'librarian',
    status: 'active',
    passwordHash: '$2a$12$storedhash',
    failedLogins: 0,
    lockedUntil: null,
    mustChangeCredentials: false,
    ...over,
  };
}

/** `deadRedis` makes every call throw, which is the Redis outage the finding is about. */
function makeService(opts: { deadRedis?: boolean; passwordOk?: boolean } = {}) {
  const fail = () => {
    throw new Error('redis down');
  };
  const redis = {
    client: opts.deadRedis
      ? { get: fail, set: fail, incr: fail, expire: fail, del: fail }
      : {
          get: vi.fn().mockResolvedValue(null),
          set: vi.fn().mockResolvedValue('OK'),
          incr: vi.fn().mockResolvedValue(1),
          expire: vi.fn().mockResolvedValue(1),
          del: vi.fn().mockReturnValue({ catch: () => Promise.resolve() }),
        },
  };
  const passwords = {
    verify: vi.fn().mockResolvedValue(opts.passwordOk ?? false),
    dummyVerify: vi.fn().mockResolvedValue(false),
    hash: vi.fn(),
  };
  const jwt = { sign: vi.fn(() => ({ token: 'tok', expiresAt: new Date(), remember: false })) };
  const svc = new LoginService(passwords as never, jwt as never, redis as never);
  return { svc, redis, passwords };
}

const CREDS = {
  tenantSlug: 'acme',
  identifier: 'librarian@acme.test',
  password: 'guess',
  ip: '1.2.3.4',
};

describe('LoginService lockout (authn-authz-10)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tenantFindUnique.mockResolvedValue(TENANT);
    userUpdate.mockResolvedValue({ failedLogins: 1 });
  });

  it('refuses a CORRECT password while users.lockedUntil is in the future', async () => {
    // The column existed, was selected, and was never read. An operator's
    // `UPDATE users SET "lockedUntil" = now() + interval '1 hour'` — the
    // documented incident response — did nothing at all.
    const { svc, passwords } = makeService({ passwordOk: true });
    userFindFirst.mockResolvedValue(
      makeUser({ lockedUntil: new Date(Date.now() + 60 * 60 * 1000) }),
    );

    await expect(svc.login(CREDS)).rejects.toThrow(/couldn't sign you in/i);
    // Never even reached the real compare, and burned a dummy for timing parity.
    expect(passwords.verify).not.toHaveBeenCalled();
    expect(passwords.dummyVerify).toHaveBeenCalledTimes(1);
  });

  it('ignores an EXPIRED lockedUntil', async () => {
    const { svc } = makeService({ passwordOk: true });
    userFindFirst.mockResolvedValue(makeUser({ lockedUntil: new Date(Date.now() - 1000) }));
    await expect(svc.login(CREDS)).resolves.toMatchObject({ token: 'tok' });
  });

  it('does NOT write lockedUntil on the healthy path, however many failures', async () => {
    // A bare-account lock is a renewable denial of service: anyone who knows a
    // librarian's email can lock them out by guessing (A1-01). That is why the
    // normal lock is per-(account+IP) in Redis, and why the durable one must
    // stay confined to the outage path.
    const { svc, redis } = makeService();
    (redis.client.incr as ReturnType<typeof vi.fn>).mockResolvedValue(9);
    userFindFirst.mockResolvedValue(makeUser({ failedLogins: 8 }));
    userUpdate.mockResolvedValue({ failedLogins: 9 });

    await expect(svc.login(CREDS)).rejects.toThrow();

    const wrote = userUpdate.mock.calls.map(
      (c) => (c[0] as { data: Record<string, unknown> }).data,
    );
    expect(wrote).toEqual([{ failedLogins: { increment: 1 } }]);
    expect(redis.client.set).toHaveBeenCalled(); // the Redis lock still fired
  });

  it('writes the durable lock once Redis is gone and the threshold is reached', async () => {
    // The probe deleted the two Redis keys and signed straight in with the
    // correct password. With Redis unreachable the rate limiter also fails open
    // for the login bucket, so this write is the only remaining protection.
    const { svc } = makeService({ deadRedis: true });
    userFindFirst.mockResolvedValue(makeUser({ failedLogins: 4 }));
    userUpdate.mockResolvedValue({ failedLogins: 5 }); // reaches maxFailedLogins

    await expect(svc.login(CREDS)).rejects.toThrow();

    const lockWrite = userUpdate.mock.calls
      .map((c) => c[0] as { data: Record<string, unknown> })
      .find((a) => a.data.lockedUntil instanceof Date);
    expect(lockWrite, 'no durable lockout was written').toBeTruthy();
    const until = lockWrite!.data.lockedUntil as Date;
    expect(until.getTime()).toBeGreaterThan(Date.now() + 14 * 60 * 1000);
    expect(until.getTime()).toBeLessThanOrEqual(Date.now() + 16 * 60 * 1000);
  });

  it('does not lock below the threshold, even with Redis gone', async () => {
    const { svc } = makeService({ deadRedis: true });
    userFindFirst.mockResolvedValue(makeUser({ failedLogins: 1 }));
    userUpdate.mockResolvedValue({ failedLogins: 2 });

    await expect(svc.login(CREDS)).rejects.toThrow();

    const wrote = userUpdate.mock.calls.map(
      (c) => (c[0] as { data: Record<string, unknown> }).data,
    );
    expect(wrote.some((d) => 'lockedUntil' in d)).toBe(false);
  });

  it('clears the durable lock on a successful sign-in', async () => {
    const { svc } = makeService({ passwordOk: true });
    userFindFirst.mockResolvedValue(makeUser({ failedLogins: 4 }));

    await svc.login(CREDS);

    expect(userUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ failedLogins: 0, lockedUntil: null }),
      }),
    );
  });
});
