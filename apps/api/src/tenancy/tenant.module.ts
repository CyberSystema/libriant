import { Module } from '@nestjs/common';
import { TenantResolverService } from './tenant-resolver.service.js';
import { TenantPrismaService } from './tenant-prisma.service.js';
import { TenantAuditService } from './tenant-audit.service.js';
import { TenantGuard } from './tenant.guard.js';
import { RolesGuard } from './roles.guard.js';
import { TenantDemoController } from './tenant-demo.controller.js';

@Module({
  providers: [
    TenantResolverService,
    TenantPrismaService,
    TenantAuditService,
    TenantGuard,
    RolesGuard,
  ],
  controllers: [TenantDemoController],
  exports: [
    TenantResolverService,
    TenantPrismaService,
    TenantAuditService,
    TenantGuard,
    RolesGuard,
  ],
})
export class TenantModule {}
