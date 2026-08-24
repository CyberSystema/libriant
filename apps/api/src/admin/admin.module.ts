import { Module } from '@nestjs/common';
import { PlansModule } from '../plans/plans.module.js';
import { PlatformSettingsModule } from '../platform-settings/platform-settings.module.js';
import { AdminSubscriptionsController } from '../platform-settings/admin-subscriptions.controller.js';
import { TenantProvisioningService } from '../provisioning/tenant-provisioning.service.js';
import { PasswordService } from '../auth/password.service.js';
import { MfaService } from '../support/mfa.service.js';
import { AdminAuthController } from './admin-auth.controller.js';
import { AdminAuthGuard } from './admin-auth.guard.js';
import { AdminAuthService } from './admin-auth.service.js';
import { AdminCookieService } from './admin-cookie.service.js';
import { AdminOverridesController } from './admin-overrides.controller.js';
import {
  AdminAccountRecoveryController,
  AdminOutboxController,
} from './admin-outbox.controller.js';
import { AdminOutboxService } from './admin-outbox.service.js';
import { AdminPlansController } from './admin-plans.controller.js';
import { AdminSessionService } from './admin-session.service.js';
import { AdminTenantsController } from './admin-tenants.controller.js';
import { FleetController } from './fleet.controller.js';
import { FleetService } from './fleet.service.js';

/**
 * Internal admin module — auth + tenant list + plan editor + tenant
 * override editor + the undelivered-mail escape hatch (launch-readiness-01).
 * Support sessions, announcements, and system mode are separate modules in
 * Steps 18a / 18b / 18c.
 *
 * Exports the auth surface (guard + cookie + session services) so other
 * modules can opt into admin-gated routes (currently the BillingAdmin
 * controller does this).
 */
@Module({
  imports: [PlansModule, PlatformSettingsModule],
  providers: [
    PasswordService,
    AdminSessionService,
    AdminCookieService,
    AdminAuthService,
    AdminAuthGuard,
    FleetService,
    TenantProvisioningService,
    // launch-readiness-01: the operator's read-the-mail / recover-an-account
    // surface. Lives in AdminModule because it is owner-admin break-glass, not
    // tenant functionality.
    AdminOutboxService,
    // Stateless TOTP helper; the replay guard's state lives in shared Redis, so
    // a second instance alongside SupportModule's is harmless and avoids a
    // circular import (SupportModule already depends on AdminModule's guard).
    MfaService,
  ],
  controllers: [
    AdminAuthController,
    AdminTenantsController,
    AdminPlansController,
    AdminOverridesController,
    AdminOutboxController,
    AdminAccountRecoveryController,
    AdminSubscriptionsController,
    FleetController,
  ],
  exports: [AdminSessionService, AdminCookieService, AdminAuthGuard],
})
export class AdminModule {}
