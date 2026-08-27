import { describe, expect, it, vi } from 'vitest';
import { FinesService } from './fines.service.js';
import { decodeCursor, encodeCursor } from '../platform/query.js';
import type { TenantContext } from '../tenancy/tenant-context.js';

/**
 * performance-03 on the fines ledger.
 *
 * The end-to-end walk and the page-one cost meter live in
 * test/integration/list-pagination.spec.ts. These are the cursor boundaries:
 * what the token carries, what predicate it becomes, and the two ways it can
 * arrive malformed — a bare id from before the format changed, and an
 * unparseable timestamp, which must NOT reach Prisma as `Invalid Date` and
 * silently empty a librarian's ledger.
 */

const TENANT = { id: 't1', slug: 'acme' } as unknown as TenantContext;
const CREATED = new Date('2026-05-01T09:00:00.000Z');

function row(over: Partial<{ id: string; createdAt: Date }> = {}) {
  return {
    id: 'f1',
    memberId: 'm1',
    loanId: null,
    amountCents: 240,
    currency: 'EUR',
    reason: 'overdue',
    status: 'outstanding' as const,
    paidAt: null,
    resolvedByUserId: null,
    notes: null,
    customFields: {},
    createdAt: CREATED,
    updatedAt: CREATED,
    archivedAt: null,
    member: { id: 'm1', memberNumber: 'M-1', fullName: 'Ada', status: 'active' as const },
    loan: null,
    ...over,
  };
}

function svc(rows: ReturnType<typeof row>[] = []) {
  const findMany = vi.fn(async (_args: Record<string, unknown>) => rows);
  const findUnique = vi.fn(async (_args: Record<string, unknown>) => null as unknown);
  const aggregate = vi.fn(async () => ({ _sum: { amountCents: 0 }, _count: 0 }));
  const tenantPrisma = {
    getClient: () => ({
      fine: { findMany, findUnique, aggregate },
      tenantSetting: { findUnique: async () => ({ currency: 'EUR' }) },
    }),
  };
  return {
    svc: new FinesService(tenantPrisma as never, {} as never),
    findMany,
    findUnique,
  };
}

const whereOf = (findMany: ReturnType<typeof svc>['findMany']) =>
  findMany.mock.calls[0]![0].where as Record<string, unknown>;

const AFTER_CREATED = [
  { createdAt: { lte: CREATED } },
  { OR: [{ createdAt: { lt: CREATED } }, { createdAt: CREATED, id: { lt: 'f2' } }] },
];

describe('FinesService.list — performance-03 keyset', () => {
  it('pages with no Prisma cursor and no skip', async () => {
    const { svc: s, findMany } = svc([row()]);
    await s.list(TENANT, { limit: 25 });
    const args = findMany.mock.calls[0]![0];
    expect(args.cursor).toBeUndefined();
    expect(args.skip).toBeUndefined();
    expect(args.orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
  });

  it('mints a cursor carrying both sort keys', async () => {
    const { svc: s } = svc([row({ id: 'f1' }), row({ id: 'f2' }), row({ id: 'f3' })]);
    const res = await s.list(TENANT, { limit: 2 });
    expect(res.items.map((f) => f.id)).toEqual(['f1', 'f2']);
    expect(decodeCursor(res.nextCursor!, 2)).toEqual([CREATED.toISOString(), 'f2']);
  });

  it('turns that cursor into a lte start key plus the exact tie boundary', async () => {
    const { svc: s, findMany } = svc();
    await s.list(TENANT, { after: encodeCursor([CREATED.toISOString(), 'f2']) });
    expect(whereOf(findMany).AND).toEqual(AFTER_CREATED);
  });

  it('still accepts a bare fine id, the way the cursor used to look', async () => {
    const { svc: s, findMany, findUnique } = svc();
    findUnique.mockResolvedValue({ createdAt: CREATED, id: 'f2' });
    await s.list(TENANT, { after: 'f2' });
    expect(findUnique).toHaveBeenCalledWith({
      where: { id: 'f2' },
      select: { createdAt: true, id: true },
    });
    expect(whereOf(findMany).AND).toEqual(AFTER_CREATED);
  });

  it('restarts at page 1 rather than emptying the ledger on a corrupt timestamp', async () => {
    const { svc: s, findMany, findUnique } = svc();
    await s.list(TENANT, { after: encodeCursor(['not-a-date', 'f2']) });
    expect(whereOf(findMany).AND).toBeUndefined();
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('keeps the member and status filters alongside the keyset', async () => {
    // The keyset lives in `where.AND`; the filters stay on `where` itself. If
    // one overwrote the other a librarian would page one member's fines and be
    // shown the whole library's.
    const { svc: s, findMany } = svc();
    await s.list(TENANT, {
      memberId: 'm1',
      status: 'outstanding',
      after: encodeCursor([CREATED.toISOString(), 'f2']),
    });
    const where = whereOf(findMany);
    expect(where.memberId).toBe('m1');
    expect(where.status).toBe('outstanding');
    expect(where.AND).toEqual(AFTER_CREATED);
  });
});
