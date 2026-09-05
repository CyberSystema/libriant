import { Global, Module } from '@nestjs/common';
import { RedisModule } from '../platform/redis.module.js';
import { TenantModule } from '../tenancy/tenant.module.js';
import { PermissionsService } from './permissions.service.js';
import { PermissionGuard } from './permission.guard.js';

/**
 * Global because `PermissionGuard` is applied per-controller across the whole
 * tenant surface, and a guard NestJS instantiates standalone still needs
 * `PermissionsService` resolvable from the injector.
 */
@Global()
@Module({
  imports: [RedisModule, TenantModule],
  providers: [PermissionsService, PermissionGuard],
  exports: [PermissionsService, PermissionGuard],
})
export class AuthzModule {}
