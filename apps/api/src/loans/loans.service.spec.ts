import { describe, expect, it, vi } from 'vitest';
import { LoansService } from './loans.service.js';
import { decodeCursor, encodeCursor } from '../platform/query.js';
import type { TenantContext } from '../tenancy/tenant-context.js';

/**
 * performance-03 on the circulation list.
 *
 * The end-to-end walk (test/integration/list-pagination.spec.ts) proves the
 * keyset visits every loan once, in order, over the real route. What it cannot
 * easily reach is the case that makes THIS list different from the other eight:
 * it has TWO sort orders — `loanedAt DESC` normally, `dueAt ASC` for the
 * overdue tile — and a librarian who ticks "overdue only" mid-scroll hands back
 * a cursor minted under the other one.
 */

const TENANT = { id: 't1', slug: 'acme' } as unknown as TenantContext;

const LOANED = new Date('2026-05-01T09:00:00.000Z');
const DUE = new Date('2026-05-15T09:00:00.000Z');

function row(over: Partial<{ id: string; loanedAt: Date; dueAt: Date }> = {}) {
  return {
    id: 'l1',
    copyId: 'c1',
    memberId: 'm1',
    loanedAt: LOANED,
    dueAt: DUE,
    returnedAt: null,
    renewedCount: 0,
    status: 'active' as const,
    notes: null,
    checkedOutByUserId: null,
    returnedByUserId: null,
    customFields: {},
    createdAt: LOANED,
    updatedAt: LOANED,
    member: { id: 'm1', memberNumber: 'M-1', fullName: 'Ada', status: 'active' as const },
    copy: { id: 'c1', barcode: 'B1', status: 'on_loan' as const, book: { id: 'b1', title: 'T' } },
    fines: [],
    ...over,
  };
}

function svc(rows: ReturnType<typeof row>[] = []) {
  const findMany = vi.fn(async (_args: Record<string, unknown>) => rows);
  const findUnique = vi.fn(async (_args: Record<string, unknown>) => null as unknown);
  const tenantPrisma = { getClient: () => ({ loan: { findMany, findUnique } }) };
  return {
    svc: new LoansService(tenantPrisma as never, {} as never, {} as never),
    findMany,
    findUnique,
  };
}

const whereOf = (findMany: ReturnType<typeof svc>['findMany']) =>
  findMany.mock.calls[0]![0].where as Record<string, unknown>;

describe('LoansService.list — performance-03 keyset', () => {
  it('pages with no Prisma cursor and no skip', async () => {
    const { svc: s, findMany } = svc([row()]);
    await s.list(TENANT, { limit: 25 });
    const args = findMany.mock.calls[0]![0];
    expect(args.cursor).toBeUndefined();
    expect(args.skip).toBeUndefined();
    expect(args.orderBy).toEqual([{ loanedAt: 'desc' }, { id: 'desc' }]);
  });

  it('mints a cursor naming the sort key it was built under', async () => {
    const { svc: s } = svc([row({ id: 'l1' }), row({ id: 'l2' }), row({ id: 'l3' })]);
    const res = await s.list(TENANT, { limit: 2 });
    expect(res.items.map((l) => l.id)).toEqual(['l1', 'l2']);
    expect(decodeCursor(res.nextCursor!, 3)).toEqual(['loanedAt', LOANED.toISOString(), 'l2']);
  });

  it('reads the overdue tile in dueAt order and mints a dueAt cursor', async () => {
    const { svc: s, findMany } = svc([row({ id: 'l1' }), row({ id: 'l2' }), row({ id: 'l3' })]);
    const res = await s.list(TENANT, { limit: 2, overdue: true });
    expect(findMany.mock.calls[0]![0].orderBy).toEqual([{ dueAt: 'asc' }, { id: 'asc' }]);
    expect(decodeCursor(res.nextCursor!, 3)).toEqual(['dueAt', DUE.toISOString(), 'l2']);
  });

  it('walks BACKWARDS in time on the default list and forwards on the overdue tile', async () => {
    const { svc: a, findMany: newestFirst } = svc();
    await a.list(TENANT, { after: encodeCursor(['loanedAt', LOANED.toISOString(), 'l2']) });
    expect(whereOf(newestFirst).AND).toEqual([
      { loanedAt: { lte: LOANED } },
      { OR: [{ loanedAt: { lt: LOANED } }, { loanedAt: LOANED, id: { lt: 'l2' } }] },
    ]);

    const { svc: b, findMany: mostOverdueFirst } = svc();
    await b.list(TENANT, {
      overdue: true,
      after: encodeCursor(['dueAt', DUE.toISOString(), 'l2']),
    });
    expect(whereOf(mostOverdueFirst).AND).toEqual([
      { dueAt: { gte: DUE } },
      { OR: [{ dueAt: { gt: DUE } }, { dueAt: DUE, id: { gt: 'l2' } }] },
    ]);
  });

  it('re-reads the row when the reader switches sort mid-scroll', async () => {
    // THE case this list has and the others do not. The token says `loanedAt`;
    // the request is the overdue tile, which sorts by `dueAt`. Reading the
    // token's timestamp as a `dueAt` would drop the librarian somewhere
    // arbitrary in the overdue backlog — quietly, with a plausible-looking
    // page. The row is re-read by id instead, and the predicate is built from
    // its real `dueAt`.
    const { svc: s, findMany, findUnique } = svc();
    findUnique.mockResolvedValue({ loanedAt: LOANED, dueAt: DUE, id: 'l2' });
    await s.list(TENANT, {
      overdue: true,
      after: encodeCursor(['loanedAt', LOANED.toISOString(), 'l2']),
    });
    expect(findUnique).toHaveBeenCalledWith({
      where: { id: 'l2' },
      select: { loanedAt: true, dueAt: true, id: true },
    });
    expect(whereOf(findMany).AND).toEqual([
      { dueAt: { gte: DUE } },
      { OR: [{ dueAt: { gt: DUE } }, { dueAt: DUE, id: { gt: 'l2' } }] },
    ]);
  });

  it('still accepts a bare loan id, the way the cursor used to look', async () => {
    const { svc: s, findMany, findUnique } = svc();
    findUnique.mockResolvedValue({ loanedAt: LOANED, dueAt: DUE, id: 'l2' });
    await s.list(TENANT, { after: 'l2' });
    expect(whereOf(findMany).AND).toEqual([
      { loanedAt: { lte: LOANED } },
      { OR: [{ loanedAt: { lt: LOANED } }, { loanedAt: LOANED, id: { lt: 'l2' } }] },
    ]);
  });

  it('restarts at page 1 when the cursor row has since been deleted', async () => {
    const { svc: s, findMany, findUnique } = svc();
    findUnique.mockResolvedValue(null);
    await s.list(TENANT, { after: 'gone' });
    expect(whereOf(findMany).AND).toBeUndefined();
  });
});
