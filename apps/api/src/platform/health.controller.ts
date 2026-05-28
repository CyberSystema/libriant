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
   * Prometheus text exposition. Today: uptime + a build-info gauge. Adding
   * counters later (request totals, support session count, etc.) is just
   * lines in the body — the scraper contract stays the same.
   */
  @Get('metrics')
  @Header('Content-Type', 'text/plain; version=0.0.4')
  metrics(): string {
    const upSec = Math.round((Date.now() - this.bootedAt.getTime()) / 1000);
    return [
      '# HELP libriant_api_uptime_seconds Process uptime in seconds.',
      '# TYPE libriant_api_uptime_seconds counter',
      `libriant_api_uptime_seconds ${upSec}`,
      '# HELP libriant_api_build_info Build information.',
      '# TYPE libriant_api_build_info gauge',
      `libriant_api_build_info{node_env="${process.env.NODE_ENV ?? 'development'}"} 1`,
      '',
    ].join('\n');
  }
}
