import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module.js';
import { loadEnv } from './config/env.js';
import { HttpExceptionFilter } from './platform/http-exception.filter.js';

async function bootstrap() {
  const env = loadEnv();
  // `rawBody: true` keeps the original request bytes around as `req.rawBody`
  // so the Stripe webhook handler can verify the signature against the
  // exact bytes Stripe signed. JSON parsing still happens for everything
  // else.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
    rawBody: true,
  });
  app.useLogger(app.get(Logger));

  // We run behind Cloudflare → Caddy. Trust the proxy so `req.protocol` /
  // `req.secure` reflect the original HTTPS request. NOTE: the real client IP
  // is read from the `X-Real-IP` header (Caddy sets it from CF-Connecting-IP)
  // via `platform/client-ip.ts` — not from `req.ip` / X-Forwarded-For, which
  // in this topology carry the Cloudflare edge address, not the end user.
  app.set('trust proxy', true);

  // Parse Cookie header into req.cookies — required by SessionMiddleware.
  app.use(cookieParser());

  // Global error envelope: 4xx pass through (already user-readable);
  // 5xx get re-skinned with a plain-language message + copyable
  // supportCode that ops can grep the log for. See the filter for the
  // full UX-principle rationale.
  app.useGlobalFilters(new HttpExceptionFilter());

  // Input validation runs per-route via `auth/validate-dto.ts`. We avoid
  // NestJS's global ValidationPipe because `tsx` (esbuild) doesn't emit
  // `design:paramtypes` decorator metadata, which the pipe needs to know
  // which DTO class to apply. When we adopt a transpiler that emits
  // metadata (swc), we can swap back to `useGlobalPipes(new ValidationPipe(...))`.

  // Run lifecycle hooks (e.g. TenantPrismaService.onModuleDestroy, which
  // disconnects every cached tenant client; Redis cleanup) on SIGTERM /
  // SIGINT so container stops drain connections cleanly instead of dropping
  // them. `tini` (PID 1 in the Docker image) forwards the signal here.
  app.enableShutdownHooks();

  await app.listen(env.port);
  // eslint-disable-next-line no-console
  console.log(`[libriant-api] listening on :${env.port} (${env.nodeEnv})`);
}

bootstrap().catch((err) => {
  console.error('[libriant-api] failed to start', err);
  process.exit(1);
});
