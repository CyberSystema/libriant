import { describe, expect, it, vi, beforeEach } from 'vitest';

// Repo convention for a service that reads config in its constructor.
vi.mock('../config/env.js', () => ({
  loadEnv: () => ({
    applyHashPepper: 'unit-test-pepper-0123456789abcdef0123',
    applyNotifyTo: 'info@example.test',
    // Both are read for the operator-facing log line the offer's only working
    // notification channel is made of; see the `notify` block at the bottom.
    adminHost: 'admin.example.test',
    emailDriver: 'console',
  }),
}));

// `offerState` counts accepted applications, which is the whole of
// launch-readiness-11 — the unit suite has no database, so the count is the
// thing under test's only collaborator here.
const { applicationCount } = vi.hoisted(() => ({ applicationCount: vi.fn() }));
vi.mock('@libriant/db-control', () => ({
  controlDb: { application: { count: applicationCount, update: vi.fn() } },
}));

import { ERRORS } from '@libriant/site';
import { ApplicationsService, OFFER_TOTAL } from './applications.service.js';

/**
 * Validation is ported verbatim from the Cloudflare Worker this replaces, and
 * these cases are the acceptance criteria for that port. The rules matter more
 * than they look: each one is the difference between a real library's
 * application arriving and being silently dropped.
 */

const E = ERRORS.el;

function makeService(
  hit = vi.fn().mockResolvedValue({ allowed: true, count: 1, retryAfterSec: 0 }),
  redisStatus = 'ready',
) {
  const email = { enqueue: vi.fn().mockResolvedValue(undefined) };
  const rateLimit = { hit };
  // ioredis exposes the socket state as `client.status`; the service reads it
  // to tell "the ceiling counted 61" from "nothing counted anything".
  const redis = { client: { status: redisStatus } };
  // The constructor reads env; the loadEnv mock above supplies the pepper.
  // Nothing sets HASH_PEPPER in the unit environment — the integration suite
  // has to set it itself, in test/integration/setup.ts.
  const svc = new ApplicationsService(email as never, rateLimit as never, redis as never);
  // The degraded-ceiling path logs one warn per accepted submission; captured
  // rather than printed so a 60-submission test does not bury the run, and so
  // the tests below can assert the operator actually gets that signal.
  const warn = vi.spyOn(svc['logger'], 'warn').mockImplementation(() => undefined);
  return { svc, email, rateLimit, redis, warn };
}

const complete = {
  libraryName: 'Δημοτική Βιβλιοθήκη Λάρισας',
  libraryType: 'public',
  city: 'Λάρισα',
  contactName: 'Μαρία Παπαδοπούλου',
  contactEmail: 'library@example.gr',
  consent: 'yes',
};

