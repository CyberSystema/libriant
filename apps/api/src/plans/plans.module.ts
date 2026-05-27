import { Module } from '@nestjs/common';
import { TenantModule } from '../tenancy/tenant.module.js';
import { EffectivePlanService } from './effective-plan.service.js';
import { PlanGuard } from './plan.guard.js';
import { QuotaInterceptor } from './quota.interceptor.js';
import { PlanDemoController } from './plan-demo.controller.js';

@Module({
  imports: [TenantModule],
  providers: [EffectivePlanService, PlanGuard, QuotaInterceptor],
  controllers: [PlanDemoController],
  exports: [EffectivePlanService, PlanGuard, QuotaInterceptor],
})
export class PlansModule {}
