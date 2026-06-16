import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Decision-table unit test for the desktop-app entitlement rule
 * (BillingService.getDesktopAccess). Pins the contract that drives both the
 * in-panel download gate and the desktop shell's hard block:
 *   - subscriptions OFF  → everyone entitled (the current "all tenants" state);
 *   - subscriptions ON   → only a PAID plan in good standing (active / trialing,
 *     or past_due still inside its grace window). Free/canceled/paused/lapsed
 *     are blocked.
 */
const { subFindUnique, billingEnabled } = vi.hoisted(() => ({
  subFindUnique: vi.fn(),
  billingEnabled: vi.fn(),
}));

vi.mock('@libriant/db-control', () => ({
  controlDb: { subscription: { findUnique: subFindUnique } },
}));

import { BillingService } from '../billing/billing.service.js';

// Constructor is (effectivePlan, stripe, settings); getDesktopAccess only
// touches `settings.billingEnabled()` + the mocked controlDb.
function makeService() {
  return new BillingService({} as never, {} as never, { billingEnabled } as never);
}

function sub(over: { price?: number; status?: string; graceUntil?: Date | null } = {}) {
  return {
    status: over.status ?? 'active',
    graceUntil: over.graceUntil ?? null,
    plan: { monthlyPriceCents: over.price ?? 1000 },
  };
}

const future = () => new Date(Date.now() + 86_400_000);
const past = () => new Date(Date.now() - 1000);

describe('BillingService.getDesktopAccess', () => {
  beforeEach(() => {
    subFindUnique.mockReset();
    billingEnabled.mockReset();
  });

  it('is free-for-all when subscriptions are disabled — and skips the DB', async () => {
    billingEnabled.mockResolvedValue(false);
    const res = await makeService().getDesktopAccess('t1');
    expect(res).toEqual({ allowed: true, reason: 'free-for-all', billingEnabled: false });
    expect(subFindUnique).not.toHaveBeenCalled();
  });

  describe('when subscriptions are enabled', () => {
    beforeEach(() => billingEnabled.mockResolvedValue(true));

    it('blocks a tenant with no subscription row', async () => {
      subFindUnique.mockResolvedValue(null);
      expect(await makeService().getDesktopAccess('t1')).toEqual({
        allowed: false,
        reason: 'no-subscription',
        billingEnabled: true,
      });
    });

    it('blocks a FREE plan even when active', async () => {
      subFindUnique.mockResolvedValue(sub({ price: 0, status: 'active' }));
      expect(await makeService().getDesktopAccess('t1')).toMatchObject({
        allowed: false,
        reason: 'free-plan',
      });
    });

    it('allows a paid plan that is active', async () => {
      subFindUnique.mockResolvedValue(sub({ price: 1000, status: 'active' }));
      expect(await makeService().getDesktopAccess('t1')).toMatchObject({
        allowed: true,
        reason: 'active',
      });
    });

    it('allows a paid plan that is trialing', async () => {
      subFindUnique.mockResolvedValue(sub({ price: 1000, status: 'trialing' }));
      expect(await makeService().getDesktopAccess('t1')).toMatchObject({
        allowed: true,
        reason: 'trialing',
      });
    });

    it('allows a paid plan past_due but still inside the grace window', async () => {
      subFindUnique.mockResolvedValue(
        sub({ price: 1000, status: 'past_due', graceUntil: future() }),
      );
      expect(await makeService().getDesktopAccess('t1')).toMatchObject({
        allowed: true,
        reason: 'past_due',
      });
    });

    it('blocks a paid plan past_due whose grace window expired', async () => {
      subFindUnique.mockResolvedValue(sub({ price: 1000, status: 'past_due', graceUntil: past() }));
      expect(await makeService().getDesktopAccess('t1')).toMatchObject({ allowed: false });
    });

    it('blocks a paid plan past_due with no grace window', async () => {
      subFindUnique.mockResolvedValue(sub({ price: 1000, status: 'past_due', graceUntil: null }));
      expect(await makeService().getDesktopAccess('t1')).toMatchObject({ allowed: false });
    });

    it('blocks a canceled paid plan', async () => {
      subFindUnique.mockResolvedValue(sub({ price: 1000, status: 'canceled' }));
      expect(await makeService().getDesktopAccess('t1')).toMatchObject({
        allowed: false,
        reason: 'canceled',
      });
    });

    it('blocks a paused paid plan', async () => {
      subFindUnique.mockResolvedValue(sub({ price: 1000, status: 'paused' }));
      expect(await makeService().getDesktopAccess('t1')).toMatchObject({
        allowed: false,
        reason: 'paused',
      });
    });
  });
});
