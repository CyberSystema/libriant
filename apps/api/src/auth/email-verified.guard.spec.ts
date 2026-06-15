import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ForbiddenException, UnauthorizedException, type ExecutionContext } from '@nestjs/common';

const { userFindUnique } = vi.hoisted(() => ({ userFindUnique: vi.fn() }));
vi.mock('@libriant/db-control', () => ({
  controlDb: { user: { findUnique: userFindUnique } },
}));

import { EmailVerifiedGuard } from './email-verified.guard.js';

function ctxFor(session: { sub: string } | undefined): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ session }) }),
  } as unknown as ExecutionContext;
}

describe('EmailVerifiedGuard', () => {
  const guard = new EmailVerifiedGuard();
  beforeEach(() => vi.clearAllMocks());

  it('blocks an unverified email account with the email_verification_required code', async () => {
    userFindUnique.mockResolvedValue({ email: 'owner@acme.test', emailVerifiedAt: null });
    const err = await guard.canActivate(ctxFor({ sub: 'u1' })).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ForbiddenException);
    expect((err as ForbiddenException).getResponse()).toMatchObject({
      code: 'email_verification_required',
    });
  });

  it('allows a verified email account', async () => {
    userFindUnique.mockResolvedValue({ email: 'owner@acme.test', emailVerifiedAt: new Date() });
    expect(await guard.canActivate(ctxFor({ sub: 'u1' }))).toBe(true);
  });

  it('exempts staff accounts that have no email', async () => {
    userFindUnique.mockResolvedValue({ email: null, emailVerifiedAt: null });
    expect(await guard.canActivate(ctxFor({ sub: 'staff1' }))).toBe(true);
  });

  it('rejects when there is no session', async () => {
    await expect(guard.canActivate(ctxFor(undefined))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
});
