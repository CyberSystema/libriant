import { Module } from '@nestjs/common';
import { AdminModule } from '../admin/admin.module.js';
import { TenantModule } from '../tenancy/tenant.module.js';
import { AdminSupportController } from './admin-support.controller.js';
import { ImpersonationController } from './impersonation.controller.js';
import { ImpersonationCookieService } from './impersonation-cookie.service.js';
import { ImpersonationSessionService } from './impersonation-session.service.js';
import { LibrarySupportController } from './library-support.controller.js';
import { MfaController } from './mfa.controller.js';
import { MfaService } from './mfa.service.js';
import { SupportAuditInterceptor } from './support-audit.interceptor.js';
import { SupportKeyService } from './support-key.service.js';
import { SupportNotificationsService } from './support-notifications.service.js';
import { SupportSessionGuard } from './support-session.guard.js';
import { SupportSessionService } from './support-session.service.js';

/**
 * Support-access subsystem: MFA enrollment, key generation/redemption,
 * impersonation cookie, audit interceptor.
 *
 * Exports the interceptor + guard + cookie/session services so they can
 * be wired globally via AppModule, and exports the MFA/session services
 * for future modules (e.g. an enrollment UI).
 */
@Module({
  imports: [AdminModule, TenantModule],
  providers: [
    MfaService,
    SupportKeyService,
    SupportSessionService,
    SupportSessionGuard,
    SupportNotificationsService,
    ImpersonationSessionService,
    ImpersonationCookieService,
    SupportAuditInterceptor,
  ],
  controllers: [
    MfaController,
    LibrarySupportController,
    AdminSupportController,
    ImpersonationController,
  ],
  exports: [
    MfaService,
    SupportSessionService,
    ImpersonationSessionService,
    ImpersonationCookieService,
    SupportSessionGuard,
    SupportAuditInterceptor,
  ],
})
export class SupportModule {}
