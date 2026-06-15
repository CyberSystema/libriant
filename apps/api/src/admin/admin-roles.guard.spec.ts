import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { findUnique } = vi.hoisted(() => ({ findUnique: vi.fn() }));
vi.mock('@libriant/db-control', () => ({
  controlDb: { adminUser: { findUnique } },
}));

import { AdminRolesGuard } from './admin-roles.guard.js';

function ctxWith(sub: string | undefined): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ adminSession: sub ? { sub } : undefined }) }),
    getHandler: () => undefined,
    getClass: () => undefined,
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

  it('allows any admin when no role is required', async () => {
    await expect(guardRequiring(undefined).canActivate(ctxWith('a1'))).resolves.toBe(true);
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
