import {
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Inject,
  NotFoundException,
  Req,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Request } from 'express';
import { controlDb } from '@libriant/db-control';
import { loadEnv } from '../config/env.js';
import { metricHeader, metricLine } from '../observability/metrics.registry.js';
import { httpMetrics } from './http-metrics.js';
import { RedisService } from './redis.service.js';
import { resolveTenantPoolPlan } from './tenant-pool-budget.js';

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
  /**
   * The tenant-connection plan this API instance runs under (performance-06),
   * resolved on first scrape and memoised.
   *
   * Through `loadEnv()`, deliberately — NOT `process.env.TENANT_CLIENT_CACHE_SIZE`.
   * TenantPrismaService resolves its plan from `loadEnv().tenantClientCacheSize`,
   * which validates the value and falls back on a blank or non-numeric one; a
   * second, unvalidated read here would let the gauge report a plan the process
   * is not actually running under. A metric that lies about the thing it
   * measures is worse than no metric, and this one exists to be compared
   * against libriant_pg_connections.
   *
   * Lazy rather than a static field initialiser: a static would call
   * `loadEnv()` while this MODULE is being evaluated, before `bootstrap()` has
   * a try/catch or the REL-09 process handlers are installed, so a
   * misconfigured environment would surface as a bare module-evaluation throw
   * instead of the boot error this app is careful to produce.
   */
  private static poolPlan?: ReturnType<typeof resolveTenantPoolPlan>;
  private static tenantPoolPlan(): ReturnType<typeof resolveTenantPoolPlan> {
    HealthController.poolPlan ??= resolveTenantPoolPlan('api', loadEnv().tenantClientCacheSize);
    return HealthController.poolPlan;
  }

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
  async metrics(@Req() req: Request): Promise<string> {
    // A14-03: defence-in-depth — `/metrics` is internal-only. Prometheus scrapes
    // api:3001 DIRECTLY on the private net (no proxy headers); a request that
    // arrived via the public edge carries Caddy's X-Real-IP / X-Forwarded-*.
    // Reject those with a 404 so a Caddy/topology regression can't expose
    // fleet-wide tenant counts, rather than relying on the edge alone.
    if (
      req.headers['x-real-ip'] ||
      req.headers['x-forwarded-for'] ||
      req.headers['x-forwarded-host']
    ) {
      throw new NotFoundException();
    }
    const upSec = Math.round((Date.now() - this.bootedAt.getTime()) / 1000);
    const lines = [
      // Every name, HELP and TYPE below comes from
      // `observability/metrics.registry.ts`. They used to be written out here
      // by hand, which is how a rule can name a metric that does not exist:
      // the declaration and the exposition were two strings that had to agree
      // and nothing made them.
      ...metricHeader('libriant_api_uptime_seconds'),
      metricLine('libriant_api_uptime_seconds', upSec),
      ...metricHeader('libriant_api_build_info'),
      metricLine('libriant_api_build_info', 1, {
        node_env: process.env.NODE_ENV ?? 'development',
      }),
      // The connection plan this instance is running under. The worker has
      // exported its own pair since performance-06; the API — which holds the
      // larger share of the budget — exported nothing, so the one number an
      // operator needed to compare against libriant_pg_connections lived only
      // in a boot log line.
      ...metricHeader('libriant_api_tenant_conn_peak'),
      metricLine(
        'libriant_api_tenant_conn_peak',
        HealthController.tenantPoolPlan().peakConnections,
      ),
      ...metricHeader('libriant_api_tenant_conn_budget'),
      metricLine('libriant_api_tenant_conn_budget', HealthController.tenantPoolPlan().budget),
      // reliability-17: request counts by method/route/status and a latency
      // histogram, collected by HttpMetricsMiddleware (mounted in
      // PlatformModule). Rendered BEFORE the capacity block on purpose — these
      // are process-local and cannot fail, whereas capacityGauges() talks to
      // Postgres and Redis. When the DB is the thing that is broken, the error
      // rate is exactly what an operator needs the scrape to still carry.
      ...httpMetrics.render(),
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
      lines.push(...metricHeader('libriant_tenants_total'));
      for (const r of byStatus.value) {
        lines.push(metricLine('libriant_tenants_total', r._count._all, { status: r.status }));
      }
    }
    if (storage.status === 'fulfilled') {
      lines.push(
        ...metricHeader('libriant_storage_used_bytes'),
        metricLine(
          'libriant_storage_used_bytes',
          Number(storage.value._sum.storageUsedBytes ?? 0n),
        ),
      );
    }
    if (conns.status === 'fulfilled' && conns.value[0]) {
      lines.push(
        ...metricHeader('libriant_pg_connections'),
        metricLine('libriant_pg_connections', Number(conns.value[0].total)),
        ...metricHeader('libriant_pg_connections_max'),
        metricLine('libriant_pg_connections_max', Number(conns.value[0].max_conn)),
      );
    }
    if (cache.status === 'fulfilled' && cache.value[0]?.ratio != null) {
      lines.push(
        ...metricHeader('libriant_pg_cache_hit_ratio'),
        metricLine('libriant_pg_cache_hit_ratio', Number(cache.value[0].ratio)),
      );
    }
    if (redisMem.status === 'fulfilled') {
      const m = /used_memory:(\d+)/.exec(redisMem.value);
      if (m) {
        lines.push(
          ...metricHeader('libriant_redis_used_memory_bytes'),
          metricLine('libriant_redis_used_memory_bytes', Number(m[1])),
        );
      }
    }

    this.capCache = { at: now, lines };
    return lines;
  }
}
