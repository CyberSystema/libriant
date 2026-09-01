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
  /** Host serving the public marketing site. Distinct from the app host. */
  siteHost: string;
  /** Secret pepper for the application form's IP throttle hash. */
  applyHashPepper: string;
  /** Where a new application notification is sent. */
  applyNotifyTo: string;
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
  /** Session lifetime in seconds for a normal (non-"remember me") login. */
  sessionTtlSec: number;
  /** Session lifetime for a "remember me" login — longer, persistent cookie. */
  sessionRememberTtlSec: number;
  /**
   * Absolute cap on a session's TOTAL age (from first login), regardless of
   * sliding/activity. Once exceeded the user must sign in again — bounds the
   * usefulness of a stolen long-lived cookie and stops sliding from creating a
   * never-expiring session. Must exceed the remember TTL for sliding to add value.
   */
  sessionAbsoluteMaxTtlSec: number;
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
  /** GitHub `owner/repo` the desktop installers publish to (the Releases feed
   *  electron-updater reads + the panel download proxy resolves). */
  desktopReleaseRepo: string;
  /** Optional GitHub token for reading releases + assets — required only if that
   *  repo is PRIVATE; also lifts the unauthenticated GitHub API rate limit. */
  desktopReleaseToken: string | null;
  /**
   * Base URL of the ntfy server push notifications are published to. Defaults
   * to the hosted https://ntfy.sh ON PURPOSE — see the long note in
   * scripts/_lib/notify.sh. An alerting service that runs in our own compose
   * file dies with the box it is alerting about.
   */
  ntfyServer: string;
  /**
   * The ntfy topic, or `null` for "notifications are off".
   *
   * NULL COVERS BOTH "unset" AND "unusable", and neither one fails boot —
   * which is a deliberate exception to this file's own "present + valid or
   * boot fails loudly" contract, argued in {@link resolveNtfy}.
   */
  ntfyTopic: string | null;
  /** Optional ntfy access token for a protected topic. */
  ntfyToken: string | null;
  /** Lowest level that is actually published. One of NOTIFY_LEVEL_NAMES. */
  ntfyMinLevel: string;
  /**
   * Why notifications are off / degraded, phrased WITHOUT the offending value,
   * or `null` when there is nothing to say. NotifyService logs it once at
   * construction; env.ts has no logger and must not acquire one.
   *
   * `null` is also what a host that never configured ntfy gets, so the
   * shipped-by-default configuration produces no log line at all.
   */
  ntfyConfigProblem: string | null;
};

/**
 * Shortest topic this platform will publish to.
 *
 * On ntfy.sh a topic is not a channel, it is a password that looks like one:
 * anyone who knows or guesses the string reads every message on it and can
 * publish to it. Reserving a topic is a paid feature, so on the tier this
 * project uses, the length of the string IS the access control — a token does
 * not lift this floor. `libriant` and `libriant-prod` are the first two guesses
 * anybody would make, so a short topic is refused rather than used.
 *
 * Kept identical to `_NOTIFY_TOPIC_MIN_LEN` in scripts/_lib/notify.sh; the
 * unit spec reads that file and fails if the two drift.
 */
export const NTFY_TOPIC_MIN_LEN = 24;

/** ntfy's own topic character class. */
const NTFY_TOPIC_RE = /^[A-Za-z0-9_-]+$/;

/** Mirrors `_NTFY_LEVELS` in scripts/_lib/notify.sh; asserted by the spec. */
const NTFY_LEVEL_NAMES = ['debug', 'info', 'warn', 'error'] as const;

type NtfyConfig = Pick<
  AppEnv,
  'ntfyServer' | 'ntfyTopic' | 'ntfyToken' | 'ntfyMinLevel' | 'ntfyConfigProblem'
>;

/**
 * Resolve the ntfy block — the one place in this file that reports a bad value
 * by DISABLING A FEATURE instead of by refusing to boot.
 *
 * Everything else here follows "present + valid, or boot fails loudly", and
 * that rule is right for a session secret: a server running without one is
 * worse than a server that will not start. It is exactly backwards for this
 * one. The notifier's entire purpose is to tell the operator when something is
 * wrong, and a notifier that can take the API down when ITS OWN configuration
 * is wrong has become the outage it was installed to report. A typo in
 * NTFY_TOPIC would stop every container on the box, during a launch campaign,
 * over the alert channel.
 *
 * So a malformed topic means "no notifications", the reason is carried out on
 * `ntfyConfigProblem` for NotifyService to log once, and the API serves.
 *
 * Silence is the failure mode we accept here, and it is only acceptable
 * because it is checkable: `bash scripts/_lib/notify.sh --test` sends a real
 * notification and exits non-zero if it was not accepted, and `--status` says
 * whether anything is configured at all without printing a value. That is how
 * an operator turns this silence into a fact before relying on the channel.
 */
