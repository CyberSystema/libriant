import { Module } from '@nestjs/common';
import { TenantModule } from '../tenancy/tenant.module.js';
import { PlatformSettingsModule } from '../platform-settings/platform-settings.module.js';
import { EffectivePlanService } from './effective-plan.service.js';
import { PlanGuard } from './plan.guard.js';
import { QuotaInterceptor } from './quota.interceptor.js';
import { PlanDemoController } from './plan-demo.controller.js';
import { PlanUsageController } from './plan-usage.controller.js';
import { AdminPlanUsageController } from './plan-usage-admin.controller.js';

@Module({
  imports: [TenantModule, PlatformSettingsModule],
  providers: [EffectivePlanService, PlanGuard, QuotaInterceptor],
  // PlanUsageController is what makes a library's own numbers reachable in
  // production (launch-readiness-17) and AdminPlanUsageController is the
  // go-live pre-flight (billing-16); both are inert unless they are listed
  // here, which is the whole reason this line is the fix and the controllers
  // are only where it is written down.
  controllers: [PlanDemoController, PlanUsageController, AdminPlanUsageController],
  exports: [EffectivePlanService, PlanGuard, QuotaInterceptor],
})
export class PlansModule {}
