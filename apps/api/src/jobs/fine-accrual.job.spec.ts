import { beforeEach, describe, expect, it, vi } from 'vitest';

const { tenantFindMany, tenantGetClient, tenantDestroy } = vi.hoisted(() => ({
  tenantFindMany: vi.fn(),
  tenantGetClient: vi.fn(),
  tenantDestroy: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@libriant/db-control', () => ({
  controlDb: { tenant: { findMany: tenantFindMany } },
}));
vi.mock('../config/env.js', () => ({
  loadEnv: () => ({ tenantClientCacheSize: 10, tenantClientIdleMs: 60_000 }),
}));
vi.mock('../tenancy/tenant-prisma.service.js', () => ({
  TenantPrismaService: vi.fn(function () {
    return { getClient: tenantGetClient, onModuleDestroy: tenantDestroy };
  }),
}));

import { sweepFineAccrual } from './fine-accrual.job.js';

type Fine = { id: string; loanId: string; amountCents: number; status: string; reason: string };

function makeClient(opts: {
  settings: {
    overdueFinesEnabled: boolean;
    finePerDayCents: number;
    fineCapCents: number;
    currency: string;
  } | null;
  loans: Array<{ id: string; memberId: string; dueAt: Date }>;
  fines?: Fine[];
}) {
  const fines: Fine[] = opts.fines ?? [];
  let seq = fines.length;
  const created: Fine[] = [];
  const updated: Array<{ id: string; amountCents: number }> = [];
  const client = {
    tenantSetting: { findUnique: vi.fn(async () => opts.settings) },
    loan: {
      findMany: vi.fn(async () => opts.loans),
      // Accrual re-reads the loan to skip ones a return just closed; all
      // fixture loans are active overdue.
      findUnique: vi.fn(async (args: { where: { id: string } }) =>
        opts.loans.find((l) => l.id === args.where.id) ? { status: 'active' } : null,
      ),
    },
    fine: {
      findFirst: vi.fn(
        async (args: { where: { loanId: string; status: string } }) =>
          fines.find((f) => f.loanId === args.where.loanId && f.status === args.where.status) ??
          null,
      ),
      create: vi.fn(
        async (args: { data: { loanId: string; amountCents: number; reason: string } }) => {
          const f: Fine = {
            id: `fine-${++seq}`,
            loanId: args.data.loanId,
            amountCents: args.data.amountCents,
            status: 'outstanding',
            reason: args.data.reason,
          };
          fines.push(f);
          created.push(f);
          return f;
        },
      ),
      updateMany: vi.fn(
        async (args: { where: { id: string; status?: string }; data: { amountCents: number } }) => {
          let count = 0;
          for (const f of fines) {
            if (f.id === args.where.id && (!args.where.status || f.status === args.where.status)) {
              f.amountCents = args.data.amountCents;
              updated.push({ id: f.id, amountCents: args.data.amountCents });
              count++;
            }
          }
          return { count };
        },
      ),
    },
  };
  return { client, created, updated };
}

const TENANT = {
  id: 't1',
  slug: 'acme',
  name: 'Acme',
  defaultLocale: 'el',
  status: 'active',
  dbUrl: 'x',
  storageUrl: 'y',
  customSubdomain: null,
  tags: [],
};
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);

describe('sweepFineAccrual', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tenantFindMany.mockResolvedValue([TENANT]);
  });

  it('opens an outstanding fine for an overdue active loan', async () => {
    const { client, created } = makeClient({
      settings: {
        overdueFinesEnabled: true,
        finePerDayCents: 10,
        fineCapCents: 0,
        currency: 'EUR',
      },
      loans: [{ id: 'loan-1', memberId: 'm1', dueAt: daysAgo(5) }],
    });
    tenantGetClient.mockReturnValue(client);
    await sweepFineAccrual();
    expect(created).toHaveLength(1);
    expect(created[0]!.amountCents).toBe(50); // 5 days × 10
  });

  it('caps the fine at fineCapCents', async () => {
    const { client, created } = makeClient({
      settings: {
        overdueFinesEnabled: true,
        finePerDayCents: 10,
        fineCapCents: 70,
        currency: 'EUR',
      },
      loans: [{ id: 'loan-1', memberId: 'm1', dueAt: daysAgo(10) }],
    });
    tenantGetClient.mockReturnValue(client);
    await sweepFineAccrual();
    expect(created[0]!.amountCents).toBe(70); // 100 capped to 70
  });

  it('grows an existing outstanding fine, not a duplicate', async () => {
    const { client, created, updated } = makeClient({
      settings: {
        overdueFinesEnabled: true,
        finePerDayCents: 10,
        fineCapCents: 0,
        currency: 'EUR',
      },
      loans: [{ id: 'loan-1', memberId: 'm1', dueAt: daysAgo(5) }],
      fines: [
        {
          id: 'fine-1',
          loanId: 'loan-1',
          amountCents: 30,
          status: 'outstanding',
          reason: '3 day(s) overdue',
        },
      ],
    });
    tenantGetClient.mockReturnValue(client);
    await sweepFineAccrual();
    expect(created).toHaveLength(0);
    expect(updated).toEqual([{ id: 'fine-1', amountCents: 50 }]);
  });

  it('skips libraries that do not charge overdue fines', async () => {
    const { client, created } = makeClient({
      settings: { overdueFinesEnabled: true, finePerDayCents: 0, fineCapCents: 0, currency: 'EUR' },
      loans: [{ id: 'loan-1', memberId: 'm1', dueAt: daysAgo(5) }],
    });
    tenantGetClient.mockReturnValue(client);
    await sweepFineAccrual();
    expect(created).toHaveLength(0);
    expect(client.loan.findMany).not.toHaveBeenCalled();
  });

  it('skips libraries with overdue fines switched off, even with a rate set', async () => {
    const { client, created } = makeClient({
      settings: {
        overdueFinesEnabled: false,
        finePerDayCents: 10,
        fineCapCents: 0,
        currency: 'EUR',
      },
      loans: [{ id: 'loan-1', memberId: 'm1', dueAt: daysAgo(5) }],
    });
    tenantGetClient.mockReturnValue(client);
    await sweepFineAccrual();
    expect(created).toHaveLength(0);
    expect(client.loan.findMany).not.toHaveBeenCalled();
  });
});
