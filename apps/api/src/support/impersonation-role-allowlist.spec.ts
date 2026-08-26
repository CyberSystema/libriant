import { describe, expect, it, vi } from 'vitest';

const { findUnique } = vi.hoisted(() => ({ findUnique: vi.fn() }));
vi.mock('@libriant/db-control', () => ({ controlDb: { user: { findUnique } } }));

import { RolesGuard } from '../tenancy/roles.guard.js';
import { Roles, StaffWrite } from '../tenancy/roles.decorator.js';

/**
 * The allowlist that replaced `if (req.impersonation) return true;` in
 * RolesGuard (authn-authz-04 / -05).
 *
 * These are real decorators on real methods, read back through the real
 * Reflector by the real guard — not hand-written metadata — because the thing
 * under test IS the relationship between an annotation and a verdict.
 *
 * The last case has no route in the product yet. That is exactly why it is
 * here: under the old blanket bypass the FIRST `@Roles('owner')` route anyone
 * wrote would have been handed to support silently, and nothing would have
 * failed.
 */
class Routes {
  @StaffWrite()
  createMember(): void {}

  @Roles('owner', 'admin')
  changeSettings(): void {}

  @Roles('owner')
  transferOwnership(): void {}

  listMembers(): void {} // no annotation — open to every role
}

function ctxFor(handler: () => void, req: Record<string, unknown>) {
  return {
    getHandler: () => handler,
    getClass: () => Routes,
    switchToHttp: () => ({ getRequest: () => req }),
  } as never;
}

const impersonated = {
  impersonation: { imp: true, adminId: 'a1', tenantId: 't1', sessionId: 's1', iat: 1, exp: 2 },
};

describe('RolesGuard under impersonation', () => {
  const guard = new RolesGuard();

  it('lets support do library-admin work: @StaffWrite and owner/admin routes', async () => {
    // The support window exists to fix the library's records. Closing these
    // would not be a fence, it would be a broken feature.
    await expect(
      guard.canActivate(ctxFor(Routes.prototype.createMember, impersonated)),
    ).resolves.toBe(true);
    await expect(
      guard.canActivate(ctxFor(Routes.prototype.changeSettings, impersonated)),
    ).resolves.toBe(true);
    // No DB lookup for an impersonated caller — there is no tenant user to read.
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('refuses an owner-only route, which the blanket bypass would have allowed', async () => {
    await expect(
      guard.canActivate(ctxFor(Routes.prototype.transferOwnership, impersonated)),
    ).rejects.toThrow(/support access cannot perform this action/i);
  });

  it('leaves un-annotated routes open, as before', async () => {
    await expect(
      guard.canActivate(ctxFor(Routes.prototype.listMembers, impersonated)),
    ).resolves.toBe(true);
  });

  it('still judges a signed-in user by their DB role, not the JWT claim', async () => {
    // The other half of the guard must be untouched by the allowlist.
    findUnique.mockResolvedValue({ role: 'volunteer' });
    await expect(
      guard.canActivate(ctxFor(Routes.prototype.createMember, { session: { sub: 'u1' } })),
    ).rejects.toThrow(/restricted to library admins/i);

    findUnique.mockResolvedValue({ role: 'librarian' });
    await expect(
      guard.canActivate(ctxFor(Routes.prototype.createMember, { session: { sub: 'u1' } })),
    ).resolves.toBe(true);
  });
});
