import { Module } from '@nestjs/common';
import { CustomizationModule } from '../customization/customization.module.js';
import { LoansModule } from '../loans/loans.module.js';
import { PlansModule } from '../plans/plans.module.js';
import { TenantModule } from '../tenancy/tenant.module.js';
import { ReservationsController } from './reservations.controller.js';
import { ReservationsService } from './reservations.service.js';

@Module({
  imports: [TenantModule, CustomizationModule, PlansModule, LoansModule],
  providers: [ReservationsService],
  controllers: [ReservationsController],
  exports: [ReservationsService],
})
export class ReservationsModule {}
