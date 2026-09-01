import { Global, Module } from '@nestjs/common';
import { HealthController } from './health.controller.js';
import { NotifyService } from './notify.service.js';
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
/**
 * `@Global` for {@link NotifyService} alone, following the precedent RedisModule
 * sets one file over ("Global so any module can @Inject without re-importing").
 *
 * The reason is the same one, and stronger. A notification is raised from
 * wherever the interesting thing happens — the application funnel, a job, a
 * health check — and requiring each of those modules to add
 * `imports: [PlatformModule]` first is a step that gets skipped, and whose
 * omission Nest reports as a boot failure in whichever module forgot. Making
 * the alerting channel the reason a module will not construct is the exact
 * inversion this feature is not allowed to have. One provider, injectable
 * everywhere, no import churn. Only providers are globalised; HealthController
 * is unaffected.
 */
@Global()
@Module({
  imports: [RedisModule],
  controllers: [HealthController],
  providers: [NotifyService],
  exports: [NotifyService],
})
export class PlatformModule {}