function resolveNtfy(): NtfyConfig {
  const server = optional('NTFY_SERVER', 'https://ntfy.sh').replace(/\/+$/, '');
  const topic = (process.env.NTFY_TOPIC ?? '').trim();
  const token = (process.env.NTFY_TOKEN ?? '').trim();
  const rawLevel = (process.env.NTFY_MIN_LEVEL ?? '').trim().toLowerCase();

  const problems: string[] = [];
  let minLevel = 'info';
  if (rawLevel.length > 0) {
    if ((NTFY_LEVEL_NAMES as readonly string[]).includes(rawLevel)) minLevel = rawLevel;
    else problems.push(`NTFY_MIN_LEVEL must be one of ${NTFY_LEVEL_NAMES.join('|')}; using info`);
  }

  const off = (extra?: string): NtfyConfig => ({
    ntfyServer: server,
    ntfyTopic: null,
    ntfyToken: null,
    ntfyMinLevel: minLevel,
    ntfyConfigProblem: [...problems, ...(extra ? [extra] : [])].join('; ') || null,
  });

  if (topic.length === 0) {
    // Off by default and SILENT: a host that never configured this is not a
    // host that got it wrong. A token with no topic is different — that is an
    // operator who tried, and who would otherwise wait forever for a
    // notification nothing can send.
    return off(token.length > 0 ? 'NTFY_TOKEN is set but NTFY_TOPIC is empty' : undefined);
  }
  if (!NTFY_TOPIC_RE.test(topic)) {
    return off('NTFY_TOPIC contains characters ntfy does not accept (allowed: A-Z a-z 0-9 _ -)');
  }
  if (topic.length < NTFY_TOPIC_MIN_LEN) {
    return off(
      `NTFY_TOPIC is shorter than ${NTFY_TOPIC_MIN_LEN} characters. On ntfy.sh anyone who ` +
        'guesses the topic reads every message on it, so a short one is a public feed. ' +
        'Generate a real one with: openssl rand -hex 16',
    );
  }
  // The token rides in an Authorization header. A newline or a control
  // character in it is header injection into every outgoing request, and
  // Node's fetch would throw on it rather than send — so it is refused here,
  // where the refusal can be explained, instead of at the first send.
  if (token.length > 0 && !NTFY_TOPIC_RE.test(token)) {
    problems.push(
      'NTFY_TOKEN contains characters an ntfy access token cannot contain; ignoring it',
    );
    return {
      ntfyServer: server,
      ntfyTopic: topic,
      ntfyToken: null,
      ntfyMinLevel: minLevel,
      ntfyConfigProblem: problems.join('; ') || null,
    };
  }

  return {
    ntfyServer: server,
    ntfyTopic: topic,
    ntfyToken: token.length > 0 ? token : null,
    ntfyMinLevel: minLevel,
    ntfyConfigProblem: problems.join('; ') || null,
  };
}

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

const BOOL_TRUE = ['true', '1', 'yes', 'on'];
const BOOL_FALSE = ['false', '0', 'no', 'off'];

/**
 * Truthy-string parse shared by boolean env flags. Unset or blank takes the
 * fallback; anything outside the two allow-lists FAILS BOOT.
 *
 * boot-and-config-10: this used to return `BOOL_TRUE.includes(v)`, so every
 * value it did not recognise silently meant `false`. The plausible operator
 * spellings are the dangerous ones — `BILLING_ENABLED=enabled` and
 * `BILLING_ENABLED=y` both read as "subscriptions off", i.e. the whole product
 * free, with nothing logged and the admin panel still showing the switch the
 * operator thought they had set. A flag with two legal settings that quietly
 * picks one of them on a typo is the same defect class as NODE_ENV below.
 */
function bool(key: string, fallback: boolean): boolean {
  const raw = process.env[key];
  if (raw === undefined || raw.trim().length === 0) return fallback;
  const v = raw.toLowerCase().trim();
  if (BOOL_TRUE.includes(v)) return true;
  if (BOOL_FALSE.includes(v)) return false;
  throw new Error(
    `Env var ${key} must be one of ${[...BOOL_TRUE, ...BOOL_FALSE].join(', ')} — got "${raw}".`,
  );
}

/** The only environments this app knows how to be. */
const APP_ENVS = ['development', 'production', 'test'] as const;

