import { Module } from '@nestjs/common';
import { TenantModule } from '../tenancy/tenant.module.js';
import { OrgService } from './org.service.js';
import { OrgController } from './org.controller.js';

/**
 * Branches and shelving locations, read-only (2.0 phase 20a).
 *
 * `TenantModule` alone, which is the whole dependency: this module reads two
 * tables and resolves nothing. It deliberately does not reach for PolicyModule
 * — a branch's timezone and calendar are policy INPUTS, and a read surface that
 * started resolving them would become a second, divergent answer to a question
 * `PolicySnapshotService` already owns.
 *
 * Mounted from `app.module.ts` directly rather than under an existing module, so
 * that phase 20b's `rm -rf apps/api/src/{catalog,loans,members,…}` cannot
 * unmount it by accident — the failure mode this phase found in
 * `DashboardModule`, which is reachable only through `LoansModule` and would
 * have gone with it.
 *
 * NOTHING IS EXPORTED beyond the service, and that export exists because phase
 * 20b's dashboard tile needs a branch count. Phase 23's multi-branch operations
 * will want more; the right shape for that is a decision that phase can make
 * with a caller in front of it.
 */
@Module({
  imports: [TenantModule],
  providers: [OrgService],
  controllers: [OrgController],
  exports: [OrgService],
})
export class OrgModule {}
