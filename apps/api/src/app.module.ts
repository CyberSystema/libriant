import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';
import { AdminMiddleware } from './admin/admin.middleware.js';
import { AdminModule } from './admin/admin.module.js';
import { AnnouncementsModule } from './announcements/announcements.module.js';
import { AuthModule } from './auth/auth.module.js';
import { SessionMiddleware } from './auth/session.middleware.js';
import { OriginCheckMiddleware } from './platform/origin-check.middleware.js';
import { BillingModule } from './billing/billing.module.js';
import { CatalogModule } from './catalog/catalog.module.js';
import { CustomizationModule } from './customization/customization.module.js';
import { DesktopModule } from './desktop/desktop.module.js';
import { EmailModule } from './email/email.module.js';
import { HelpModule } from './help/help.module.js';
import { ImportModule } from './import/import.module.js';
import { LoansModule } from './loans/loans.module.js';
import { MaintenanceModule } from './maintenance/maintenance.module.js';
import { StaffModule } from './staff/staff.module.js';
import { ExportModule } from './export/export.module.js';
import { MembersModule } from './members/members.module.js';
import { ReservationsModule } from './reservations/reservations.module.js';
import { TenantSettingsModule } from './tenant-settings/tenant-settings.module.js';
import { AuditModule } from './audit/audit.module.js';
import { BrandingModule } from './branding/branding.module.js';
import { PlansModule } from './plans/plans.module.js';
import { PlatformModule } from './platform/platform.module.js';
import { RedisModule } from './platform/redis.module.js';
import { StorageModule } from './storage/storage.module.js';
import { ImpersonationMiddleware } from './support/impersonation.middleware.js';
import { SupportAuditInterceptor } from './support/support-audit.interceptor.js';
import { SupportModule } from './support/support.module.js';
import { SystemModeMiddleware } from './system-mode/system-mode.middleware.js';
import { SystemModeModule } from './system-mode/system-mode.module.js';
import { TenantModule } from './tenancy/tenant.module.js';
import { TenantMiddleware } from './tenancy/tenant.middleware.js';
import { LibraryModule } from './library/library.module.js';
import { ApplicationsModule } from './applications/applications.module.js';

@Module({
  imports: [
    LoggerModule.forRoot({
      pinoHttp: {
        transport:
          process.env.NODE_ENV !== 'production'
            ? { target: 'pino-pretty', options: { singleLine: true } }
            : undefined,
        redact: ['req.headers.authorization', 'req.headers.cookie'],
      },
    }),
    RedisModule,
    EmailModule,
    PlatformModule,
    TenantModule,
    AuthModule,
    PlansModule,
    CustomizationModule,
    StorageModule,
    CatalogModule,
    MembersModule,
    LoansModule,
    ReservationsModule,
    TenantSettingsModule,
    AuditModule,
    BrandingModule,
    ImportModule,
    BillingModule,
    HelpModule,
    AdminModule,
    SupportModule,
    AnnouncementsModule,
    SystemModeModule,
    MaintenanceModule,
    StaffModule,
    ExportModule,
    DesktopModule,
    LibraryModule,
    ApplicationsModule,
  ],
  providers: [
    {
      provide: APP_INTERCEPTOR,
      useClass: SupportAuditInterceptor,
    },
  ],
})
export class AppModule implements NestModule {
  /**
   * Middleware order matters:
   *   1. SessionMiddleware reads the cookie and attaches req.session.
   *   2. AdminMiddleware reads the admin cookie and attaches req.admin.
   *   3. ImpersonationMiddleware reads the impersonation cookie and attaches
   *      req.impersonation. Distinct from req.admin so a leaked admin cookie
   *      cannot impersonate without also passing key + MFA.
   *   4. SystemModeMiddleware resolves the effective system mode (global
   *      OR per-tenant, stricter wins). For maintenance / out_of_order it
   *      short-circuits with a 503 unless the request is on an admin-bypass
   *      path or carries an active support session. For read_only it lets
   *      GETs through but 503s mutations. Must run BEFORE TenantMiddleware
   *      so a maintenance event can stop the request before any tenant DB
   *      pool gets warmed up.
   *   5. TenantMiddleware resolves the tenant from path/Host and attaches
   *      req.tenant.
   *
   * All run on every route; each is a no-op when its respective signal is
   * absent (so /healthz, /auth/* etc. flow through unchanged). Guards
   * downstream compose them — AuthGuard wants session, TenantGuard wants
   * tenant + a matching session OR impersonation, PlanGuard short-circuits
   * under impersonation, etc.
   *
   * SupportAuditInterceptor is registered as a global interceptor above; it
   * inspects req.impersonation and writes a supportActionLog row only when
   * the request was made under an active support session. Other requests
   * pass through untouched.
   */
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(
        // A10-03: CSRF Origin check runs FIRST — reject a cross-site browser
        // Origin on any state-changing request before it touches session/tenant.
        OriginCheckMiddleware,
        SessionMiddleware,
        AdminMiddleware,
        ImpersonationMiddleware,
        SystemModeMiddleware,
        TenantMiddleware,
      )
      .forRoutes('*');
  }
}
