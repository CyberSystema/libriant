import { beforeEach, describe, expect, it, vi } from 'vitest';

const { findUnique } = vi.hoisted(() => ({ findUnique: vi.fn() }));
vi.mock('@libriant/db-control', () => ({
  controlDb: { tenant: { findUnique } },
}));

import { AdminTenantsController } from './admin-tenants.controller.js';
import { ADMIN_ROLES_KEY } from './admin-roles.decorator.js';

/**
 * tenant-isolation-01. The detail route returned the tenant's Postgres URL —
 * password and all — to any authenticated admin. Both halves are asserted here:
 * the credential must not be selected, and the route must be owner-gated.
 */

const DB_URL = 'postgresql://libriant:hunter2@10.0.0.5:5432/tenant_cmt5n4wv7ed';

/** Behave like Prisma: return exactly the columns the caller selected. */
function prismaLike(select: Record<string, unknown>): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  for (const key of Object.keys(select)) {
    row[key] =
      key === 'dbUrl' ? DB_URL : key === 'storageUrl' ? 'file:///srv/libriant/t1' : `v:${key}`;
  }
  return row;
}

function controller(): AdminTenantsController {
  // The route under test touches none of the injected collaborators.
  return new AdminTenantsController(undefined as never, undefined as never, undefined as never);
}

describe('AdminTenantsController.get (tenant-isolation-01)', () => {
  beforeEach(() => {
    findUnique.mockReset();
    findUnique.mockImplementation(async (args: { select: Record<string, unknown> }) =>
      prismaLike(args.select),
    );
  });

  it('does not select the tenant connection string or storage URL', async () => {
    await controller().get('t1');
    const { select } = findUnique.mock.calls[0]![0] as { select: Record<string, unknown> };
    expect(select).not.toHaveProperty('dbUrl');
    expect(select).not.toHaveProperty('storageUrl');
  });

  it('returns no credential in the response body', async () => {
    const { tenant } = await controller().get('t1');
    const body = JSON.stringify(tenant);
    expect(body).not.toContain('postgresql://');
    expect(body).not.toContain('hunter2');
    // Still the metadata the panel renders.
    expect(tenant).toMatchObject({ id: 'v:id', slug: 'v:slug', cellId: 'v:cellId' });
  });

  it('is owner-only — a support admin must not reach it', () => {
    const roles = Reflect.getMetadata(
      ADMIN_ROLES_KEY,
      AdminTenantsController.prototype.get,
    ) as string[];
    expect(roles).toEqual(['owner']);
  });
});
