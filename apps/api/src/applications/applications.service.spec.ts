import { describe, expect, it, vi, beforeEach } from 'vitest';

// Repo convention for a service that reads config in its constructor.
vi.mock('../config/env.js', () => ({
  loadEnv: () => ({
    applyHashPepper: 'unit-test-pepper-0123456789abcdef0123',
    applyNotifyTo: 'info@example.test',
  }),
}));

import { ERRORS } from '@libriant/site';
import { ApplicationsService } from './applications.service.js';

/**
 * Validation is ported verbatim from the Cloudflare Worker this replaces, and
 * these cases are the acceptance criteria for that port. The rules matter more
 * than they look: each one is the difference between a real library's
 * application arriving and being silently dropped.
 */

const E = ERRORS.el;

function makeService(
  hit = vi.fn().mockResolvedValue({ allowed: true, count: 1, retryAfterSec: 0 }),
) {
  const email = { enqueue: vi.fn().mockResolvedValue(undefined) };
  const rateLimit = { hit };
  // The constructor reads env; the test env supplies HASH_PEPPER.
  const svc = new ApplicationsService(email as never, rateLimit as never);
  return { svc, email, rateLimit };
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

describe('ApplicationsService.isRateLimited', () => {
  it('keys on a hash, never on the raw address', async () => {
    const hit = vi.fn().mockResolvedValue({ allowed: true, count: 1, retryAfterSec: 0 });
    const { svc } = makeService(hit);
    await svc.isRateLimited('203.0.113.7');
    const key = hit.mock.calls[0]?.[0] as string;
    expect(key).toMatch(/^apply:iph:[0-9a-f]{64}$/);
    expect(key).not.toContain('203.0.113.7');
  });

  it('does not use the signup: prefix, which would make it fail CLOSED', async () => {
    const hit = vi.fn().mockResolvedValue({ allowed: true, count: 1, retryAfterSec: 0 });
    const { svc } = makeService(hit);
    await svc.isRateLimited('203.0.113.7');
    // RateLimitService fails closed only for signup:* — a Redis outage must not
    // eat applications, so this bucket must stay outside that prefix.
    expect(hit.mock.calls[0]?.[0]).not.toMatch(/^signup:/);
  });

  it('gives the same visitor the same bucket and different visitors different ones', async () => {
    const hit = vi.fn().mockResolvedValue({ allowed: true, count: 1, retryAfterSec: 0 });
    const { svc } = makeService(hit);
    await svc.isRateLimited('203.0.113.7');
    await svc.isRateLimited('203.0.113.7');
    await svc.isRateLimited('203.0.113.8');
    const [a, b, c] = hit.mock.calls.map((call) => call[0] as string);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('allows 5 an hour', async () => {
    const hit = vi.fn().mockResolvedValue({ allowed: true, count: 1, retryAfterSec: 0 });
    const { svc } = makeService(hit);
    await svc.isRateLimited('203.0.113.7');
    expect(hit.mock.calls[0]?.slice(1)).toEqual([5, 3600]);
  });

  it('reports over-budget when the limiter says so', async () => {
    const hit = vi.fn().mockResolvedValue({ allowed: false, count: 6, retryAfterSec: 900 });
    const { svc } = makeService(hit);
    await expect(svc.isRateLimited('203.0.113.7')).resolves.toBe(true);
  });
});
