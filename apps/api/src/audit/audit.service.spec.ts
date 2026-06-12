import { beforeEach, describe, expect, it, vi } from 'vitest';

const { findMany, userFindMany, adminFindMany, getClient } = vi.hoisted(() => ({
  findMany: vi.fn(),
  userFindMany: vi.fn(),
  adminFindMany: vi.fn(),
  getClient: vi.fn(),
}));

vi.mock('@libriant/db-control', () => ({
  controlDb: { user: { findMany: userFindMany }, adminUser: { findMany: adminFindMany } },
}));
vi.mock('../tenancy/tenant-prisma.service.js', () => ({
  TenantPrismaService: vi.fn(function () {
    return { getClient };
  }),
}));

import { AuditService } from './audit.service.js';
import { TenantPrismaService } from '../tenancy/tenant-prisma.service.js';
import type { TenantContext } from '../tenancy/tenant-context.js';

const TENANT = { id: 't1', slug: 'acme' } as unknown as TenantContext;

function row(over: Record<string, unknown>) {
  return {
    id: 'a1',
    occurredAt: new Date('2026-06-12'),
    action: 'member.archived',
    actorType: 'user',
    actorId: 'u1',
    targetType: 'member',
    targetId: 'm1',
    beforeJson: { status: 'active' },
    afterJson: { status: 'archived' },
    supportSessionId: null,
    ...over,
  };
}

function svc() {
  getClient.mockReturnValue({ auditEvent: { findMany } });
  return new AuditService(new TenantPrismaService() as never);
}

describe('AuditService.list', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    userFindMany.mockResolvedValue([]);
    adminFindMany.mockResolvedValue([]);
  });

  it('resolves a user actor name and maps before/after', async () => {
    findMany.mockResolvedValue([row({})]);
    userFindMany.mockResolvedValue([
      { id: 'u1', fullName: 'Pat Smith', email: null, username: null },
    ]);
    const res = await svc().list(TENANT, {});
    expect(res.items[0]!.actorLabel).toBe('Pat Smith');
    expect(res.items[0]!.before).toEqual({ status: 'active' });
    expect(res.items[0]!.after).toEqual({ status: 'archived' });
    expect(res.items[0]!.viaSupport).toBe(false);
    expect(res.nextCursor).toBeNull();
  });

  it('resolves an admin actor + flags support sessions', async () => {
    findMany.mockResolvedValue([
      row({ actorType: 'admin', actorId: 'ad1', supportSessionId: 'sess-9' }),
    ]);
    adminFindMany.mockResolvedValue([{ id: 'ad1', fullName: 'Support Sam' }]);
    const res = await svc().list(TENANT, {});
    expect(res.items[0]!.actorLabel).toBe('Support Sam');
    expect(res.items[0]!.viaSupport).toBe(true);
  });

  it('labels a system / actor-less event as null', async () => {
    findMany.mockResolvedValue([row({ actorType: 'system', actorId: null })]);
    const res = await svc().list(TENANT, {});
    expect(res.items[0]!.actorLabel).toBeNull();
  });

  it('returns a cursor when there is another page', async () => {
    // limit 2 → service fetches 3; 3 returned ⇒ hasMore
    findMany.mockResolvedValue([row({ id: 'a1' }), row({ id: 'a2' }), row({ id: 'a3' })]);
    const res = await svc().list(TENANT, { limit: 2 });
    expect(res.items).toHaveLength(2);
    expect(res.nextCursor).toBe('a2');
  });
});
