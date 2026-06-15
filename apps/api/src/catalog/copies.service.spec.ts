import { describe, expect, it, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { CopiesService } from './copies.service.js';
import type { TenantContext } from '../tenancy/tenant-context.js';

const TENANT = { id: 't1', slug: 'acme' } as unknown as TenantContext;

function makeSvc(copyRow: unknown) {
  const findFirst = vi.fn(async () => copyRow);
  const tenantPrisma = { getClient: () => ({ bookCopy: { findFirst } }) };
  // fieldDefs isn't touched by lookupByBarcode.
  const svc = new CopiesService(tenantPrisma as never, {} as never);
  return { svc, findFirst };
}

describe('CopiesService.lookupByBarcode', () => {
  it('returns the copy + book in the checkout-picker shape', async () => {
    const { svc, findFirst } = makeSvc({
      id: 'c1',
      barcode: 'BC-1',
      status: 'available',
      shelfLocation: 'A1',
      book: {
        id: 'b1',
        title: 'Dune',
        authors: [{ authorId: 'a1', order: 0, author: { fullName: 'Frank Herbert' } }],
      },
    });

    const res = await svc.lookupByBarcode(TENANT, 'BC-1');

    expect(res.copy).toEqual({
      id: 'c1',
      barcode: 'BC-1',
      status: 'available',
      shelfLocation: 'A1',
    });
    expect(res.book).toEqual({
      id: 'b1',
      title: 'Dune',
      authors: [{ authorId: 'a1', fullName: 'Frank Herbert', order: 0 }],
    });
    // Only matches active (non-archived) copies — archived ones may reuse a barcode.
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { barcode: 'BC-1', archivedAt: null } }),
    );
  });

  it('throws NotFound when no active copy matches the barcode', async () => {
    const { svc } = makeSvc(null);
    await expect(svc.lookupByBarcode(TENANT, 'NOPE')).rejects.toBeInstanceOf(NotFoundException);
  });
});
