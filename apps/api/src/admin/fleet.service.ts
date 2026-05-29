import { statfs } from 'node:fs/promises';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { controlDb } from '@libriant/db-control';
import { loadEnv } from '../config/env.js';
import { RedisService } from '../platform/redis.service.js';
import { type FleetTenantRow, formatBytes, summarizeTenants } from './fleet-summary.js';

/** Mirrors `TenantProvisioningService.dbNameFor` so we can map a tenant to its DB. */
function dbNameFor(tenantId: string): string {
  return `tenant_${tenantId.replace(/[^a-z0-9_]/gi, '_').toLowerCase()}`;
}

export type FleetOverview =
  ReturnType<FleetService['getOverview']> extends Promise<infer T> ? T : never;

/**
 * Read-only fleet/capacity snapshot for operators: how many libraries exist
 * (by status / plan / cell), how big each one is (DB + storage), and how
 * close the host is to its limits (Postgres connections + cache hit ratio,
 * Redis memory, disk on the storage volume).
 *
 * Everything here is a cheap aggregate; it's safe to poll occasionally but
 * NOT on a hot path (the `pg_database_size` sweep touches every DB).
 */
@Injectable()
export class FleetService {
  private readonly logger = new Logger(FleetService.name);

  constructor(@Inject(RedisService) private readonly redis: RedisService) {}

  async getOverview() {
    const [tenants, dbSizes, conn, perDbConn, cache, redis, disk] = await Promise.all([
      this.loadTenants(),
      this.dbSizes(),
      this.connectionStats(),
      this.perDatabaseConnections(),
      this.cacheHitRatio(),
      this.redisStats(),
      this.diskStats(),
    ]);

    const rows: FleetTenantRow[] = tenants.map((t) => ({
      id: t.id,
      slug: t.slug,
      name: t.name,
      status: t.status,
      cellSlug: t.cell?.slug ?? t.cellId,
      planSlug: t.subscription?.plan?.slug ?? null,
      storageBytes: Number(t.storageUsedBytes),
      dbBytes: dbSizes.get(dbNameFor(t.id)) ?? 0,
      createdAt: t.createdAt,
    }));

    const census = summarizeTenants(rows);
    const controlDbBytes = dbSizes.get('libriant_control') ?? 0;
    const tenantDbTotalBytes = census.totalDbBytes;

    // Per-tenant list, heaviest first — the ones to watch / relocate.
    const perTenant = rows
      .map((r) => ({
        slug: r.slug,
        name: r.name,
        status: r.status,
        plan: r.planSlug,
        cell: r.cellSlug,
        dbBytes: r.dbBytes,
        storageBytes: r.storageBytes,
        totalBytes: r.dbBytes + r.storageBytes,
      }))
      .sort((a, b) => b.totalBytes - a.totalBytes);

    const connectionsUsedPct =
      conn.max > 0 ? Math.round((conn.total / conn.max) * 1000) / 10 : null;
    const diskUsedPct =
      disk && disk.totalBytes > 0
        ? Math.round(((disk.totalBytes - disk.freeBytes) / disk.totalBytes) * 1000) / 10
        : null;

    return {
      generatedAt: new Date().toISOString(),
      tenants: census,
      database: {
        controlDbBytes,
        tenantDbCount: rows.filter((r) => r.dbBytes > 0).length,
        tenantDbTotalBytes,
        connections: {
          total: conn.total,
          max: conn.max,
          usedPct: connectionsUsedPct,
          // Top databases by open connections — spot a saturating tenant or
          // a too-large PgBouncer pool early.
          topByDatabase: perDbConn.slice(0, 10),
        },
        cacheHitRatio: cache, // null until there's traffic; target > 0.99
      },
      redis,
      disk, // null if statfs unavailable (e.g. STORAGE_ROOT missing)
      signals: {
        connectionsUsedPct,
        cacheHitRatio: cache,
        diskUsedPct,
      },
      perTenant,
    };
  }

  // ---- gatherers ----------------------------------------------------------

  private async loadTenants() {
    return controlDb.tenant.findMany({
      select: {
        id: true,
        slug: true,
        name: true,
        status: true,
        cellId: true,
        storageUsedBytes: true,
        createdAt: true,
        cell: { select: { slug: true } },
        subscription: { select: { plan: { select: { slug: true } } } },
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  /** datname → bytes, for the control DB and every `tenant_*` DB. */
  private async dbSizes(): Promise<Map<string, number>> {
    const rows = await controlDb.$queryRaw<Array<{ datname: string; bytes: number }>>`
      SELECT datname, pg_database_size(datname)::float8 AS bytes
      FROM pg_database
      WHERE datname = 'libriant_control' OR datname LIKE 'tenant_%'`;
    return new Map(rows.map((r) => [r.datname, Number(r.bytes)]));
  }

  private async connectionStats(): Promise<{ total: number; max: number }> {
    const rows = await controlDb.$queryRaw<Array<{ total: number; max_conn: number }>>`
      SELECT
        (SELECT count(*)::int FROM pg_stat_activity) AS total,
        (SELECT setting::int FROM pg_settings WHERE name = 'max_connections') AS max_conn`;
    const r = rows[0];
    return { total: Number(r?.total ?? 0), max: Number(r?.max_conn ?? 0) };
  }

  private async perDatabaseConnections(): Promise<Array<{ datname: string; conns: number }>> {
    const rows = await controlDb.$queryRaw<Array<{ datname: string; conns: number }>>`
      SELECT datname, count(*)::int AS conns
      FROM pg_stat_activity
      WHERE datname IS NOT NULL
      GROUP BY datname
      ORDER BY conns DESC`;
    return rows.map((r) => ({ datname: r.datname, conns: Number(r.conns) }));
  }

  private async cacheHitRatio(): Promise<number | null> {
    const rows = await controlDb.$queryRaw<Array<{ ratio: number | null }>>`
      SELECT (sum(blks_hit)::float8 / NULLIF(sum(blks_hit) + sum(blks_read), 0)) AS ratio
      FROM pg_stat_database`;
    const ratio = rows[0]?.ratio;
    return ratio === null || ratio === undefined ? null : Math.round(Number(ratio) * 10000) / 10000;
  }

  private async redisStats(): Promise<{ usedMemoryBytes: number; keys: number } | null> {
    try {
      const info = await this.redis.client.info('memory');
      const m = /used_memory:(\d+)/.exec(info);
      const keys = await this.redis.client.dbsize();
      return { usedMemoryBytes: m ? Number(m[1]) : 0, keys: Number(keys) };
    } catch (err) {
      this.logger.warn(`redis stats unavailable: ${(err as Error).message}`);
      return null;
    }
  }

  private async diskStats(): Promise<{ totalBytes: number; freeBytes: number } | null> {
    try {
      const s = await statfs(loadEnv().storageRoot);
      return { totalBytes: s.blocks * s.bsize, freeBytes: s.bavail * s.bsize };
    } catch {
      return null;
    }
  }
}

export { formatBytes };
