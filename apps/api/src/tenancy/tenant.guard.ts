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

/**
 * Tenant-scoped route guard. Composes these checks:
 *
 *   1. The URL resolved to a tenant (TenantMiddleware ran and attached
 *      `req.tenant`). Otherwise → 400.
 *   2. The caller is signed in (`req.session` set by SessionMiddleware).
 *      Otherwise → 401.
 *   3. The signed-in user's tenant matches the URL's tenant. Otherwise
 *      → 403 — this is the central cross-tenant defense in our path-based
 *      URL world (where cookies are shared across paths).
 *   4. The signed-in user is STILL active in the DB. Sessions are 7-day JWTs,
 *      so without this a deactivated/suspended user would keep full access to
 *      tenant data until the token expired. Re-read per request (uses the
 *      `controlDb` singleton directly, no DI — mirroring RolesGuard, since a
 *      `@UseGuards(TenantGuard)` class ref can be instantiated standalone).
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
    // Deactivation / suspension takes effect immediately, not at JWT expiry.
    const user = await controlDb.user.findUnique({
      where: { id: req.session.sub },
      select: { status: true },
    });
    if (!user || user.status !== 'active') {
      throw new UnauthorizedException('Your account is no longer active. Please sign in again.');
    }
    return true;
  }
}
