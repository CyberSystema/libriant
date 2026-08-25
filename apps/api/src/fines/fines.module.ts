import { Module } from '@nestjs/common';
import { IdempotencyInterceptor } from '../platform/idempotency.interceptor.js';
import { TenantModule } from '../tenancy/tenant.module.js';
import { FinesController } from './fines.controller.js';
import { FinesService } from './fines.service.js';

/**
 * Mirrors LoansModule: the interceptor is listed as a provider so the route
 * decorator resolves a DI-constructed instance (with RedisService injected)
 * rather than a standalone one that would fail to dedupe.
 */
@Module({
  imports: [TenantModule],
  providers: [FinesService, IdempotencyInterceptor],
  controllers: [FinesController],
  exports: [FinesService],
})
export class FinesModule {}
