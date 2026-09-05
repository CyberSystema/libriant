import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { getPermission } from '@libriant/shared/permissions';
import {
  PERMISSION_KEY,
  PUBLIC_WITHIN_TENANT_KEY,
  type PermissionRequirement,
} from './permission.decorator.js';
import './permission-context.js';
import { PermissionsService, type EffectivePermissions } from './permissions.service.js';

/**
 * The permission check. Runs AFTER `TenantGuard`, which proves the caller
 * belongs to this tenant.
 *
 * REPLACES `RolesGuard` on every tenant-scoped route. The decision is
 * identical for all four shipped roles — asserted route by route in
 * `authorization-matrix.spec.ts` against the live Nest router, with the old
 * behaviour committed beside it as a frozen record.
 *
 * IT FAILS CLOSED IN THREE DIRECTIONS, and each one is a real failure mode:
 *
 *   No metadata on the handler. A route with neither `@RequirePermission` nor
 *   `@PublicWithinTenant` is refused, not allowed. Forgetting the decorator is
 *   the likeliest mistake anyone will make here, and its natural consequence —
 *   a route open to every signed-in member of the library — is invisible.
 *   `pnpm check:permissions` also fails the build, so this is the second line.
 *
 *   No session. Refused.
 *
 *   Resolution produced nothing. An empty permission set denies everything,
 *   including for a user whose tenant is missing its seeded roles. That is
 *   loud and recoverable; the alternative — falling back to the shipped
 *   template — would mean a library with a broken roles table behaves as
 *   though it is not.
 *
 * SUPPORT IS NARROWER THAN ADMIN. An impersonating Libriant admin resolves
 * against the platform's `support` template, never against the tenant's own
 * rows: a library that has customised `admin` does not thereby change what
 * support can see, and support cannot export a patron's data, manage staff or
 * configure identity. `RolesGuard` gave it the whole `admin` role.
 */
@Injectable()
export class PermissionGuard implements CanActivate {
  // Constructed directly, exactly as TenantGuard and RolesGuard do: NestJS
  // instantiates a `@UseGuards(PermissionGuard)` standalone when the guard is
  // not in the controller module's provider graph, and an injected Reflector
  // would then be undefined and 500 every route it protects.
  private readonly reflector = new Reflector();

  constructor(@Inject(PermissionsService) private readonly permissions: PermissionsService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request>();

    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_WITHIN_TENANT_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (isPublic) return true;

    const requirement = this.reflector.getAllAndOverride<PermissionRequirement>(PERMISSION_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (!requirement) {
      throw new ForbiddenException(
        'This action is not available. (No permission is declared for this route, so it is ' +
          'refused; this is a bug, not a policy.)',
      );
    }

    const held = await this.resolve(ctx, req);
    // Handed to the request so a service can enforce a ceiling on a value only
    // it knows — see assertWithinLimit in permission-context.ts.
    req.permissions = held;
    if (!held.keys.has(requirement.permission)) {
      throw new ForbiddenException(this.denial(requirement.permission, req));
    }

    if (requirement.limitFrom) {
      const ceiling = held.limits.get(requirement.permission);
      // `null` is "no ceiling". `undefined` cannot happen — the key is held —
      // but treat it as unlimited rather than throwing, because the key check
      // above is the authority on whether it is held.
      if (ceiling !== null && ceiling !== undefined) {
        const requested = readNumeric(req, requirement.limitFrom);
        if (requested !== null && requested > ceiling) {
          throw new ForbiddenException(
            `This is above your limit for this action. You may go up to ${ceiling}, and this ` +
              `is ${requested}. Ask someone with a higher limit.`,
          );
        }
      }
    }

    return true;
  }

  private async resolve(ctx: ExecutionContext, req: Request): Promise<EffectivePermissions> {
    if (req.impersonation) return this.permissions.supportPermissions();
    if (!req.session) throw new UnauthorizedException('Please sign in to access this library.');
    if (!req.tenant) {
      // Unreachable behind TenantGuard, and refused rather than assumed:
      // resolving permissions needs the tenant's own database.
      throw new ForbiddenException('This action is not available.');
    }
    void ctx;
    return this.permissions.forUser(req.tenant, req.session.sub);
  }

  private denial(permission: string, req: Request): string {
    const descriptor = getPermission(permission);
    const what = descriptor ? descriptor.label.toLowerCase() : permission;
    if (req.impersonation) {
      return (
        `Support access cannot ${what}. A support session acts with a deliberately narrower ` +
        `role than a library administrator. Ask someone at the library to do it from their ` +
        `own account.`
      );
    }
    return `You do not have permission to ${what}.`;
  }
}

/**
 * Pull a number out of the request for a limit check.
 *
 * Body first, then route params, then query — the order a mutating route
 * actually carries its amount. A value that is absent or not a number returns
 * `null` and the limit is not applied: the route's own validation owns
 * "that is not a number", and a guard that refused on a malformed body would
 * report a permissions problem for a validation one.
 */
function readNumeric(req: Request, field: string): bigint | null {
  const sources: unknown[] = [
    (req.body as Record<string, unknown> | undefined)?.[field],
    (req.params as Record<string, unknown> | undefined)?.[field],
    (req.query as Record<string, unknown> | undefined)?.[field],
  ];
  for (const raw of sources) {
    if (raw === undefined || raw === null) continue;
    if (typeof raw === 'bigint') return raw;
    if (typeof raw === 'number') return Number.isFinite(raw) ? BigInt(Math.trunc(raw)) : null;
    if (typeof raw === 'string' && /^-?\d+$/.test(raw.trim())) return BigInt(raw.trim());
    return null;
  }
  return null;
}
