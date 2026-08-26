import { Module } from '@nestjs/common';
import { CustomizationModule } from '../customization/customization.module.js';
import { DashboardModule } from '../dashboard/dashboard.module.js';
import { IdempotencyInterceptor } from '../platform/idempotency.interceptor.js';
import { TenantModule } from '../tenancy/tenant.module.js';
import { LoansController } from './loans.controller.js';
import { LoansService } from './loans.service.js';

@Module({
  // DashboardModule serves `GET /t/:slug/summary`, which exists to replace the
  // two `GET /t/:slug/loans` calls the tenant home fired on every render
  // (performance-11) — see dashboard.module.ts for why it hangs here.
  imports: [TenantModule, CustomizationModule, DashboardModule],
  providers: [LoansService, IdempotencyInterceptor],
  controllers: [LoansController],
  exports: [LoansService],
})
export class LoansModule {}
