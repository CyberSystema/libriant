import { SetMetadata } from '@nestjs/common';

export type AdminRole = 'owner' | 'support';

export const ADMIN_ROLES_KEY = 'adminRoles';

/** Every tier, most privileged first. */
export const ADMIN_ROLES: readonly AdminRole[] = ['owner', 'support'];

/**
 * Restrict a route (or controller) to specific admin roles. Use together with
 * `AdminRolesGuard`.
 *
 *   @AdminRoles('owner')   // owner-only platform mutation
 *
 * A route that carries the guard and NO decorator is owner-only — see
 * admin-route-roles.ts for why the default flipped from open to closed
 * (authn-authz-14). If a route really is meant for every tier, say so with
 * {@link AnyAdmin} rather than by leaving it undecorated: the reader of a
 * bare route cannot tell "every tier is fine" from "nobody thought about it".
 */
export const AdminRoles = (...roles: AdminRole[]) => SetMetadata(ADMIN_ROLES_KEY, roles);

/** Explicitly reachable by any authenticated admin, support tier included. */
export const AnyAdmin = () => AdminRoles(...ADMIN_ROLES);
