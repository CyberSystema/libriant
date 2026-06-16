import { Module } from '@nestjs/common';
import { TenantModule } from '../tenancy/tenant.module.js';
import { BillingModule } from '../billing/billing.module.js';
import { DesktopController } from './desktop.controller.js';
import { DesktopReleaseService } from './desktop-release.service.js';

/**
 * Desktop-app distribution: the in-panel download (proxied + entitlement-gated)
 * and the entitlement check the web app uses to hard-block the shell. Reuses
 * `BillingService` for the paid-plan check and `TenantModule` for the
 * tenant/auth guards.
 */
@Module({
  imports: [TenantModule, BillingModule],
  providers: [DesktopReleaseService],
  controllers: [DesktopController],
})
export class DesktopModule {}
