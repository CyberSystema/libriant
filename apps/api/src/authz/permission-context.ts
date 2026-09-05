import { createParamDecorator, ExecutionContext, ForbiddenException } from '@nestjs/common';
import type { Request } from 'express';
import { getPermission } from '@libriant/shared/permissions';
import type { EffectivePermissions } from './permissions.service.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /**
       * Populated by `PermissionGuard`. Undefined on any route it does not
       * protect, so a service must never read it optimistically.
       */
      permissions?: EffectivePermissions;
    }
  }
}

/**
 * Enforce a numeric ceiling where the amount is only known after a database read.
 *
 * `PermissionGuard` can check a limit that arrives IN the request —
 * `@RequirePermission(key, { limitFrom: 'amountCents' })`. It cannot check one
 * that does not: waiving a fine sends only the fine's id, and the amount lives
 * on the row. A guard that loaded the fine to find out would be doing the
 * service's work a second time, on every request, and would still be reading a
 * value the service is about to re-read inside its own transaction.
 *
 * So the guard resolves the permissions and hands them to the request, and the
 * service asks HERE, once it knows the number. One helper rather than an
 * inline comparison per call site, so the refusal message is the same wherever
 * a ceiling bites and there is one place to change it.
 */
export function assertWithinLimit(
  req: Pick<Request, 'permissions'>,
  permission: string,
  amount: bigint | number,
): void {
  const held = req.permissions;
  // No permissions on the request means this route is not behind
  // PermissionGuard. Refuse rather than assume: a limit check that silently
  // does nothing is worse than one that is missing, because it reads as
  // enforced.
  if (!held) {
    throw new ForbiddenException(
      'This action is not available. (No permissions were resolved for this request, so the ' +
        'limit could not be checked; this is a bug, not a policy.)',
    );
  }
  const ceiling = held.limits.get(permission);
  if (ceiling === null || ceiling === undefined) return; // Held with no ceiling.
  const requested = typeof amount === 'bigint' ? amount : BigInt(Math.trunc(amount));
  if (requested <= ceiling) return;

  const label = getPermission(permission)?.label.toLowerCase() ?? permission;
  throw new ForbiddenException(
    `This is above your limit. You may ${label} up to ${ceiling}, and this is ${requested}. ` +
      `Ask someone with a higher limit.`,
  );
}

/**
 * The permissions `PermissionGuard` resolved for this request.
 *
 * A service cannot reach the request, so a route whose ceiling depends on a
 * value only the service knows takes them as an argument. Undefined is
 * impossible on a route behind the guard, and {@link assertWithinLimit}
 * refuses rather than assumes if it ever is.
 */
export const ActorPermissions = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): EffectivePermissions | undefined =>
    ctx.switchToHttp().getRequest<Request>().permissions,
);
