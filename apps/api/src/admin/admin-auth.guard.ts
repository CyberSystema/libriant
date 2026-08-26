import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UnauthorizedException,
  createParamDecorator,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { controlDb } from '@libriant/db-control';
import { loadEnv } from '../config/env.js';
import type { AdminSessionPayload } from './admin-session.service.js';

/**
 * Controllers that are entirely second-factor self-service, named by class
 * identity because they live outside `src/admin/` and cannot carry
 * {@link MfaExempt} without an edit over there. `MfaController` is
 * `/admin/mfa/*` — status, setup, verify, recovery-codes — and an admin who
 * cannot reach it under ADMIN_MFA_REQUIRED cannot enroll, which turns the
 * enrollment wall into a lockout.
 */
const MFA_EXEMPT_CONTROLLERS: ReadonlySet<string> = new Set(['MfaController']);

export const MFA_EXEMPT_KEY = 'adminMfaExempt';

/**
 * Reachable by an admin who has not yet enrolled a second factor, while
 * `ADMIN_MFA_REQUIRED` holds everything else back. Put it only on routes that
 * an admin needs IN ORDER to enroll, or the wall stops meaning anything.
 */
export const MfaExempt = () => SetMetadata(MFA_EXEMPT_KEY, true);

/**
 * Gate every `/admin/*` route behind a valid admin session **AND** a
 * still-active row in `admin_users`. Looking up the row every request
 * means a disabled admin's existing session is invalidated immediately,
 * not at next sign-in.
 *
 * Also enforces:
 *   • session invalidation (AUTH-01) — a token issued before the admin's
 *     `sessionsValidAfter` epoch is rejected (forced reset / disable);
 *   • mandatory MFA (AUTH-06) — when `ADMIN_MFA_REQUIRED`, an admin without
 *     MFA enrolled reaches only the routes that let them enroll (see
 *     {@link MfaExempt}) and is pushed to enroll before anything else.
 */
@Injectable()
export class AdminAuthGuard implements CanActivate {
  // Own Reflector, no DI — same reason AdminRolesGuard builds its own, spelled
  // out in that file: under tsx there is no `design:paramtypes`, so an injected
  // Reflector arrives as `undefined` and every admin route 500s.
  private readonly reflector = new Reflector();

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request>();
    const session = req.adminSession;
    if (!session) {
      throw new UnauthorizedException('Admin sign-in required.');
    }
    const admin = await controlDb.adminUser.findUnique({
      where: { id: session.sub },
      select: {
        id: true,
        role: true,
        status: true,
        disabledAt: true,
        lockedUntil: true,
        mfaEnabled: true,
        sessionsValidAfter: true,
      },
    });
    // Deny-by-default on status: anything other than 'active' kills the session
    // on the next request. That is the right behaviour for a DISABLED admin and
    // it is exactly why nothing on an unauthenticated path may write this column
    // — until authn-authz-03, five wrong passwords from a stranger set
    // `status = 'locked'` here and 403'd the real admin's live cookie. The
    // brute-force lockout now lives in Redis, keyed on (admin, IP); see
    // admin-auth.service.ts. A row still stuck at 'locked' from before that fix
    // heals on the next successful sign-in (recordSuccess).
    if (!admin || admin.disabledAt || admin.status !== 'active') {
      throw new ForbiddenException('Your admin account is no longer active.');
    }
    // An operator freezing an account by hand — `UPDATE admin_users SET
    // "lockedUntil" = now() + interval '1 hour'` — is the documented incident
    // response for a compromised admin, and it has to reach the LIVE cookie or
    // it does nothing for the hour that matters. Safe to enforce here for
    // exactly one reason, and it is the same reason spelled out in
    // admin-auth.service.ts: nothing on an unauthenticated path writes this
    // column. If that ever changes, this line turns straight back into the
    // remote-controlled admin lockout of authn-authz-03 — so it does not
    // change.
    if (admin.lockedUntil && admin.lockedUntil.getTime() > Date.now()) {
      throw new ForbiddenException('Your admin account is temporarily locked.');
    }
    // A1-02 / AUTH-01: reject a session minted before a forced reset/disable.
    // This used to be a read with no writer. It has one now: enrolling or
    // REPLACING an admin's second factor (`POST /admin/mfa/verify`,
    // authn-authz-09) stamps `sessionsValidAfter`, so a stolen cookie that was
    // used to re-point the authenticator dies here on its next request — and so
    // does every other cookie for that account except the one the enrolling
    // browser is re-issued. Any further admin self-service credential change
    // MUST write this column for the same reason.
    //
    // The impersonation path enforces the same three columns as this guard;
    // see `adminRevocationReason` in support/impersonation.middleware.ts. The
    // two must not drift (authn-authz-04).
    const validAfterMs = admin.sessionsValidAfter ? admin.sessionsValidAfter.getTime() : 0;
    if (validAfterMs > 0 && session.iat && session.iat < Math.floor(validAfterMs / 1000)) {
      throw new UnauthorizedException('Your admin session has expired. Please sign in again.');
    }
    // AUTH-06: force MFA enrollment. The enrollment + auth endpoints stay
    // reachable so a not-yet-enrolled admin can actually set MFA up; everything
    // else 403s until they do.
    if (loadEnv().adminMfaRequired && !admin.mfaEnabled && !this.isMfaExempt(ctx)) {
      throw new ForbiddenException({
        code: 'mfa_enrollment_required',
        message: 'Set up two-factor authentication before using the admin console.',
      });
    }
    return true;
  }

  /**
   * authn-authz-12. This was
   * `path.includes('/mfa/') || path.includes('/auth/')` — a substring test on
   * the request path, which the caller writes. Three admin controllers take a
   * `:tenantId`, so `GET /admin/billing/tenants/auth/` contained `/auth/` and
   * came back 200 while every honest route the same un-enrolled admin touched
   * came back 403: mandatory MFA, defeated by naming a path segment `auth`.
   *
   * Nothing here reads the path. Exemption is a decision recorded on the
   * handler, or the identity of the controller class — neither of which a
   * request can influence — and a route that says nothing is not exempt.
   */
  private isMfaExempt(ctx: ExecutionContext): boolean {
    const marked = this.reflector.getAllAndOverride<boolean | undefined>(MFA_EXEMPT_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    return marked === true || MFA_EXEMPT_CONTROLLERS.has(ctx.getClass().name);
  }
}

/**
 * Pull the verified admin session from the request inside a route handler.
 * Throws 401 if no session — used inside handlers behind `AdminAuthGuard`
 * for type safety.
 */
export const AdminSess = createParamDecorator<unknown, AdminSessionPayload>((_, ctx) => {
  const req = ctx.switchToHttp().getRequest<Request>();
  if (!req.adminSession) {
    throw new UnauthorizedException('Admin sign-in required.');
  }
  return req.adminSession;
});
