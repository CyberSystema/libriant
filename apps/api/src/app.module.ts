import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { AuthModule } from './auth/auth.module.js';
import { SessionMiddleware } from './auth/session.middleware.js';
import { CatalogModule } from './catalog/catalog.module.js';
import { CustomizationModule } from './customization/customization.module.js';
import { LoansModule } from './loans/loans.module.js';
import { MembersModule } from './members/members.module.js';
import { PlansModule } from './plans/plans.module.js';
import { PlatformModule } from './platform/platform.module.js';
import { RedisModule } from './platform/redis.module.js';
import { StorageModule } from './storage/storage.module.js';
import { TenantModule } from './tenancy/tenant.module.js';
import { TenantMiddleware } from './tenancy/tenant.middleware.js';

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
    PlatformModule,
    TenantModule,
    AuthModule,
    PlansModule,
    CustomizationModule,
    StorageModule,
    CatalogModule,
    MembersModule,
    LoansModule,
  ],
})
export class AppModule implements NestModule {
  /**
   * Middleware order matters:
   *   1. SessionMiddleware reads the cookie and attaches req.session.
   *   2. TenantMiddleware resolves the tenant from path/Host and attaches
   *      req.tenant.
   *
   * Both run on every route; both are no-ops when their respective signals
   * are absent (so /healthz, /auth/* etc. flow through unchanged). Guards
   * downstream compose the two — AuthGuard wants session, TenantGuard wants
   * both session and tenant + that they match.
   */
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(SessionMiddleware, TenantMiddleware).forRoutes('*');
  }
}