/**
 * NODE_ENV, validated rather than cast.
 *
 * boot-and-config-03 / tenant-isolation-06 are one defect: this was
 * `(process.env.NODE_ENV ?? 'development') as AppEnv['nodeEnv']`, a bare cast
 * with no allow-list, and FOUR protections key on the string being exactly
 * `production` — main.ts refusing to boot with RATE_LIMIT_DISABLED,
 * RateLimitService ignoring that flag, the NonProductionOnlyGuard on the
 * dev-only demo controller (whose POST /demo/books does a real, unvalidated
 * book write around the quota authority), and STORAGE_SIGNING_SECRET being
 * demanded instead of silently collapsing into SESSION_SECRET.
 *
 * `staging`, `prod` or a typo'd `Production` was neither: still non-dev, so
 * every secret was demanded and the box LOOKED correctly configured, while all
 * four protections were off. Executed against a real boot before this change:
 * `NODE_ENV=staging` and `NODE_ENV=Production` both started clean, and
 * `NODE_ENV=staging` with STORAGE_SIGNING_SECRET unset booted with the storage
 * HMAC key equal to the session JWT key.
 *
 * Fixing it at the four call sites would have left the fifth to be written
 * later, so it is fixed here instead: an environment we do not recognise is a
 * configuration error, not a mode. Nothing this repo deploys is affected —
 * Dockerfile and compose both pin `production`.
 */
function resolveNodeEnv(): AppEnv['nodeEnv'] {
  const raw = process.env.NODE_ENV;
  if (raw === undefined || raw.trim().length === 0) return 'development';
  const v = raw.trim();
  if ((APP_ENVS as readonly string[]).includes(v)) return v as AppEnv['nodeEnv'];
  throw new Error(
    `Env var NODE_ENV must be one of ${APP_ENVS.join(', ')} — got "${raw}". ` +
      'Anything else is treated as non-development (so every secret is still demanded) ' +
      'while silently disabling every production-only protection: the dev-only demo ' +
      'endpoints become reachable, RATE_LIMIT_DISABLED starts being honoured, and ' +
      'STORAGE_SIGNING_SECRET falls back to SESSION_SECRET.',
  );
}

/**
 * Infrastructure the process cannot function without, kept quickstart-friendly
 * in development only.
 *
 * boot-and-config-07: these four were `optional()` with PRODUCTION-SHAPED
 * fallbacks — `postgresql://libriant:libriant@localhost:5432/libriant_control`
 * and `/srv/libriant/storage` — against this file's own promise that every
 * value we depend on is present + valid or boot fails loudly. Executed: with
 * NODE_ENV=production and PG_SUPERUSER_URL unset the API booted fully green
 * (readyz=200), because nothing on the startup or readiness path touches it;
 * the mistake would first surface as a tenant signup running CREATE DATABASE
 * against localhost with the guessable libriant/libriant credentials. Same
 * rule as the secrets above: a dev fallback, or a loud failure.
 */
function requiredOutsideDev(key: string, devFallback: string, nodeEnv: AppEnv['nodeEnv']): string {
  return nodeEnv === 'development' ? optional(key, devFallback) : required(key);
}

