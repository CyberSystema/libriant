import { beforeEach, describe, expect, it, vi } from 'vitest';

const { tenantFindUnique, userFindFirst, userUpdate, queryRaw } = vi.hoisted(() => ({
  tenantFindUnique: vi.fn(),
  userFindFirst: vi.fn(),
  userUpdate: vi.fn(),
  queryRaw: vi.fn(),
}));

vi.mock('@libriant/db-control', () => ({
  controlDb: {
    // 2.0 phase 20f: the sweeps read which libraries have been cut over.
    tenantSchemaState: { findMany: () => Promise.resolve([]) },
    tenant: { findUnique: tenantFindUnique },
    user: { findFirst: userFindFirst, update: userUpdate },
    $queryRaw: queryRaw,
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

/**
 * `deadRedis` makes every call throw, which is the Redis OUTAGE.
 * `scope` seeds the value `login:lock-scope:<uid>` returns — `undefined` means
 * "no such key", which is the Redis FLUSH/RESTART, the state the audit probe
 * created with `redis-cli del` and the one the first remediation missed.
 */
function makeService(
  opts: { deadRedis?: boolean; passwordOk?: boolean; scope?: string | null } = {},
) {
  const fail = () => {
    throw new Error('redis down');
  };
  const store = new Map<string, string>();
  if (opts.scope) store.set('login:lock-scope:u1', opts.scope);
  const redis = {
    client: opts.deadRedis
      ? { get: fail, set: fail, incr: fail, expire: fail, del: fail }
      : {
          get: vi.fn(async (k: string) => store.get(k) ?? null),
          set: vi.fn(async (k: string, v: string) => {
            store.set(k, v);
            return 'OK';
          }),
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
  return { svc, redis, passwords, store };
}

const CREDS = {
  tenantSlug: 'acme',
  identifier: 'librarian@acme.test',
  password: 'guess',
  ip: '1.2.3.4',
};

/** What the RETURNING clause of the failure UPDATE hands back. */
function returning(failedLogins: number, lockedUntil: Date | null = null) {
  queryRaw.mockResolvedValue([{ failedLogins, lockedUntil }]);
}

describe('LoginService lockout (authn-authz-10)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tenantFindUnique.mockResolvedValue(TENANT);
    userUpdate.mockResolvedValue({ failedLogins: 1 });
    returning(1);
  });

  it('refuses a CORRECT password while users.lockedUntil is in the future', async () => {
    // The column existed, was selected, and was never read. An operator's
    // `UPDATE users SET "lockedUntil" = now() + interval '1 hour'` — the
    // documented incident response — did nothing at all. An operator lock
    // writes no scope marker, so it applies to every address.
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

  it('arms the durable lock at the threshold on the HEALTHY path', async () => {
    // The refuted version wrote `lockedUntil` only when Redis THREW, so the
    // audited sequence — six wrong logins with Redis fine, flush, correct
    // password — still ended in 200 with the column NULL. The lock and the
    // count it is derived from are decided by one statement so two concurrent
    // failures cannot both read 4 and neither arm it.
    const { svc } = makeService();
    returning(5, new Date(Date.now() + 15 * 60 * 1000));
    userFindFirst.mockResolvedValue(makeUser({ failedLogins: 4 }));

    await expect(svc.login(CREDS)).rejects.toThrow();

    expect(queryRaw).toHaveBeenCalledTimes(1);
    const [strings, ...values] = queryRaw.mock.calls[0] as [string[], ...unknown[]];
    const sql = strings.join('?');
    expect(sql).toMatch(/UPDATE users/);
    expect(sql).toMatch(/"failedLogins" = "failedLogins" \+ 1/);
    expect(sql).toMatch(/"lockedUntil" = CASE/);
    // The threshold, the lock instant and the user id are bound parameters,
    // not interpolated text.
    expect(values[0]).toBe(5);
    expect(values[1]).toBeInstanceOf(Date);
    expect((values[1] as Date).getTime()).toBeGreaterThan(Date.now() + 14 * 60 * 1000);
    expect((values[1] as Date).getTime()).toBeLessThanOrEqual(Date.now() + 16 * 60 * 1000);
    expect(values[2]).toBe('u1');
  });

  it('scopes the armed lock to the address that armed it', async () => {
    // Without this marker the durable lock is a bare-account lock, i.e. the
    // renewable DoS A1-01 removed and authn-authz-03 had to remove again on
    // the admin side. Keyed on the DURABLE threshold, not the per-IP one: an
    // attacker spread over five addresses reaches failedLogins=5 with every
    // per-IP counter still at 1.
    const { svc, redis, store } = makeService();
    returning(5, new Date(Date.now() + 15 * 60 * 1000));
    userFindFirst.mockResolvedValue(makeUser({ failedLogins: 4 }));
    (redis.client.incr as ReturnType<typeof vi.fn>).mockResolvedValue(1); // no per-IP lock yet

    await expect(svc.login(CREDS)).rejects.toThrow();

    expect(store.get('login:lock-scope:u1')).toBe('1.2.3.4');
    expect(redis.client.set).toHaveBeenCalledWith('login:lock-scope:u1', '1.2.3.4', 'EX', 15 * 60);
  });

  it('does NOT arm the durable lock below the threshold', async () => {
    const { svc, store } = makeService();
    returning(2);
    userFindFirst.mockResolvedValue(makeUser({ failedLogins: 1 }));

    await expect(svc.login(CREDS)).rejects.toThrow();

    expect(store.has('login:lock-scope:u1')).toBe(false);
  });

  it('enforces a live lock account-wide once Redis has forgotten who armed it', async () => {
    // THE BYPASS. Six wrong logins, `redis-cli del` the keys, correct password
    // → 200. With the marker gone there is nothing left to scope by, so the
    // column applies to every address, including the one that was guessing.
    const { svc, passwords } = makeService({ passwordOk: true, scope: null });
    userFindFirst.mockResolvedValue(
      makeUser({ failedLogins: 6, lockedUntil: new Date(Date.now() + 10 * 60 * 1000) }),
    );

    await expect(svc.login(CREDS)).rejects.toThrow(/couldn't sign you in/i);
    expect(passwords.verify).not.toHaveBeenCalled();
  });

  it('enforces a live lock account-wide when Redis will not answer at all', async () => {
    // The other half: during an outage `isLockedOut` fails open and
    // RateLimitService.hit fails open for the login bucket, so the column is
    // the only protection left and an "unknown → allow" branch here would
    // rebuild the hole one layer up.
    const { svc, passwords } = makeService({ passwordOk: true, deadRedis: true });
    userFindFirst.mockResolvedValue(
      makeUser({ failedLogins: 6, lockedUntil: new Date(Date.now() + 10 * 60 * 1000) }),
    );

    await expect(svc.login(CREDS)).rejects.toThrow(/couldn't sign you in/i);
    expect(passwords.verify).not.toHaveBeenCalled();
  });

  it('lets the real user in from their own address while the lock is live', async () => {
    // A1-01 intact: the marker names the attacker, so a victim signing in from
    // anywhere else is unaffected by a lock somebody else triggered.
    const { svc } = makeService({ passwordOk: true, scope: '9.9.9.9' });
    userFindFirst.mockResolvedValue(
      makeUser({ failedLogins: 6, lockedUntil: new Date(Date.now() + 10 * 60 * 1000) }),
    );

    await expect(svc.login({ ...CREDS, ip: '1.2.3.4' })).resolves.toMatchObject({ token: 'tok' });
  });

  it('still bars the address the marker names', async () => {
    const { svc, passwords } = makeService({ passwordOk: true, scope: '9.9.9.9' });
    userFindFirst.mockResolvedValue(
      makeUser({ failedLogins: 6, lockedUntil: new Date(Date.now() + 10 * 60 * 1000) }),
    );

    await expect(svc.login({ ...CREDS, ip: '9.9.9.9' })).rejects.toThrow(/couldn't sign you in/i);
    expect(passwords.verify).not.toHaveBeenCalled();
  });

  it('leaves the lock ACCOUNT-WIDE when the caller passed no usable IP', async () => {
    // No verified address means no bucket to scope by. Falling back to
    // account-wide is the safe direction; the service logs it at error because
    // in production clientIp() always yields the TCP peer, so getting here
    // means a call site is not passing it.
    const { svc, store } = makeService();
    returning(5, new Date(Date.now() + 15 * 60 * 1000));
    userFindFirst.mockResolvedValue(makeUser({ failedLogins: 4 }));

    await expect(svc.login({ ...CREDS, ip: 'unknown' })).rejects.toThrow();

    expect(store.has('login:lock-scope:u1')).toBe(false);
  });

  it('clears the durable lock AND its marker on a successful sign-in', async () => {
    const { svc, redis } = makeService({ passwordOk: true });
    userFindFirst.mockResolvedValue(makeUser({ failedLogins: 4 }));

    await svc.login(CREDS);

    expect(userUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ failedLogins: 0, lockedUntil: null }),
      }),
    );
    expect(redis.client.del).toHaveBeenCalledWith(
      'login:fail:u1:1.2.3.4',
      'login:lock:u1:1.2.3.4',
      'login:lock-scope:u1',
    );
  });

  it('does not turn a failed lockout write into a 500', async () => {
    // A control-plane blip must still refuse the wrong password, loudly, not
    // 500 and hand the caller a different oracle.
    const { svc } = makeService();
    queryRaw.mockRejectedValue(new Error('control plane unreachable'));
    userFindFirst.mockResolvedValue(makeUser({ failedLogins: 4 }));

    await expect(svc.login(CREDS)).rejects.toThrow(/couldn't sign you in/i);
  });
});
