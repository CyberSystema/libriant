import { Module } from '@nestjs/common';
import { TenantModule } from '../tenancy/tenant.module.js';
import { AdminModule } from '../admin/admin.module.js';
import { ExportService } from './export.service.js';
import { ExportQueueService } from './export-queue.service.js';
import { TenantExportController } from './tenant-export.controller.js';
import { AdminExportController } from './admin-export.controller.js';

/**
 * Database export. The API side only enqueues jobs + serves downloads; the
 * worker (export-worker.ts) produces the files. TenantModule supplies
 * TenantGuard + RolesGuard for the library-admin surface; AdminModule supplies
 * the AdminAuthGuard for the owner surface. RedisModule is global.
 */
@Module({
  imports: [TenantModule, AdminModule],
  providers: [ExportService, ExportQueueService],
  controllers: [TenantExportController, AdminExportController],
})
export class ExportModule {}
