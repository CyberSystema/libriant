import { describe, expect, it, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { MembersService } from './members.service.js';
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
