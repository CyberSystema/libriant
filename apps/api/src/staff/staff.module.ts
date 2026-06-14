import { Module } from '@nestjs/common';
import { TenantModule } from '../tenancy/tenant.module.js';
import { PlansModule } from '../plans/plans.module.js';
import { PasswordService } from '../auth/password.service.js';
import { StaffController } from './staff.controller.js';
import { StaffService } from './staff.service.js';

/**
 * Library staff management. TenantModule supplies TenantGuard + RolesGuard;
 * PlansModule supplies the QuotaInterceptor (staff_seats gate) +
 * EffectivePlanService; PasswordService (stateless) is provided directly.
 */
@Module({
  imports: [TenantModule, PlansModule],
  providers: [StaffService, PasswordService],
  controllers: [StaffController],
})
export class StaffModule {}
