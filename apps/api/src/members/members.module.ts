import { Module } from '@nestjs/common';
import { CustomizationModule } from '../customization/customization.module.js';
import { PlansModule } from '../plans/plans.module.js';
import { StorageModule } from '../storage/storage.module.js';
import { TenantModule } from '../tenancy/tenant.module.js';
import { MembersController } from './members.controller.js';
import { MembersService } from './members.service.js';
import { MemberPhotosController } from './photos.controller.js';

@Module({
  imports: [TenantModule, PlansModule, CustomizationModule, StorageModule],
  providers: [MembersService],
  controllers: [MembersController, MemberPhotosController],
  exports: [MembersService],
})
export class MembersModule {}
