import { SetMetadata } from '@nestjs/common';
import type { UserRole } from '@libriant/db-control';

export const ROLES_KEY = 'tenant_roles';

/**
 * Restrict a tenant route (or whole controller) to specific library roles.
 * Use with `RolesGuard`, after `TenantGuard`. Day-to-day work (catalog,
 * members, loans, reservations) carries no `@Roles` and stays open to all
 * roles; "control the library" actions use `@Roles('owner', 'admin')`.
 */
export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES_KEY, roles);
