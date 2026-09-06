import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  composeRuntimeUrl,
  newRuntimePassword,
  openTenantPassword,
  otherSlot,
  parseTenantDbMasterKey,
  redactDbUrl,
  sameEndpointAndDatabase,
  sealTenantPassword,
  slotOfRole,
  tenantLoginRole,
  tenantPrivilegeRole,
  tenantRoleNames,
} from '@libriant/db-control';

const KEY = parseTenantDbMasterKey(
  'aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899',
);
const ADMIN_URL =
  'postgresql://libriant:supersecret@db.internal:5432/tenant_cabc123?sslmode=require';
const TENANT = 'cabc123';

describe('per-tenant role naming', () => {
  it('derives the privilege role and both slots from the tenant id', () => {
    expect(tenantPrivilegeRole(TENANT)).toBe('tenant_cabc123_app');
    expect(tenantLoginRole(TENANT, 'a')).toBe('tenant_cabc123_a');
    expect(tenantLoginRole(TENANT, 'b')).toBe('tenant_cabc123_b');
    expect(tenantRoleNames(TENANT).logins).toEqual(['tenant_cabc123_a', 'tenant_cabc123_b']);
  });

  it('normalises the id the same way the database name does', () => {
    // `dbNameForTenant` lowercases and replaces anything outside [a-z0-9_].
    // If the two disagreed, a rotation would ALTER a role nothing connects as.
    expect(tenantPrivilegeRole('cAB-c1')).toBe('tenant_cab_c1_app');
  });

  it('round-trips a role name back to its slot, and rejects a foreign one', () => {
    expect(slotOfRole(TENANT, 'tenant_cabc123_b')).toBe('b');
    expect(slotOfRole(TENANT, 'tenant_someone_else_a')).toBeNull();
    expect(otherSlot('a')).toBe('b');
    expect(otherSlot('b')).toBe('a');
  });
});

describe('sealing a runtime password', () => {
  it('round-trips', () => {
    const password = newRuntimePassword();
    const sealed = sealTenantPassword({
      tenantId: TENANT,
      roleName: 'tenant_cabc123_a',
      password,
      masterKey: KEY,
    });
    expect(openTenantPassword({ tenantId: TENANT, row: sealed, masterKey: KEY })).toBe(password);
  });

  it('generates a URL-safe password', () => {
    // Not cosmetic: the value is interpolated into `postgresql://user:pw@host`
    // AND into `ALTER ROLE … PASSWORD '…'`. A character needing escaping in
    // either is a bug that only shows up on the unlucky tenant.
    for (let i = 0; i < 50; i++) expect(newRuntimePassword()).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses to open under a DIFFERENT tenant id', () => {
    // The tenant id is the AAD. Without it, moving one library's sealed row
    // onto another library's id would decrypt cleanly and hand out a working
    // credential for the wrong database — the exact failure the per-tenant
    // role exists to make impossible.
    const sealed = sealTenantPassword({
      tenantId: TENANT,
      roleName: 'tenant_cabc123_a',
      password: newRuntimePassword(),
      masterKey: KEY,
    });
    expect(() =>
      openTenantPassword({ tenantId: 'cother999', row: sealed, masterKey: KEY }),
    ).toThrow();
  });

  it('refuses a tampered ciphertext and a wrong key', () => {
    const sealed = sealTenantPassword({
      tenantId: TENANT,
      roleName: 'tenant_cabc123_a',
      password: newRuntimePassword(),
      masterKey: KEY,
    });
    const flipped = Uint8Array.from(sealed.encryptedPwd);
    flipped[0] = (flipped[0] ?? 0) ^ 0xff;
    expect(() =>
      openTenantPassword({
        tenantId: TENANT,
        row: { ...sealed, encryptedPwd: flipped },
        masterKey: KEY,
      }),
    ).toThrow();

    const otherKey = parseTenantDbMasterKey('11'.repeat(32));
    expect(() =>
      openTenantPassword({ tenantId: TENANT, row: sealed, masterKey: otherKey }),
    ).toThrow();
  });

  it('rejects a master key that is not 32 bytes of hex', () => {
    expect(() => parseTenantDbMasterKey('short')).toThrow(/64 hex/);
    expect(() => parseTenantDbMasterKey('zz'.repeat(32))).toThrow(/64 hex/);
  });

  it('names the key id it cannot open, rather than throwing a decrypt error', () => {
    const sealed = sealTenantPassword({
      tenantId: TENANT,
      roleName: 'tenant_cabc123_a',
      password: newRuntimePassword(),
      masterKey: KEY,
    });
    expect(() =>
      openTenantPassword({
        tenantId: TENANT,
        row: { ...sealed, encryptionKeyId: 'v2' },
        masterKey: KEY,
      }),
    ).toThrow(/key id "v2"/);
  });
});

