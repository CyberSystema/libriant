import { Module } from '@nestjs/common';
import { PlansModule } from '../plans/plans.module.js';
import { TenantModule } from '../tenancy/tenant.module.js';
import { SignedUrlService } from './signed-url.service.js';
import { StorageDemoController } from './storage-demo.controller.js';
import { StorageService } from './storage.service.js';

@Module({
  imports: [TenantModule, PlansModule],
  providers: [StorageService, SignedUrlService],
  controllers: [StorageDemoController],
  exports: [StorageService, SignedUrlService],
})
export class StorageModule {}
