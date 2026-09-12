import { beforeEach, describe, expect, it, vi } from 'vitest';

const { tenantFindMany, tenantGetClient, tenantDestroy } = vi.hoisted(() => ({
  tenantFindMany: vi.fn(),
  tenantGetClient: vi.fn(),
  tenantDestroy: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@libriant/db-control', async (importOriginal) => ({
  // Spread the real module: since phase 4 the sweep composes each tenant's
  // runtime connection string from its sealed credential, so the sealing
  // helpers have to be the real ones (tenant-isolation-02).
  ...(await importOriginal<typeof import('@libriant/db-control')>()),
  controlDb: {
    // 2.0 phase 20f: the sweeps read which libraries have been cut over.
    tenantSchemaState: { findMany: () => Promise.resolve([]) },
    tenant: { findMany: tenantFindMany },
  },
}));
vi.mock('../config/env.js', () => ({
  loadEnv: () => ({
    tenantClientCacheSize: 10,
    tenantClientIdleMs: 60_000,
    ...TEST_TENANT_DB_ENV,
  }),
}));
vi.mock('../tenancy/tenant-prisma.service.js', () => ({
  // Regular function (not an arrow) so the sweeper's `new TenantPrismaService()`
  // works — under vitest 4 a `vi.fn` wrapping an arrow can't be constructed.
  TenantPrismaService: vi.fn(function () {
    return {
      getClient: tenantGetClient,
      onModuleDestroy: tenantDestroy,
    };
  }),
}));
import {
  TEST_TENANT_DB_ENV,
  testSealedCredential,
} from '../tenancy/__fixtures__/tenant-credential.js';

import { sweepExpiredReservationPickups } from './reservation-expiry.job.js';

/**
 * Build a fake tenant Prisma client. `reservations` + `bookCopies` are
 * tiny in-memory tables and `$transaction(fn)` calls back synchronously
 * with the tx object set to the same client (so the inline tx logic in
 * the sweeper runs against the same shared state).
 */
function makeTenantClient(
  reservations: Array<{
    id: string;
    bookId: string;
    status: string;
    expiresAt: Date | null;
    queuePosition: number | null;
    fulfilledByCopyId: string | null;
    readyAt?: Date | null;
  }>,
  bookCopies: Array<{ id: string; bookId: string; status: string }>,
) {
  const client = {
    reservation: {
      findMany: vi.fn(async (args: { where: Record<string, unknown> }) => {
        const w = args.where;
        return reservations.filter((r) => {
          if (w.status && r.status !== w.status) return false;
          if (w.expiresAt && r.expiresAt) {
            const cutoff = (w.expiresAt as { lt: Date }).lt;
            if (r.expiresAt >= cutoff) return false;
          }
          return true;
        });
      }),
      findFirst: vi.fn(async (args: { where: Record<string, unknown> }) => {
        const w = args.where;
        return (
          reservations
            .filter((r) => r.status === w.status && r.bookId === w.bookId)
            .sort((a, b) => (a.queuePosition ?? 0) - (b.queuePosition ?? 0))[0] ?? null
        );
      }),
      updateMany: vi.fn(
        async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
          let count = 0;
          for (const r of reservations) {
            if (r.id === args.where.id && r.status === args.where.status) {
              Object.assign(r, args.data);
              count++;
            }
          }
          return { count };
        },
      ),
      update: vi.fn(
        async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
          const r = reservations.find((x) => x.id === args.where.id);
          if (r) Object.assign(r, args.data);
          return r;
        },
      ),
    },
    bookCopy: {
      findFirst: vi.fn(async (args: { where: Record<string, unknown> }) => {
        return (
          bookCopies.find(
            (c) => c.bookId === args.where.bookId && c.status === args.where.status,
          ) ?? null
        );
      }),
      updateMany: vi.fn(
        async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
          let count = 0;
          for (const c of bookCopies) {
            // Honor the status guard so compare-and-swap claims + the
            // status-guarded free are modeled accurately (the production code
            // relies on `where: { id, status }` to avoid clobbering copies).
            if (c.id === args.where.id && (!args.where.status || c.status === args.where.status)) {
              Object.assign(c, args.data);
              count++;
            }
          }
          return { count };
        },
      ),
      update: vi.fn(
        async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
          const c = bookCopies.find((x) => x.id === args.where.id);
          if (c) Object.assign(c, args.data);
          return c;
        },
      ),
    },
    tenantSetting: {
      findUnique: vi.fn(async () => ({ holdPickupHours: 48 })),
    },
    // Per-book advisory lock taken at the top of the promotion tx — a no-op in
    // the in-memory model (it only matters under real concurrent Postgres txns).
    $executeRaw: vi.fn(async () => 0),
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(client)),
  };
  return client;
}

