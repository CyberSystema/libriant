import {
  BadRequestException,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';

/**
 * Tenant-scoped route guard. Composes THREE checks:
 *
 *   1. The URL resolved to a tenant (TenantMiddleware ran and attached
 *      `req.tenant`). Otherwise → 400.
 *   2. The caller is signed in (`req.session` set by SessionMiddleware).
 *      Otherwise → 401.
 *   3. The signed-in user's tenant matches the URL's tenant. Otherwise
 *      → 403 — this is the central cross-tenant defense in our path-based
 *      URL world (where cookies are shared across paths).
 */
@Injectable()
export class TenantGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<Request>();
    if (!req.tenant) {
      throw new BadRequestException(
        'No tenant in this request. Did you mean to hit a /t/<slug>/... route?',
      );
    }
    if (!req.session) {
      throw new UnauthorizedException('Please sign in to access this library.');
    }
    if (req.session.tid !== req.tenant.id) {
      throw new ForbiddenException(
        "You're signed in to a different library. Sign out and sign in to this one to continue.",
      );
    }
    return true;
  }
}