describe('ApplicationsService.validate', () => {
  let svc: ApplicationsService;
  beforeEach(() => {
    svc = makeService().svc;
  });

  it('accepts a complete application', () => {
    const { errors } = svc.validate(complete, E);
    expect(errors).toEqual({});
  });

  it('requires the five fields the form marks required', () => {
    const { errors } = svc.validate({ consent: 'yes' }, E);
    expect(Object.keys(errors).sort()).toEqual(
      ['city', 'contactEmail', 'contactName', 'libraryName', 'libraryType'].sort(),
    );
  });

  it('treats consent as given ONLY for the literal "yes"', () => {
    for (const v of ['true', '1', 'on', 'YES', ' yes ']) {
      const { values, errors } = svc.validate({ ...complete, consent: v }, E);
      // ' yes ' trims to 'yes' and is legitimately accepted; the rest are not.
      if (v.trim() === 'yes') {
        expect(values.consent, v).toBe('yes');
        expect(errors.consent, v).toBeUndefined();
      } else {
        expect(values.consent, v).toBeUndefined();
        expect(errors.consent, v).toBe(E.consent);
      }
    }
  });

  it('rejects a libraryType outside the enum', () => {
    const { errors } = svc.validate({ ...complete, libraryType: 'archive' }, E);
    expect(errors.libraryType).toBe(E.badType);
  });

  it('accepts every value the form actually offers', () => {
    for (const t of ['public', 'academic', 'school', 'special', 'community', 'other']) {
      const { errors } = svc.validate({ ...complete, libraryType: t }, E);
      expect(errors.libraryType, t).toBeUndefined();
    }
  });

  it('rejects an address with no dot in the domain, accepts a normal one', () => {
    expect(
      svc.validate({ ...complete, contactEmail: 'nope@localhost' }, E).errors.contactEmail,
    ).toBe(E.badEmail);
    expect(
      svc.validate({ ...complete, contactEmail: 'a.b+tag@sub.example.co.uk' }, E).errors
        .contactEmail,
    ).toBeUndefined();
  });

  it('does not report "too long" on a field that is already missing', () => {
    const { errors } = svc.validate({ consent: 'yes' }, E);
    expect(errors.libraryName).toBe(E.required.libraryName);
  });

  it('enforces the per-field length caps', () => {
    const { errors } = svc.validate({ ...complete, message: 'x'.repeat(4001) }, E);
    expect(errors.message).toBe(E.tooLong(4000));
  });

  it('trims values, so whitespace alone is not an answer', () => {
    const { values, errors } = svc.validate({ ...complete, city: '   ' }, E);
    expect(values.city).toBe('');
    expect(errors.city).toBe(E.required.city);
  });

  it('ignores unknown fields rather than rejecting them — the honeypot is one', () => {
    // validateDto would 400 here because of forbidNonWhitelisted, which is
    // exactly why this does not use it.
    const { errors } = svc.validate({ ...complete, website: 'http://spam.example' }, E);
    expect(errors).toEqual({});
  });
});

