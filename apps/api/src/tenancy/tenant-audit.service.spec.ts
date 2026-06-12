import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TenantAuditService } from './tenant-audit.service.js';
import type { TenantContext } from './tenant-context.js';
import type { TenantActor } from './tenant-actor.js';

const TENANT = { id: 't1', slug: 'acme' } as unknown as TenantContext;

const USER_ACTOR: TenantActor = {
  userId: 'user-1',
  actorId: 'user-1',
  actorType: 'user',
  supportSessionId: null,
};
const ADMIN_ACTOR: TenantActor = {
  userId: null,
  actorId: 'admin-9',
  actorType: 'admin',
  supportSessionId: 'sess-42',
};

function makeSvc(createImpl: (args: unknown) => Promise<unknown>) {
  const create = vi.fn(createImpl);
  const tenantPrisma = { getClient: vi.fn(() => ({ auditEvent: { create } })) };
  const svc = new TenantAuditService(tenantPrisma as never);
  return { svc, create };
}

describe('TenantAuditService', () => {
  beforeEach(() => vi.clearAllMocks());

  it('maps a normal user action onto auditEvent.create', async () => {
    const { svc, create } = makeSvc(async () => ({}));
    await svc.record(TENANT, USER_ACTOR, {
      action: 'member.archived',
      targetType: 'member',
      targetId: 'm1',
      before: { status: 'active' },
      after: { status: 'archived' },
    });

    expect(create).toHaveBeenCalledTimes(1);
    const data = (create.mock.calls[0]![0] as { data: Record<string, unknown> }).data;
    expect(data.actorType).toBe('user');
    expect(data.actorId).toBe('user-1');
    expect(data.action).toBe('member.archived');
    expect(data.targetType).toBe('member');
    expect(data.targetId).toBe('m1');
    expect(data.beforeJson).toEqual({ status: 'active' });
    expect(data.afterJson).toEqual({ status: 'archived' });
    expect(data.supportSessionId).toBeNull();
  });

  it('attributes an impersonated action to the admin + support session', async () => {
    const { svc, create } = makeSvc(async () => ({}));
    await svc.record(TENANT, ADMIN_ACTOR, { action: 'loan.returned', targetId: 'l1' });
    const data = (create.mock.calls[0]![0] as { data: Record<string, unknown> }).data;
    expect(data.actorType).toBe('admin');
    expect(data.actorId).toBe('admin-9');
    expect(data.supportSessionId).toBe('sess-42');
  });

  it('omits before/after when not supplied (column stays NULL)', async () => {
    const { svc, create } = makeSvc(async () => ({}));
    await svc.record(TENANT, USER_ACTOR, { action: 'member.created', after: { fullName: 'X' } });
    const data = (create.mock.calls[0]![0] as { data: Record<string, unknown> }).data;
    expect(data.beforeJson).toBeUndefined();
    expect(data.afterJson).toEqual({ fullName: 'X' });
  });

  it('swallows write failures — a broken audit must not break the caller', async () => {
    const { svc } = makeSvc(async () => {
      throw new Error('db down');
    });
    await expect(
      svc.record(TENANT, USER_ACTOR, { action: 'loan.returned' }),
    ).resolves.toBeUndefined();
  });
});
