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
import { ADMIN_ROLES, ADMIN_ROLES_KEY, type AdminRole } from './admin-roles.decorator.js';
import { adminRouteRoles } from './admin-route-roles.js';

/**
 * Enforce `@AdminRoles(...)` on admin routes. Runs AFTER `AdminAuthGuard`
 * (which proves a valid, active admin session). The live `role` is re-read
 * from the DB rather than trusted from the JWT claim, so a role downgrade
 * takes effect immediately and a forged/stale claim can't escalate.
 *
 * A route that carries this guard and declares NO roles is owner-only. It used
 * to be the opposite — `if (!required) return true` — which made
 * `@UseGuards(AdminAuthGuard, AdminRolesGuard)` with a forgotten `@AdminRoles`
 * read as defended and behave as open; `GET /admin/applications.csv` shipped
 * that way and handed the support tier every applicant's name, email and phone
 * (authn-authz-14). The routes that are genuinely any-admin are named in
 * admin-route-roles.ts, which also explains why the list is keyed on the
 * controller class instead of the URL.
 */
@Injectable()
export class AdminRolesGuard implements CanActivate {
  // Construct Reflector DIRECTLY (no DI) — matching the tenant RolesGuard.
  // A `@UseGuards(AdminRolesGuard)` class reference can be instantiated as a
  // standalone (outside the controller module's provider graph), and under tsx
  // (esbuild emits no `design:paramtypes`) constructor injection of Reflector
  // yields `undefined` → every guarded admin route 500s on
  // `reflector.getAllAndOverride`. Reflector is stateless, so this is safe.
  private readonly reflector = new Reflector();

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const declared = this.reflector.getAllAndOverride<AdminRole[] | undefined>(ADMIN_ROLES_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    const required =
      declared && declared.length > 0
        ? declared
        : adminRouteRoles(ctx.getClass().name, ctx.getHandler().name);
    // A route open to every tier has nothing left to check: AdminAuthGuard has
    // already proved this request carries a live, active, non-locked admin, and
    // it re-read the same row to do it. Returning here keeps the any-admin
    // routes at exactly the query count they had before the default flipped —
    // the alternative is a second findUnique on every fleet page load.
    if (ADMIN_ROLES.every((r) => required.includes(r))) return true;

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
