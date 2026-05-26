import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { PlatformModule } from './platform/platform.module.js';
import { RedisModule } from './platform/redis.module.js';
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
  ],
})
export class AppModule implements NestModule {
  /**
   * TenantMiddleware runs on every route. It's a no-op when no tenant is
   * detectable from the URL or Host header — so /healthz, /readyz, and
   * future /auth/* / /admin/* endpoints all flow through cleanly.
   */
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(TenantMiddleware).forRoutes('*');
  }
}
