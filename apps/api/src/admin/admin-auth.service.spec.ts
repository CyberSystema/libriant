import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { adminFindUnique, adminUpdate } = vi.hoisted(() => ({
  adminFindUnique: vi.fn(),
  adminUpdate: vi.fn(),
}));

vi.mock('@libriant/db-control', () => ({
  controlDb: { adminUser: { findUnique: adminFindUnique, update: adminUpdate } },
}));
vi.mock('../config/env.js', () => ({
  loadEnv: () => ({ maxFailedLogins: 5, loginLockoutMs: 900_000 }),
}));

import { AdminAuthService } from './admin-auth.service.js';

/** A tiny in-memory stand-in for the Redis keyspace the lockout uses. */
function makeRedis() {
  const store = new Map<string, string>();
  const client = {
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    incr: vi.fn(async (k: string) => {
      const n = Number(store.get(k) ?? '0') + 1;
      store.set(k, String(n));
      return n;
    }),
    expire: vi.fn(async () => 1),
    set: vi.fn(async (k: string, v: string) => {
      store.set(k, v);
      return 'OK';
    }),
    del: vi.fn(async (...keys: string[]) => {
      let n = 0;
      for (const k of keys) if (store.delete(k)) n += 1;
      return n;
    }),
  };
  return { redis: { client }, store };
}

function makeService(passwordOk = false) {
  const { redis, store } = makeRedis();
  const passwords = {
    verify: vi.fn(async () => passwordOk),
    dummyVerify: vi.fn(async () => false),
  };
  const svc = new AdminAuthService(passwords as never, redis as never);
  return { svc, redis, store, passwords };
}

const ADMIN = {
  id: 'adm1',
  email: 'ops@example.test',
  fullName: 'Ops',
  role: 'owner' as const,
  status: 'active',
  disabledAt: null,
  lockedUntil: null as Date | null,
  passwordHash: '$2b$12$hash',
};

