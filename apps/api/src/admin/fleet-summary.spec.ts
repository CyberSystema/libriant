import { describe, expect, it } from 'vitest';
import { type FleetTenantRow, formatBytes, summarizeTenants } from './fleet-summary.js';

const row = (over: Partial<FleetTenantRow>): FleetTenantRow => ({
  id: 'cmp1',
  slug: 'lib',
  name: 'Lib',
  status: 'active',
  cellSlug: 'cell-01',
  planSlug: 'community',
  storageBytes: 0,
  dbBytes: 0,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  ...over,
});

describe('summarizeTenants', () => {
  it('returns zeroed census for no tenants', () => {
    expect(summarizeTenants([])).toEqual({
      total: 0,
      byStatus: {},
      byPlan: {},
      byCell: {},
      totalStorageBytes: 0,
      totalDbBytes: 0,
      oldestCreatedAt: null,
      newestCreatedAt: null,
    });
  });

  it('counts ALL tenants by status (not only active)', () => {
    const c = summarizeTenants([
      row({ status: 'active' }),
      row({ status: 'active' }),
      row({ status: 'suspended' }),
      row({ status: 'archived' }),
    ]);
    expect(c.total).toBe(4);
    expect(c.byStatus).toEqual({ active: 2, suspended: 1, archived: 1 });
  });

  it('groups by plan (null → "none") and by cell', () => {
    const c = summarizeTenants([
      row({ planSlug: 'starter', cellSlug: 'cell-01' }),
      row({ planSlug: 'municipal', cellSlug: 'cell-01' }),
      row({ planSlug: null, cellSlug: 'cell-02' }),
    ]);
    expect(c.byPlan).toEqual({ starter: 1, municipal: 1, none: 1 });
    expect(c.byCell).toEqual({ 'cell-01': 2, 'cell-02': 1 });
  });

  it('sums storage + db bytes and tracks the oldest/newest createdAt', () => {
    const c = summarizeTenants([
      row({ storageBytes: 1000, dbBytes: 2000, createdAt: new Date('2026-03-01T00:00:00Z') }),
      row({ storageBytes: 500, dbBytes: 1500, createdAt: new Date('2026-01-15T00:00:00Z') }),
      row({ storageBytes: 0, dbBytes: 0, createdAt: new Date('2026-05-20T00:00:00Z') }),
    ]);
    expect(c.totalStorageBytes).toBe(1500);
    expect(c.totalDbBytes).toBe(3500);
    expect(c.oldestCreatedAt).toBe('2026-01-15T00:00:00.000Z');
    expect(c.newestCreatedAt).toBe('2026-05-20T00:00:00.000Z');
  });
});

describe('formatBytes', () => {
  it('formats common sizes', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(-5)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5 MB');
    expect(formatBytes(2.5 * 1024 ** 3)).toBe('2.5 GB');
    expect(formatBytes(3 * 1024 ** 4)).toBe('3 TB');
  });
});
