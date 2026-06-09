import { Module } from '@nestjs/common';
import { AdminModule } from '../admin/admin.module.js';
import { AdminMaintenanceController } from './admin-maintenance.controller.js';
import { MaintenanceQueueService } from './maintenance-queue.service.js';
import { MaintenanceService } from './maintenance.service.js';

/**
 * Operator maintenance subsystem. The API side only enqueues runs + serves
 * their status; the actual work happens in the worker process
 * (maintenance-worker.ts). RedisModule is global, so the queue producer needs
 * no extra import; AdminModule supplies the auth guard for the controller.
 */
@Module({
  imports: [AdminModule],
  providers: [MaintenanceService, MaintenanceQueueService],
  controllers: [AdminMaintenanceController],
  exports: [MaintenanceService],
})
export class MaintenanceModule {}
