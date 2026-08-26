import { describe, expect, it } from 'vitest';
import { adminRevocationReason } from './impersonation.middleware.js';

const NOW_SEC = Math.floor(Date.now() / 1000);
const active = { status: 'active', disabledAt: null, sessionsValidAfter: null };

/**
 * authn-authz-04. Each column is asserted on its own: the probe disabled an
 * admin by setting BOTH `status` and `disabledAt`, so a check that only read
 * one of them would have passed that test while leaving the other half open.
 */
describe('adminRevocationReason', () => {
  it('lets an active admin through', () => {
    expect(adminRevocationReason(active, NOW_SEC)).toBeNull();
  });

  it('stops an admin with disabledAt set, even if status still says active', () => {
    expect(adminRevocationReason({ ...active, disabledAt: new Date() }, NOW_SEC)).toMatch(
      /disabled/,
    );
  });

  it('stops an admin whose status is not active, even with disabledAt null', () => {
    expect(adminRevocationReason({ ...active, status: 'disabled' }, NOW_SEC)).toMatch(/not active/);
  });

  it('stops a cookie minted before the admin sessions were invalidated', () => {
    const cutoff = new Date((NOW_SEC + 60) * 1000);
    expect(adminRevocationReason({ ...active, sessionsValidAfter: cutoff }, NOW_SEC)).toMatch(
      /invalidated/,
    );
  });

  it('keeps a cookie minted in the same second as the cutoff', () => {
    // Second granularity, matching AuthGuard/AdminAuthGuard: a token minted in
    // the same second as the bump must not be caught by its own bump.
    const cutoff = new Date(NOW_SEC * 1000);
    expect(adminRevocationReason({ ...active, sessionsValidAfter: cutoff }, NOW_SEC)).toBeNull();
  });

  it('stops a session whose admin row has vanished', () => {
    expect(adminRevocationReason(null, NOW_SEC)).toMatch(/exists/);
  });
});
