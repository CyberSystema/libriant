import { randomBytes } from 'node:crypto';
import { ForbiddenException } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { controlDb } from '@libriant/db-control';
import {
  DEFAULT_TENANT_SETTINGS,
  makeTenantPrismaClient,
  type TenantPrismaClient,
} from '@libriant/db-tenant';
import { ROLE_TEMPLATES, SUPPORT_DENIED_KEYS } from '@libriant/shared/permissions';
import { TenantProvisioningService } from '../../src/provisioning/tenant-provisioning.service.js';
import { PermissionsService } from '../../src/authz/permissions.service.js';
import { assertWithinLimit } from '../../src/authz/permission-context.js';
import { RedisService } from '../../src/platform/redis.service.js';
import { TenantPrismaService } from '../../src/tenancy/tenant-prisma.service.js';
import { declareBillingPosture } from './billing-posture.js';

declareBillingPosture(
  'unenforced',
  'This provisions a database and resolves permissions. No plan gate is exercised.',
);

/**
 * Resolving what one person may do, against a real database.
 *
 * The matrix spec proves the MODEL agrees with the old role check. This proves
 * the RESOLVER — the part that reads a library's own rows and turns them into
 * a decision — and it is written around the ways that goes wrong rather than
 * the way it goes right:
 *
 *   A ceiling that is not enforced. `circ.fee.waive` with a limit of 500 must
 *   waive €5.00 and refuse €5.01, and the refusal must say the number, because
 *   "forbidden" with no figure sends the librarian to look for a bug.
 *
 *   A deny that can be out-voted. An override must beat every role that grants
 *   the same key, or an exception is not one.
 *
 *   Failing OPEN. A user who is disabled, who belongs to another tenant, or
 *   whose library is missing its seeded roles must resolve to NOTHING. The
 *   tempting fallback — "no rows, so use the shipped template" — would mean a
 *   library with a broken roles table behaves exactly as though it is not.
 *
 *   Redis being treated as the source of truth. An outage must cost a query,
 *   never a permission.
 */

const provisioning = new TenantProvisioningService();
const tenantId = `perm${randomBytes(6).toString('hex')}`;
const slug = `perm-${randomBytes(4).toString('hex')}`;

let db: TenantPrismaClient;
let permissions: PermissionsService;
let redis: RedisService;
let tenants: TenantPrismaService;
let tenant: { id: string; dbUrl: string };
const users: Record<string, string> = {};

async function makeUser(role: 'owner' | 'admin' | 'librarian' | 'volunteer'): Promise<string> {
  const u = await controlDb.user.create({
    data: {
      tenantId,
      fullName: `${role} tester`,
      username: `${role}-${randomBytes(4).toString('hex')}`,
      role,
      status: 'active',
    },
    select: { id: true },
  });
  return u.id;
}

beforeAll(async () => {
  const placement = await provisioning.provision({ tenantId, cellId: 'cell-eu-1' });
  tenant = { id: tenantId, dbUrl: placement.dbUrl };
  await controlDb.tenant.create({
    data: {
      id: tenantId,
      slug,
      name: 'Permission fixture',
      cellId: (await controlDb.cell.findFirstOrThrow({ select: { id: true } })).id,
      dbUrl: placement.dbUrl,
      storageUrl: placement.storageUrl,
      primaryEmail: `${slug}@example.test`,
    },
  });
  db = makeTenantPrismaClient({ databaseUrl: placement.dbUrl, maxPoolSize: 2 });

  redis = new RedisService();
  tenants = new TenantPrismaService();
  permissions = new PermissionsService(redis, tenants);

  for (const role of ['owner', 'admin', 'librarian', 'volunteer'] as const) {
    users[role] = await makeUser(role);
  }
}, 180_000);

afterAll(async () => {
  await db?.$disconnect().catch(() => undefined);
  await controlDb.user.deleteMany({ where: { tenantId } }).catch(() => undefined);
  await controlDb.tenant.delete({ where: { id: tenantId } }).catch(() => undefined);
  await provisioning.teardown(tenantId).catch(() => undefined);
  await tenants?.onModuleDestroy?.().catch(() => undefined);
  await redis?.onModuleDestroy?.().catch(() => undefined);
});

