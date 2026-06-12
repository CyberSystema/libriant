import { Module } from '@nestjs/common';
import { TenantModule } from '../tenancy/tenant.module.js';
import { PlansModule } from '../plans/plans.module.js';
import { TenantSettingsController } from './tenant-settings.controller.js';
import { TenantSettingsService } from './tenant-settings.service.js';

@Module({
  imports: [TenantModule, PlansModule],
  providers: [TenantSettingsService],
  controllers: [TenantSettingsController],
  exports: [TenantSettingsService],
})
export class TenantSettingsModule {}
