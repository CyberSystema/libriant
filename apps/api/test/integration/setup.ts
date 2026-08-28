// Integration-test setup. Runs before any integration spec is imported.

import { Redis } from 'ioredis';
import { beforeAll } from 'vitest';
import { declaredBillingPosture } from './billing-posture.js';

// --- environment the whole suite needs, set BEFORE loadEnv() is ever called --
//
// `loadEnv()` treats HASH_PEPPER as a required secret outside development, and
// storage.module.ts calls it at import time — so without this the whole suite
// dies during module resolution, before a single test runs. It peppers the IP
// hash behind the /apply throttle; any stable value works here, and the length
// bar is waived under NODE_ENV=test.
process.env.HASH_PEPPER ||= 'integration-only-pepper';

// The suite performs many signups/logins from a single loopback IP against a
// shared Redis, which would trip the production edge rate limits (5 signups /
// 10 min / IP). Disable the counter for integration runs; the controller still
// invokes RateLimitService (wiring stays covered) and the limiter's own logic
// is unit-tested in src/platform/rate-limit.service.spec.ts.
process.env.RATE_LIMIT_DISABLED ||= 'true';

// The marketing site's host, which OriginCheckMiddleware compares the
// application form's `Origin` against. Unset, `siteHost` falls through
// PUBLIC_APEX_DOMAIN to 'localhost', and a spec that posts /apply as a real
// browser would — which is the only way to reach that handler now that
// BROWSER_ONLY_PATHS refuses a missing Origin — would have to name a host that
// exists nowhere else in the repository. Naming the real one keeps the
// submission in retention-erasure.spec.ts shaped like the production request it
// claims to be.
process.env.SITE_HOST ||= 'libriant.com';

// Admin tests bootstrap a password-only admin and exercise authorization, not
// MFA enrollment. Mandatory-MFA (AUTH-06) defaults ON outside development, which
// would 403 those admins onto the enrollment flow; opt the suite out so it
// tests what it means to. MFA enforcement has its own dedicated coverage.
process.env.ADMIN_MFA_REQUIRED ||= 'false';

// --- subscriptions posture: declared per file, never defaulted here ----------
//
// See billing-posture.ts for the full story. Short version: forcing the switch
// ON for the whole suite hid data-integrity-01 (every upload 500'd with billing
// off), and defaulting it OFF for the whole suite hides the opposite class
// (billing off ⇒ unlimitedPlan() ⇒ every gate open, so a spec asserting a
// closed gate proves nothing). Unset it, and make a file that never declared
// fail loudly instead of inheriting either default.
delete process.env.BILLING_ENABLED;

beforeAll(() => {
  if (declaredBillingPosture() === null) {
    throw new Error(
      'This integration spec never declared a subscriptions posture. Add, at module scope:\n' +
        "    import { declareBillingPosture } from './billing-posture.js';\n" +
        "    declareBillingPosture('unenforced', '<why this spec needs it>');\n" +
        "Use 'unenforced' (subscriptions OFF — the launch configuration) unless the spec " +
        "exists to prove a plan gate refuses something, in which case use 'enforced'.",
    );
  }
});

// --- clear the cross-file cache the posture is resolved through --------------
//
// PlatformSettingsService caches the resolved switch in Redis for 30 s under a
// single GLOBAL key, and the whole suite shares one Redis. Because the files
// deliberately disagree about the posture, a value cached by the previous spec
// file would silently outrank this file's declaration for the first 30 s of its
// run. That is the poisoning admin-role-guard.spec.ts documents — measured at
// import-api.spec.ts seeing 201 instead of 402 about one run in ten, back when
// every file at least agreed on the value. Clear the key as each file starts so
// the switch always resolves from this file's own declaration.
//
// This block exists precisely to kill a documented cross-file flake, so it must
// not be able to fail silently: a swallowed DEL, or a client pointed at a Redis
// the app does not use, would put the flake back with the comment still claiming
// it was fixed. Everything below therefore throws.

// Read the URL through the app's own resolver rather than re-deriving it. This
// import must come after the env writes above — loadEnv() validates on call.
const { loadEnv } = await import('../../src/config/env.js');
const redisUrl = loadEnv().redisUrl;

const redis = new Redis(redisUrl, {
  // Matches RedisService's prefix — same key, same namespace. If that constant
  // ever moves, the assertion below is what notices: we DEL and then read back.
  keyPrefix: 'lbr:',
  lazyConnect: true,
  maxRetriesPerRequest: 1,
  connectTimeout: 2_000,
  // One-shot client: never sit in a reconnect loop holding up the run.
  retryStrategy: () => null,
});
// Swallow the *event* so ioredis doesn't print its own "Unhandled error event"
// banner over the real message; the awaited calls below still reject.
redis.on('error', () => undefined);
try {
  await redis.connect();
  await redis.del('platform_setting:billing.enabled');
  // Read back through the same prefixed client. A DEL that "succeeded" against
  // the wrong database, or under the wrong prefix, still leaves this non-null.
  const left = await redis.get('platform_setting:billing.enabled');
  if (left !== null) {
    throw new Error(`key survived DEL (value ${JSON.stringify(left)})`);
  }
} catch (err) {
  throw new Error(
    `Integration setup could not clear the cached subscriptions switch in Redis at ` +
      `${redisUrl}: ${err instanceof Error ? err.message : String(err)}. ` +
      'Without that clear, this file resolves whichever posture the previous spec file ' +
      'cached (30 s TTL, one global key) instead of the one it declared. ' +
      'Start the dev containers with `pnpm db:up`, and make sure REDIS_URL points at the ' +
      'same Redis the API uses.',
    { cause: err },
  );
} finally {
  redis.disconnect();
}
