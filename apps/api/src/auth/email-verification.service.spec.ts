import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { userUpdateMany, userFindUnique, userFindFirst, tenantFindUnique } = vi.hoisted(() => ({
  userUpdateMany: vi.fn(),
  userFindUnique: vi.fn(),
  userFindFirst: vi.fn(),
  tenantFindUnique: vi.fn(),
}));

vi.mock('@libriant/db-control', () => ({
  controlDb: {
    user: { updateMany: userUpdateMany, findUnique: userFindUnique, findFirst: userFindFirst },
    tenant: { findUnique: tenantFindUnique },
  },
  // Re-export a Prisma stand-in so the `instanceof PrismaClientKnownRequestError`
  // branch type-checks; the tests don't exercise it.
  Prisma: { PrismaClientKnownRequestError: class extends Error {} },
}));
vi.mock('../config/env.js', () => ({ loadEnv: () => ({ publicAppUrl: 'https://app.test' }) }));

import { EmailVerificationService } from './email-verification.service.js';

function makeService() {
  // `ping` is real API surface now: the service checks Redis is reachable
  // BEFORE the account lookup, so a 503 during an outage cannot become an
  // account-enumeration oracle.
  const redis = {
    client: { set: vi.fn().mockResolvedValue('OK'), getdel: vi.fn() },
    ping: vi.fn().mockResolvedValue(true),
  };
  const rateLimit = { hit: vi.fn().mockResolvedValue({ allowed: true }) };
  const emails = { enqueue: vi.fn().mockResolvedValue({ outboxId: 'o1' }) };
  // authn-authz-08 added the step-up + notice collaborators. They are real
  // dependencies of `requestEmailChange`, so they are stubbed here rather than
  // omitted — a spec that constructs the service without them would stop
  // compiling the moment anything in `send()` reached for one.
  const passwords = { verify: vi.fn().mockResolvedValue(true), dummyVerify: vi.fn() };
  const revocations = { revokeAllForUser: vi.fn().mockResolvedValue('account') };
  const audit = { record: vi.fn() };
  const tenants = { resolveBySlug: vi.fn().mockResolvedValue(null) };
  const svc = new EmailVerificationService(
    redis as never,
    rateLimit as never,
    emails as never,
    passwords as never,
    revocations as never,
    audit as never,
    tenants as never,
  );
  return { svc, redis, rateLimit, emails, passwords, revocations, audit, tenants };
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

    // authn-authz-11: the key must not BE the token. It used to be
    // `emailverify:<token>`, so anyone who could read Redis — or a Redis dump,
    // or the appendonly file inside a volume backup — could take over any
    // account with a verification in flight. The key is the digest; the
    // plaintext exists only in the message.
    const token = /verify-email\?token=([A-Za-z0-9_-]+)/.exec(body)![1]!;
    expect(token.length).toBeGreaterThan(20);
    expect(key).not.toContain(token);
    expect(key).toBe(`emailverify:${createHash('sha256').update(token, 'utf8').digest('hex')}`);
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

  it('applies a staged email change, pinning the address it was staged against', async () => {
    const { svc, redis, revocations } = makeService();
    redis.client.getdel.mockResolvedValue(
      JSON.stringify({
        uid: 'u1',
        tid: 't1',
        email: 'new@acme.test',
        mode: 'change',
        prevEmail: 'owner@acme.test',
      }),
    );
    userUpdateMany.mockResolvedValue({ count: 1 });
    tenantFindUnique.mockResolvedValue(TENANT);

    const res = await svc.verify('tok');

    expect(res).toEqual({ ok: true, mode: 'change', slug: 'acme' });
    // authn-authz-08: the where-clause carries the PRIOR address, so a token
    // staged during a stolen session is inert once the owner has recovered.
    // And `sessionsValidAfter` lands with the new address, which is what ends
    // the attacker's borrowed cookie.
    expect(userUpdateMany).toHaveBeenCalledWith({
      where: { id: 'u1', tenantId: 't1', email: 'owner@acme.test' },
      data: {
        email: 'new@acme.test',
        emailVerifiedAt: expect.any(Date),
        sessionsValidAfter: expect.any(Date),
      },
    });
    expect(revocations.revokeAllForUser).toHaveBeenCalledWith('u1', expect.any(String));
  });

  it('reports failure (and revokes nothing) when the pinned address no longer matches', async () => {
    const { svc, redis, revocations } = makeService();
    redis.client.getdel.mockResolvedValue(
      JSON.stringify({
        uid: 'u1',
        tid: 't1',
        email: 'attacker@evil.test',
        mode: 'change',
        prevEmail: 'owner@acme.test',
      }),
    );
    // The pinned where-clause matched no row — the account has since moved on.
    userUpdateMany.mockResolvedValue({ count: 0 });
    tenantFindUnique.mockResolvedValue(TENANT);

    expect(await svc.verify('tok')).toEqual({ ok: false });
    expect(revocations.revokeAllForUser).not.toHaveBeenCalled();
  });

  it('still applies a pre-authn-authz-08 token that carries no prevEmail', async () => {
    // A change staged before the deploy has a live 24h token. Failing those
    // would break every in-flight address change on release day, so an absent
    // `prevEmail` keeps the old unpinned where-clause.
    const { svc, redis } = makeService();
    redis.client.getdel.mockResolvedValue(
      JSON.stringify({ uid: 'u1', tid: 't1', email: 'new@acme.test', mode: 'change' }),
    );
    userUpdateMany.mockResolvedValue({ count: 1 });
    tenantFindUnique.mockResolvedValue(TENANT);

    expect(await svc.verify('tok')).toEqual({ ok: true, mode: 'change', slug: 'acme' });
    expect(userUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'u1', tenantId: 't1' } }),
    );
  });
});

