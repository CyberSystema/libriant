import { Module } from '@nestjs/common';
import { TenantModule } from '../tenancy/tenant.module.js';
import { PasswordService } from '../auth/password.service.js';
import { StaffController } from './staff.controller.js';
import { StaffService } from './staff.service.js';

/**
 * Library staff management. TenantModule supplies TenantGuard + RolesGuard;
 * PasswordService (stateless) is provided directly.
 */
@Module({
  imports: [TenantModule],
  providers: [StaffService, PasswordService],
  controllers: [StaffController],
})
export class StaffModule {}
