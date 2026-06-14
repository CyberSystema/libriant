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
import { ADMIN_ROLES_KEY, type AdminRole } from './admin-roles.decorator.js';

/**
 * Enforce `@AdminRoles(...)` on admin routes. Runs AFTER `AdminAuthGuard`
 * (which proves a valid, active admin session). The live `role` is re-read
 * from the DB rather than trusted from the JWT claim, so a role downgrade
 * takes effect immediately and a forged/stale claim can't escalate.
 *
 * Routes without `@AdminRoles` are unaffected (any authenticated admin).
 */
@Injectable()
export class AdminRolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<AdminRole[] | undefined>(ADMIN_ROLES_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (!required || required.length === 0) return true;

    const req = ctx.switchToHttp().getRequest<Request>();
    const sub = req.adminSession?.sub;
    if (!sub) throw new UnauthorizedException('Admin sign-in required.');

    const admin = await controlDb.adminUser.findUnique({
      where: { id: sub },
      select: { role: true, status: true, disabledAt: true },
    });
    if (!admin || admin.disabledAt || admin.status !== 'active') {
      throw new ForbiddenException('Your admin account is no longer active.');
    }
    if (!required.includes(admin.role as AdminRole)) {
      throw new ForbiddenException('This action requires an owner-level admin.');
    }
    return true;
  }
}
