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
 * The library role a Libriant admin acts as inside a consented support window.
 *
 * authn-authz-05 left `if (req.impersonation) return true;` in place — a
 * blanket bypass that satisfied EVERY `@Roles(...)` annotation on the tenant
 * API — and narrowed what it reached with a path fence
 * (`support/impersonation-policy.ts`), which the fence's own docblock records
 * as "not the whole fix". authn-authz-04 then showed the bypass being reached
 * by an admin who had already been offboarded.
 *
 * This is the allowlist that replaces it. Support is granted the `admin` role
 * and nothing more, and the ordinary `roles.includes(...)` test decides — the
 * same expression, for support and for a signed-in librarian alike, so there is
 * no second code path to forget. Consequences, both intended:
 *
 *   • `@StaffWrite()` and `@Roles('owner','admin')` routes stay reachable —
 *     support has to be able to fix the library's records, which is what the
 *     window is for.
 *   • A route annotated `@Roles('owner')` is REFUSED under impersonation, on
 *     the day it is written, without anyone remembering this file. There is no
 *     such route today; that is precisely why the rule has to be in place
 *     before the first one exists, because a blanket `return true` would have
 *     handed it over silently.
 *
 * Support access is a four-hour, library-revocable window over someone else's
 * data. "Whatever the owner can do" is not what the library consented to.
 */
const IMPERSONATION_EFFECTIVE_ROLE: UserRole = 'admin';

/**
 * Library-role guard. Runs AFTER `TenantGuard` (which proves the caller belongs
 * to this tenant). Reads the role required by `@Roles(...)` and checks it
 * against the user's CURRENT role in the DB — not the JWT, which can be stale
 * after an admin changes someone's role.
 *
 * An impersonating Libriant admin (support session) is checked against
 * {@link IMPERSONATION_EFFECTIVE_ROLE} rather than waved through.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  // `Reflector` is stateless (it just reads metadata via `Reflect.getMetadata`),
  // so we construct it directly instead of relying on DI. NestJS instantiates a
  // `@UseGuards(RolesGuard)` standalone when the guard isn't in the controller
  // module's provider graph — and a standalone instance would get no injected
  // Reflector, making every role-guarded route 500. This keeps it dep-free,
  // exactly like TenantGuard.
  private readonly reflector = new Reflector();

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const roles = this.reflector.getAllAndOverride<UserRole[]>(ROLES_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (!roles || roles.length === 0) return true;

    const req = ctx.switchToHttp().getRequest<Request>();
    if (req.impersonation) {
      // No fall-through to the session branch: an impersonated request has no
      // tenant session by design, so reaching that branch would 401 support
      // rather than answer the role question.
      if (roles.includes(IMPERSONATION_EFFECTIVE_ROLE)) return true;
      throw new ForbiddenException(
        'Support access cannot perform this action. It is restricted to the library owner, and a ' +
          'support session acts with library-admin rights only. Ask an owner to do it from their ' +
          'own account.',
      );
    }
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
