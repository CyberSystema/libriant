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
  controlDb: { tenant: { findMany: tenantFindMany } },
}));
vi.mock('../config/env.js', () => ({
  loadEnv: () => ({
    tenantClientCacheSize: 10,
    tenantClientIdleMs: 60_000,
    ...TEST_TENANT_DB_ENV,
  }),
}));
vi.mock('../tenancy/tenant-prisma.service.js', () => ({
  TenantPrismaService: vi.fn(function () {
    return { getClient: tenantGetClient, onModuleDestroy: tenantDestroy };
  }),
}));
import {
  TEST_TENANT_DB_ENV,
  testSealedCredential,
} from '../tenancy/__fixtures__/tenant-credential.js';

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
  // performance-08 turned the sweep's per-row work into set operations: the
  // overdue page is a keyset $queryRaw, and the amount changes go out as one
  // `UPDATE … FROM unnest(...)`. The fake therefore has to answer those two,
  // and it reads the REAL bound parameters off the Prisma.Sql object rather
  // than re-deriving them, so a bug in what the job binds still shows up here.
  const overduePages = vi.fn(async () => opts.loans);
  const batchUpdate = vi.fn(async (sql: { values: readonly unknown[] }) => {
    const [, ids, amounts] = sql.values as [Date, string[], number[], string[]];
    let count = 0;
    for (let i = 0; i < ids.length; i++) {
      const f = fines.find((x) => x.id === ids[i] && x.status === 'outstanding');
      if (!f) continue; // the status guard in the SQL
      f.amountCents = amounts[i]!;
      updated.push({ id: f.id, amountCents: amounts[i]! });
      count++;
    }
    return count;
  });
  const client = {
    $queryRaw: overduePages,
    $executeRaw: batchUpdate,
    tenantSetting: { findUnique: vi.fn(async () => opts.settings) },
    loan: {
      // Accrual re-reads the page's loans to skip ones a return just closed;
      // all fixture loans are active overdue.
      findMany: vi.fn(async (args: { where: { id: { in: string[] } } }) =>
        opts.loans.filter((l) => args.where.id.in.includes(l.id)).map((l) => ({ id: l.id })),
      ),
    },
    fine: {
      // What each loan has already paid/waived — the sweep nets this off the
      // running total so a settled fine can't be resurrected the next night.
      groupBy: vi.fn(async () => {
        const byLoan = new Map<string, number>();
        for (const f of fines) {
          if (f.status !== 'paid' && f.status !== 'waived') continue;
          byLoan.set(f.loanId, (byLoan.get(f.loanId) ?? 0) + f.amountCents);
        }
        return [...byLoan].map(([loanId, sum]) => ({
          loanId,
          _sum: { amountCents: sum },
        }));
      }),
      findMany: vi.fn(async (args: { where: { loanId: { in: string[] }; status: string } }) =>
        fines
          .filter((f) => args.where.loanId.in.includes(f.loanId) && f.status === args.where.status)
          .map((f) => ({ id: f.id, loanId: f.loanId, amountCents: f.amountCents })),
      ),
      createMany: vi.fn(
        async (args: { data: Array<{ loanId: string; amountCents: number; reason: string }> }) => {
          let count = 0;
          for (const d of args.data) {
            // `skipDuplicates` against fines_one_outstanding_per_loan.
            if (fines.some((f) => f.loanId === d.loanId && f.status === 'outstanding')) continue;
            const f: Fine = {
              id: `fine-${++seq}`,
              loanId: d.loanId,
              amountCents: d.amountCents,
              status: 'outstanding',
              reason: d.reason,
            };
            fines.push(f);
            created.push(f);
            count++;
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
  // A real-shaped ADMIN url: `runtimeDbUrl` composes the tenant's own
  // credential onto this endpoint, so 'x' is no longer parseable input.
  dbUrl: 'postgresql://libriant:s3cr3t@postgres:5432/tenant_t1',
  storageUrl: 'y',
  customSubdomain: null,
  tags: [],
  dbCredentials: testSealedCredential('t1'),
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

  it('does not resurrect a fine that was written off while the book is still out', async () => {
    // The gap this closes: a librarian voids a fine raised in error on an
    // ACTIVE loan. There is no outstanding row left, so the old sweep saw a
    // bare overdue loan, recomputed the whole running total and re-billed it —
    // the write-off lasted until the next 03:00 run.
    const { client, created } = makeClient({
      settings: {
        overdueFinesEnabled: true,
        finePerDayCents: 10,
        fineCapCents: 0,
        currency: 'EUR',
      },
      loans: [{ id: 'loan-1', memberId: 'm1', dueAt: daysAgo(5) }],
      fines: [
        { id: 'fine-1', loanId: 'loan-1', amountCents: 50, status: 'waived', reason: 'error' },
      ],
    });
    tenantGetClient.mockReturnValue(client);
    await sweepFineAccrual();
    expect(created).toHaveLength(0);
  });

  it('bills only the days accrued since a payment, never the ones already paid', async () => {
    // Paid €0.30 for three days overdue on Monday; the book is still out and by
    // Thursday five days have accrued. The member owes the two NEW days, not
    // five days all over again.
    const { client, created } = makeClient({
      settings: {
        overdueFinesEnabled: true,
        finePerDayCents: 10,
        fineCapCents: 0,
        currency: 'EUR',
      },
      loans: [{ id: 'loan-1', memberId: 'm1', dueAt: daysAgo(5) }],
      fines: [
        { id: 'fine-1', loanId: 'loan-1', amountCents: 30, status: 'paid', reason: '3 day(s)' },
      ],
    });
    tenantGetClient.mockReturnValue(client);
    await sweepFineAccrual();
    expect(created).toHaveLength(1);
    expect(created[0]!.amountCents).toBe(20); // 50 accrued − 30 already paid
  });

  it('skips libraries that do not charge overdue fines', async () => {
    const { client, created } = makeClient({
      settings: { overdueFinesEnabled: true, finePerDayCents: 0, fineCapCents: 0, currency: 'EUR' },
      loans: [{ id: 'loan-1', memberId: 'm1', dueAt: daysAgo(5) }],
    });
    tenantGetClient.mockReturnValue(client);
    await sweepFineAccrual();
    expect(created).toHaveLength(0);
    // The scan itself must not happen — that is the whole point of the early
    // return. `$queryRaw` is the overdue page query since performance-08.
    expect(client.$queryRaw).not.toHaveBeenCalled();
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
    expect(client.$queryRaw).not.toHaveBeenCalled();
  });
});
