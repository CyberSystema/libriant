import { describe, expect, it, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { MembersService } from './members.service.js';
import { decodeCursor, encodeCursor } from '../platform/query.js';
import type { TenantContext } from '../tenancy/tenant-context.js';

const TENANT = { id: 't1', slug: 'acme' } as unknown as TenantContext;

const ROW = {
  id: 'm1',
  memberNumber: 'M-2026-0001',
  fullName: 'Ada Lovelace',
  sortName: 'lovelace ada',
  email: 'ada@example.com',
  phone: null,
  dateOfBirth: null,
  addressLine1: null,
  addressLine2: null,
  city: null,
  postalCode: null,
  country: null,
  photoAssetRef: null,
  status: 'active' as const,
  staffNotes: null,
  joinedAt: new Date('2026-01-01T00:00:00.000Z'),
  customFields: {},
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  archivedAt: null,
  erasedAt: null,
};

function makeSvc(memberRow: unknown) {
  const findFirst = vi.fn(async () => memberRow);
  const tenantPrisma = { getClient: () => ({ member: { findFirst } }) };
  // fieldDefs / quota / audit / storage aren't touched by getByMemberNumber.
  const svc = new MembersService(
    tenantPrisma as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  return { svc, findFirst };
}

describe('MembersService.getByMemberNumber', () => {
  it('resolves a membership number to the member (active only)', async () => {
    const { svc, findFirst } = makeSvc(ROW);
    const res = await svc.getByMemberNumber(TENANT, 'M-2026-0001');
    expect(res.id).toBe('m1');
    expect(res.memberNumber).toBe('M-2026-0001');
    expect(res.fullName).toBe('Ada Lovelace');
    expect(res.status).toBe('active');
    expect(findFirst).toHaveBeenCalledWith({
      where: { memberNumber: 'M-2026-0001', archivedAt: null },
    });
  });

  it('throws NotFound when no active member has that number', async () => {
    const { svc } = makeSvc(null);
    await expect(svc.getByMemberNumber(TENANT, 'M-NOPE')).rejects.toBeInstanceOf(NotFoundException);
  });
});

/**
 * performance-03 on the roster — the list a librarian pages deepest, and the
 * most expensive of the nine before this: at depth 100,000 the audited SQL
 * discarded 100,000 index entries and read 100,615 buffers to return 26 names.
 *
 * The walk that proves every member is visited once, in order, and the meter
 * that proves the deep page no longer reads the roster, are in
 * test/integration/list-pagination.spec.ts. These are the cursor boundaries.
 */
function listSvc(rows: (typeof ROW)[] = []) {
  const findMany = vi.fn(async (_args: Record<string, unknown>) => rows);
  const findUnique = vi.fn(async (_args: Record<string, unknown>) => null as unknown);
  const tenantPrisma = { getClient: () => ({ member: { findMany, findUnique } }) };
  const svc = new MembersService(
    tenantPrisma as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  return { svc, findMany, findUnique };
}

const whereOf = (findMany: ReturnType<typeof listSvc>['findMany']) =>
  findMany.mock.calls[0]![0].where as Record<string, unknown>;

const AFTER_LOVELACE = [
  { sortName: { gte: 'lovelace ada' } },
  {
    OR: [{ sortName: { gt: 'lovelace ada' } }, { sortName: 'lovelace ada', id: { gt: 'm1' } }],
  },
];

describe('MembersService.list — performance-03 keyset', () => {
  it('pages with no Prisma cursor and no skip', async () => {
    const { svc, findMany } = listSvc([ROW]);
    await svc.list(TENANT, { limit: 25 });
    const args = findMany.mock.calls[0]![0];
    expect(args.cursor).toBeUndefined();
    expect(args.skip).toBeUndefined();
    expect(args.orderBy).toEqual([{ sortName: 'asc' }, { id: 'asc' }]);
  });

  it('mints a cursor carrying both sort keys', async () => {
    const { svc } = listSvc([ROW, { ...ROW, id: 'm2' }, { ...ROW, id: 'm3' }]);
    const res = await svc.list(TENANT, { limit: 2 });
    expect(res.items.map((m) => m.id)).toEqual(['m1', 'm2']);
    expect(decodeCursor(res.nextCursor!, 2)).toEqual(['lovelace ada', 'm2']);
  });

  it('turns that cursor into a gte start key plus the exact tie boundary', async () => {
    // The tie tier is not decoration on this list: two patrons with the same
    // name is ordinary in a Greek roster, and `gte` alone would show the
    // earlier ones again on every page boundary.
    const { svc, findMany } = listSvc();
    await svc.list(TENANT, { after: encodeCursor(['lovelace ada', 'm1']) });
    expect(whereOf(findMany).AND).toEqual(AFTER_LOVELACE);
  });

  it('still accepts a bare member id, the way the cursor used to look', async () => {
    const { svc, findMany, findUnique } = listSvc();
    findUnique.mockResolvedValue({ sortName: 'lovelace ada', id: 'm1' });
    await svc.list(TENANT, { after: 'm1' });
    expect(findUnique).toHaveBeenCalledWith({
      where: { id: 'm1' },
      select: { sortName: true, id: true },
    });
    expect(whereOf(findMany).AND).toEqual(AFTER_LOVELACE);
  });

  it('keeps the status and archived filters alongside the keyset', async () => {
    // The keyset lives in `where.AND`; the filters stay on `where` itself. If
    // one clobbered the other, paging past the first screen of "suspended
    // members" would quietly start listing everybody.
    const { svc, findMany } = listSvc();
    await svc.list(TENANT, {
      status: 'suspended',
      after: encodeCursor(['lovelace ada', 'm1']),
    });
    const where = whereOf(findMany);
    expect(where.status).toBe('suspended');
    expect(where.archivedAt).toBeNull();
    expect(where.AND).toEqual(AFTER_LOVELACE);
  });
});
