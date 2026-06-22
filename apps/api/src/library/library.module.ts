import { Module } from '@nestjs/common';
import { AdminModule } from '../admin/admin.module.js';
import { TenantModule } from '../tenancy/tenant.module.js';
import { AdminLibraryRequestsController } from './admin-library-requests.controller.js';
import { LibraryController } from './library.controller.js';
import { LibraryProfileService } from './library-profile.service.js';

/**
 * Library profile + the owner-approved "core field" edit-request workflow.
 * Tenant owner/admins view + edit (free fields directly, core fields via a
 * request); platform owner-admins approve/reject. EmailService is @Global.
 */
@Module({
  imports: [AdminModule, TenantModule],
  providers: [LibraryProfileService],
  controllers: [LibraryController, AdminLibraryRequestsController],
  exports: [LibraryProfileService],
})
export class LibraryModule {}