describe('ApplicationsService.throttle', () => {
  it('keys on a hash, never on the raw address', async () => {
    const hit = vi.fn().mockResolvedValue({ allowed: true, count: 1, retryAfterSec: 0 });
    const { svc } = makeService(hit);
    await svc.throttle('203.0.113.7');
    const key = hit.mock.calls[0]?.[0] as string;
    expect(key).toMatch(/^apply:iph:[0-9a-f]{64}$/);
    expect(key).not.toContain('203.0.113.7');
  });

  it('keeps the per-visitor bucket outside every fail-closed prefix', async () => {
    const hit = vi.fn().mockResolvedValue({ allowed: true, count: 1, retryAfterSec: 0 });
    const { svc } = makeService(hit);
    await svc.throttle('203.0.113.7');
    // A Redis outage must not eat one visitor's lead, so this bucket must not
    // pick up `signup:` or the `apply-all:` prefix the ceiling below uses.
    expect(hit.mock.calls[0]?.[0]).not.toMatch(/^(signup:|apply-all:)/);
  });

  it('gives the same visitor the same bucket and different visitors different ones', async () => {
    const hit = vi.fn().mockResolvedValue({ allowed: true, count: 1, retryAfterSec: 0 });
    const { svc } = makeService(hit);
    await svc.throttle('203.0.113.7');
    await svc.throttle('203.0.113.7');
    await svc.throttle('203.0.113.8');
    const [a, , b, , c] = hit.mock.calls.map((call) => call[0] as string);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('allows 5 an hour', async () => {
    const hit = vi.fn().mockResolvedValue({ allowed: true, count: 1, retryAfterSec: 0 });
    const { svc } = makeService(hit);
    await svc.throttle('203.0.113.7');
    expect(hit.mock.calls[0]?.slice(1)).toEqual([5, 3600]);
  });

  it('reports over-budget when the limiter says so', async () => {
    const hit = vi.fn().mockResolvedValue({ allowed: false, count: 6, retryAfterSec: 900 });
    const { svc } = makeService(hit);
    await expect(svc.throttle('203.0.113.7')).resolves.toBe('ip');
  });

  /**
   * input-and-files-10. The per-IP bucket is the visitor's own budget and fails
   * open; behind it there has to be something that a rotated X-Real-IP cannot
   * step around and a Redis outage cannot remove. The auditor executed the
   * first half — eight submissions with rotating headers, all persisted.
   */
  it('also spends a platform-wide hourly ceiling that no address can dodge', async () => {
    const hit = vi.fn().mockResolvedValue({ allowed: true, count: 1, retryAfterSec: 0 });
    const { svc } = makeService(hit);

    await svc.throttle('203.0.113.7');
    await svc.throttle('198.51.100.9');

    const shared = hit.mock.calls.filter((call) => (call[0] as string).startsWith('apply-all:'));
    expect(shared).toHaveLength(2);
    // Same key from two different addresses, or it is not a ceiling.
    expect(shared[0]?.[0]).toBe(shared[1]?.[0]);
    expect(shared[0]?.slice(1)).toEqual([60, 3600]);
  });

  it('uses the prefix that makes that ceiling fail CLOSED on a Redis error', async () => {
    // The prefix is the whole mechanism: RateLimitService decides deny-vs-allow
    // from the key. Get it wrong and the ceiling evaporates in the outage it
    // exists for, which is exactly how the per-IP bucket behaves today.
    const hit = vi.fn().mockResolvedValue({ allowed: true, count: 1, retryAfterSec: 0 });
    const { svc } = makeService(hit);
    await svc.throttle('203.0.113.7');
    expect(hit.mock.calls[1]?.[0]).toMatch(/^apply-all:/);
  });

  it('reports "global" when the ceiling refuses, so the visitor is not blamed', async () => {
    const hit = vi
      .fn()
      .mockResolvedValueOnce({ allowed: true, count: 1, retryAfterSec: 0 })
      .mockResolvedValueOnce({ allowed: false, count: 61, retryAfterSec: 3600 });
    const { svc } = makeService(hit);
    await expect(svc.throttle('203.0.113.7')).resolves.toBe('global');
  });

  /**
   * The other half of input-and-files-10, and the reason the fail-closed prefix
   * is not the whole answer.
   *
   * `RateLimitService.hit` cannot tell these two apart — a genuine 61st
   * submission and a dead socket both return `{ allowed: false, count: 61 }` —
   * so a Redis blip refused every application on the one unauthenticated write
   * in the product, during a campaign whose entire purpose is capturing five
   * leads. The verdict below is what a librarian's application depends on.
   */
  /**
   * What `RateLimitService` returns for both buckets when Redis is gone: the
   * per-visitor bucket fails open (`allowed`, nothing counted), the `apply-all:`
   * ceiling fails closed. Keyed by bucket rather than by call order, because
   * every test below makes more than one submission.
   */
  const outage = () =>
    vi.fn(async (key: string) =>
      key.startsWith('apply-all:')
        ? { allowed: false, count: 61, retryAfterSec: 3600 }
        : { allowed: true, count: 0, retryAfterSec: 0 },
    );

  it('accepts the application when the ceiling was refused by an unreachable Redis', async () => {
    const { svc, warn } = makeService(outage(), 'reconnecting');
    await expect(svc.throttle('203.0.113.7')).resolves.toBe('ok');
    // Accepting quietly would leave an operator with no way to know the shared
    // ceiling is no longer shared.
    expect(warn.mock.calls.map(String).join('\n')).toContain('reconnecting');
  });

  it('still refuses the 61st, so the outage does not remove the ceiling', async () => {
    const { svc } = makeService(outage(), 'end');
    for (let i = 0; i < 60; i++) {
      await expect(svc.throttle(`203.0.113.${i}`), `submission ${i + 1}`).resolves.toBe('ok');
    }
    await expect(svc.throttle('203.0.113.61')).resolves.toBe('global');
  });

  it('keeps refusing a genuine 61st while Redis is healthy enough to have counted it', async () => {
    // Same refusal, reachable socket: this one really is the ceiling, and the
    // in-process counter must not second-guess it.
    const { svc } = makeService(outage(), 'ready');
    await expect(svc.throttle('203.0.113.7')).resolves.toBe('global');
  });

  it('spends the in-process ceiling while Redis is healthy, so an outage inherits it', async () => {
    // A counter that only starts on the first error hands an attacker a fresh
    // 60 slots the moment Redis drops — the whole ceiling back, at the worst
    // possible moment.
    let redisUp = true;
    const hit = vi.fn(async (key: string) =>
      !redisUp && key.startsWith('apply-all:')
        ? { allowed: false, count: 61, retryAfterSec: 3600 }
        : { allowed: true, count: 1, retryAfterSec: 0 },
    );
    const { svc, redis } = makeService(hit, 'ready');
    for (let i = 0; i < 60; i++) {
      await expect(svc.throttle(`198.51.100.${i}`), `healthy submission ${i + 1}`).resolves.toBe(
        'ok',
      );
    }
    redisUp = false;
    redis.client.status = 'end';
    await expect(svc.throttle('198.51.100.200')).resolves.toBe('global');
  });

  it('does not spend the shared ceiling on a visitor already over their own budget', async () => {
    const hit = vi.fn().mockResolvedValue({ allowed: false, count: 6, retryAfterSec: 900 });
    const { svc } = makeService(hit);
    await svc.throttle('203.0.113.7');
    expect(hit).toHaveBeenCalledTimes(1);
  });
});

/**
 * launch-readiness-11. The form's gate used to be
 * `config.offer.spotsRemaining <= 0` — a literal compiled into the API, which
 * nothing decremented and which took a commit, a CI run and an on-box deploy
 * to change. These are the cases that matter to a real library: the sixth
 * applicant must not be accepted by a form that should have shut, and the
 * first must not be turned away because a query failed.
 */
describe('ApplicationsService.offerState', () => {
  beforeEach(() => {
    applicationCount.mockReset();
  });

  it('is open while fewer than the advertised places have been given', async () => {
    applicationCount.mockResolvedValue(OFFER_TOTAL - 1);
    const { svc } = makeService();
    await expect(svc.offerState()).resolves.toEqual({
      total: OFFER_TOTAL,
      taken: OFFER_TOTAL - 1,
      open: true,
    });
  });

  it('closes the moment the last place is given, with no deploy', async () => {
    applicationCount.mockResolvedValue(OFFER_TOTAL);
    const { svc } = makeService();
    await expect(svc.offerState()).resolves.toMatchObject({ taken: OFFER_TOTAL, open: false });
  });

  it('counts accepted applications only — a reply is not a promise of a place', async () => {
    applicationCount.mockResolvedValue(0);
    const { svc } = makeService();
    await svc.offerState();
    expect(applicationCount).toHaveBeenCalledWith({ where: { status: 'accepted' } });
  });

  it('FAILS OPEN: a database error must never tell a real library the places are gone', async () => {
    applicationCount.mockRejectedValue(new Error('connection terminated'));
    const { svc } = makeService();
    const error = vi.spyOn(svc['logger'], 'error').mockImplementation(() => undefined);
    await expect(svc.offerState()).resolves.toMatchObject({ open: true });
    expect(error).toHaveBeenCalledOnce();
  });
});

/**
 * launch-readiness-03. The enqueue below it is delivered by nobody under
 * EMAIL_DRIVER=console, so this line is one of the two channels that actually
 * reach the operator (the other is the admin panel). It must name the library
 * — and it must NOT name the person: the container log is archived into the
 * nightly backup and reached by no retention sweep.
 */
describe('ApplicationsService.notify', () => {
  it('announces the application on a channel that works with the console driver', async () => {
    const { svc, warn } = makeService();
    await svc.notify('app-123', {
      values: {
        libraryName: 'Δημοτική Βιβλιοθήκη Λάρισας',
        city: 'Λάρισα',
        contactName: 'Μαρία Παπαδοπούλου',
        contactEmail: 'library@example.gr',
        phone: '2410000000',
      },
      errors: {},
    });
    expect(warn).toHaveBeenCalledOnce();
    const line = String(warn.mock.calls[0]?.[0]);
    expect(line).toContain('NEW APPLICATION');
    expect(line).toContain('Δημοτική Βιβλιοθήκη Λάρισας');
    expect(line).toContain('Λάρισα');
    expect(line).toContain('app-123');
    expect(line).toContain('https://admin.example.test/en/admin/applications');
    expect(line).toContain('EMAIL_DRIVER=console');
    // The applicant is a person. Their name, address and phone stay out of a
    // log nothing ever erases (privacy-legal-04).
    expect(line).not.toContain('Μαρία');
    expect(line).not.toContain('library@example.gr');
    expect(line).not.toContain('2410000000');
  });
});
