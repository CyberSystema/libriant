import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';

/**
 * Refuses requests without a verified session (set by SessionMiddleware).
 * Apply via `@UseGuards(AuthGuard)` to platform endpoints; tenant routes
 * compose this with TenantGuard.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<Request>();
    if (!req.session) {
      throw new UnauthorizedException('Please sign in.');
    }
    return true;
  }
}
