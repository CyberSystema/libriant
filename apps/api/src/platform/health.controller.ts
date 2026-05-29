import {
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Inject,
  ServiceUnavailableException,
} from '@nestjs/common';
import { controlDb } from '@libriant/db-control';
import { RedisService } from './redis.service.js';

/**
 * Liveness, readiness, and metrics endpoints.
 * Wired here from day one so that every orchestrator (Compose, k8s, Nomad,
 * a load-balancer health check) has the same contract regardless of stage.
 *
 * Note on @Inject(): `tsx` (esbuild) doesn't emit `design:paramtypes`
 * metadata, so NestJS can't auto-infer constructor types in dev. We use
 * explicit @Inject() everywhere — this also makes DI calls easier to read.
 */
@Controller()
export class HealthController {
  private readonly bootedAt = new Date();

  constructor(@Inject(RedisService) private readonly redis: RedisService) {}

  @Get('healthz')
  liveness() {
    return { status: 'ok', bootedAt: this.bootedAt.toISOString() };
  }

  @Get('readyz')
  @HttpCode(HttpStatus.OK)
  async readiness() {
    const [redisOk, dbOk] = await Promise.all([
      this.redis.ping(),
      controlDb.$queryRaw`SELECT 1`.then(() => true).catch(() => false),
    ]);
    const status = redisOk && dbOk ? 'ready' : 'not_ready';
    const body = { status, dependencies: { redis: redisOk, controlDb: dbOk } };
    if (!redisOk || !dbOk) {
      throw new ServiceUnavailableException(body);
    }
    return body;
  }

  /**
   * Prometheus text exposition. Always-cheap process gauges (uptime + build)
   * plus a TTL-cached block of fleet/capacity gauges so dashboards can chart
   * tenant growth and host pressure over time — without an expensive query
   * on every scrape. The heavy per-tenant DB sizes stay on the on-demand
   * `/admin/fleet/overview` endpoint, NOT here.
   *
   * Note: `/metrics` is internal-only (Caddy short-circuits the public path),
   * so these aggregate counts aren't exposed to tenants.
   */
  private capCache?: { at: number; lines: string[] };
  private static readonly CAP_TTL_MS = 15_000;

  @Get('metrics')
  @Header('Content-Type', 'text/plain; version=0.0.4')
  async metrics(): Promise<string> {
    const upSec = Math.round((Date.now() - this.bootedAt.getTime()) / 1000);
    const lines = [
      '# HELP libriant_api_uptime_seconds Process uptime in seconds.',
      '# TYPE libriant_api_uptime_seconds counter',
      `libriant_api_uptime_seconds ${upSec}`,
      '# HELP libriant_api_build_info Build information.',
      '# TYPE libriant_api_build_info gauge',
      `libriant_api_build_info{node_env="${process.env.NODE_ENV ?? 'development'}"} 1`,
      ...(await this.capacityGauges()),
      '',
    ];
    return lines.join('\n');
  }

  /** Cheap census + capacity gauges, cached for CAP_TTL_MS. Each source is
   *  isolated: a failure omits its gauge rather than breaking the scrape. */
  private async capacityGauges(): Promise<string[]> {
    const now = Date.now();
    if (this.capCache && now - this.capCache.at < HealthController.CAP_TTL_MS) {
      return this.capCache.lines;
    }

    const lines: string[] = [];
    const [byStatus, storage, conns, cache, redisMem] = await Promise.allSettled([
      controlDb.tenant.groupBy({ by: ['status'], _count: { _all: true } }),
      controlDb.tenant.aggregate({ _sum: { storageUsedBytes: true } }),
      controlDb.$queryRaw<Array<{ total: number; max_conn: number }>>`
        SELECT
          (SELECT count(*)::int FROM pg_stat_activity) AS total,
          (SELECT setting::int FROM pg_settings WHERE name = 'max_connections') AS max_conn`,
      controlDb.$queryRaw<Array<{ ratio: number | null }>>`
        SELECT (sum(blks_hit)::float8 / NULLIF(sum(blks_hit) + sum(blks_read), 0)) AS ratio
        FROM pg_stat_database`,
      this.redis.client.info('memory').catch(() => ''),
    ]);

    if (byStatus.status === 'fulfilled') {
      lines.push(
        '# HELP libriant_tenants_total Number of tenants (libraries) by status.',
        '# TYPE libriant_tenants_total gauge',
      );
      for (const r of byStatus.value) {
        lines.push(`libriant_tenants_total{status="${r.status}"} ${r._count._all}`);
      }
    }
    if (storage.status === 'fulfilled') {
      lines.push(
        '# HELP libriant_storage_used_bytes Tracked per-tenant storage usage, summed.',
        '# TYPE libriant_storage_used_bytes gauge',
        `libriant_storage_used_bytes ${Number(storage.value._sum.storageUsedBytes ?? 0n)}`,
      );
    }
    if (conns.status === 'fulfilled' && conns.value[0]) {
      lines.push(
        '# HELP libriant_pg_connections Current Postgres backend connections.',
        '# TYPE libriant_pg_connections gauge',
        `libriant_pg_connections ${Number(conns.value[0].total)}`,
        '# HELP libriant_pg_connections_max Postgres max_connections setting.',
        '# TYPE libriant_pg_connections_max gauge',
        `libriant_pg_connections_max ${Number(conns.value[0].max_conn)}`,
      );
    }
    if (cache.status === 'fulfilled' && cache.value[0]?.ratio != null) {
      lines.push(
        '# HELP libriant_pg_cache_hit_ratio Postgres buffer cache hit ratio (0-1).',
        '# TYPE libriant_pg_cache_hit_ratio gauge',
        `libriant_pg_cache_hit_ratio ${Number(cache.value[0].ratio)}`,
      );
    }
    if (redisMem.status === 'fulfilled') {
      const m = /used_memory:(\d+)/.exec(redisMem.value);
      if (m) {
        lines.push(
          '# HELP libriant_redis_used_memory_bytes Redis used_memory in bytes.',
          '# TYPE libriant_redis_used_memory_bytes gauge',
          `libriant_redis_used_memory_bytes ${Number(m[1])}`,
        );
      }
    }

    this.capCache = { at: now, lines };
    return lines;
  }
}
