import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
  createParamDecorator,
} from '@nestjs/common';
import type { Request } from 'express';
import { controlDb } from '@libriant/db-control';
import { loadEnv } from '../config/env.js';
import type { AdminSessionPayload } from './admin-session.service.js';

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
 *     MFA enrolled is allowed ONLY onto the enrollment/auth endpoints and is
 *     pushed to enroll before anything else.
 */
@Injectable()
export class AdminAuthGuard implements CanActivate {
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
        mfaEnabled: true,
        sessionsValidAfter: true,
      },
    });
    if (!admin || admin.disabledAt || admin.status !== 'active') {
      throw new ForbiddenException('Your admin account is no longer active.');
    }
    // A1-02 / AUTH-01: reject a session minted before a forced reset/disable.
    // NOTE: today admins are seed-managed — there is NO in-app admin
    // password-change/disable endpoint, so nothing WRITES sessionsValidAfter
    // yet, and immediate revocation is handled by the status/disabledAt checks
    // above (re-read from the DB on every request, admin sessions TTL = 1h).
    // This read is the wired-and-ready hook: any FUTURE admin self-service
    // credential change MUST set `adminUser.sessionsValidAfter = now()` to kill
    // existing cookies. Keeping the check (rather than deleting it) means that
    // path is one line away and can't be forgotten.
    const validAfterMs = admin.sessionsValidAfter ? admin.sessionsValidAfter.getTime() : 0;
    if (validAfterMs > 0 && session.iat && session.iat < Math.floor(validAfterMs / 1000)) {
      throw new UnauthorizedException('Your admin session has expired. Please sign in again.');
    }
    // AUTH-06: force MFA enrollment. The enrollment + auth endpoints stay
    // reachable so a not-yet-enrolled admin can actually set MFA up; everything
    // else 403s until they do.
    if (loadEnv().adminMfaRequired && !admin.mfaEnabled && !isMfaEnrollmentPath(req.path)) {
      throw new ForbiddenException({
        code: 'mfa_enrollment_required',
        message: 'Set up two-factor authentication before using the admin console.',
      });
    }
    return true;
  }
}

/** Endpoints a not-yet-enrolled admin must still reach (to enroll / sign out). */
function isMfaEnrollmentPath(path: string): boolean {
  return path.includes('/mfa/') || path.includes('/auth/');
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
