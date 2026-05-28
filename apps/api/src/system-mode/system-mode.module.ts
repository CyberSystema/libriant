import { Module } from '@nestjs/common';
import { AdminModule } from '../admin/admin.module.js';
import { TenantModule } from '../tenancy/tenant.module.js';
import { AdminSystemModeController } from './admin-system-mode.controller.js';
import { PublicSystemModeController } from './public-system-mode.controller.js';
import { SystemModeService } from './system-mode.service.js';

/**
 * System-mode subsystem (Step 18c). Exports the service so other
 * subsystems can read the current mode without importing the full
 * module — e.g. AppModule registers the middleware globally and needs
 * the service singleton.
 */
@Module({
  imports: [AdminModule, TenantModule],
  providers: [SystemModeService],
  controllers: [AdminSystemModeController, PublicSystemModeController],
  exports: [SystemModeService],
})
export class SystemModeModule {}
