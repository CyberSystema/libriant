import { SetMetadata } from '@nestjs/common';

export type AdminRole = 'owner' | 'support';

export const ADMIN_ROLES_KEY = 'adminRoles';

/**
 * Restrict a route (or controller) to specific admin roles. Use together with
 * `AdminRolesGuard`. With no decorator, a route is reachable by any
 * authenticated admin (the previous behaviour) — so this is opt-in per route.
 *
 *   @AdminRoles('owner')   // owner-only platform mutation
 */
export const AdminRoles = (...roles: AdminRole[]) => SetMetadata(ADMIN_ROLES_KEY, roles);
