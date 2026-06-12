import { Module } from '@nestjs/common';
import { TenantModule } from '../tenancy/tenant.module.js';
import { StorageModule } from '../storage/storage.module.js';
import { BrandingController } from './branding.controller.js';

@Module({
  imports: [TenantModule, StorageModule],
  controllers: [BrandingController],
})
export class BrandingModule {}