describe('EmailVerificationService.requestEmailChange (authn-authz-08)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('refuses without the current password, before anything is staged', async () => {
    const { svc, passwords, redis, emails } = makeService();
    userFindUnique.mockResolvedValue({
      email: 'owner@acme.test',
      status: 'active',
      tenantId: 't1',
      passwordHash: '$2a$12$hash',
    });
    passwords.verify.mockResolvedValue(false);

    await expect(svc.requestEmailChange('u1', 'attacker@evil.test', 'wrong')).rejects.toThrow(
      /password is wrong/i,
    );
    // Nothing staged, nothing sent: the probe's one-request takeover ended here.
    expect(redis.client.set).not.toHaveBeenCalled();
    expect(emails.enqueue).not.toHaveBeenCalled();
  });

  it('warns the OLD address and records the request in the library audit log', async () => {
    const { svc, passwords, emails, audit, tenants } = makeService();
    userFindUnique
      .mockResolvedValueOnce({
        email: 'owner@acme.test',
        status: 'active',
        tenantId: 't1',
        passwordHash: '$2a$12$hash',
      })
      // uniqueness pre-check (findFirst is a separate mock; see below)
      .mockResolvedValue(null);
    passwords.verify.mockResolvedValue(true);
    userFindFirst.mockResolvedValue(null);
    tenantFindUnique.mockResolvedValue(TENANT);
    tenants.resolveBySlug.mockResolvedValue({ id: 't1', slug: 'acme' });

    await svc.requestEmailChange('u1', 'new@acme.test', 'correct-horse-battery');

    // Two messages: the verify link to the NEW address, and the security
    // notice to the OLD one. Nothing is delivered (EMAIL_DRIVER=console), which
    // is exactly why the audit row below has to exist as well.
    const recipients = emails.enqueue.mock.calls.map((c) => (c[0] as { toEmail: string }).toEmail);
    expect(recipients).toContain('new@acme.test');
    expect(recipients).toContain('owner@acme.test');
    expect(audit.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ actorId: 'u1', actorType: 'user' }),
      expect.objectContaining({
        action: 'account.email_change_requested',
        after: { from: 'owner@acme.test', to: 'new@acme.test' },
      }),
    );
  });
});

describe('EmailVerificationService.send when Redis is unreachable', () => {
  it('refuses with a 503 rather than issuing a link that can never be redeemed', async () => {
    // Redis is not a cache here — it is where the single-use token lives. A
    // swallowed write would send someone a link that reports itself invalid,
    // which is worse than an honest failure. The check runs BEFORE the account
    // lookup so the 503 cannot reveal whether an address exists.
    const { svc, redis, emails } = makeService();
    redis.ping.mockResolvedValue(false);

    await expect(
      svc.send({
        userId: 'u1',
        tenantId: 't1',
        email: 'someone@example.gr',
        mode: 'signup',
        locale: 'el',
        tenant: TENANT as never,
        fullName: 'Someone',
      } as never),
    ).rejects.toMatchObject({ status: 503 });

    expect(emails.enqueue).not.toHaveBeenCalled();
    expect(redis.client.set).not.toHaveBeenCalled();
  });
});