describe('composing the runtime url', () => {
  it('swaps ONLY the credentials', () => {
    const url = new URL(
      composeRuntimeUrl({
        adminUrl: ADMIN_URL,
        roleName: 'tenant_cabc123_a',
        password: 'deadbeef'.repeat(8),
      }),
    );
    expect(url.username).toBe('tenant_cabc123_a');
    expect(url.password).toBe('deadbeef'.repeat(8));
    // Endpoint, database and every parameter survive. A helper that quietly
    // dropped `sslmode=require` while swapping credentials would be a
    // downgrade nobody notices.
    expect(url.host).toBe('db.internal:5432');
    expect(url.pathname).toBe('/tenant_cabc123');
    expect(url.searchParams.get('sslmode')).toBe('require');
  });

  it('keeps the database name, which is what assertUrlBelongsToTenant checks', () => {
    const runtime = composeRuntimeUrl({
      adminUrl: ADMIN_URL,
      roleName: 'tenant_cabc123_a',
      password: 'ab'.repeat(32),
    });
    expect(sameEndpointAndDatabase(ADMIN_URL, runtime)).toBe(true);
    // The same credential pointed at another library's database is a different
    // (endpoint, database) pair — which is what the rotation script refuses on
    // and what `assertUrlBelongsToTenant` refuses on.
    const elsewhere = new URL(runtime);
    elsewhere.pathname = '/tenant_cother999';
    expect(sameEndpointAndDatabase(ADMIN_URL, elsewhere.toString())).toBe(false);
  });

  it('redacts the password and survives an unparseable url', () => {
    expect(redactDbUrl(ADMIN_URL)).toContain(':***@');
    expect(redactDbUrl(ADMIN_URL)).not.toContain('supersecret');
    expect(redactDbUrl('not a url')).toBe('<unparseable database url>');
  });

  it('refuses an admin url that is not a url', () => {
    expect(() =>
      composeRuntimeUrl({ adminUrl: 'nope', roleName: 'r', password: 'ab'.repeat(32) }),
    ).toThrow(/not a URL/);
  });
});

// --- runtimeDbUrl, which reads the environment ------------------------------

const ENV_KEYS = [
  'NODE_ENV',
  'CONTROL_DATABASE_URL',
  'REDIS_URL',
  'PG_SUPERUSER_URL',
  'STORAGE_ROOT',
  'SESSION_SECRET',
  'HASH_PEPPER',
  'ADMIN_SESSION_SECRET',
  'IMPERSONATION_SECRET',
  'STORAGE_SIGNING_SECRET',
  'MFA_MASTER_KEY',
  'TENANT_DB_MASTER_KEY',
  'TENANT_DB_ALLOW_SUPERUSER_FALLBACK',
] as const;

describe('runtimeDbUrl', () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    process.env.NODE_ENV = 'test';
    process.env.CONTROL_DATABASE_URL = 'postgresql://u:p@localhost:5432/libriant_control';
    process.env.REDIS_URL = 'redis://localhost:6379';
    process.env.PG_SUPERUSER_URL = 'postgresql://u:p@localhost:5432/libriant_control';
    process.env.STORAGE_ROOT = '/tmp/lbr-unit';
    process.env.SESSION_SECRET = 'unit';
    process.env.ADMIN_SESSION_SECRET = 'unit-admin';
    process.env.IMPERSONATION_SECRET = 'unit-imp';
    process.env.STORAGE_SIGNING_SECRET = 'unit-storage';
    process.env.HASH_PEPPER = 'unit';
    process.env.MFA_MASTER_KEY = '00'.repeat(32);
    process.env.TENANT_DB_MASTER_KEY =
      'aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899';
    delete process.env.TENANT_DB_ALLOW_SUPERUSER_FALLBACK;
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  async function load() {
    // Fresh module each time: `runtimeDbUrl` memoises the parsed master key and
    // the set of tenants it has already warned about, and these cases
    // deliberately disagree about the environment.
    vi.resetModules();
    return import('./tenant-db-url.js');
  }

  it('composes the tenant credential when the sealed row is present', async () => {
    const { runtimeDbUrl } = await load();
    const password = newRuntimePassword();
    const sealed = sealTenantPassword({
      tenantId: TENANT,
      roleName: 'tenant_cabc123_a',
      password,
      masterKey: KEY,
    });
    const url = new URL(runtimeDbUrl({ id: TENANT, dbUrl: ADMIN_URL, dbCredentials: sealed }));
    expect(url.username).toBe('tenant_cabc123_a');
    expect(url.password).toBe(password);
    expect(url.host).toBe('db.internal:5432');
  });

  it('fails CLOSED when the tenant has no credential', async () => {
    const { runtimeDbUrl } = await load();
    expect(() => runtimeDbUrl({ id: TENANT, dbUrl: ADMIN_URL, dbCredentials: null })).toThrow(
      /tenant_db_credentials/,
    );
    // The message must not carry the url — this error is logged, and the url
    // it would carry is the superuser credential (tenant-isolation-03).
    try {
      runtimeDbUrl({ id: TENANT, dbUrl: ADMIN_URL, dbCredentials: null });
    } catch (err) {
      expect((err as Error).message).not.toContain('supersecret');
      expect((err as Error).message).toContain('tenant:rotate-db-creds');
    }
  });

  it('falls back to the admin url only when explicitly allowed', async () => {
    process.env.TENANT_DB_ALLOW_SUPERUSER_FALLBACK = 'true';
    const { runtimeDbUrl } = await load();
    expect(runtimeDbUrl({ id: TENANT, dbUrl: ADMIN_URL, dbCredentials: null })).toBe(ADMIN_URL);
  });
});
