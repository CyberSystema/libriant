import { ROLE_TEMPLATES } from '@libriant/shared/permissions';
import type { TenantPrismaClient } from './client.js';

/** Stable ids, so the reconciler addresses a role without a lookup. */
const SYSTEM_ROLE_ORDER = { owner: 10, admin: 20, librarian: 30, volunteer: 40 } as const;

export interface ReconcileResult {
  readonly created: number;
  readonly permissionsAdded: number;
}

/**
 * Bring a tenant's four built-in roles back in step with the shipped templates.
 *
 * WHY THIS EXISTS AT ALL. The authorization migration seeds the roles once,
 * with the permission list frozen the day it was written. Every phase after it
 * adds keys — acquisitions, ILL, the report builder — and a library that never
 * touched a built-in role should inherit them without anyone editing a row.
 *
 * IT ADDS AND NEVER REMOVES. A library that granted `circ.fee.waive` to its own
 * librarian role, or narrowed one of these, has made a decision. A seed script
 * that silently reverted it would be the worst kind of bug: invisible,
 * periodic, and about who may forgive money. Removing a key from a built-in
 * role is a migration written on purpose, not a side effect of seeding.
 *
 * WHY IT LIVES HERE AND NOT IN THE SEED SCRIPT. There were already two copies
 * of "seed a tenant's defaults" — `prisma/seed-defaults.ts` for the CLI and
 * `TenantProvisioningService.seedDefaults` for signup — and they had drifted
 * to the point that a tenant provisioned through the API got no role
 * reconciliation at all, while one seeded from the CLI did. The integration
 * suite caught it as an owner missing exactly one key. One implementation,
 * two callers.
 */
export async function reconcileSystemRoles(client: TenantPrismaClient): Promise<ReconcileResult> {
  let created = 0;
  let permissionsAdded = 0;

  for (const key of ['owner', 'admin', 'librarian', 'volunteer'] as const) {
    const template = ROLE_TEMPLATES[key];
    const id = `role_${key}`;
    const role = await client.role.upsert({
      where: { id },
      // Name and description follow the shipped template. Renaming a BUILT-IN
      // role is not a supported edit — it would make every support
      // conversation ambiguous — and custom roles are how a library gets its
      // own names.
      update: { name: template.name, description: template.description, isSystem: true },
      create: {
        id,
        key,
        name: template.name,
        description: template.description,
        isSystem: true,
        sortOrder: SYSTEM_ROLE_ORDER[key],
      },
      select: { createdAt: true, updatedAt: true },
    });
    if (role.createdAt.getTime() === role.updatedAt.getTime()) created += 1;

    const held = new Set(
      (
        await client.rolePermission.findMany({
          where: { roleId: id },
          select: { permissionKey: true },
        })
      ).map((p) => p.permissionKey),
    );
    const missing = template.permissions.filter((k) => !held.has(k));
    if (missing.length) {
      await client.rolePermission.createMany({
        data: missing.map((permissionKey) => ({ roleId: id, permissionKey })),
        skipDuplicates: true,
      });
      permissionsAdded += missing.length;
    }
  }

  return { created, permissionsAdded };
}
