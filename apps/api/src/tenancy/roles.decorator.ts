import { SetMetadata } from '@nestjs/common';
import type { UserRole } from '@libriant/db-control';

export const ROLES_KEY = 'tenant_roles';

/**
 * Restrict a tenant route (or whole controller) to specific library roles.
 * Use with `RolesGuard`, after `TenantGuard`. Reads carry no `@Roles` and stay
 * open to all roles; "control the library" actions use `@Roles('owner', 'admin')`.
 */
export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES_KEY, roles);

/**
 * A2-01: the role set allowed to CREATE/EDIT/ARCHIVE core library data
 * (catalog, copies, authors, members, loans, reservations, custom records).
 * Excludes `volunteer` — a deliberately limited role that may READ everything
 * but must not mutate. Apply to every mutating handler on those controllers;
 * GET handlers stay un-annotated so volunteers keep read access.
 */
export const StaffWrite = () => Roles('owner', 'admin', 'librarian');
