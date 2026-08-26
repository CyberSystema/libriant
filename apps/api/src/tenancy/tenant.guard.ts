import {
  BadRequestException,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { controlDb } from '@libriant/db-control';
import { loadEnv } from '../config/env.js';
import { isPastAbsoluteMax, isSessionRevoked } from '../auth/jwt-session.service.js';

/**
 * Tenant-scoped route guard. Composes these checks:
 *
 *   1. The URL resolved to a tenant (TenantMiddleware ran and attached
 *      `req.tenant`). Otherwise → 400.
 *   2. The caller is signed in (`req.session` set by SessionMiddleware).
 *      Otherwise → 401.
 *   3. The signed-in user's tenant matches the URL's tenant — as the session
 *      claims it (403) and as the user row still says it is (401,
 *      tenant-isolation-04). This is the central cross-tenant defense in our
 *      path-based URL world (where cookies are shared across paths).
 *   4. The signed-in user is STILL active in the DB AND the session hasn't been
 *      revoked (password reset / role change — `sessionsValidAfter`) or aged out
 *      (absolute lifetime cap). This is the SAME revocation AuthGuard enforces,
 *      applied here too: tenant data routes use TenantGuard, not AuthGuard, so
 *      without these checks a reset wouldn't actually cut off library-data
 *      access and a sliding session could live forever. Re-read per request
 *      (uses the `controlDb` singleton directly, no DI — mirroring RolesGuard,
 *      since a `@UseGuards(TenantGuard)` class ref can be instantiated standalone).
 */
@Injectable()
export class TenantGuard implements CanActivate {
  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request>();
    if (!req.tenant) {
      throw new BadRequestException(
        'No tenant in this request. Did you mean to hit a /t/<slug>/... route?',
      );
    }

    // Impersonation mode (Step 18a): a Libriant admin has redeemed a
    // tenant-issued support key. The impersonation payload binds them
    // to ONE specific tenant for the lifetime of the session — anything
    // else would 403. `SupportSessionGuard` (run by the support
    // interceptor) validates the session row separately.
    if (req.impersonation) {
      if (req.impersonation.tenantId !== req.tenant.id) {
        throw new ForbiddenException(
          'This support session covers a different library. Redeem a new key for this one.',
        );
      }
      return true;
    }

    if (!req.session) {
      throw new UnauthorizedException('Please sign in to access this library.');
    }
    if (req.session.tid !== req.tenant.id) {
      throw new ForbiddenException(
        "You're signed in to a different library. Sign out and sign in to this one to continue.",
      );
    }
    // Absolute lifetime cap (payload-only) — a session can't outlive this even
    // with sliding.
    if (
      isPastAbsoluteMax(
        req.session,
        Math.floor(Date.now() / 1000),
        loadEnv().sessionAbsoluteMaxTtlSec,
      )
    ) {
      throw new UnauthorizedException('Your session has expired. Please sign in again.');
    }
    // Deactivation / suspension AND revocation (password reset / role change)
    // take effect immediately, not at JWT expiry. Revocation keys off the
    // immutable session start so a sliding re-issue can't escape it.
    const user = await controlDb.user.findUnique({
      where: { id: req.session.sub },
      select: { status: true, tenantId: true, sessionsValidAfter: true },
    });
    if (!user || user.status !== 'active') {
      throw new UnauthorizedException('Your account is no longer active. Please sign in again.');
    }
    // tenant-isolation-04: the `tid` test above compares two halves of the same
    // request — a claim minted at login against the slug in the URL — so it
    // cannot notice that the user has since been moved out of this library. The
    // row that says where they actually belong is already in hand (same query,
    // one more column), and AuthGuard has always compared it; tenant DATA routes
    // run TenantGuard instead, which is exactly where the binding matters.
    // Proved by moving a signed-in owner's `users.tenantId` to another library
    // and replaying the cookie: /t/<the-library-they-left>/members kept
    // answering 200 for the rest of the session's 90-day absolute lifetime.
    // 401, not 403, matching AuthGuard: signing in again is what actually fixes
    // it for a librarian who has genuinely been moved, whereas a 403 sends them
    // to a "wrong library" screen they can do nothing about.
    if (user.tenantId !== req.tenant.id) {
      throw new UnauthorizedException('Your session is no longer valid. Please sign in again.');
    }
    const validAfterMs = user.sessionsValidAfter ? user.sessionsValidAfter.getTime() : 0;
    if (isSessionRevoked(req.session, validAfterMs)) {
      throw new UnauthorizedException('Your session is no longer valid. Please sign in again.');
    }
    return true;
  }
}
