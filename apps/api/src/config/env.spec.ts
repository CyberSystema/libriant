import { afterEach, describe, expect, it } from 'vitest';
import { loadEnv } from './env.js';

/**
 * These four defects share a shape: a value the operator got slightly wrong,
 * accepted silently, changing what the server IS.
 *
 * Executed against a real `node src/main.ts` before the fix: `NODE_ENV=staging`
 * and `NODE_ENV=Production` both booted clean (readyz=200) with every
 * production-only protection off; `NODE_ENV=production` with PG_SUPERUSER_URL
 * unset also booted clean, because nothing on the startup or readiness path
 * touches it — the first sign would have been a tenant signup running CREATE
 * DATABASE against localhost with libriant/libriant; and `BILLING_ENABLED=enabled`
 * booted with enforcement quietly off.
 */
const SAVED = { ...process.env };

/** A complete, valid production env. Each test breaks exactly one thing. */
function prodEnv(overrides: Record<string, string | undefined> = {}) {
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, {
    NODE_ENV: 'production',
    CONTROL_DATABASE_URL: 'postgresql://u:p@db:5432/libriant_control',
    PG_SUPERUSER_URL: 'postgresql://u:p@db:5432/libriant_control',
    REDIS_URL: 'redis://redis:6379',
    STORAGE_ROOT: '/srv/libriant/storage',
    SESSION_SECRET: 'session-secret-long-enough-for-the-floor',
    ADMIN_SESSION_SECRET: 'admin-secret-long-enough-for-the-floor',
    IMPERSONATION_SECRET: 'imp-secret-long-enough-for-the-floor',
    STORAGE_SIGNING_SECRET: 'storage-secret-long-enough-and-distinct',
    HASH_PEPPER: 'hash-pepper-long-enough-for-the-32-char-floor',
    MFA_MASTER_KEY: '0011223344556677889900112233445566778899001122334455667788990011',
    TENANT_DB_MASTER_KEY: 'aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899',
  });
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

afterEach(() => {
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, SAVED);
});

describe('loadEnv — NODE_ENV is validated, not cast', () => {
  it.each(['staging', 'Production', 'prod'])('refuses to boot on NODE_ENV=%s', (nodeEnv) => {
    prodEnv({ NODE_ENV: nodeEnv });
    expect(() => loadEnv()).toThrow(/NODE_ENV must be one of/);
  });

  it.each(['development', 'production', 'test'])('accepts %s', (nodeEnv) => {
    prodEnv({ NODE_ENV: nodeEnv });
    expect(loadEnv().nodeEnv).toBe(nodeEnv);
  });

  it('still defaults an unset NODE_ENV to development with its quickstart fallbacks', () => {
    // The quickstart contract: `pnpm dev` with nothing configured must work.
    for (const key of Object.keys(process.env)) delete process.env[key];
    const env = loadEnv();
    expect(env.nodeEnv).toBe('development');
    expect(env.controlDbUrl).toContain('localhost:5432');
  });
});

describe('loadEnv — infrastructure the app cannot run without', () => {
  it.each(['CONTROL_DATABASE_URL', 'REDIS_URL', 'PG_SUPERUSER_URL', 'STORAGE_ROOT'])(
    'refuses to boot in production without %s instead of falling back to localhost',
    (key) => {
      prodEnv({ [key]: undefined });
      expect(() => loadEnv()).toThrow(new RegExp(`Missing required env var: ${key}`));
    },
  );
});

describe('loadEnv — the tenant database master key', () => {
  it('refuses to boot in production without it', () => {
    // Not optional and not defaultable: without it the API cannot open the
    // sealed per-tenant passwords, and the only "fallback" available would be
    // the superuser url — which is tenant-isolation-02 itself.
    prodEnv({ TENANT_DB_MASTER_KEY: undefined });
    expect(() => loadEnv()).toThrow(/Missing required env var: TENANT_DB_MASTER_KEY/);
  });

  it.each(['short', 'zz'.repeat(32), '00'.repeat(16)])(
    'refuses a key that is not 64 hex characters (%s)',
    (bad) => {
      prodEnv({ TENANT_DB_MASTER_KEY: bad });
      expect(() => loadEnv()).toThrow(/TENANT_DB_MASTER_KEY must be 64 hex characters/);
    },
  );

  it('refuses to boot when it is a copy of MFA_MASTER_KEY', () => {
    // One recovers admin TOTP enrollments; the other opens every library
    // database. A single key means a leak of either is a leak of both, and the
    // copy-paste is the natural mistake — same length, same shape, adjacent
    // lines in the env file.
    prodEnv({
      TENANT_DB_MASTER_KEY: '0011223344556677889900112233445566778899001122334455667788990011',
    });
    expect(() => loadEnv()).toThrow(/same value/);
  });

  it('is case-insensitive about that comparison', () => {
    prodEnv({
      TENANT_DB_MASTER_KEY:
        '0011223344556677889900112233445566778899001122334455667788990011'.toUpperCase(),
    });
    expect(() => loadEnv()).toThrow(/same value/);
  });

  it('defaults the superuser fallback to OFF outside development', () => {
    prodEnv();
    expect(loadEnv().tenantDbAllowSuperuserFallback).toBe(false);
    prodEnv({ NODE_ENV: 'test' });
    expect(loadEnv().tenantDbAllowSuperuserFallback).toBe(false);
  });

  it('keeps the quickstart working: dev has both keys and they differ', () => {
    for (const key of Object.keys(process.env)) delete process.env[key];
    const env = loadEnv();
    expect(env.tenantDbMasterKey).toMatch(/^[0-9a-f]{64}$/);
    expect(env.tenantDbMasterKey).not.toBe(env.mfaMasterKey);
    // …and dev IS allowed the fallback, so `pnpm dev` against a control plane
    // seeded before phase 4 still starts.
    expect(env.tenantDbAllowSuperuserFallback).toBe(true);
  });
});

describe('loadEnv — the storage and session keys must stay separate', () => {
  it('refuses to boot in production when the two hold the same value', () => {
    prodEnv({ STORAGE_SIGNING_SECRET: 'session-secret-long-enough-for-the-floor' });
    expect(() => loadEnv()).toThrow(/same value/);
  });

  it('still lets dev and test share them through the fallback', () => {
    prodEnv({ NODE_ENV: 'test', STORAGE_SIGNING_SECRET: undefined });
    expect(loadEnv().storageSigningSecret).toBe('session-secret-long-enough-for-the-floor');
  });
});

describe('loadEnv — boolean flags', () => {
  it.each(['enabled', 'y', 'True!', 'sure'])(
    'refuses BILLING_ENABLED=%s rather than reading it as "off"',
    (raw) => {
      prodEnv({ BILLING_ENABLED: raw });
      expect(() => loadEnv()).toThrow(/BILLING_ENABLED must be one of/);
    },
  );

  it.each([
    ['true', true],
    ['TRUE', true],
    ['1', true],
    ['on', true],
    ['false', false],
    ['0', false],
    ['off', false],
    ['', false],
  ])('reads BILLING_ENABLED=%s as %s', (raw, expected) => {
    prodEnv({ BILLING_ENABLED: raw });
    expect(loadEnv().billingEnabled).toBe(expected);
  });
});