export function loadEnv(): AppEnv {
  const nodeEnv = resolveNodeEnv();
  // In dev, allow a static fallback so quickstart works without configuration.
  // In any other environment, refuse to boot without a real secret.
  const isDev = nodeEnv === 'development';
  const sessionSecret = requiredSecret(
    'SESSION_SECRET',
    'dev-only-session-secret-CHANGE-IN-PROD',
    nodeEnv,
  );
  // A5-04: resolve + validate the MFA master key at BOOT, not lazily at
  // MfaService construction. AES-256-GCM needs exactly 32 bytes (64 hex chars);
  // a typo'd/short key must fail the whole process loudly at startup rather than
  // 500-ing the first admin who tries to enroll.
  const mfaMasterKey =
    nodeEnv === 'development'
      ? optional(
          'MFA_MASTER_KEY',
          // Fixed 32-byte dev key — predictable on purpose so the
          // quickstart doesn't need ceremony. PROD must override.
          '0011223344556677889900112233445566778899001122334455667788990011',
        )
      : required('MFA_MASTER_KEY');
  if (!/^[0-9a-fA-F]{64}$/.test(mfaMasterKey)) {
    throw new Error('Env var MFA_MASTER_KEY must be 64 hex characters (a 32-byte key).');
  }

  const cookieSecure = optional('SESSION_COOKIE_SECURE', 'auto');
  const isSecure =
    cookieSecure === 'auto'
      ? // Default ('auto'): Secure in EVERY real deployment — the app always runs
        // behind TLS (Cloudflare→Caddy), and a session/admin cookie must never
        // go out without Secure + the __Host- prefix. A5-02: keying this on
        // `=== 'production'` left `staging` (or any other non-prod NODE_ENV)
        // silently shipping non-Secure bearer cookies, so treat ANY environment
        // other than development/test as secure. Dev + test stay non-Secure so
        // local + http supertest flows still work; an explicit https
        // PUBLIC_APP_URL still upgrades them.
        (nodeEnv !== 'development' && nodeEnv !== 'test') ||
        optional('PUBLIC_APP_URL', 'http://localhost:3000').startsWith('https://')
      : cookieSecure === 'true';

  // Storage signing — separate secret so we can rotate it independently of
  // session JWTs. Dev + test fall back to the session secret to keep
  // quickstart / fixtures painless; PRODUCTION must set it explicitly (TEN-05)
  // so a leaked storage secret can't be turned into a session-forgery oracle
  // and vice-versa.
  //
  // tenant-isolation-06: the non-production half of that ("`staging` silently
  // reuses the session secret") is closed at source by resolveNodeEnv(). What
  // no gate ever caught is the copy-paste — two variables in .env.prod holding
  // the same string satisfies `required()` and collapses the separation just as
  // completely. It matters because `GET /_files/signed` is the one storage
  // route with no guard at all: `verify(token)` alone picks both the tenant and
  // the object, so one key covering both session forgery and anonymous
  // cross-tenant file reads is exactly the oracle the paragraph above says must
  // not exist. Asserted only in production, because dev + test share the two on
  // purpose via the fallback directly above.
  const storageSigningSecret =
    nodeEnv === 'production'
      ? requiredSecret('STORAGE_SIGNING_SECRET', sessionSecret, nodeEnv)
      : optional('STORAGE_SIGNING_SECRET', sessionSecret);
  if (nodeEnv === 'production' && storageSigningSecret === sessionSecret) {
    throw new Error(
      'STORAGE_SIGNING_SECRET and SESSION_SECRET hold the same value — refusing to boot. ' +
        'They are deliberately different keys so a leaked storage-signing secret cannot be ' +
        'turned into a session-forgery oracle, or the reverse. Generate a distinct value ' +
        'for STORAGE_SIGNING_SECRET (`openssl rand -hex 32`).',
    );
  }

  return {
    nodeEnv,
    port: num('PORT', 3001, { int: true, min: 1, max: 65535 }),
    publicAppUrl: optional('PUBLIC_APP_URL', 'http://localhost:3000'),
    controlDbUrl: requiredOutsideDev(
      'CONTROL_DATABASE_URL',
      'postgresql://libriant:libriant@localhost:5432/libriant_control',
      nodeEnv,
    ),
    redisUrl: requiredOutsideDev('REDIS_URL', 'redis://localhost:6379', nodeEnv),
    storageRoot: requiredOutsideDev('STORAGE_ROOT', '/srv/libriant/storage', nodeEnv),
    assetsRoot: optional('ASSETS_ROOT', new URL('../../../../assets', import.meta.url).pathname),
    publicApexDomain: optional('PUBLIC_APEX_DOMAIN', 'localhost'),
    siteHost: optional('SITE_HOST', optional('PUBLIC_APEX_DOMAIN', 'localhost')).toLowerCase(),
    // No insecure production fallback: a publicly-known pepper over the 2^32
    // IPv4 space is a rainbow table away from being the address itself, and the
    // privacy notice promises a secret key.
    applyHashPepper: requiredSecret('HASH_PEPPER', 'libriant-dev-only', nodeEnv, 32),
    applyNotifyTo: optional(
      'APPLY_NOTIFY_TO',
      `info@${optional('PUBLIC_APEX_DOMAIN', 'localhost')}`,
    ),
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
    sessionRememberTtlSec: num('SESSION_REMEMBER_TTL_SEC', 30 * 24 * 60 * 60, {
      int: true,
      min: 60,
    }),
    sessionAbsoluteMaxTtlSec: num('SESSION_ABSOLUTE_MAX_TTL_SEC', 90 * 24 * 60 * 60, {
      int: true,
      min: 60,
    }),
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
    mfaMasterKey,
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
    pgSuperuserUrl: requiredOutsideDev(
      'PG_SUPERUSER_URL',
      'postgresql://libriant:libriant@localhost:5432/libriant_control',
      nodeEnv,
    ),
    storageSigningSecret,
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
    desktopReleaseRepo: optional('DESKTOP_RELEASE_REPO', 'CyberSystema/libriant'),
    desktopReleaseToken: process.env.DESKTOP_RELEASE_TOKEN?.length
      ? process.env.DESKTOP_RELEASE_TOKEN
      : null,
    ...resolveNtfy(),
  };
}
