import { describe, expect, it, vi } from 'vitest';

vi.mock('../config/env.js', () => ({
  loadEnv: () => ({
    sessionSecret: 'unit-test-session-secret-0123456789abcdef',
    sessionTtlSec: 7 * 24 * 60 * 60, // 7d
    sessionRememberTtlSec: 30 * 24 * 60 * 60, // 30d
  }),
}));

import {
  JwtSessionService,
  isPastAbsoluteMax,
  isPastHalfLife,
  isSessionRevoked,
  sessionStartSec,
} from './jwt-session.service.js';

const BASE = { sub: 'u1', tid: 't1', role: 'owner' as const };

describe('JwtSessionService remember-aware signing', () => {
  const svc = new JwtSessionService();

  it('issues a long persistent token when remember=true', () => {
    const r = svc.sign({ ...BASE, remember: true });
    expect(r.remember).toBe(true);
    const days = (r.expiresAt.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29);
    expect(days).toBeLessThan(31);
    expect(svc.verify(r.token)?.rmb).toBe(true);
  });

  it('issues a short token when remember is absent/false', () => {
    const r = svc.sign({ ...BASE });
    expect(r.remember).toBe(false);
    const days = (r.expiresAt.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6);
    expect(days).toBeLessThan(8);
    expect(svc.verify(r.token)?.rmb).toBe(false);
  });

  it('round-trips sub/tid/role through verify and stamps a session start (ist)', () => {
    const r = svc.sign({ ...BASE, remember: true });
    const p = svc.verify(r.token);
    expect(p).toMatchObject({ sub: 'u1', tid: 't1', role: 'owner' });
    expect(typeof p?.ist).toBe('number');
  });

  it('preserves the original ist when re-signing (a slide) — start time is immutable', () => {
    const first = svc.verify(svc.sign({ ...BASE, remember: true }).token)!;
    // Simulate a slide: re-sign passing the original ist through.
    const slid = svc.verify(svc.sign({ ...BASE, remember: true, ist: first.ist }).token)!;
    expect(slid.ist).toBe(first.ist);
  });

  it('sliding a LEGACY token (no ist) carries its iat forward, never resets the start', () => {
    // A legacy token predates `ist`. The middleware slides via
    // `ist: sessionStartSec(payload)`, which for a legacy token is its iat — so
    // the start can't move forward (the laundering bug the security review found).
    const legacy = { iat: 1_000_000, role: 'owner' as const } as Parameters<
      typeof sessionStartSec
    >[0];
    const carried = sessionStartSec(legacy); // = 1_000_000 (no ist)
    const slid = svc.verify(svc.sign({ ...BASE, remember: true, ist: carried }).token)!;
    expect(slid.ist).toBe(1_000_000);
    // And a revocation epoch after the legacy start still revokes the slid token.
    expect(isSessionRevoked(slid, 1_000_001 * 1000)).toBe(true);
  });
});

describe('session start + revocation (resurrection defence)', () => {
  it('sessionStartSec uses ist, falling back to iat for legacy tokens', () => {
    expect(sessionStartSec({ iat: 100, ist: 50 })).toBe(50);
    expect(sessionStartSec({ iat: 100 })).toBe(100); // legacy, no ist
  });

  it('a session that STARTED before the revocation epoch is revoked', () => {
    const validAfterMs = 2_000_000; // epoch second = 2000
    expect(isSessionRevoked({ iat: 9999, ist: 1999 }, validAfterMs)).toBe(true); // started before
    expect(isSessionRevoked({ iat: 9999, ist: 2001 }, validAfterMs)).toBe(false); // started after
  });

  it('CANNOT be laundered by sliding: a fresh iat does NOT escape revocation', () => {
    const validAfterMs = 2_000_000; // epoch second = 2000
    // The attacker's session started at ist=1500 (before the reset). A slide
    // gives it a brand-new iat=9999, but ist is preserved → still revoked.
    const slidStolen = { iat: 9999, ist: 1500 };
    expect(isSessionRevoked(slidStolen, validAfterMs)).toBe(true);
  });

  it('no revocation when the user has never bumped the epoch (0)', () => {
    expect(isSessionRevoked({ iat: 100, ist: 100 }, 0)).toBe(false);
  });
});

describe('absolute lifetime cap', () => {
  const MAX = 90 * 24 * 60 * 60; // 90d
  it('rejects once total age (from ist) exceeds the cap, regardless of iat', () => {
    const start = 1_000_000;
    const slid = { iat: start + MAX, ist: start }; // recently slid, but old session
    expect(isPastAbsoluteMax(slid, start + MAX + 1, MAX)).toBe(true);
    expect(isPastAbsoluteMax(slid, start + MAX - 1, MAX)).toBe(false);
  });
});

describe('isPastHalfLife', () => {
  it('is false before the half-life and true at/after it', () => {
    const p = { iat: 1000, exp: 2000 }; // half-life at 1500
    expect(isPastHalfLife(p, 1499)).toBe(false);
    expect(isPastHalfLife(p, 1500)).toBe(true);
    expect(isPastHalfLife(p, 1999)).toBe(true);
  });

  it('is false for a malformed/degenerate window', () => {
    expect(isPastHalfLife({ iat: 2000, exp: 1000 }, 5000)).toBe(false);
    expect(isPastHalfLife({ iat: NaN, exp: 2000 }, 5000)).toBe(false);
  });
});
