import { beforeEach, describe, expect, it, vi } from 'vitest';

const { userUpdateMany, userFindUnique, tenantFindUnique } = vi.hoisted(() => ({
  userUpdateMany: vi.fn(),
  userFindUnique: vi.fn(),
  tenantFindUnique: vi.fn(),
}));

vi.mock('@libriant/db-control', () => ({
  controlDb: {
    user: { updateMany: userUpdateMany, findUnique: userFindUnique },
    tenant: { findUnique: tenantFindUnique },
  },
  // Re-export a Prisma stand-in so the `instanceof PrismaClientKnownRequestError`
  // branch type-checks; the tests don't exercise it.
  Prisma: { PrismaClientKnownRequestError: class extends Error {} },
}));
vi.mock('../config/env.js', () => ({ loadEnv: () => ({ publicAppUrl: 'https://app.test' }) }));

import { EmailVerificationService } from './email-verification.service.js';

function makeService() {
  const redis = { client: { set: vi.fn().mockResolvedValue('OK'), getdel: vi.fn() } };
  const rateLimit = { hit: vi.fn().mockResolvedValue({ allowed: true }) };
  const emails = { enqueue: vi.fn().mockResolvedValue({ outboxId: 'o1' }) };
  const svc = new EmailVerificationService(redis as never, rateLimit as never, emails as never);
  return { svc, redis, rateLimit, emails };
}

const TENANT = { slug: 'acme', name: 'Acme Library', defaultLocale: 'en' };

describe('EmailVerificationService.send', () => {
  beforeEach(() => vi.clearAllMocks());

  it('issues a token + enqueues an email_verification message', async () => {
    const { svc, redis, emails } = makeService();
    await svc.send({
      userId: 'u1',
      tenantId: 't1',
      email: 'owner@acme.test',
      slug: 'acme',
      locale: 'en',
      libraryName: 'Acme Library',
      mode: 'signup',
    });
    expect(redis.client.set).toHaveBeenCalledTimes(1);
    const [key, value, ex, ttl] = redis.client.set.mock.calls[0] as [
      string,
      string,
      string,
      number,
    ];
    expect(key).toMatch(/^emailverify:/);
    expect(JSON.parse(value)).toMatchObject({
      uid: 'u1',
      tid: 't1',
      email: 'owner@acme.test',
      mode: 'signup',
    });
    expect(ex).toBe('EX');
    expect(ttl).toBe(24 * 60 * 60);
    expect(emails.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'email_verification', toEmail: 'owner@acme.test' }),
    );
    // The verify link uses the token from the Redis key.
    const body = (emails.enqueue.mock.calls[0]![0] as { bodyMarkdown: string }).bodyMarkdown;
    expect(body).toContain('https://app.test/en/verify-email?token=');
  });

  it('stays silent + sends nothing when the per-account limit is exceeded', async () => {
    const { svc, redis, rateLimit, emails } = makeService();
    rateLimit.hit.mockResolvedValueOnce({ allowed: false });
    await svc.send({
      userId: 'u1',
      tenantId: 't1',
      email: 'o@a.test',
      slug: 'acme',
      locale: 'en',
      libraryName: 'A',
      mode: 'signup',
    });
    expect(redis.client.set).not.toHaveBeenCalled();
    expect(emails.enqueue).not.toHaveBeenCalled();
  });
});

describe('EmailVerificationService.verify', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns ok:false for a missing/expired token', async () => {
    const { svc, redis } = makeService();
    redis.client.getdel.mockResolvedValue(null);
    expect(await svc.verify('nope')).toEqual({ ok: false });
    expect(userUpdateMany).not.toHaveBeenCalled();
  });

  it('marks a signup address verified and welcomes a first-time owner', async () => {
    const { svc, redis, emails } = makeService();
    redis.client.getdel.mockResolvedValue(
      JSON.stringify({ uid: 'u1', tid: 't1', email: 'owner@acme.test', mode: 'signup' }),
    );
    userUpdateMany.mockResolvedValue({ count: 1 }); // null→set transition
    tenantFindUnique.mockResolvedValue(TENANT);

    const res = await svc.verify('tok');

    expect(res).toEqual({ ok: true, mode: 'signup', slug: 'acme' });
    expect(userUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'u1', email: 'owner@acme.test', emailVerifiedAt: null },
        data: { emailVerifiedAt: expect.any(Date) },
      }),
    );
    expect(emails.enqueue).toHaveBeenCalledWith(expect.objectContaining({ kind: 'welcome' }));
  });

  it('does not re-welcome on a second click (no null→set transition)', async () => {
    const { svc, redis, emails } = makeService();
    redis.client.getdel.mockResolvedValue(
      JSON.stringify({ uid: 'u1', tid: 't1', email: 'owner@acme.test', mode: 'signup' }),
    );
    userUpdateMany.mockResolvedValue({ count: 0 }); // already verified
    tenantFindUnique.mockResolvedValue(TENANT);

    const res = await svc.verify('tok');

    expect(res).toEqual({ ok: true, mode: 'signup', slug: 'acme' });
    expect(emails.enqueue).not.toHaveBeenCalled(); // no welcome
  });

  it('applies a staged email change', async () => {
    const { svc, redis } = makeService();
    redis.client.getdel.mockResolvedValue(
      JSON.stringify({ uid: 'u1', tid: 't1', email: 'new@acme.test', mode: 'change' }),
    );
    userUpdateMany.mockResolvedValue({ count: 1 });
    tenantFindUnique.mockResolvedValue(TENANT);

    const res = await svc.verify('tok');

    expect(res).toEqual({ ok: true, mode: 'change', slug: 'acme' });
    expect(userUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'u1', tenantId: 't1' },
        data: { email: 'new@acme.test', emailVerifiedAt: expect.any(Date) },
      }),
    );
  });
});
