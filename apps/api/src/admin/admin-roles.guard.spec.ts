import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { findUnique } = vi.hoisted(() => ({ findUnique: vi.fn() }));
vi.mock('@libriant/db-control', () => ({
  controlDb: { adminUser: { findUnique } },
}));

import { AdminRolesGuard } from './admin-roles.guard.js';

/**
 * The class/handler names matter now: with no `@AdminRoles` the guard asks
 * admin-route-roles.ts who may reach THIS route, and the answer is keyed on
 * them. Default to a route nobody pinned, so a test that says nothing about
 * identity is testing the fail-closed path.
 */
function ctxWith(
  sub: string | undefined,
  route: { controller: string; handler: string } = {
    controller: 'SomeBrandNewController',
    handler: 'index',
  },
): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ adminSession: sub ? { sub } : undefined }) }),
    getHandler: () => ({ name: route.handler }),
    getClass: () => ({ name: route.controller }),
  } as unknown as ExecutionContext;
}

function guardRequiring(roles: string[] | undefined): AdminRolesGuard {
  // The guard builds its own Reflector (no DI — see the guard's comment), so
  // override that field to control what metadata it "reads" for this unit test.
  const guard = new AdminRolesGuard();
  (guard as unknown as { reflector: { getAllAndOverride: () => unknown } }).reflector = {
    getAllAndOverride: () => roles,
  };
  return guard;
}

describe('AdminRolesGuard', () => {
  beforeEach(() => findUnique.mockReset());

  // authn-authz-14: this used to assert the opposite — "allows any admin when
  // no role is required" — which is precisely how the applicant-PII export
  // ended up readable by the support tier. An undeclared route is owner-only.
  it('refuses a support admin on a route that declares nothing and is not pinned', async () => {
    findUnique.mockResolvedValue({ role: 'support', status: 'active', disabledAt: null });
    await expect(guardRequiring(undefined).canActivate(ctxWith('a1'))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('still lets an owner through a route that declares nothing', async () => {
    findUnique.mockResolvedValue({ role: 'owner', status: 'active', disabledAt: null });
    await expect(guardRequiring(undefined).canActivate(ctxWith('a1'))).resolves.toBe(true);
  });

  it('allows a pinned any-admin route without spending a second query on the row', async () => {
    // AdminAuthGuard already read this admin one guard earlier.
    await expect(
      guardRequiring(undefined).canActivate(
        // A route still pinned in admin-route-roles.ts. If that pin ever moves
        // onto the route as @AnyAdmin(), this test goes red rather than quiet.
        ctxWith('a1', { controller: 'AdminLibraryRequestsController', handler: 'list' }),
      ),
    ).resolves.toBe(true);
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('allows an owner when owner is required', async () => {
    findUnique.mockResolvedValue({ role: 'owner', status: 'active', disabledAt: null });
    await expect(guardRequiring(['owner']).canActivate(ctxWith('a1'))).resolves.toBe(true);
  });

  it('rejects a support admin when owner is required', async () => {
    findUnique.mockResolvedValue({ role: 'support', status: 'active', disabledAt: null });
    await expect(guardRequiring(['owner']).canActivate(ctxWith('a1'))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('re-reads the live role (does not trust the JWT claim) — disabled account blocked', async () => {
    findUnique.mockResolvedValue({ role: 'owner', status: 'disabled', disabledAt: new Date() });
    await expect(guardRequiring(['owner']).canActivate(ctxWith('a1'))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('401s when there is no admin session', async () => {
    await expect(guardRequiring(['owner']).canActivate(ctxWith(undefined))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
});
