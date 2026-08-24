import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { DynamicModule, Provider } from '@nestjs/common';
import { PARAMS_PROVIDER_TOKEN, type Params } from 'nestjs-pino';
import { AppModule } from '../../src/app.module.js';
import {
  LOG_REDACT_CENSOR,
  logRedactPaths,
  serializeRes,
} from '../../src/platform/log-redaction.js';
import { declareBillingPosture } from './billing-posture.js';

declareBillingPosture(
  'unenforced',
  'Reads module metadata only — it never boots Nest, opens a socket or resolves a plan. ' +
    'The launch configuration is the honest default for a spec with no opinion.',
);

/**
 * reliability-03, the half the unit spec structurally cannot cover.
 *
 * src/platform/log-redaction.spec.ts builds its own pino instance from the
 * exported constants and asserts the emitted line. That proves the redaction
 * WORKS. It says nothing about whether the running API still uses it: delete
 * `serializers: { res: serializeRes }` from app.module.ts and every one of
 * those tests keeps passing while production goes straight back to writing
 * `Set-Cookie` — a live, replayable session JWT — into stdout.
 *
 * So this reads the parameters app.module.ts actually hands
 * `LoggerModule.forRoot` and asserts they are the very objects log-redaction.ts
 * exports. `LoggerModule.forRoot(params)` stores them on a provider keyed by
 * `PARAMS_PROVIDER_TOKEN` (nestjs-pino/LoggerModule.js), so they are readable
 * from the module metadata with nothing started.
 *
 * It lives in the integration project rather than next to the unit spec only
 * because importing AppModule pulls in `loadEnv()`, which requires the secrets
 * the integration environment supplies. It needs neither Postgres nor Redis —
 * no connection is opened.
 */

function loggerParams(): Params {
  const imports = (Reflect.getMetadata('imports', AppModule) ?? []) as unknown[];
  const dynamic = imports.filter(
    (m): m is DynamicModule => typeof m === 'object' && m !== null && 'providers' in m,
  );
  for (const mod of dynamic) {
    for (const provider of (mod.providers ?? []) as Provider[]) {
      if (
        typeof provider === 'object' &&
        provider !== null &&
        'provide' in provider &&
        provider.provide === PARAMS_PROVIDER_TOKEN &&
        'useValue' in provider
      ) {
        return provider.useValue as Params;
      }
    }
  }
  throw new Error(
    'app.module.ts no longer registers LoggerModule.forRoot() — the HTTP access log is ' +
      'unconfigured, which means unredacted. If the logger moved, move this assertion with it.',
  );
}

/** Lazy so a wiring change is reported as a failing test, not a collection error. */
const pinoHttpOptions = (): Record<string, unknown> | undefined =>
  loggerParams().pinoHttp as Record<string, unknown> | undefined;

describe('app.module.ts logger wiring (reliability-03)', () => {
  it('registers the pinoHttp options at all', () => {
    expect(
      pinoHttpOptions(),
      'LoggerModule.forRoot() was called without pinoHttp options',
    ).toBeTruthy();
  });

  it('installs OUR response serializer, not the default header-emitting one', () => {
    // Identity, not shape: a serializer that merely "looks similar" is how the
    // header bag came back last time.
    const serializers = pinoHttpOptions()?.serializers as Record<string, unknown> | undefined;
    expect(serializers?.res).toBe(serializeRes);
  });

  it('installs the redact paths and the allowlist censor', () => {
    const redact = pinoHttpOptions()?.redact as { paths?: unknown; censor?: unknown } | undefined;
    expect(redact?.paths).toBe(logRedactPaths);
    // The censor is a FUNCTION (it has to be — an allowlist over request
    // headers is not expressible as redact paths). A string here means the
    // wildcard path is censoring every header including the useful ones, and
    // that the allowlist is not running.
    expect(redact?.censor).toBe(LOG_REDACT_CENSOR);
    expect(typeof redact?.censor).toBe('function');
  });

  it('keeps the wildcard request-header path that makes the allowlist reachable', () => {
    // Without `req.headers[*]` the censor is never called for a header nobody
    // listed, and the request side silently reverts to a denylist.
    expect(logRedactPaths).toContain('req.headers[*]');
    expect(logRedactPaths).toContain('req.url');
  });
});
