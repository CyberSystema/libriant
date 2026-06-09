import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { controlDb } from '@libriant/db-control';
import type { UserRole } from '@libriant/db-control';
import { ROLES_KEY } from './roles.decorator.js';

/**
 * Library-role guard. Runs AFTER `TenantGuard` (which proves the caller belongs
 * to this tenant). Reads the role required by `@Roles(...)` and checks it
 * against the user's CURRENT role in the DB — not the JWT, which can be stale
 * after an admin changes someone's role.
 *
 * An impersonating Libriant admin (support session) bypasses role checks: they
 * already hold platform-level access and need to act on the tenant's behalf.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const roles = this.reflector.getAllAndOverride<UserRole[]>(ROLES_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (!roles || roles.length === 0) return true;

    const req = ctx.switchToHttp().getRequest<Request>();
    if (req.impersonation) return true;
    if (!req.session) throw new UnauthorizedException('Please sign in to access this library.');

    const user = await controlDb.user.findUnique({
      where: { id: req.session.sub },
      select: { role: true },
    });
    if (!user || !roles.includes(user.role)) {
      throw new ForbiddenException('This action is restricted to library admins.');
    }
    return true;
  }
}