describe('what provisioning leaves behind', () => {
  it('seeds the settings row AND the four system roles, in one call', async () => {
    // `provision()` above is the real signup path. The assertion is here rather
    // than in a unit test because the defect it guards was not in any one
    // path's logic — it was that four provisioning paths each did their own
    // thing, and one of them (`scripts/tenant-create.ts`) did neither, so a
    // library created from the command line had no settings row at all.
    // `apps/api/src/provisioning/tenant-defaults.spec.ts` asserts that every
    // path calls the shared seed; this asserts the shared seed works.
    const settings = await db.tenantSetting.findUnique({ where: { id: 1 } });
    expect(settings, 'provisioning left no tenant_settings row').not.toBeNull();
    expect(settings).toMatchObject(DEFAULT_TENANT_SETTINGS);

    const roles = await db.role.findMany({
      where: { isSystem: true },
      select: { key: true },
      orderBy: { sortOrder: 'asc' },
    });
    expect(roles.map((r) => r.key)).toEqual(['owner', 'admin', 'librarian', 'volunteer']);
  });
});

describe('resolving a staff member’s permissions', () => {
  it('gives each shipped role exactly what its template holds', async () => {
    for (const role of ['owner', 'admin', 'librarian', 'volunteer'] as const) {
      const held = await permissions.forUser(tenant, users[role]!, { skipCache: true });
      expect([...held.keys].sort(), role).toEqual([...ROLE_TEMPLATES[role].permissions].sort());
    }
  }, 60_000);

  it('takes the highest ceiling when two roles grant the same key', async () => {
    // The library grants its librarian a EUR 5 waive limit, then also grants
    // that person a second role with a EUR 20 one. The union must be 20:
    // adding a role may not make someone LESS able than before.
    await db.rolePermission.upsert({
      where: {
        roleId_permissionKey: { roleId: 'role_librarian', permissionKey: 'circ.fee.waive' },
      },
      create: { roleId: 'role_librarian', permissionKey: 'circ.fee.waive', limitNum: 500n },
      update: { limitNum: 500n },
    });
    const senior = await db.role.create({
      data: {
        key: `senior-${randomBytes(3).toString('hex')}`,
        name: 'Senior desk',
        permissions: { create: [{ permissionKey: 'circ.fee.waive', limitNum: 2000n }] },
      },
      select: { id: true },
    });
    await db.staffRoleGrant.create({ data: { userId: users.librarian!, roleId: senior.id } });

    const held = await permissions.forUser(tenant, users.librarian!, { skipCache: true });
    expect(held.limits.get('circ.fee.waive')).toBe(2000n);

    await db.staffRoleGrant.deleteMany({ where: { roleId: senior.id } });
    await db.role.delete({ where: { id: senior.id } });
    // Put the librarian role back exactly as shipped. This test GRANTS a key
    // the template does not hold, and leaving it behind made a later test —
    // the one asserting the degraded path returns the template — fail on a
    // difference this test had created.
    await db.rolePermission.deleteMany({
      where: { roleId: 'role_librarian', permissionKey: 'circ.fee.waive' },
    });
  }, 60_000);

  it('enforces the ceiling, and the refusal says the number', () => {
    const held = { keys: new Set(['circ.fee.waive']), limits: new Map([['circ.fee.waive', 500n]]) };
    // EUR 5.00 — exactly the limit, which is allowed. A ceiling is inclusive;
    // "up to 500" that refuses 500 is a fencepost bug in someone's pay packet.
    expect(() => assertWithinLimit({ permissions: held }, 'circ.fee.waive', 500)).not.toThrow();
    expect(() => assertWithinLimit({ permissions: held }, 'circ.fee.waive', 499)).not.toThrow();
    try {
      assertWithinLimit({ permissions: held }, 'circ.fee.waive', 501);
      expect.unreachable('501 must be refused');
    } catch (err) {
      expect(err).toBeInstanceOf(ForbiddenException);
      const message = (err as ForbiddenException).message;
      expect(message).toContain('500');
      expect(message).toContain('501');
    }
  });

  it('treats a null ceiling as no ceiling, and a missing one as a bug', () => {
    const unlimited = {
      keys: new Set(['circ.fee.waive']),
      limits: new Map([['circ.fee.waive', null]]),
    };
    expect(() =>
      assertWithinLimit({ permissions: unlimited }, 'circ.fee.waive', 999_999),
    ).not.toThrow();
    // No permissions on the request means the route is not behind the guard.
    // Refuse: a limit check that silently does nothing reads as enforced.
    expect(() => assertWithinLimit({ permissions: undefined }, 'circ.fee.waive', 1)).toThrow(
      ForbiddenException,
    );
  });

  it('lets a deny override beat every role that grants the key', async () => {
    await db.staffPermissionOverride.create({
      data: { userId: users.admin!, permissionKey: 'circ.fee.waive', effect: 'deny' },
    });
    const held = await permissions.forUser(tenant, users.admin!, { skipCache: true });
    expect(held.keys.has('circ.fee.waive')).toBe(false);
    expect(held.limits.has('circ.fee.waive')).toBe(false);
    // ...and everything else the administrator role holds is untouched.
    expect(held.keys.has('circ.fee.void')).toBe(true);
    await db.staffPermissionOverride.deleteMany({ where: { userId: users.admin! } });
  }, 60_000);

  it('lets a grant override raise one person above their role', async () => {
    await db.staffPermissionOverride.create({
      data: {
        userId: users.volunteer!,
        permissionKey: 'circ.fee.waive',
        effect: 'grant',
        limitNum: 250n,
      },
    });
    const held = await permissions.forUser(tenant, users.volunteer!, { skipCache: true });
    expect(held.keys.has('circ.fee.waive')).toBe(true);
    expect(held.limits.get('circ.fee.waive')).toBe(250n);
    // A grant is not a promotion: nothing else moved.
    expect(held.keys.has('patron.write')).toBe(false);
    await db.staffPermissionOverride.deleteMany({ where: { userId: users.volunteer! } });
  }, 60_000);

  it('fails closed for a disabled user, a foreign user, and an unknown one', async () => {
    const disabled = await makeUser('admin');
    await controlDb.user.update({ where: { id: disabled }, data: { status: 'disabled' } });
    expect((await permissions.forUser(tenant, disabled, { skipCache: true })).keys.size).toBe(0);

    expect(
      (await permissions.forUser(tenant, 'no-such-user-id', { skipCache: true })).keys.size,
    ).toBe(0);

    // A real, active user of a DIFFERENT tenant holds nothing here.
    const other = await controlDb.user.findFirst({
      where: { tenantId: { not: tenantId }, status: 'active' },
      select: { id: true },
    });
    if (other) {
      expect((await permissions.forUser(tenant, other.id, { skipCache: true })).keys.size).toBe(0);
    }
  }, 60_000);

  it('fails closed when the library is missing its seeded roles', async () => {
    // Not a hypothetical: seeding can be skipped, and the tempting fallback —
    // "no row, so use the shipped template" — would hide it forever.
    await db.role.update({ where: { id: 'role_volunteer' }, data: { key: 'volunteer-parked' } });
    const held = await permissions.forUser(tenant, users.volunteer!, { skipCache: true });
    expect(held.keys.size).toBe(0);
    await db.role.update({ where: { id: 'role_volunteer' }, data: { key: 'volunteer' } });
  }, 60_000);

  it('resolves a warm cache fast enough for the request path', async () => {
    await permissions.forUser(tenant, users.librarian!); // prime
    const N = 200;
    const started = process.hrtime.bigint();
    for (let i = 0; i < N; i += 1) await permissions.forUser(tenant, users.librarian!);
    const perCallMs = Number(process.hrtime.bigint() - started) / N / 1e6;
    // Every request on the tenant surface pays this. The budget is 3 ms; the
    // assertion is deliberately loose because CI is noisy, and the number is
    // logged so a regression is visible even when it does not fail.
    // eslint-disable-next-line no-console
    console.log(`permission resolution: ${perCallMs.toFixed(3)} ms/call warm`);
    expect(perCallMs).toBeLessThan(3);
  }, 60_000);

  it('does not treat Redis as the source of truth', async () => {
    // Point the service at a Redis that is not there. Resolution must still
    // succeed from the tenant database — an outage costs a query, never a
    // permission — and must never fail OPEN either.
    const broken = {
      client: {
        get: () => Promise.reject(new Error('redis down')),
        set: () => Promise.reject(new Error('redis down')),
        del: () => Promise.reject(new Error('redis down')),
        incr: () => Promise.reject(new Error('redis down')),
      },
    } as unknown as RedisService;
    const degraded = new PermissionsService(broken, tenants);

    const held = await degraded.forUser(tenant, users.librarian!);
    expect([...held.keys].sort()).toEqual([...ROLE_TEMPLATES.librarian.permissions].sort());

    const nobody = await degraded.forUser(tenant, 'no-such-user-id');
    expect(nobody.keys.size).toBe(0);
  }, 60_000);

  it('gives support a narrower set than the administrator it impersonates', () => {
    const support = permissions.supportPermissions();
    for (const denied of SUPPORT_DENIED_KEYS) expect(support.keys.has(denied)).toBe(false);
    for (const key of ROLE_TEMPLATES.admin.permissions) {
      if (SUPPORT_DENIED_KEYS.includes(key)) continue;
      expect(support.keys.has(key), key).toBe(true);
    }
    // Resolved from the platform template, never from the tenant's rows: a
    // library that customises `admin` must not thereby widen support.
    expect(support.keys.size).toBe(ROLE_TEMPLATES.support.permissions.length);
  });
});
