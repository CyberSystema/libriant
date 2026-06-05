import { Module } from '@nestjs/common';
import { PlansModule } from '../plans/plans.module.js';
import { TenantModule } from '../tenancy/tenant.module.js';
import { ImportController } from './import.controller.js';
import { ImportQueueService } from './import-queue.service.js';
import { ImportService } from './import.service.js';

/**
 * Bulk import / migration. PlansModule supplies PlanGuard (the
 * `bulk_import_enabled` gate); TenantModule supplies TenantGuard + tenant
 * context; RedisService is global (queue producer connection). The actual
 * row-writing runs in the worker process (import-worker.ts), not here.
 */
@Module({
  imports: [TenantModule, PlansModule],
  providers: [ImportService, ImportQueueService],
  controllers: [ImportController],
})
export class ImportModule {}
