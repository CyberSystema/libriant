import { beforeEach, describe, expect, it, vi } from 'vitest';

const { findMany, findUnique, userFindMany, adminFindMany, getClient } = vi.hoisted(() => ({
  findMany: vi.fn(),
  findUnique: vi.fn(),
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
import { decodeCursor, encodeCursor } from '../platform/query.js';
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
  getClient.mockReturnValue({ auditEvent: { findMany, findUnique } });
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

  it('returns a cursor carrying BOTH sort keys when there is another page', async () => {
    // limit 2 → service fetches 3; 3 returned ⇒ hasMore
    findMany.mockResolvedValue([row({ id: 'a1' }), row({ id: 'a2' }), row({ id: 'a3' })]);
    const res = await svc().list(TENANT, { limit: 2 });
    expect(res.items).toHaveLength(2);
    // performance-03: the cursor used to be the bare id `a2`, which is why the
    // next page had to be found with an OR of correlated subselects. It now
    // carries `occurredAt` too, because that is the only way the next page can
    // be asked for as a range the index can be entered at.
    expect(decodeCursor(res.nextCursor!, 2)).toEqual(['2026-06-12T00:00:00.000Z', 'a2']);
  });

  it('turns that cursor into a range predicate, not a Prisma cursor', async () => {
    findMany.mockResolvedValue([]);
    const at = new Date('2026-06-12T00:00:00.000Z');
    await svc().list(TENANT, { after: encodeCursor([at.toISOString(), 'a2']) });
    const args = findMany.mock.calls[0]![0];
    // The thing the finding is about: no `cursor`, no `skip`, and a `<=` start
    // key the planner can seek `audit_log_occurredAt_id_idx` with.
    expect(args.cursor).toBeUndefined();
    expect(args.skip).toBeUndefined();
    expect(args.where.AND).toEqual([
      { occurredAt: { lte: at } },
      { OR: [{ occurredAt: { lt: at } }, { occurredAt: at, id: { lt: 'a2' } }] },
    ]);
  });

  it('still accepts a bare row id, the way the cursor used to look', async () => {
    // A reader mid-scroll across a deploy hands back the old shape. It must
    // land on the same page rather than restarting at the newest entry.
    const at = new Date('2026-06-12T00:00:00.000Z');
    findUnique.mockResolvedValue({ occurredAt: at, id: 'a2' });
    findMany.mockResolvedValue([]);
    await svc().list(TENANT, { after: 'a2' });
    expect(findUnique).toHaveBeenCalledWith({
      where: { id: 'a2' },
      select: { occurredAt: true, id: true },
    });
    expect(findMany.mock.calls[0]![0].where.AND).toEqual([
      { occurredAt: { lte: at } },
      { OR: [{ occurredAt: { lt: at } }, { occurredAt: at, id: { lt: 'a2' } }] },
    ]);
  });

  it('restarts at page 1 rather than emptying the log on a corrupt timestamp', async () => {
    // `new Date('not-a-date')` reaches Prisma as `Invalid Date`, which compares
    // against NULL — every row filtered out, and an owner auditing a support
    // session sees a blank page instead of an error.
    findMany.mockResolvedValue([]);
    await svc().list(TENANT, { after: encodeCursor(['not-a-date', 'a2']) });
    expect(findMany.mock.calls[0]![0].where.AND).toBeUndefined();
    expect(findUnique).not.toHaveBeenCalled();
  });
});
