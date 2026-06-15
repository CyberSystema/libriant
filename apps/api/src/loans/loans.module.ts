import { Module } from '@nestjs/common';
import { CustomizationModule } from '../customization/customization.module.js';
import { IdempotencyInterceptor } from '../platform/idempotency.interceptor.js';
import { TenantModule } from '../tenancy/tenant.module.js';
import { LoansController } from './loans.controller.js';
import { LoansService } from './loans.service.js';

@Module({
  imports: [TenantModule, CustomizationModule],
  providers: [LoansService, IdempotencyInterceptor],
  controllers: [LoansController],
  exports: [LoansService],
})
export class LoansModule {}
