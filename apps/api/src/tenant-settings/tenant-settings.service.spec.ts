import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TenantSettingsService } from './tenant-settings.service.js';
import type { TenantContext } from '../tenancy/tenant-context.js';
import type { TenantActor } from '../tenancy/tenant-actor.js';

const TENANT = { id: 't1', slug: 'acme' } as unknown as TenantContext;
const ACTOR: TenantActor = {
  userId: 'u1',
  actorId: 'u1',
  actorType: 'user',
  supportSessionId: null,
};

const ROW = {
  id: 1,
  currency: 'EUR',
  loanPeriodDays: 14,
  renewalsEnabled: true,
  maxRenewals: 2,
  overdueFinesEnabled: false,
  finePerDayCents: 0,
  fineCapCents: 0,
  lostItemFeesEnabled: false,
  lostItemDefaultFeeCents: 0,
  reservationsEnabled: true,
  holdPickupHours: 48,
  maxActiveLoans: 0,
};

function makeSvc(planReservations = true) {
  const update = vi.fn(async (args: { data: Record<string, unknown> }) => ({
    ...ROW,
    ...args.data,
  }));
  const findUnique = vi.fn(async () => ({ ...ROW }));
  const tenantPrisma = { getClient: () => ({ tenantSetting: { findUnique, update } }) };
  const record = vi.fn(async (_t: unknown, _a: unknown, _e: unknown) => undefined);
  const getBool = vi.fn(async () => planReservations);
  const svc = new TenantSettingsService(
    tenantPrisma as never,
    { record } as never,
    { getBool } as never,
  );
  return { svc, update, record, getBool };
}

describe('TenantSettingsService', () => {
  beforeEach(() => vi.clearAllMocks());

  it('exposes whether the plan permits reservations', async () => {
    const { svc } = makeSvc(false);
    const view = await svc.get(TENANT);
    expect(view.reservationsAllowedByPlan).toBe(false);
    expect(view.reservationsEnabled).toBe(true); // the library setting, separate
  });

  it('rejects turning reservations ON when the plan forbids it', async () => {
    const { svc, update } = makeSvc(false);
    await expect(svc.update(TENANT, { reservationsEnabled: true }, ACTOR)).rejects.toThrow(/plan/i);
    expect(update).not.toHaveBeenCalled();
  });

  it('allows turning reservations OFF regardless of plan', async () => {
    const { svc, update } = makeSvc(false);
    await svc.update(TENANT, { reservationsEnabled: false }, ACTOR);
    expect(update).toHaveBeenCalledTimes(1);
    expect((update.mock.calls[0]![0] as { data: Record<string, unknown> }).data).toEqual({
      reservationsEnabled: false,
    });
  });

  it('writes only changed fields and audits the diff', async () => {
    const { svc, update, record } = makeSvc(true);
    await svc.update(
      TENANT,
      { overdueFinesEnabled: true, finePerDayCents: 20, loanPeriodDays: 14 /* unchanged */ },
      ACTOR,
    );
    const data = (update.mock.calls[0]![0] as { data: Record<string, unknown> }).data;
    expect(data).toEqual({ overdueFinesEnabled: true, finePerDayCents: 20 });
    expect(record).toHaveBeenCalledTimes(1);
    const entry = record.mock.calls[0]![2] as {
      action: string;
      before: Record<string, unknown>;
      after: Record<string, unknown>;
    };
    expect(entry.action).toBe('settings.updated');
    expect(entry.before).toEqual({ overdueFinesEnabled: false, finePerDayCents: 0 });
    expect(entry.after).toEqual({ overdueFinesEnabled: true, finePerDayCents: 20 });
  });

  it('is a no-op (no write, no audit) when nothing changes', async () => {
    const { svc, update, record } = makeSvc(true);
    await svc.update(TENANT, { currency: 'EUR', maxRenewals: 2 }, ACTOR);
    expect(update).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });
});
