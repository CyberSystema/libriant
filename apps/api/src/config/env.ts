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
  /** Platform admin host (e.g. `admin.libriant.com`). Excluded from tenant
   *  subdomain resolution so it isn't mistaken for a library slug. */
  adminHost: string;
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
  /**
   * Admin session JWT secret. Deliberately distinct from `sessionSecret`
   * so a leaked tenant cookie can't be turned into an admin cookie even
   * if both secrets happened to share a code path. Falls back to a dev
   * default; production must override.
   */
  adminSessionSecret: string;
  /** Admin session lifetime in seconds (shorter than tenant: 1h default). */
  adminSessionTtlSec: number;
  /** Cookie name for the admin session. */
  adminCookieName: string;
  /**
   * Hex-encoded 32-byte master key used to AES-256-GCM-encrypt admin
   * TOTP secrets at rest. The DB column stores ciphertext + nonce; this
   * env value is the only thing that can decrypt them. Rotation is
   * out of MVP scope; for now keep this stable.
   */
  mfaMasterKey: string;
  /**
   * Impersonation session secret. Distinct from `adminSessionSecret` so
   * even a leaked admin cookie cannot impersonate a tenant. JWT TTL
   * mirrors `SupportSession.expiresAt` (4h after redemption).
   */
  impersonationSecret: string;
  /** Default support-session lifetime in seconds. Plan: 4h. */
  supportSessionTtlSec: number;
  /** Support-key lifetime in seconds (from generation). Plan: 1h. */
  supportKeyTtlSec: number;
  /** Cookie name for the impersonation session. */
  impersonationCookieName: string;
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
  /**
   * Master switch for plan/quota enforcement. When `false`, EVERY tenant gets
   * unrestricted access to all features and limits (the whole product is free)
   * — useful for a pre-monetization launch. The admin panel is unaffected
   * (it has its own auth). Separate from `stripeDriver`, which only controls
   * whether real charges happen. Default `true`.
   */
  billingEnabled: boolean;
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
  /**
   * `console` → log what would have gone out (dev default). `smtp` →
   * deliver through nodemailer + `SMTP_URL` (e.g. `smtp://user:pass@host:port`).
   * Production must opt in to a real driver.
   */
  emailDriver: 'console' | 'smtp';
  /** SMTP connection URL — `smtp://user:pass@host:587` style. Required for `smtp`. */
  smtpUrl: string | null;
  /** Default `From:` envelope. Falls back to `Libriant <no-reply@$PUBLIC_HOST>`. */
  emailFrom: string;
  /** Optional default `Reply-To:` envelope. */
  emailReplyTo: string | null;
  /** Per-job retry budget. */
  emailMaxAttempts: number;
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
    adminHost: optional(
      'ADMIN_HOST',
      `admin.${optional('PUBLIC_APEX_DOMAIN', 'localhost')}`,
    ).toLowerCase(),
    tenantPathPrefix: optional('TENANT_PATH_PREFIX', '/t/'),
    tenantCacheTtlSec: Number(optional('TENANT_CACHE_TTL_SEC', '300')),
    tenantClientCacheSize: Number(optional('TENANT_CLIENT_CACHE_SIZE', '50')),
    tenantClientIdleMs: Number(optional('TENANT_CLIENT_IDLE_MS', String(30 * 60 * 1000))),
    sessionSecret,
    sessionTtlSec: Number(optional('SESSION_TTL_SEC', String(7 * 24 * 60 * 60))),
    adminSessionSecret:
      nodeEnv === 'development'
        ? optional('ADMIN_SESSION_SECRET', 'dev-only-admin-session-secret-CHANGE-IN-PROD')
        : required('ADMIN_SESSION_SECRET'),
    adminSessionTtlSec: Number(optional('ADMIN_SESSION_TTL_SEC', String(60 * 60))),
    adminCookieName: optional(
      'ADMIN_COOKIE_NAME',
      isSecure ? '__Host-libriant_admin' : 'libriant_admin',
    ),
    mfaMasterKey:
      nodeEnv === 'development'
        ? optional(
            'MFA_MASTER_KEY',
            // Fixed 32-byte dev key — predictable on purpose so the
            // quickstart doesn't need ceremony. PROD must override.
            '0011223344556677889900112233445566778899001122334455667788990011',
          )
        : required('MFA_MASTER_KEY'),
    impersonationSecret:
      nodeEnv === 'development'
        ? optional('IMPERSONATION_SECRET', 'dev-only-impersonation-secret-CHANGE-IN-PROD')
        : required('IMPERSONATION_SECRET'),
    supportSessionTtlSec: Number(optional('SUPPORT_SESSION_TTL_SEC', String(4 * 60 * 60))),
    supportKeyTtlSec: Number(optional('SUPPORT_KEY_TTL_SEC', String(60 * 60))),
    impersonationCookieName: optional(
      'IMPERSONATION_COOKIE_NAME',
      isSecure ? '__Host-libriant_imp' : 'libriant_imp',
    ),
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
    // Subscriptions default to OFF (free for everyone). Enforcement turns on
    // ONLY when BILLING_ENABLED is an explicit truthy value — unset, EMPTY, or
    // anything non-truthy means disabled. (The old default was "true", and `??`
    // doesn't catch an empty string, so a blank env var silently enforced
    // Starter limits.) The admin "Subscriptions" toggle — a platform_settings
    // DB row — overrides this at runtime and is the authoritative switch.
    billingEnabled: ['true', '1', 'yes', 'on'].includes(
      (process.env.BILLING_ENABLED ?? '').toLowerCase().trim(),
    ),
    stripeApiKey: process.env.STRIPE_API_KEY?.length ? process.env.STRIPE_API_KEY : null,
    stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET?.length
      ? process.env.STRIPE_WEBHOOK_SECRET
      : null,
    billingReturnUrl: optional(
      'BILLING_RETURN_URL',
      optional('PUBLIC_APP_URL', 'http://localhost:3000'),
    ),
    billingGracePeriodDays: Number(optional('BILLING_GRACE_PERIOD_DAYS', '7')),
    emailDriver: (() => {
      const raw = (process.env.EMAIL_DRIVER ?? '').toLowerCase().trim();
      if (raw === 'console' || raw === 'smtp') return raw;
      // Default: console in development (no network needed); smtp in any
      // other environment. The smtp driver fails fast at boot if SMTP_URL
      // is missing, so a misconfigured prod surfaces immediately.
      return nodeEnv === 'development' ? 'console' : 'smtp';
    })(),
    smtpUrl: process.env.SMTP_URL?.length ? process.env.SMTP_URL : null,
    emailFrom: optional(
      'EMAIL_FROM',
      `Libriant <no-reply@${optional('PUBLIC_APEX_DOMAIN', 'localhost')}>`,
    ),
    emailReplyTo: process.env.EMAIL_REPLY_TO?.length ? process.env.EMAIL_REPLY_TO : null,
    emailMaxAttempts: Number(optional('EMAIL_MAX_ATTEMPTS', '5')),
  };
}