describe('AdminAuthService lockout keying (authn-authz-03)', () => {
  let logError: ReturnType<typeof vi.spyOn>;
  let logWarn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    adminFindUnique.mockResolvedValue(ADMIN);
    adminUpdate.mockResolvedValue({ failedAttempts: 1 });
    // Nest's Logger writes to stdout; silence it and assert on the calls.
    logError = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    logWarn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('locks on (adminId, ip) in Redis — never on the bare account', async () => {
    const { svc, store } = makeService();
    for (let i = 0; i < 5; i += 1) {
      await expect(svc.verify(ADMIN.email, 'wrong', '198.51.100.9')).rejects.toThrow();
    }
    expect([...store.keys()]).toEqual([
      'admin-login:fail:adm1:198.51.100.9',
      'admin-login:lock:adm1:198.51.100.9',
    ]);
  });

  it('never writes status or lockedUntil from a failed sign-in', async () => {
    const { svc } = makeService();
    for (let i = 0; i < 6; i += 1) {
      await expect(svc.verify(ADMIN.email, 'wrong', '198.51.100.9')).rejects.toThrow();
    }
    // The only DB write allowed on this path is the audit tally.
    for (const call of adminUpdate.mock.calls) {
      const [args] = call as [{ data: Record<string, unknown> }];
      expect(Object.keys(args.data)).toEqual(['failedAttempts']);
      expect(args.data.failedAttempts).toEqual({ increment: 1 });
    }
  });

  it("an attacker's lockout does not touch the admin's own bucket", async () => {
    // The finding, end to end: five unauthenticated requests used to deny the
    // operator the control plane. The real admin, at a different IP with the
    // right password, must sail straight through.
    const { svc, store, passwords } = makeService();
    for (let i = 0; i < 5; i += 1) {
      await expect(svc.verify(ADMIN.email, 'wrong', '198.51.100.9')).rejects.toThrow();
    }
    expect(store.has('admin-login:lock:adm1:198.51.100.9')).toBe(true);

    passwords.verify.mockResolvedValue(true);
    await expect(svc.verify(ADMIN.email, 'correct', '203.0.113.7')).resolves.toMatchObject({
      id: 'adm1',
    });
    expect(store.has('admin-login:lock:adm1:203.0.113.7')).toBe(false);
  });

  it('reports a locked bucket with the same generic message as a wrong password (AUTH-02)', async () => {
    const { svc, passwords } = makeService();
    for (let i = 0; i < 5; i += 1) {
      await expect(svc.verify(ADMIN.email, 'wrong', '198.51.100.9')).rejects.toThrow();
    }
    passwords.verify.mockClear();
    await expect(svc.verify(ADMIN.email, 'correct', '198.51.100.9')).rejects.toThrow(
      'Email or password is wrong.',
    );
    // Locked out means the hash is never even compared, so the dummy keeps the
    // timing honest.
    expect(passwords.verify).not.toHaveBeenCalled();
    expect(passwords.dummyVerify).toHaveBeenCalled();
  });

  it('a disabled account still fails closed', async () => {
    adminFindUnique.mockResolvedValue({ ...ADMIN, status: 'disabled' });
    const { svc } = makeService(true);
    await expect(svc.verify(ADMIN.email, 'correct', '203.0.113.7')).rejects.toThrow(
      'This admin account is disabled.',
    );
  });

  it('fails open when Redis is unreachable rather than blocking every admin', async () => {
    const { svc, redis } = makeService(true);
    redis.client.get.mockRejectedValue(new Error('Redis down'));
    redis.client.incr.mockRejectedValue(new Error('Redis down'));
    await expect(svc.verify(ADMIN.email, 'correct', '203.0.113.7')).resolves.toMatchObject({
      id: 'adm1',
    });
  });

  // ---- the half the first fix left open ------------------------------------
  // A verifier locked a named admin out for 15 minutes with five bad passwords
  // by landing them all in `admin-login:lock:<adminId>:unknown`, the bucket
  // every caller without a client IP shares. The severe half (writing
  // status='locked') was genuinely gone; this is the rest of it.
  describe('a caller with no verified client IP', () => {
    it('writes NO lock key — an anonymous stranger cannot lock a named admin', async () => {
      const { svc, store } = makeService();
      for (let i = 0; i < 10; i += 1) {
        await expect(svc.verify(ADMIN.email, 'wrong')).rejects.toThrow();
      }
      expect([...store.keys()]).toEqual([]);
    });

    it('never blocks the real admin, who signs in normally', async () => {
      const { svc, passwords } = makeService();
      for (let i = 0; i < 10; i += 1) {
        await expect(svc.verify(ADMIN.email, 'wrong')).rejects.toThrow();
      }
      passwords.verify.mockResolvedValue(true);
      await expect(svc.verify(ADMIN.email, 'correct', '203.0.113.7')).resolves.toMatchObject({
        id: 'adm1',
      });
    });

    it('says so at error level rather than degrading quietly', async () => {
      const { svc } = makeService();
      await expect(svc.verify(ADMIN.email, 'wrong')).rejects.toThrow();
      expect(logError).toHaveBeenCalledWith(expect.stringContaining('no usable client IP'));
    });

    it('treats a garbage IP the same as a missing one', async () => {
      const { svc, store } = makeService();
      for (let i = 0; i < 6; i += 1) {
        await expect(svc.verify(ADMIN.email, 'wrong', 'not-an-ip')).rejects.toThrow();
      }
      expect([...store.keys()]).toEqual([]);
    });
  });

  // ---- the audit record ------------------------------------------------------
  describe('the failed-sign-in audit record', () => {
    it('is emitted even when the DB tally write fails, and says the tally is behind', async () => {
      const { svc } = makeService();
      adminUpdate.mockRejectedValue(new Error('column failedAttempts does not exist'));
      await expect(svc.verify(ADMIN.email, 'wrong', '198.51.100.9')).rejects.toThrow();
      expect(logWarn).toHaveBeenCalledWith(
        expect.stringContaining('Failed admin sign-in for adm1 from 198.51.100.9'),
      );
      expect(logError).toHaveBeenCalledWith(
        expect.stringContaining('DB audit tally is now behind'),
      );
    });

    it('still applies the Redis lockout when the DB write fails', async () => {
      // The write is best-effort; the lockout is the control that stops the
      // attack, so a broken DB must not skip it.
      const { svc, store } = makeService();
      adminUpdate.mockRejectedValue(new Error('DB down'));
      for (let i = 0; i < 5; i += 1) {
        await expect(svc.verify(ADMIN.email, 'wrong', '198.51.100.9')).rejects.toThrow();
      }
      expect(store.has('admin-login:lock:adm1:198.51.100.9')).toBe(true);
    });
  });

  // ---- the operator's own lock ----------------------------------------------
  describe('adminUser.lockedUntil', () => {
    it('is honoured — an operator freezing an account by hand actually freezes it', async () => {
      adminFindUnique.mockResolvedValue({
        ...ADMIN,
        lockedUntil: new Date(Date.now() + 60 * 60 * 1000),
      });
      const { svc, passwords } = makeService(true);
      await expect(svc.verify(ADMIN.email, 'correct', '203.0.113.7')).rejects.toThrow(
        'Email or password is wrong.',
      );
      // No oracle: same generic message, and the hash is never compared.
      expect(passwords.verify).not.toHaveBeenCalled();
      expect(passwords.dummyVerify).toHaveBeenCalled();
    });

    it('is ignored once it has expired', async () => {
      adminFindUnique.mockResolvedValue({
        ...ADMIN,
        lockedUntil: new Date(Date.now() - 1000),
      });
      const { svc } = makeService(true);
      await expect(svc.verify(ADMIN.email, 'correct', '203.0.113.7')).resolves.toMatchObject({
        id: 'adm1',
      });
    });
  });

  it('a full success clears that IP bucket and heals a legacy locked row', async () => {
    const { svc, store, redis } = makeService();
    for (let i = 0; i < 5; i += 1) {
      await expect(svc.verify(ADMIN.email, 'wrong', '198.51.100.9')).rejects.toThrow();
    }
    adminUpdate.mockClear();
    await svc.recordSuccess(ADMIN.id, '198.51.100.9');
    expect(store.size).toBe(0);
    expect(redis.client.del).toHaveBeenCalledWith(
      'admin-login:fail:adm1:198.51.100.9',
      'admin-login:lock:adm1:198.51.100.9',
    );
    const [args] = adminUpdate.mock.calls[0] as [{ data: Record<string, unknown> }];
    expect(args.data).toMatchObject({ failedAttempts: 0, lockedUntil: null, status: 'active' });
  });
});
