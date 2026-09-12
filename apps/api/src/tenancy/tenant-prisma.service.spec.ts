import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Keep Prisma out of a unit test. `makeTenantPrismaClient` is lazy (the audit
 * measured zero backends after constructing ten clients), but importing the
 * real module drags in the generated client for no benefit here — the subject
 * is which URL the service is willing to open, not what it opens it with.
 */
const { makeTenantPrismaClient, makeTenantPrismaClientV2 } = vi.hoisted(() => ({
  makeTenantPrismaClient: vi.fn(() => ({ $disconnect: vi.fn(async () => undefined) })),
  // Phase 10: every cached tenant holds BOTH datamodels. Mocked here too, or
  // the guard tests fail on a missing export rather than on what they assert.
  makeTenantPrismaClientV2: vi.fn(() => ({ $disconnect: vi.fn(async () => undefined) })),
}));
// `v2SchemaFor` is REAL, not stubbed (2.0 phase 20f): the cache key now
// includes the schema this tenant's 2.0 tables are in, and a stub would let
// this spec pass while the real mapping was wrong.
vi.mock('@libriant/db-tenant', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@libriant/db-tenant')>()),
  makeTenantPrismaClient,
  makeTenantPrismaClientV2,
}));

vi.mock('../config/env.js', () => ({
  loadEnv: () => ({ tenantClientCacheSize: 10, tenantClientIdleMs: 60_000 }),
}));

import { TenantPrismaService } from './tenant-prisma.service.js';

const TENANT_A = 'cmt95bx1o60d0e1e772191bbf4c';
const TENANT_B = 'cmt96oghc71cc5ea2000000000';
const urlFor = (dbName: string) => `postgresql://libriant:s3cr3t-pg-pw@postgres:5432/${dbName}`;

describe('TenantPrismaService cross-tenant routing guard (tenant-isolation-02)', () => {
  let service: TenantPrismaService;

  beforeEach(() => {
    makeTenantPrismaClient.mockClear();
    makeTenantPrismaClientV2.mockClear();
    service = new TenantPrismaService();
  });

  it('opens the client when the URL names this tenant’s own database', () => {
    const client = service.getClient({ id: TENANT_A, dbUrl: urlFor(`tenant_${TENANT_A}`) });

    expect(client).toBeDefined();
    expect(makeTenantPrismaClient).toHaveBeenCalledTimes(1);
  });

  it('refuses — and opens NOTHING — when the context points at another library’s database', () => {
    // The audit did this by hand with psql: take the connection string held for
    // library A, swap in B's database name, read B's members. This is the same
    // shape arriving through a logic bug or a poisoned cache instead.
    expect(() => service.getClient({ id: TENANT_A, dbUrl: urlFor(`tenant_${TENANT_B}`) })).toThrow(
      /cross-tenant routing bug/,
    );
    expect(makeTenantPrismaClient).not.toHaveBeenCalled();
  });

  it('refuses a URL pointed at the CONTROL plane', () => {
    expect(() => service.getClient({ id: TENANT_A, dbUrl: urlFor('libriant_control') })).toThrow(
      /expected database "tenant_/,
    );
    expect(makeTenantPrismaClient).not.toHaveBeenCalled();
  });

  it('never puts the connection string — a live superuser credential — in the error', () => {
    // tenant-isolation-03: this error is written to the same log the audit
    // found the credential in. It must name the databases, not the URL.
    let message = '';
    try {
      service.getClient({ id: TENANT_A, dbUrl: urlFor(`tenant_${TENANT_B}`) });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).not.toBe('');
    expect(message).not.toContain('s3cr3t-pg-pw');
    expect(message).not.toContain('postgresql://');
  });

  it('refuses a dbUrl that is not a URL at all', () => {
    expect(() => service.getClient({ id: TENANT_A, dbUrl: 'not a url' })).toThrow(
      /not a valid URL/,
    );
    expect(makeTenantPrismaClient).not.toHaveBeenCalled();
  });

  it('still rebuilds the client when a relocate moves the tenant to a new HOST', () => {
    // tenant-relocate.ts changes the host and keeps the database name, which is
    // why the guard keys on the database name alone. A guard that pinned the
    // host would break relocation.
    service.getClient({ id: TENANT_A, dbUrl: urlFor(`tenant_${TENANT_A}`) });
    const moved = `postgresql://libriant:s3cr3t-pg-pw@postgres-2:5432/tenant_${TENANT_A}`;

    service.getClient({ id: TENANT_A, dbUrl: moved });

    expect(makeTenantPrismaClient).toHaveBeenCalledTimes(2);
    // BOTH datamodels rebuild. A relocate that rebuilt only the 1.0 client
    // would leave the 2.0 one pointing at the tenant's OLD database — a
    // cross-tenant read, which is the failure this whole service exists to
    // prevent, and it would be invisible to every test that only asserts the
    // 1.0 client.
    expect(makeTenantPrismaClientV2).toHaveBeenCalledTimes(2);
    expect(makeTenantPrismaClient).toHaveBeenLastCalledWith(
      expect.objectContaining({ databaseUrl: moved }),
    );
  });
});
