import { SetMetadata } from '@nestjs/common';
import { isPermissionKey } from '@libriant/shared/permissions';

export const PERMISSION_KEY = 'libriant_permission';
export const PUBLIC_WITHIN_TENANT_KEY = 'libriant_public_within_tenant';

export interface PermissionRequirement {
  readonly permission: string;
  /**
   * Name of a numeric field to check against the holder's ceiling.
   *
   * `@RequirePermission('circ.fee.waive', { limitFrom: 'amountCents' })` reads
   * `amountCents` from the request body (falling back to params, then query)
   * and refuses when it exceeds what the caller was granted. Absent, the
   * permission is a plain may/may-not.
   */
  readonly limitFrom?: string;
}

/**
 * The permission a route requires.
 *
 * Every tenant-scoped route carries exactly one of these or
 * {@link PublicWithinTenant}. `pnpm check:permissions` fails the build on a
 * handler that carries neither — because the failure mode of forgetting is a
 * route that anyone signed into the library can call, and nothing reports it.
 *
 * A class-level decorator applies to every handler in the controller; a
 * handler-level one overrides it.
 */
export const RequirePermission = (permission: string, opts: { limitFrom?: string } = {}) => {
  if (!isPermissionKey(permission)) {
    // Thrown at import time, so a typo cannot reach a running server. A key
    // that is not in the catalog can never be granted, so the route would be
    // permanently unreachable and would look like a permissions bug forever.
    throw new Error(
      `@RequirePermission('${permission}') is not a key in @libriant/shared/permissions. ` +
        `Add it to the catalog, or fix the typo.`,
    );
  }
  return SetMetadata(PERMISSION_KEY, { permission, limitFrom: opts.limitFrom });
};

/**
 * This route is open to anyone signed in to the library, whatever their role.
 *
 * DELIBERATE, and rare. It exists so "I forgot" and "everyone may" are
 * different states in the source — an undecorated handler is a build failure,
 * not a silently-open route. `TenantGuard` still applies: "public" here means
 * public within the tenant, never public to the internet.
 */
export const PublicWithinTenant = () => SetMetadata(PUBLIC_WITHIN_TENANT_KEY, true);
