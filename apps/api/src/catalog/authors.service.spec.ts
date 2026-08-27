import { describe, expect, it, vi } from 'vitest';
import { AuthorsService } from './authors.service.js';
import { decodeCursor, encodeCursor } from '../platform/query.js';
import type { TenantContext } from '../tenancy/tenant-context.js';

/**
 * `AuthorsService.list` got the performance-03 keyset in the previous wave with
 * NO test of any kind — there was no spec file for this service at all, and
 * test/integration/list-pagination.spec.ts walked only books and holds. A
 * boundary bug in the author keyset (a `gt` where a `gte` belongs, the tie tier
 * reversed, the cursor built from the wrong row) drops or repeats a name in the
 * middle of the author picker and nothing would have caught it.
 *
 * These are the boundary cases; the end-to-end walk that proves the whole list
 * is visited exactly once, in order, over the real HTTP route lives in
 * test/integration/list-pagination.spec.ts.
 */

const TENANT = { id: 't1', slug: 'acme' } as unknown as TenantContext;

function row(over: Partial<{ id: string; sortName: string }> = {}) {
  return {
    id: 'a1',
    fullName: 'Καζαντζάκης Νίκος',
    sortName: 'καζαντζακης νικος',
    isOrganization: false,
    birthYear: null,
    deathYear: null,
    notes: null,
    customFields: {},
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    archivedAt: null,
    ...over,
  };
}

function svc(rows: ReturnType<typeof row>[]) {
  const findMany = vi.fn(async (_args: Record<string, unknown>) => rows);
  const findUnique = vi.fn(async (_args: Record<string, unknown>) => null as unknown);
  const tenantPrisma = { getClient: () => ({ author: { findMany, findUnique } }) };
  return { svc: new AuthorsService(tenantPrisma as never), findMany, findUnique };
}

describe('AuthorsService.list — performance-03 keyset', () => {
  it('pages with no cursor and no skip at all', async () => {
    const { svc: s, findMany } = svc([row()]);
    const res = await s.list(TENANT, { limit: 25 });
    const args = findMany.mock.calls[0]![0];
    // The whole point of the finding: Prisma's `cursor` renders as an OR of
    // correlated subselects the planner cannot enter `authors_sortName_idx`
    // with, so neither key may appear here again.
    expect(args.cursor).toBeUndefined();
    expect(args.skip).toBeUndefined();
    expect(args.orderBy).toEqual([{ sortName: 'asc' }, { id: 'asc' }]);
    expect(args.take).toBe(26);
    expect(res.nextCursor).toBeNull();
  });

  it('mints a cursor from the LAST row of the page, carrying both sort keys', async () => {
    // limit 2 → the service asks for 3; 3 come back ⇒ there is another page,
    // and the cursor must describe row 2, not row 3.
    const { svc: s } = svc([
      row({ id: 'a1', sortName: 'alpha' }),
      row({ id: 'a2', sortName: 'beta' }),
      row({ id: 'a3', sortName: 'gamma' }),
    ]);
    const res = await s.list(TENANT, { limit: 2 });
    expect(res.items.map((a) => a.id)).toEqual(['a1', 'a2']);
    expect(decodeCursor(res.nextCursor!, 2)).toEqual(['beta', 'a2']);
  });

  it('turns that cursor into a gte start key plus the exact tie boundary', async () => {
    const { svc: s, findMany } = svc([]);
    await s.list(TENANT, { after: encodeCursor(['beta', 'a2']) });
    const where = findMany.mock.calls[0]![0].where as Record<string, unknown>;
    expect(where.AND).toEqual([
      // The start key. `gte` and not `gt`, because the authors who TIE on
      // `beta` are still ahead of us — the OR below is what excludes the ones
      // already shown.
      { sortName: { gte: 'beta' } },
      { OR: [{ sortName: { gt: 'beta' } }, { sortName: 'beta', id: { gt: 'a2' } }] },
    ]);
  });

  it('still accepts a bare author id, the way the cursor used to look', async () => {
    // A librarian mid-scroll across a deploy hands back the old shape.
    const { svc: s, findMany, findUnique } = svc([]);
    findUnique.mockResolvedValue({ sortName: 'beta', id: 'a2' });
    await s.list(TENANT, { after: 'a2' });
    expect(findUnique).toHaveBeenCalledWith({
      where: { id: 'a2' },
      select: { sortName: true, id: true },
    });
    const where = findMany.mock.calls[0]![0].where as Record<string, unknown>;
    expect(where.AND).toEqual([
      { sortName: { gte: 'beta' } },
      { OR: [{ sortName: { gt: 'beta' } }, { sortName: 'beta', id: { gt: 'a2' } }] },
    ]);
  });

  it('restarts at page 1 when the cursor row has since been deleted', async () => {
    const { svc: s, findMany, findUnique } = svc([]);
    findUnique.mockResolvedValue(null);
    await s.list(TENANT, { after: 'gone' });
    const where = findMany.mock.calls[0]![0].where as Record<string, unknown>;
    expect(where.AND).toBeUndefined();
  });

  it('rejects a cursor minted for a different list rather than reading it into the wrong column', async () => {
    // A reservations cursor is a 4-tuple. Destructured here it would produce a
    // `sortName >= 'queued'` and silently start the author list in the wrong
    // place; `decodeCursor`'s arity check sends it down the id path instead,
    // which finds no such author and restarts at page 1.
    const { svc: s, findMany, findUnique } = svc([]);
    findUnique.mockResolvedValue(null);
    await s.list(TENANT, { after: encodeCursor(['queued', 1, '2026-01-01', 'r1']) });
    const where = findMany.mock.calls[0]![0].where as Record<string, unknown>;
    expect(where.AND).toBeUndefined();
  });

  it('answers a too-short search without querying at all (performance-12)', async () => {
    const { svc: s, findMany } = svc([row()]);
    const res = await s.list(TENANT, { q: 'κα' });
    expect(res.items).toEqual([]);
    expect(res.minQueryChars).toBe(3);
    expect(findMany).not.toHaveBeenCalled();
  });
});
