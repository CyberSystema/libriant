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
   * Require every control-plane admin to have MFA enrolled (AUTH-06). When
   * true, AdminAuthGuard forces a non-enrolled admin onto the enrollment
   * endpoints and blocks everything else. Default ON outside development —
   * the control plane is the highest-value credential in the system.
   */
  adminMfaRequired: boolean;
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
   * whether real charges happen. Default `false` (off) — enforcement turns on
   * only when BILLING_ENABLED is an explicit truthy value; the admin
   * "Subscriptions" toggle (a platform_settings row) overrides this at runtime.
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
   * `console` → log what would have gone out (dev default). `smtp` → deliver
   * through nodemailer + `SMTP_URL`. `resend` → deliver through the Resend HTTP
   * API + `RESEND_API_KEY`. Production must opt in to a real driver.
   */
  emailDriver: 'console' | 'smtp' | 'resend';
  /** SMTP connection URL — `smtp://user:pass@host:587` style. Required for `smtp`. */
  smtpUrl: string | null;
  /** Resend API key (`re_…`). Required for the `resend` driver. */
  resendApiKey: string | null;
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

/**
 * A secret that MUST be present in non-dev AND meet a minimum length, so a
 * stub/typo'd value can't sail through boot (AUTH-11). Dev keeps the static
 * fallback for a frictionless quickstart; automated tests must supply a value
 * but aren't held to the length bar (short fixture secrets are fine).
 */
function requiredSecret(
  key: string,
  devFallback: string,
  nodeEnv: AppEnv['nodeEnv'],
  minLen = 24,
): string {
  const isDev = nodeEnv === 'development';
  const v = isDev ? optional(key, devFallback) : required(key);
  if (!isDev && nodeEnv !== 'test' && v.trim().length < minLen) {
    throw new Error(`Env var ${key} is too short — needs at least ${minLen} characters.`);
  }
  return v;
}

function optional(key: string, fallback: string): string {
  const v = process.env[key];
  return v && v.length ? v : fallback;
}

/**
 * Parse a numeric env var with explicit validation. An unset OR empty value
 * uses the fallback (so a blank `PORT=` doesn't become NaN → a random ephemeral
 * port); anything present but non-finite / out of range fails boot loudly,
 * honouring the "valid or fail" contract (CFG-03, STG-02, BILL-5).
 */
function num(
  key: string,
  fallback: number,
  opts: { min?: number; max?: number; int?: boolean } = {},
): number {
  const raw = process.env[key];
  if (raw === undefined || raw.trim().length === 0) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new Error(`Env var ${key} must be a number, got "${raw}".`);
  }
  if (opts.int && !Number.isInteger(n)) {
    throw new Error(`Env var ${key} must be a whole number, got "${raw}".`);
  }
  if (opts.min !== undefined && n < opts.min) {
    throw new Error(`Env var ${key} must be >= ${opts.min}, got ${n}.`);
  }
  if (opts.max !== undefined && n > opts.max) {
    throw new Error(`Env var ${key} must be <= ${opts.max}, got ${n}.`);
  }
  return n;
}

/** Truthy-string parse shared by boolean env flags. */
function bool(key: string, fallback: boolean): boolean {
  const raw = process.env[key];
  if (raw === undefined || raw.trim().length === 0) return fallback;
  return ['true', '1', 'yes', 'on'].includes(raw.toLowerCase().trim());
}

