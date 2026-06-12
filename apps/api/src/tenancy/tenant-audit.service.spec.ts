import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TenantAuditService } from './tenant-audit.service.js';
import type { TenantContext } from './tenant-context.js';

const TENANT = { id: 't1', slug: 'acme' } as unknown as TenantContext;

function makeSvc(createImpl: (args: unknown) => Promise<unknown>) {
  const create = vi.fn(createImpl);
  const tenantPrisma = { getClient: vi.fn(() => ({ auditEvent: { create } })) };
  const svc = new TenantAuditService(tenantPrisma as never);
  return { svc, create };
}

describe('TenantAuditService', () => {
  beforeEach(() => vi.clearAllMocks());

  it('maps an entry onto auditEvent.create with defaults', async () => {
    const { svc, create } = makeSvc(async () => ({}));
    await svc.record(TENANT, {
      action: 'member.archived',
      actorId: 'user-1',
      targetType: 'member',
      targetId: 'm1',
      before: { status: 'active' },
      after: { status: 'archived' },
    });

    expect(create).toHaveBeenCalledTimes(1);
    const data = (create.mock.calls[0]![0] as { data: Record<string, unknown> }).data;
    expect(data.actorType).toBe('user'); // defaulted
    expect(data.actorId).toBe('user-1');
    expect(data.action).toBe('member.archived');
    expect(data.targetType).toBe('member');
    expect(data.targetId).toBe('m1');
    expect(data.beforeJson).toEqual({ status: 'active' });
    expect(data.afterJson).toEqual({ status: 'archived' });
    expect(data.supportSessionId).toBeNull();
  });

  it('omits before/after when not supplied (column stays NULL)', async () => {
    const { svc, create } = makeSvc(async () => ({}));
    await svc.record(TENANT, { action: 'member.created', actorId: 'u1', after: { fullName: 'X' } });
    const data = (create.mock.calls[0]![0] as { data: Record<string, unknown> }).data;
    expect(data.beforeJson).toBeUndefined();
    expect(data.afterJson).toEqual({ fullName: 'X' });
  });

  it('swallows write failures — a broken audit must not break the caller', async () => {
    const { svc } = makeSvc(async () => {
      throw new Error('db down');
    });
    await expect(
      svc.record(TENANT, { action: 'loan.returned', actorId: 'u1' }),
    ).resolves.toBeUndefined();
  });
});
