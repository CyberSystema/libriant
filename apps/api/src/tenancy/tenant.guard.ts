import { CanActivate, ExecutionContext, Injectable, BadRequestException } from '@nestjs/common';
import type { Request } from 'express';

/**
 * Marker guard for tenant-scoped routes. Ensures `req.tenant` has been
 * set by TenantMiddleware. Once authentication lands (Step 7) this guard
 * will also enforce `session.tenantId === req.tenant.id` — the central
 * cross-tenant defense in our path-based URL world.
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
    // Auth check (session.tenantId vs req.tenant.id) added in Step 7.
    return true;
  }
}