export function loadEnv(): AppEnv {
  const nodeEnv = (process.env.NODE_ENV ?? 'development') as AppEnv['nodeEnv'];
  // In dev, allow a static fallback so quickstart works without configuration.
  // In any other environment, refuse to boot without a real secret.
  const isDev = nodeEnv === 'development';
  const sessionSecret = requiredSecret(
    'SESSION_SECRET',
    'dev-only-session-secret-CHANGE-IN-PROD',
    nodeEnv,
  );
  const cookieSecure = optional('SESSION_COOKIE_SECURE', 'auto');
  const isSecure =
    cookieSecure === 'auto'
      ? optional('PUBLIC_APP_URL', 'http://localhost:3000').startsWith('https://')
      : cookieSecure === 'true';
  return {
    nodeEnv,
    port: num('PORT', 3001, { int: true, min: 1, max: 65535 }),
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
    tenantCacheTtlSec: num('TENANT_CACHE_TTL_SEC', 300, { int: true, min: 0 }),
    tenantClientCacheSize: num('TENANT_CLIENT_CACHE_SIZE', 50, { int: true, min: 1 }),
    tenantClientIdleMs: num('TENANT_CLIENT_IDLE_MS', 30 * 60 * 1000, { int: true, min: 1000 }),
    sessionSecret,
    sessionTtlSec: num('SESSION_TTL_SEC', 7 * 24 * 60 * 60, { int: true, min: 60 }),
    adminSessionSecret: requiredSecret(
      'ADMIN_SESSION_SECRET',
      'dev-only-admin-session-secret-CHANGE-IN-PROD',
      nodeEnv,
    ),
    adminSessionTtlSec: num('ADMIN_SESSION_TTL_SEC', 60 * 60, { int: true, min: 60 }),
    adminCookieName: optional(
      'ADMIN_COOKIE_NAME',
      isSecure ? '__Host-libriant_admin' : 'libriant_admin',
    ),
    // MFA mandatory for admins by default outside development (AUTH-06).
    adminMfaRequired: bool('ADMIN_MFA_REQUIRED', !isDev),
    mfaMasterKey:
      nodeEnv === 'development'
        ? optional(
            'MFA_MASTER_KEY',
            // Fixed 32-byte dev key — predictable on purpose so the
            // quickstart doesn't need ceremony. PROD must override.
            '0011223344556677889900112233445566778899001122334455667788990011',
          )
        : required('MFA_MASTER_KEY'),
    impersonationSecret: requiredSecret(
      'IMPERSONATION_SECRET',
      'dev-only-impersonation-secret-CHANGE-IN-PROD',
      nodeEnv,
    ),
    supportSessionTtlSec: num('SUPPORT_SESSION_TTL_SEC', 4 * 60 * 60, { int: true, min: 60 }),
    supportKeyTtlSec: num('SUPPORT_KEY_TTL_SEC', 60 * 60, { int: true, min: 60 }),
    impersonationCookieName: optional(
      'IMPERSONATION_COOKIE_NAME',
      isSecure ? '__Host-libriant_imp' : 'libriant_imp',
    ),
    sessionCookieName: optional(
      'SESSION_COOKIE_NAME',
      isSecure ? '__Host-libriant_session' : 'libriant_session',
    ),
    sessionCookieSecure: isSecure,
    bcryptCost: num('BCRYPT_COST', 12, { int: true, min: 10, max: 15 }),
    maxFailedLogins: num('MAX_FAILED_LOGINS', 5, { int: true, min: 1 }),
    loginLockoutMs: num('LOGIN_LOCKOUT_MS', 15 * 60 * 1000, { int: true, min: 1000 }),
    // Used by signup to CREATE DATABASE for new tenants. In dev this is the
    // libriant superuser. In prod, a dedicated provisioning role per cell.
    pgSuperuserUrl: optional(
      'PG_SUPERUSER_URL',
      'postgresql://libriant:libriant@localhost:5432/libriant_control',
    ),
    // Storage signing — separate secret so we can rotate it independently of
    // session JWTs. Dev + test fall back to the session secret to keep
    // quickstart / fixtures painless; PRODUCTION must set it explicitly (TEN-05)
    // so a leaked storage secret can't be turned into a session-forgery oracle
    // and vice-versa.
    storageSigningSecret:
      nodeEnv === 'production'
        ? requiredSecret('STORAGE_SIGNING_SECRET', sessionSecret, nodeEnv)
        : optional('STORAGE_SIGNING_SECRET', sessionSecret),
    storageSignedTtlSec: num('STORAGE_SIGNED_TTL_SEC', 3600, { int: true, min: 1 }),
    storageMaxUploadBytes: num('STORAGE_MAX_UPLOAD_BYTES', 25 * 1024 * 1024, {
      int: true,
      min: 1,
    }),
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
    billingEnabled: bool('BILLING_ENABLED', false),
    stripeApiKey: process.env.STRIPE_API_KEY?.length ? process.env.STRIPE_API_KEY : null,
    stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET?.length
      ? process.env.STRIPE_WEBHOOK_SECRET
      : null,
    billingReturnUrl: optional(
      'BILLING_RETURN_URL',
      optional('PUBLIC_APP_URL', 'http://localhost:3000'),
    ),
    billingGracePeriodDays: num('BILLING_GRACE_PERIOD_DAYS', 7, { int: true, min: 0, max: 365 }),
    emailDriver: (() => {
      const raw = (process.env.EMAIL_DRIVER ?? '').toLowerCase().trim();
      if (raw === 'console' || raw === 'smtp' || raw === 'resend') return raw;
      // Default: console in development (no network needed); smtp in any
      // other environment. Each real driver fails fast at boot if its config
      // (SMTP_URL / RESEND_API_KEY) is missing, so a misconfigured prod
      // surfaces immediately.
      return nodeEnv === 'development' ? 'console' : 'smtp';
    })(),
    smtpUrl: process.env.SMTP_URL?.length ? process.env.SMTP_URL : null,
    resendApiKey: process.env.RESEND_API_KEY?.length ? process.env.RESEND_API_KEY : null,
    emailFrom: optional(
      'EMAIL_FROM',
      `Libriant <no-reply@${optional('PUBLIC_APEX_DOMAIN', 'localhost')}>`,
    ),
    emailReplyTo: process.env.EMAIL_REPLY_TO?.length ? process.env.EMAIL_REPLY_TO : null,
    emailMaxAttempts: num('EMAIL_MAX_ATTEMPTS', 5, { int: true, min: 1 }),
  };
}
