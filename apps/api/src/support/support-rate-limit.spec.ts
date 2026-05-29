import { describe, expect, it } from 'vitest';
import { REDEEM_LIMITS, evaluateRedeemRateLimit } from './support-rate-limit.js';

describe('evaluateRedeemRateLimit', () => {
  const zero = { adminLastMinute: 0, ipLastMinute: 0, adminFailedLastHour: 0 };

  it('allows when all counts are below the limits', () => {
    expect(evaluateRedeemRateLimit(zero)).toEqual({ allowed: true });
    expect(
      evaluateRedeemRateLimit({ adminLastMinute: 4, ipLastMinute: 9, adminFailedLastHour: 9 }),
    ).toEqual({ allowed: true });
  });

  it('locks out at 10 failed attempts in the last hour (takes precedence)', () => {
    const d = evaluateRedeemRateLimit({
      ...zero,
      adminFailedLastHour: REDEEM_LIMITS.failedPerHourLockout,
    });
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.reason).toBe('locked_out');
  });

  it('lockout wins even when the per-minute limits are also tripped', () => {
    const d = evaluateRedeemRateLimit({
      adminLastMinute: 99,
      ipLastMinute: 99,
      adminFailedLastHour: 99,
    });
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.reason).toBe('locked_out');
  });

  it('throttles the admin at 5 attempts/minute', () => {
    const d = evaluateRedeemRateLimit({ ...zero, adminLastMinute: REDEEM_LIMITS.adminPerMinute });
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.reason).toBe('admin_rate');
  });

  it('throttles the IP at 10 attempts/minute', () => {
    const d = evaluateRedeemRateLimit({ ...zero, ipLastMinute: REDEEM_LIMITS.ipPerMinute });
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.reason).toBe('ip_rate');
  });

  it('admin per-minute limit is checked before the IP limit', () => {
    const d = evaluateRedeemRateLimit({
      adminLastMinute: REDEEM_LIMITS.adminPerMinute,
      ipLastMinute: REDEEM_LIMITS.ipPerMinute,
      adminFailedLastHour: 0,
    });
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.reason).toBe('admin_rate');
  });
});
