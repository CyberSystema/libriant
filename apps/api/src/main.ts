import 'reflect-metadata';
import type { Server } from 'node:http';
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

  // Drain on SIGTERM / SIGINT — `tini` (PID 1 in the Docker image) forwards
  // the signal here. Registered at the point `enableShutdownHooks()` was, ahead
  // of `listen()`, so the window in which a signal can land unhandled is no
  // wider than it was before.
  installShutdownHandlers(app);

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
 * Hard ceiling on a graceful drain (reliability-14). Kept well inside the `api`
 * service's `stop_grace_period: 30s` so the exit that ends a deploy is ours —
 * logged, with the hooks run — instead of the kernel's SIGKILL. The longest
 * thing an API request does is provision a tenant: `POST /signup` runs the
 * CREATE DATABASE and the migration inline, measured at ~1.1s of DDL in
 * auth.controller.ts.
 *
 * One route breaks that rule and it is worth naming rather than letting the
 * sentence above quietly be wrong: `GET /t/:slug/desktop/download` pipes the
 * Electron installer straight through from GitHub Releases
 * (desktop-release.service.ts, `nodeStream.pipe(res)`), so its duration is the
 * client's bandwidth, not ours. A ~100 MB installer needs a sustained ~5 MB/s
 * to finish inside this cap, and a slower connection gets cut.
 *
 * That is the right trade and not a close call. A severed download is a GET of
 * an immutable artefact: the browser reports a failed download and the reader
 * clicks again. Raising the cap to cover it would instead hold every deploy
 * open for whoever has the slowest link, and the alternative — no cap — is the
 * uncontrolled SIGKILL this whole change exists to prevent, which would cut the
 * same download anyway AND take a mid-write checkout with it. The thing worth
 * protecting is the write, and 20s is many times what any write here needs.
 *
 * RE-EXAMINED IN PHASE 11B, and the sentence above stays true. The catalogue
 * MARC export could have been a live `GET /catalog/export.mrc` streaming a
 * 250,000-record file, which would have been a second exception — and a worse
 * one, because unlike the installer it is COMPUTED: a severed export is minutes
 * of serialization thrown away, not a re-clickable download of an immutable
 * artefact. It is a `catalog_marc` export job on the export queue instead, which
 * runs in the worker under its own four-hour budget and lands in a file the
 * librarian downloads afterwards. The MARC INGEST is bounded for the same
 * reason: `CATALOG_INGEST_MAX_RECORDS` is 1,000 because 1,000 records is ~2.5s
 * of measured database floor, so an ingest in flight when a deploy lands
 * finishes inside this drain.
 *
 * Mirrors worker.ts's SHUTDOWN_DEADLINE_MS (25s under a 60s grace).
 */
const SHUTDOWN_DEADLINE_MS = 20_000;

/**
 * Stop accepting, let in-flight requests finish, close Nest, exit — bounded.
 *
 * This replaces `app.enableShutdownHooks()`, which was doing the job badly in
 * two ways that only show up on a deploy. Its handler
 * (@nestjs/core/nest-application-context.js, `listenToShutdownSignals`) runs
 * `callDestroyHook()` BEFORE `dispose()`, i.e. it disconnects every cached
 * tenant Prisma client and quits Redis while the HTTP server is still serving:
 * the checkout a librarian pressed a second before the deploy landed loses its
 * database connection mid-write instead of finishing. And nothing bounds it —
 * one wedged hook or one wedged request and the process simply sits there until
 * Docker's `stop_grace_period` escalates to SIGKILL, which is the uncontrolled
 * sever the grace period exists to prevent.
 *
 * So we own the order: close the listening socket first (new connections are
 * refused, idle keep-alives are dropped, sockets that still owe a response are
 * left alone), and only once nothing is in flight call `app.close()`, which
 * runs the same destroy/shutdown hooks `enableShutdownHooks` would have — the
 * two are the same code path in Nest, the signal listener is all we are giving
 * up. The whole sequence is raced against SHUTDOWN_DEADLINE_MS; if that trips
 * we exit non-zero so a drain that failed is visible in the deploy log rather
 * than looking like a clean stop.
 *
 * SIGTERM and SIGINT only. Nest's default list also carried SIGSEGV, SIGILL,
 * SIGABRT, SIGBUS and SIGFPE — signals that mean the VM is already broken, and
 * where running async teardown on top of it is the wrong thing to attempt.
 */
function installShutdownHandlers(app: NestExpressApplication): void {
  const httpServer = app.getHttpServer() as Server;
  let shuttingDown = false;

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    // A second signal — an impatient operator re-running `docker compose down`
    // — must not start a second drain on top of the first.
    if (shuttingDown) return;
    shuttingDown = true;
    // eslint-disable-next-line no-console
    console.log(`[libriant-api] received ${signal}, draining…`);

    const deadline = setTimeout(() => {
      console.error(
        `[libriant-api] graceful shutdown exceeded ${SHUTDOWN_DEADLINE_MS}ms — forcing exit`,
      );
      process.exit(1);
    }, SHUTDOWN_DEADLINE_MS);

    try {
      // Calls back once the last in-flight response has been written. On a
      // server that never reached `listen()` it calls back immediately with
      // ERR_SERVER_NOT_RUNNING, which is the right outcome here too.
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      await app.close();
    } catch (err) {
      console.error('[libriant-api] error during shutdown', err);
      clearTimeout(deadline);
      process.exit(1);
    }

    clearTimeout(deadline);
    // eslint-disable-next-line no-console
    console.log('[libriant-api] drained, exiting');
    process.exit(0);
  };

  process.on('SIGTERM', (signal) => void shutdown(signal));
  process.on('SIGINT', (signal) => void shutdown(signal));
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
