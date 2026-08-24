import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module.js';
import { loadEnv } from './config/env.js';
import { HttpExceptionFilter } from './platform/http-exception.filter.js';
import { describeTrustedProxies, isTrustedProxy } from './platform/client-ip.js';

async function bootstrap() {
  const env = loadEnv();
  // AUTH-07: the RATE_LIMIT_DISABLED escape hatch must never reach production.
  // RateLimitService already ignores it in prod, but refuse to boot at all so
  // a stray/copied env var surfaces immediately instead of silently lingering.
  if (env.nodeEnv === 'production' && process.env.RATE_LIMIT_DISABLED === 'true') {
    throw new Error(
      'RATE_LIMIT_DISABLED=true is set in production — refusing to boot. ' +
        'This flag disables every auth rate limiter and must only be set in test/dev.',
    );
  }
  // `rawBody: true` keeps the original request bytes around as `req.rawBody`
  // so the Stripe webhook handler can verify the signature against the
  // exact bytes Stripe signed. JSON parsing still happens for everything
  // else.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
    rawBody: true,
  });
  app.useLogger(app.get(Logger));

  // We run behind Cloudflare → Caddy, so the proxy has to be trusted for
  // `req.protocol` / `req.secure` to reflect the original HTTPS request — but
  // only the proxies we actually have. This was `trust proxy: true`, which
  // trusts EVERY hop, and the audit (authn-authz-01) proved what that costs:
  // `req.ip` became the leftmost `X-Forwarded-For` entry, i.e. a value the
  // client writes, and six wrong logins carrying `X-Forwarded-For: 192.0.2.55`
  // locked the bucket the attacker chose instead of their own. The predicate is
  // the same one `clientIp()` uses, so Express and our rate-limit keys agree on
  // exactly who counts as "our proxy". A malformed TRUSTED_PROXY_CIDRS throws
  // here, at boot, rather than on the first request.
  const trustedProxies = describeTrustedProxies();
  app.set('trust proxy', (addr: string) => isTrustedProxy(addr));

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
  console.log(
    `[libriant-api] listening on :${env.port} (${env.nodeEnv}) — trusted proxies: ${trustedProxies}`,
  );
}

// REL-09: last-resort process-level handlers. Node's default
// `--unhandled-rejections=throw` would otherwise terminate the process with no
// structured/greppable line. We log a clear `[libriant-api]`-prefixed error so
// the failure is observable, then exit non-zero so the orchestrator restarts a
// process left in an unknown state (the Nest exception filter + per-handle
// `.catch` cover ordinary error paths; these catch only the ones that escape).
process.on('unhandledRejection', (reason) => {
  console.error('[libriant-api] unhandledRejection', reason);
  process.exit(1);
});
process.on('uncaughtException', (err) => {
  console.error('[libriant-api] uncaughtException', err);
  process.exit(1);
});

bootstrap().catch((err) => {
  console.error('[libriant-api] failed to start', err);
  process.exit(1);
});