describe('sweepExpiredReservationPickups', () => {
  beforeEach(() => {
    tenantFindMany.mockReset();
    tenantGetClient.mockReset();
    tenantDestroy.mockClear();
  });

  it('returns a no-op summary when there are no active tenants', async () => {
    tenantFindMany.mockResolvedValue([]);

    const result = await sweepExpiredReservationPickups();

    expect(result.counts?.tenantsScanned).toBe(0);
    expect(result.counts?.expired).toBe(0);
  });

  it('returns a no-op summary when a tenant has no expired pickups', async () => {
    tenantFindMany.mockResolvedValue([
      {
        id: 't-1',
        slug: 'acme',
        dbUrl: 'postgresql://libriant:s3cr3t@postgres:5432/tenant_t_1',
        storageUrl: '',
        dbCredentials: testSealedCredential('t-1'),
        defaultLocale: 'en',
        status: 'active',
        name: 'Acme',
        customSubdomain: null,
        tags: [],
      },
    ]);
    tenantGetClient.mockReturnValue(makeTenantClient([], []));

    const result = await sweepExpiredReservationPickups();

    expect(result.counts?.tenantsScanned).toBe(1);
    expect(result.counts?.expired).toBe(0);
  });

  it('expires a ready pickup and promotes the next queued hold when a copy is available', async () => {
    tenantFindMany.mockResolvedValue([
      {
        id: 't-1',
        slug: 'acme',
        dbUrl: 'postgresql://libriant:s3cr3t@postgres:5432/tenant_t_1',
        storageUrl: '',
        dbCredentials: testSealedCredential('t-1'),
        defaultLocale: 'en',
        status: 'active',
        name: 'Acme',
        customSubdomain: null,
        tags: [],
      },
    ]);
    const past = new Date(Date.now() - 60_000);
    const reservations = [
      {
        id: 'r-1',
        bookId: 'b-1',
        status: 'ready',
        expiresAt: past,
        queuePosition: null,
        fulfilledByCopyId: 'c-1',
        readyAt: past,
      },
      {
        id: 'r-2',
        bookId: 'b-1',
        status: 'queued',
        expiresAt: null,
        queuePosition: 1,
        fulfilledByCopyId: null,
        readyAt: null,
      },
    ];
    // A 'ready' hold's copy is 'reserved' (held for pickup), not 'on_loan'.
    const copies = [
      { id: 'c-1', bookId: 'b-1', status: 'reserved' },
      { id: 'c-2', bookId: 'b-1', status: 'available' },
    ];
    tenantGetClient.mockReturnValue(makeTenantClient(reservations, copies));

    const result = await sweepExpiredReservationPickups();

    expect(result.counts?.expired).toBe(1);
    expect(result.counts?.promoted).toBe(1);
    // r-1 → expired
    expect(reservations[0]!.status).toBe('expired');
    // r-2 promoted to ready — and readyAt MUST be set or the hold-ready
    // notification job will never email the patron.
    expect(reservations[1]!.status).toBe('ready');
    expect(reservations[1]!.readyAt).toBeInstanceOf(Date);
    // The just-freed c-1 gets snapped back up by the promotion (it
    // shows up in findFirst before c-2), and c-2 stays available
    // for the next library-side hold.
    expect(copies[0]!.status).toBe('reserved');
    expect(copies[1]!.status).toBe('available');
  });

  it('expires the pickup and frees its copy when nothing is queued (no promotion)', async () => {
    tenantFindMany.mockResolvedValue([
      {
        id: 't-1',
        slug: 'acme',
        dbUrl: 'postgresql://libriant:s3cr3t@postgres:5432/tenant_t_1',
        storageUrl: '',
        dbCredentials: testSealedCredential('t-1'),
        defaultLocale: 'en',
        status: 'active',
        name: 'Acme',
        customSubdomain: null,
        tags: [],
      },
    ]);
    const past = new Date(Date.now() - 60_000);
    const reservations = [
      {
        id: 'r-1',
        bookId: 'b-1',
        status: 'ready',
        expiresAt: past,
        queuePosition: null,
        fulfilledByCopyId: 'c-1',
      },
    ];
    // The held copy is 'reserved'; with no one queued it should be freed to
    // 'available' and nothing promoted.
    const copies = [{ id: 'c-1', bookId: 'b-1', status: 'reserved' }];
    tenantGetClient.mockReturnValue(makeTenantClient(reservations, copies));

    const result = await sweepExpiredReservationPickups();

    expect(result.counts?.expired).toBe(1);
    // Nothing queued → no promotion; the held copy is released to available.
    expect(result.counts?.promoted).toBe(0);
    expect(copies[0]!.status).toBe('available');
  });

  it('counts a per-reservation failure instead of reporting a clean sweep', async () => {
    // reliability-07, one level down: the per-reservation `catch` only emitted
    // a logger.warn, so a tenant in which EVERY expiry transaction threw
    // returned `{expired: 0}` and the sweep said "1 tenant(s) scanned; no
    // pickups to expire" — green, forever. `rowsFailed` is a `…Failed` key, so
    // the runner now marks the run not-ok (scheduled-jobs.runner.ts).
    tenantFindMany.mockResolvedValue([
      {
        id: 't-1',
        slug: 'acme',
        dbUrl: 'postgresql://libriant:s3cr3t@postgres:5432/tenant_t_1',
        storageUrl: '',
        dbCredentials: testSealedCredential('t-1'),
        defaultLocale: 'en',
        status: 'active',
        name: 'Acme',
        customSubdomain: null,
        tags: [],
      },
    ]);
    const client = makeTenantClient(
      [
        {
          id: 'r-1',
          bookId: 'b-1',
          status: 'ready',
          expiresAt: new Date(Date.now() - 60_000),
          queuePosition: null,
          fulfilledByCopyId: 'c-1',
        },
        {
          id: 'r-2',
          bookId: 'b-2',
          status: 'ready',
          expiresAt: new Date(Date.now() - 60_000),
          queuePosition: null,
          fulfilledByCopyId: 'c-2',
        },
      ],
      [],
    );
    // Every expiry transaction dies — a deadlock storm, a lock timeout, a
    // CHECK the data violates.
    client.$transaction.mockRejectedValue(new Error('deadlock detected'));
    tenantGetClient.mockReturnValue(client);

    const result = await sweepExpiredReservationPickups();

    expect(result.counts?.expired).toBe(0);
    // The tenant itself did not blow up — only its rows did, which is exactly
    // the case the tenant-level counter cannot see.
    expect(result.counts?.tenantsFailed).toBe(0);
    expect(result.counts?.rowsFailed).toBe(2);
    expect(result.message).toContain('2 reservation(s) failed');
  });

  it('continues to the next tenant when one tenant blows up', async () => {
    tenantFindMany.mockResolvedValue([
      {
        id: 't-1',
        slug: 'broken',
        dbUrl: 'postgresql://libriant:s3cr3t@postgres:5432/tenant_t_1',
        storageUrl: '',
        dbCredentials: testSealedCredential('t-1'),
        defaultLocale: 'en',
        status: 'active',
        name: 'Broken',
        customSubdomain: null,
        tags: [],
      },
      {
        id: 't-2',
        slug: 'fine',
        dbUrl: 'postgresql://libriant:s3cr3t@postgres:5432/tenant_t_2',
        storageUrl: '',
        dbCredentials: testSealedCredential('t-2'),
        defaultLocale: 'en',
        status: 'active',
        name: 'Fine',
        customSubdomain: null,
        tags: [],
      },
    ]);
    tenantGetClient.mockImplementation((ctx: { id: string }) => {
      if (ctx.id === 't-1') throw new Error('connection refused');
      return makeTenantClient([], []);
    });

    const result = await sweepExpiredReservationPickups();

    expect(result.counts?.tenantsScanned).toBe(2);
    expect(result.counts?.tenantsFailed).toBe(1);
  });
});
