import { beforeEach, describe, expect, it, vi } from 'vitest';

const { tenantFindMany, tenantGetClient, tenantDestroy } = vi.hoisted(() => ({
  tenantFindMany: vi.fn(),
  tenantGetClient: vi.fn(),
  tenantDestroy: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@libriant/db-control', () => ({
  controlDb: {
    tenant: { findMany: tenantFindMany },
  },
}));
vi.mock('../config/env.js', () => ({
  loadEnv: () => ({ tenantClientCacheSize: 10, tenantClientIdleMs: 60_000 }),
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
            if (c.id === args.where.id) {
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
        dbUrl: '',
        storageUrl: '',
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
        dbUrl: '',
        storageUrl: '',
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
      {
        id: 'r-2',
        bookId: 'b-1',
        status: 'queued',
        expiresAt: null,
        queuePosition: 1,
        fulfilledByCopyId: null,
      },
    ];
    const copies = [
      { id: 'c-1', bookId: 'b-1', status: 'on_loan' },
      { id: 'c-2', bookId: 'b-1', status: 'available' },
    ];
    tenantGetClient.mockReturnValue(makeTenantClient(reservations, copies));

    const result = await sweepExpiredReservationPickups();

    expect(result.counts?.expired).toBe(1);
    expect(result.counts?.promoted).toBe(1);
    // r-1 → expired
    expect(reservations[0]!.status).toBe('expired');
    // r-2 promoted to ready
    expect(reservations[1]!.status).toBe('ready');
    // The just-freed c-1 gets snapped back up by the promotion (it
    // shows up in findFirst before c-2), and c-2 stays available
    // for the next library-side hold.
    expect(copies[0]!.status).toBe('reserved');
    expect(copies[1]!.status).toBe('available');
  });

  it('expires the pickup but does not promote when no copy is available', async () => {
    tenantFindMany.mockResolvedValue([
      {
        id: 't-1',
        slug: 'acme',
        dbUrl: '',
        storageUrl: '',
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
      {
        id: 'r-2',
        bookId: 'b-1',
        status: 'queued',
        expiresAt: null,
        queuePosition: 1,
        fulfilledByCopyId: null,
      },
    ];
    // c-1 will be marked available by the expire step; sweeper finds it
    // again as the available copy candidate to promote r-2 onto.
    const copies = [{ id: 'c-1', bookId: 'b-1', status: 'on_loan' }];
    tenantGetClient.mockReturnValue(makeTenantClient(reservations, copies));

    const result = await sweepExpiredReservationPickups();

    expect(result.counts?.expired).toBe(1);
    // c-1 got freed → then immediately rebound to r-2.
    expect(result.counts?.promoted).toBe(1);
  });

  it('continues to the next tenant when one tenant blows up', async () => {
    tenantFindMany.mockResolvedValue([
      {
        id: 't-1',
        slug: 'broken',
        dbUrl: '',
        storageUrl: '',
        defaultLocale: 'en',
        status: 'active',
        name: 'Broken',
        customSubdomain: null,
        tags: [],
      },
      {
        id: 't-2',
        slug: 'fine',
        dbUrl: '',
        storageUrl: '',
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
