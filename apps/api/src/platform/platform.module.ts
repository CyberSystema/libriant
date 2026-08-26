import { Module } from '@nestjs/common';
import { HealthController } from './health.controller.js';
import { RedisModule } from './redis.module.js';

/**
 * reliability-17 note: `HttpMetricsMiddleware` — which feeds the request/error/
 * latency series this module's `/metrics` endpoint renders — is deliberately
 * NOT mounted here. Nest applies the root module's middleware chain before an
 * imported module's, and mounting it here put it behind the whole
 * OriginCheck → Session → Admin → Impersonation → SystemMode → Tenant chain:
 * measured against a running API, `/t/<unknown-slug>/members` 404'd from
 * TenantMiddleware and was NOT counted at all, which loses exactly the case the
 * finding names ("a tenant whose every request errors"), plus every maintenance
 * 503 and every CSRF 403. It is therefore the FIRST entry in AppModule's own
 * `configure()`. See the comment there.
 */
@Module({
  imports: [RedisModule],
  controllers: [HealthController],
})
export class PlatformModule {}
