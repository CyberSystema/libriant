import { Controller, Get } from '@nestjs/common';

/**
 * Liveness, readiness, and metrics endpoints.
 * Wired here from day one so that every orchestrator (Compose, k8s, Nomad,
 * a load-balancer health check) has the same contract regardless of stage.
 */
@Controller()
export class HealthController {
  private readonly bootedAt = new Date();

  @Get('healthz')
  liveness() {
    return { status: 'ok', bootedAt: this.bootedAt.toISOString() };
  }

  @Get('readyz')
  readiness() {
    // TODO: once DB + Redis are wired, ping them here and return 503 if down.
    return { status: 'ready' };
  }

  @Get('metrics')
  metrics() {
    // Placeholder for Prometheus exposition format; structured for upgrade later.
    return {
      uptime_seconds: Math.round((Date.now() - this.bootedAt.getTime()) / 1000),
    };
  }
}
