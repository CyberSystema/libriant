import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module.js';
import { loadEnv } from './config/env.js';
import { HttpExceptionFilter } from './platform/http-exception.filter.js';
import { describeTrustedProxies, isTrustedProxy } from './platform/client-ip.js';
import { compressResponses } from './platform/compression.js';
import { resolveStripeDriverKind } from './billing/stripe-driver-kind.js';
import { controlDb } from '@libriant/db-control';

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

  // performance-15: gzip the API's own responses. Registered with `app.use`
  // rather than in AppModule.configure so it wraps `res` ahead of the parsers
  // and the whole module middleware chain — it has to be the outermost thing on
  // the response for the same reason it is the innermost on the request.
  app.use(compressResponses());

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
  // boot-and-config-10: the process used to say nothing at all about the
  // configuration it had resolved — the line above was the only one. An
  // operator who left EMAIL_DRIVER=console on a server that is meant to be
  // sending password resets, or who expected subscriptions to be enforced,
  // had to shell in and read the env file to find out. One greppable line, no
  // secrets: which driver, which switch, and the HOST half of each connection
  // string with any credentials dropped.
  // eslint-disable-next-line no-console
  console.log(
    `[libriant-api] config: email=${env.emailDriver} stripe=${resolveStripeDriverKind().kind} ` +
      // The `platform_settings` row set from the admin panel overrides this at
      // runtime and is the authoritative switch, so name what this actually is.
      `billing-env=${env.billingEnabled ? 'enforced' : 'free'} ` +
      `admin-mfa=${env.adminMfaRequired ? 'required' : 'optional'} ` +
      `cookie-secure=${env.sessionCookieSecure} control-db=${endpointOf(env.controlDbUrl)} ` +
      `redis=${endpointOf(env.redisUrl)} storage=${env.storageRoot}`,
  );
  void warnIfGreekSortsWrong();
}

/**
 * Does this cluster sort Greek in Greek order, or in byte order?
 *
 * boot-and-config-14 put the assertion in `postgres-init.sql`, which the
 * official entrypoint runs exactly once, on an empty data directory. That is
 * the only moment the collation can still be CHOSEN — but it is not the only
 * moment it can be WRONG, and the compose file gives `postgres` a
 * `restart: unless-stopped` policy. So a cluster that fails the assertion
 * aborts boot 1, Docker restarts it, and boot 2 skips every init script
 * because pg_data is no longer empty. The stack then comes up healthy on a
 * byte-ordered cluster, and nothing downstream notices: every extension the
 * init file creates is also created `IF NOT EXISTS` by the Prisma migrations.
 *
 * This runs on EVERY boot, which is the property the init script cannot have.
 * It only warns. Refusing to start would be the wrong trade — the collation
 * cannot be corrected at runtime (it is baked into every text index in every
 * tenant database), so a refusal turns a bad sort order into a total outage
 * with no way out but a reindex. A librarian can work with Ω-first browsing
 * for an afternoon; they cannot work with a dead server.
 *
 * Asserted as BEHAVIOUR, matching postgres-init.sql: under byte order 'άλφα'
 * (U+03AC) sorts after 'Βιζυηνός' (U+0392); under ICU el-GR it sorts before,
 * where the alphabet puts it.
 */
async function warnIfGreekSortsWrong(): Promise<void> {
  try {
    const rows = await controlDb.$queryRaw<Array<{ ok: boolean }>>`
      SELECT ('άλφα' < 'Βιζυηνός') AS ok
    `;
    if (rows[0]?.ok) return;
    console.error(
      '[libriant-api] COLLATION: this cluster sorts Greek in byte order, not Greek order. ' +
        'Every catalogue browse puts lowercase and accented titles after Ω. It cannot be ' +
        'changed in place — the cluster must be rebuilt with ' +
        'POSTGRES_INITDB_ARGS=--locale-provider=icu --icu-locale=el-GR --locale=C.UTF-8 ' +
        '--encoding=UTF8 before libraries have data. See boot-and-config-14.',
    );
  } catch {
    // A database that cannot answer this has larger problems, and /readyz is
    // what reports them. Never let a diagnostic stop the process from booting.
  }
}

/** Host + path of a connection URL. Credentials are dropped on purpose. */
function endpointOf(raw: string): string {
  try {
    const url = new URL(raw);
    return `${url.host}${url.pathname}`;
  } catch {
    return '(unparseable)';
  }
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
