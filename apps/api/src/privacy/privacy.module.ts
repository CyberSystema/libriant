import { Module } from '@nestjs/common';
import { TenantModule } from '../tenancy/tenant.module.js';
import { StorageModule } from '../storage/storage.module.js';
import { SubjectAccessController } from './subject-access.controller.js';
import { SubjectAccessService } from './subject-access.service.js';

/**
 * Data-subject rights that are not part of the everyday member surface
 * (privacy-legal-15). TenantModule supplies TenantGuard, AuthzModule supplies PermissionGuard, +
 * TenantPrismaService + TenantAuditService; StorageModule supplies the reader
 * for the member's photo.
 */
@Module({
  imports: [TenantModule, StorageModule],
  providers: [SubjectAccessService],
  controllers: [SubjectAccessController],
})
export class PrivacyModule {}
