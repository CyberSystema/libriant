import { Module } from '@nestjs/common';
import { TenantModule } from '../tenancy/tenant.module.js';
import { PolicyController } from './policy.controller.js';
import { PolicySnapshotService } from './policy-snapshot.service.js';
import { PolicyWriteService } from './policy-write.service.js';
import { TenantClockService } from './tenant-clock.service.js';

/**
 * §4.1's owner of policy resolution, on the service side.
 *
 * `imports: [TenantModule]` only — `AuthzModule` is `@Global()`, so
 * `PermissionGuard` resolves without being imported, and `RedisModule` is too.
 *
 * `PolicySnapshotService` is exported because phases 16 (circulation), 17
 * (holds), 18 (fees) and 22 (notices) all resolve policy, and §4.1 names one
 * owner. `TenantClockService` is exported for the same reason and one more: the
 * ESLint block in `eslint.config.mjs` bans a raw clock read in
 * `apps/api/src/circulation/`, so phase 16 has to be able to inject this.
 */
@Module({
  imports: [TenantModule],
  providers: [PolicySnapshotService, PolicyWriteService, TenantClockService],
  controllers: [PolicyController],
  exports: [PolicySnapshotService, PolicyWriteService, TenantClockService],
})
export class PolicyModule {}
