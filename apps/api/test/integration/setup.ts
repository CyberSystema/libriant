// Integration-test setup. Runs before any integration spec.
//
// The suite exercises plan/quota enforcement (e.g. the bulk-import 402 gate),
// which only applies when subscriptions are enabled. The app now defaults that
// OFF, so turn enforcement on for the integration project unless the
// environment already pins it. Keeping this here (rather than in the CI
// workflow env) means the suite is self-describing and runs the same locally.
process.env.BILLING_ENABLED ||= 'true';

// The suite performs many signups/logins from a single loopback IP against a
// shared Redis, which would trip the production edge rate limits (5 signups /
// 10 min / IP). Disable the counter for integration runs; the controller still
// invokes RateLimitService (wiring stays covered) and the limiter's own logic
// is unit-tested in src/platform/rate-limit.service.spec.ts.
process.env.RATE_LIMIT_DISABLED ||= 'true';

// Admin tests bootstrap a password-only admin and exercise authorization, not
// MFA enrollment. Mandatory-MFA (AUTH-06) defaults ON outside development, which
// would 403 those admins onto the enrollment flow; opt the suite out so it
// tests what it means to. MFA enforcement has its own dedicated coverage.
process.env.ADMIN_MFA_REQUIRED ||= 'false';

// `loadEnv()` treats HASH_PEPPER as a required secret outside development, and
// storage.module.ts calls it at import time — so without this the whole suite
// dies during module resolution, before a single test runs. It peppers the IP
// hash behind the /apply throttle; any stable value works here, and the length
// bar is waived under NODE_ENV=test.
process.env.HASH_PEPPER ||= 'integration-only-pepper';
