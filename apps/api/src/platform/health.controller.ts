import {
  Controller,
  Get,
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

  @Get('metrics')
  metrics() {
    // Placeholder for Prometheus exposition format; structured for upgrade later.
    return {
      uptime_seconds: Math.round((Date.now() - this.bootedAt.getTime()) / 1000),
    };
  }
}
