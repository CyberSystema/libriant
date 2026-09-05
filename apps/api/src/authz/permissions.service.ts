import { Inject, Injectable, Logger } from '@nestjs/common';
import { controlDb } from '@libriant/db-control';
import type { UserRole } from '@libriant/db-control';
import { ROLE_TEMPLATES, type BuiltInRoleKey } from '@libriant/shared/permissions';
import { FailOpenMemo, RedisService } from '../platform/redis.service.js';
import type { TenantContext } from '../tenancy/tenant-context.js';
import { TenantPrismaService } from '../tenancy/tenant-prisma.service.js';

/**
 * What one person may do in one library.
 *
 * `keys` is the set of permissions held. `limits` carries a ceiling for the
 * keys that take one — `undefined` means the key is not held at all, `null`
 * means held with no ceiling, a number means held up to that value.
 */
export interface EffectivePermissions {
  readonly keys: ReadonlySet<string>;
  readonly limits: ReadonlyMap<string, bigint | null>;
}

interface CachedShape {
  readonly k: string[];
  /** key → limit, where `null` is "no ceiling". Only limit keys appear. */
  readonly l: Record<string, string | null>;
}

/**
 * The cache key carries a per-tenant VERSION, so invalidating a whole library
 * is one INCR rather than a SCAN over an unknown key space. Bumping the
 * version orphans every old entry, which then expires on its own TTL.
 */
const VERSION_KEY = (tenantId: string) => `perm:v:${tenantId}`;
const CACHE_KEY = (tenantId: string, version: string, userId: string) =>
  `perm:${tenantId}:${version}:${userId}`;
/** Short. A permission change must reach the desk in seconds, not minutes. */
const CACHE_TTL_SEC = 30;
/** Only consulted while Redis is unreachable, to keep a herd off the tenant DB. */
const DEGRADED_TTL_MS = 5_000;

/**
 * Resolves a staff member's effective permissions.
 *
 * THE RESOLUTION, in order:
 *
 *   1. The control-plane `users.role` maps onto the system role of the same
 *      key. This is what makes the whole model land with NO per-user data
 *      migration: every existing staff account resolves through it, and
 *      `staff_role_grants` stays empty until a library customises something.
 *   2. Any ADDITIONAL roles granted in `staff_role_grants` — permissions are
 *      the union, and for a limit key the HIGHEST ceiling wins.
 *   3. Per-person overrides. `deny` beats every grant, always; that asymmetry
 *      is the point of an exception. A `grant` override REPLACES the
 *      role-derived ceiling rather than adding to it.
 *
 * IT FAILS CLOSED. Every path that cannot produce an answer produces an empty
 * set, and `PermissionGuard` refuses. Redis being down is not such a path —
 * the tenant database is the source of truth and is still there — so an outage
 * costs a query, never a permission.
 */
@Injectable()
export class PermissionsService {
  private readonly logger = new Logger(PermissionsService.name);
  private readonly degraded = new FailOpenMemo<EffectivePermissions>(DEGRADED_TTL_MS, 2000);

  constructor(
    @Inject(RedisService) private readonly redis: RedisService,
    @Inject(TenantPrismaService) private readonly tenants: TenantPrismaService,
  ) {}

  /**
   * The permissions a Libriant admin holds inside a consented support window.
   *
   * Resolved from the shipped template and NEVER from the tenant database: it
   * is a platform-defined role, so a library cannot widen it by editing a row,
   * and a library that has customised `admin` does not thereby change what
   * support can see. It is `admin` minus a patron's personal data, staff
   * management and identity configuration — see SUPPORT_DENIED_KEYS.
   */
  supportPermissions(): EffectivePermissions {
    return templateOf('support');
  }

  async forUser(
    tenant: Pick<TenantContext, 'id' | 'dbUrl'>,
    userId: string,
    opts: { skipCache?: boolean } = {},
  ): Promise<EffectivePermissions> {
    const tenantId = tenant.id;
    const version = await this.version(tenantId);
    const cacheKey = CACHE_KEY(tenantId, version, userId);
    if (!opts.skipCache) {
      const hit = await this.readCache(cacheKey);
      if (hit) return hit;
    }

    const resolved = await this.resolve(tenant, userId);
    await this.writeCache(cacheKey, resolved);
    return resolved;
  }

  /** Drop the cache for one user, or for every user of a tenant. */
  async invalidate(tenantId: string, userId?: string): Promise<void> {
    try {
      if (userId) {
        const version = await this.version(tenantId);
        const key = CACHE_KEY(tenantId, version, userId);
        this.degraded.delete(key);
        await this.redis.client.del(key);
        return;
      }
      // One INCR orphans every cached entry for the tenant at once.
      await this.redis.client.incr(VERSION_KEY(tenantId));
    } catch (err) {
      // Loud: the caller asked for a change to take effect and it has not.
      // While Redis is unreachable the degraded memo still holds entries, and
      // they expire on their own 5s TTL — so the worst case is bounded and
      // short, but it is not zero and nobody should discover that by surprise.
      this.logger.warn(
        `Could not invalidate permission cache for ${tenantId}: ${(err as Error).message}. ` +
          `Changes take effect within ${DEGRADED_TTL_MS / 1000}s.`,
      );
    }
  }

