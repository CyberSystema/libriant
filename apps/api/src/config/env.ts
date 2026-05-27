/**
 * Resolve environment variables once at boot. Treats config strictly: every
 * value we depend on is either present + valid, or boot fails loudly.
 */
export type AppEnv = {
  nodeEnv: 'development' | 'production' | 'test';
  port: number;
  publicAppUrl: string;
  controlDbUrl: string;
  redisUrl: string;
  storageRoot: string;
  assetsRoot: string;
  /** Apex domain used to detect a tenant from the Host header subdomain. */
  publicApexDomain: string;
  /** Path prefix that signals a tenant-scoped request, e.g. `/t/<slug>/...`. */
  tenantPathPrefix: string;
  /** TTL for the slug → tenant context Redis cache, in seconds. */
  tenantCacheTtlSec: number;
  /** Max number of per-tenant Prisma clients kept hot in memory. */
  tenantClientCacheSize: number;
  /** Idle TTL (ms) before an unused tenant client is evicted + disconnected. */
  tenantClientIdleMs: number;
  /** HMAC secret for session JWTs. MUST be set in non-dev environments. */
  sessionSecret: string;
  /** Session lifetime in seconds (sliding). */
  sessionTtlSec: number;
  /** Cookie name; use `__Host-` prefix only when serving over HTTPS. */
  sessionCookieName: string;
  /** Whether to set Secure on the session cookie (HTTPS only). */
  sessionCookieSecure: boolean;
  /** bcrypt rounds for password hashing (12 ≈ 250ms; tuneable). */
  bcryptCost: number;
  /** After this many failed logins, the user is locked out for `loginLockoutMs`. */
  maxFailedLogins: number;
  /** How long a locked-out user is blocked from logging in (ms). */
  loginLockoutMs: number;
  /** Where to write the per-tenant DB+storage URLs during signup provisioning. */
  pgSuperuserUrl: string;
  /** HMAC secret for signed-download URLs. Defaults to sessionSecret in dev. */
  storageSigningSecret: string;
  /** Default TTL (seconds) for signed download URLs. */
  storageSignedTtlSec: number;
  /** Hard upload ceiling per request (bytes); the actual quota is per plan. */
  storageMaxUploadBytes: number;
  /**
   * `real` → calls the Stripe API. `fake` → in-memory driver that records
   * calls and returns canned IDs. Default is `fake` in development so the
   * quickstart works without Stripe credentials; production must opt in.
   */
  stripeDriver: 'real' | 'fake';
  /** Stripe secret key (`sk_test_…` / `sk_live_…`). Required for `real`. */
  stripeApiKey: string | null;
  /** Webhook signing secret (`whsec_…`). Required for `real`. */
  stripeWebhookSecret: string | null;
  /**
   * Where Stripe Checkout / Customer Portal return the user. The library
   * slug is appended at request time.
   */
  billingReturnUrl: string;
  /** Days a tenant keeps full feature access after a failed payment. */
  billingGracePeriodDays: number;
};

function required(key: string): string {
  const v = process.env[key];
  if (!v || v.trim().length === 0) {
    throw new Error(`Missing required env var: ${key}`);
  }
  return v;
}

function optional(key: string, fallback: string): string {
  const v = process.env[key];
  return v && v.length ? v : fallback;
}

export function loadEnv(): AppEnv {
  const nodeEnv = (process.env.NODE_ENV ?? 'development') as AppEnv['nodeEnv'];
  // In dev, allow a static fallback so quickstart works without configuration.
  // In any other environment, refuse to boot without a real secret.
  const sessionSecret =
    nodeEnv === 'development'
      ? optional('SESSION_SECRET', 'dev-only-session-secret-CHANGE-IN-PROD')
      : required('SESSION_SECRET');
  const cookieSecure = optional('SESSION_COOKIE_SECURE', 'auto');
  const isSecure =
    cookieSecure === 'auto'
      ? optional('PUBLIC_APP_URL', 'http://localhost:3000').startsWith('https://')
      : cookieSecure === 'true';
  return {
    nodeEnv,
    port: Number(optional('PORT', '3001')),
    publicAppUrl: optional('PUBLIC_APP_URL', 'http://localhost:3000'),
    controlDbUrl: optional(
      'CONTROL_DATABASE_URL',
      'postgresql://libriant:libriant@localhost:5432/libriant_control',
    ),
    redisUrl: optional('REDIS_URL', 'redis://localhost:6379'),
    storageRoot: optional('STORAGE_ROOT', '/srv/libriant/storage'),
    assetsRoot: optional('ASSETS_ROOT', new URL('../../../../assets', import.meta.url).pathname),
    publicApexDomain: optional('PUBLIC_APEX_DOMAIN', 'localhost'),
    tenantPathPrefix: optional('TENANT_PATH_PREFIX', '/t/'),
    tenantCacheTtlSec: Number(optional('TENANT_CACHE_TTL_SEC', '300')),
    tenantClientCacheSize: Number(optional('TENANT_CLIENT_CACHE_SIZE', '50')),
    tenantClientIdleMs: Number(optional('TENANT_CLIENT_IDLE_MS', String(30 * 60 * 1000))),
    sessionSecret,
    sessionTtlSec: Number(optional('SESSION_TTL_SEC', String(7 * 24 * 60 * 60))),
    sessionCookieName: optional(
      'SESSION_COOKIE_NAME',
      isSecure ? '__Host-libriant_session' : 'libriant_session',
    ),
    sessionCookieSecure: isSecure,
    bcryptCost: Number(optional('BCRYPT_COST', '12')),
    maxFailedLogins: Number(optional('MAX_FAILED_LOGINS', '5')),
    loginLockoutMs: Number(optional('LOGIN_LOCKOUT_MS', String(15 * 60 * 1000))),
    // Used by signup to CREATE DATABASE for new tenants. In dev this is the
    // libriant superuser. In prod, a dedicated provisioning role per cell.
    pgSuperuserUrl: optional(
      'PG_SUPERUSER_URL',
      'postgresql://libriant:libriant@localhost:5432/libriant_control',
    ),
    // Storage signing — separate secret so we can rotate it independently
    // of session JWTs. In dev we fall back to the session secret to keep
    // quickstart painless.
    storageSigningSecret: optional('STORAGE_SIGNING_SECRET', sessionSecret),
    storageSignedTtlSec: Number(optional('STORAGE_SIGNED_TTL_SEC', '3600')),
    storageMaxUploadBytes: Number(optional('STORAGE_MAX_UPLOAD_BYTES', String(25 * 1024 * 1024))),
    stripeDriver: (() => {
      const raw = (process.env.STRIPE_DRIVER ?? '').toLowerCase().trim();
      if (raw === 'real' || raw === 'fake') return raw;
      // Default: fake in development, real in any other environment. Hard
      // failure if the operator misconfigured prod with no Stripe creds
      // happens in the real driver constructor (see stripe-real.driver.ts).
      return nodeEnv === 'development' ? 'fake' : 'real';
    })(),
    stripeApiKey: process.env.STRIPE_API_KEY?.length ? process.env.STRIPE_API_KEY : null,
    stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET?.length
      ? process.env.STRIPE_WEBHOOK_SECRET
      : null,
    billingReturnUrl: optional(
      'BILLING_RETURN_URL',
      optional('PUBLIC_APP_URL', 'http://localhost:3000'),
    ),
    billingGracePeriodDays: Number(optional('BILLING_GRACE_PERIOD_DAYS', '7')),
  };
}