  /**
   * The tenant's cache generation. Missing or unreachable resolves to `0`,
   * which is a correct answer: it only ever costs cache hits, never a wrong
   * permission, because the entry it addresses was written under the same
   * assumption.
   */
  private async version(tenantId: string): Promise<string> {
    try {
      return (await this.redis.client.get(VERSION_KEY(tenantId))) ?? '0';
    } catch {
      return '0';
    }
  }

  private async resolve(
    tenant: Pick<TenantContext, 'id' | 'dbUrl'>,
    userId: string,
  ): Promise<EffectivePermissions> {
    const tenantId = tenant.id;
    const user = await controlDb.user.findUnique({
      where: { id: userId },
      select: { role: true, status: true, tenantId: true },
    });
    // A user who is not an active member of THIS tenant holds nothing. The
    // tenant check is belt-and-braces behind TenantGuard, which already
    // compares the session's `tid`; it is here because this method is also
    // reachable from jobs and scripts that have no request.
    if (!user || user.tenantId !== tenantId || user.status !== 'active') {
      return EMPTY;
    }

    const db = await this.tenants.getClient(tenant);

    const [roleRows, grants, overrides] = await Promise.all([
      db.role.findMany({
        where: { archivedAt: null },
        select: {
          id: true,
          key: true,
          permissions: { select: { permissionKey: true, limitNum: true } },
        },
      }),
      db.staffRoleGrant.findMany({ where: { userId }, select: { roleId: true } }),
      db.staffPermissionOverride.findMany({
        where: { userId },
        select: { permissionKey: true, effect: true, limitNum: true },
      }),
    ]);

    const byId = new Map(roleRows.map((r) => [r.id, r]));
    const byKey = new Map(roleRows.map((r) => [r.key, r]));

    const active: typeof roleRows = [];
    const base = byKey.get(user.role as UserRole);
    if (base) active.push(base);
    else {
      // The system role is missing from this tenant's database — seeding did
      // not run, or someone deleted it past the CHECK. Fail closed and say so:
      // silently falling back to the shipped template would mean a library
      // whose roles table is broken behaves as though it is not.
      this.logger.error(
        `Tenant ${tenantId} has no live role with key "${user.role}". User ${userId} resolves ` +
          `to NO permissions. Run \`pnpm tenant:seed:defaults\` against this tenant.`,
      );
      return EMPTY;
    }
    for (const g of grants) {
      const r = byId.get(g.roleId);
      if (r) active.push(r);
    }

    const keys = new Set<string>();
    const limits = new Map<string, bigint | null>();
    for (const role of active) {
      for (const p of role.permissions) {
        keys.add(p.permissionKey);
        if (limits.has(p.permissionKey)) {
          const existing = limits.get(p.permissionKey) ?? null;
          // Union of roles means the MOST permissive ceiling wins; `null` is
          // unlimited and therefore beats every number.
          if (existing === null || p.limitNum === null) limits.set(p.permissionKey, null);
          else if (p.limitNum !== null && p.limitNum > existing)
            limits.set(p.permissionKey, p.limitNum);
        } else {
          limits.set(p.permissionKey, p.limitNum);
        }
      }
    }

    for (const o of overrides) {
      if (o.effect === 'deny') {
        keys.delete(o.permissionKey);
        limits.delete(o.permissionKey);
      } else {
        keys.add(o.permissionKey);
        limits.set(o.permissionKey, o.limitNum);
      }
    }

    return { keys, limits };
  }

  private async readCache(key: string): Promise<EffectivePermissions | null> {
    try {
      const raw = await this.redis.client.get(key);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as CachedShape;
      return {
        keys: new Set(parsed.k),
        limits: new Map(
          Object.entries(parsed.l).map(([k, v]) => [k, v === null ? null : BigInt(v)]),
        ),
      };
    } catch {
      return this.degraded.get(key);
    }
  }

  private async writeCache(key: string, value: EffectivePermissions): Promise<void> {
    const shape: CachedShape = {
      k: [...value.keys],
      l: Object.fromEntries([...value.limits].map(([k, v]) => [k, v === null ? null : String(v)])),
    };
    try {
      await this.redis.client.set(key, JSON.stringify(shape), 'EX', CACHE_TTL_SEC);
    } catch {
      this.degraded.set(key, value);
    }
  }
}

const EMPTY: EffectivePermissions = { keys: new Set(), limits: new Map() };

function templateOf(key: BuiltInRoleKey): EffectivePermissions {
  const t = ROLE_TEMPLATES[key];
  return {
    keys: new Set(t.permissions),
    // A template grants no ceiling: support and the shipped roles are
    // unlimited on the keys they hold. A library narrows that with a limit on
    // its own role rows.
    limits: new Map(t.permissions.map((k) => [k, null])),
  };
}
