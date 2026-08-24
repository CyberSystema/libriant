import { randomBytes } from 'node:crypto';

/**
 * Keeps bearer credentials out of `email_outbox.bodyMarkdown` — while still
 * letting the operator read a live link.
 *
 * TWO FINDINGS PULL IN OPPOSITE DIRECTIONS AND THIS FILE IS WHERE THEY MEET.
 *
 *   launch-readiness-01 (blocker) — `EMAIL_DRIVER=console` delivers nothing and
 *   the console driver withholds the body from the log, so a librarian who
 *   needs a verification or reset link has no way to get one and neither does
 *   the operator. The operator MUST be able to read the rendered link.
 *
 *   privacy-legal-06 (high) — the same link was stored in cleartext, forever,
 *   in `email_outbox.bodyMarkdown`: never purged, not covered by the
 *   control-export redactor (which matches COLUMN NAMES, and `bodymarkdown`
 *   matches none of them), and inside `pg_dumpall` in every nightly backup
 *   (scripts/backup.sh step 1). Anyone with a backup could take over any
 *   account whose reset was in flight. An attacker with a backup MUST NOT be
 *   able to read the link.
 *
 * THE RESOLUTION: the secret never enters Postgres at all.
 *
 * At enqueue time every bearer-credential query parameter is lifted out of the
 * body and replaced with an opaque placeholder. The values go to REDIS under a
 * random reference, with a TTL. Postgres stores
 *
 *     https://app.libriant.com/el/login/reset?token={{lbr-secret:9f3…:1}}&slug=demo
 *
 * The worker re-hydrates from Redis immediately before handing the body to the
 * driver, and the admin outbox viewer re-hydrates the same way for the operator.
 *
 * Why Redis is the right side of the line, concretely:
 *
 *   • `scripts/backup.sh` captures `pg_dumpall` + `/srv/libriant/storage` +
 *     the Caddy access log. It does NOT capture Redis. So a stolen backup now
 *     contains a URL shape and nothing redeemable.
 *   • The reset/verify token ALREADY lives in Redis (`pwreset:<token>`,
 *     `emailverify:<token>`) — that is where PasswordResetService and
 *     EmailVerificationService keep it and where they redeem it from. Putting
 *     the copy next to the original adds no new place to steal it from, and it
 *     inherits the same "it dies on its own" property.
 *   • The operator keeps a readable link for exactly as long as the link is
 *     worth reading. Once the TTL lapses, the underlying token is dead anyway,
 *     so what the viewer shows (`[link expired]`) is the truth rather than a
 *     tempting-but-broken URL.
 *
 * What this deliberately does NOT do: encrypt the stored body. An AES key would
 * have to live in `/srv/libriant/.env.prod`, on the same box the backup is
 * taken from, and would decrypt every historical row forever. Expiry beats
 * encryption here because the plaintext's usefulness is already time-bounded.
 *
 * SCOPE OF THE SEAL: query and fragment parameters, because that is the only
 * shape a credential takes in a Libriant email today (`?token=`, `#token=`),
 * and the parameter list below is generous on purpose — it seals a `code=` / `key=` / `invite=`
 * link that does not exist yet, so a future producer inherits the protection
 * without knowing this file exists. It does NOT seal a bare credential printed
 * outside a URL. Nothing does that today (the support-key mail carries only
 * `SUPPORT-<prefix>…`, never the full code — see
 * support-notifications.service.ts) and a producer that starts doing so must
 * come back here.
 */

/**
 * Query parameters whose VALUE is a bearer credential. Matched
 * case-insensitively. Adding a name here retroactively protects every producer.
 */
const SECRET_QUERY_PARAMS = [
  'token',
  'code',
  'key',
  'secret',
  'invite',
  'otp',
  'sig',
  'signature',
] as const;

/**
 * `?token=<value>` / `&token=<value>` / `#token=<value>`. The value runs to the
 * first character that cannot be inside a query value in a plain-text email
 * body: whitespace, `&` (next parameter), or a quote/bracket that is almost
 * certainly markup or punctuation wrapping the URL.
 *
 * `#` is in the leading class because the credential is migrating OUT of the
 * query string (privacy-legal-06 — Caddy logs `request.uri`, backups keep the
 * log). `AdminOutboxService.issuePasswordResetLink` already mints
 * `…/login/reset#token=…`, and when the e-mail producers follow, a body that
 * fell out of this pattern would be persisted with a live token in it — the
 * exact defect this file exists to prevent, reintroduced by a change that
 * looks like a hardening.
 */
const SECRET_PARAM_RE = new RegExp(
  `([?&#](?:${SECRET_QUERY_PARAMS.join('|')})=)([^\\s&"'<>\\)\\]}]+)`,
  'gi',
);

/** `{{lbr-secret:<ref>:<slot>}}` — what Postgres stores in place of a secret. */
const PLACEHOLDER_RE = /\{\{lbr-secret:([0-9a-f]{8,64}):(\d+)\}\}/g;

/** Shown to the operator when the sealed value is gone (TTL lapsed / flushed). */
export const EXPIRED_SECRET_TEXT = '[link expired]';

/**
 * How long a sealed value survives in Redis.
 *
 * The longest-lived token in the system is the 24-hour e-mail-verification
 * token (EmailVerificationService.TOKEN_TTL_SEC); a password-reset token dies
 * after 60 minutes and its sealed copy is inert long before this. The two extra
 * hours are so an operator answering "I never got the mail" about a link minted
 * 23h50m ago still sees something rather than a placeholder — the link itself
 * may already have expired, and the viewer says so, which is a better answer
 * than a blank.
 */
export const OUTBOX_SECRET_TTL_SEC = 26 * 60 * 60;

/** Redis key for one message's sealed values. Prefixed with `lbr:` by RedisService. */
export function outboxSecretKey(ref: string): string {
  return `email:secret:${ref}`;
}

export type SealedBody = {
  /** What goes into `email_outbox.bodyMarkdown`. Safe to back up. */
  storedBody: string;
  /** Redis reference, or null when the body carried no credential at all. */
  ref: string | null;
  /** slot → plaintext. Empty when `ref` is null. */
  secrets: Record<string, string>;
};

/**
 * Lift every bearer credential out of `body`. Pure — the caller writes
 * `secrets` to Redis under {@link outboxSecretKey}(`ref`) BEFORE persisting
 * `storedBody`, so a crash between the two can only ever orphan a Redis key
 * (which expires) and never persist a body whose secrets were lost.
 */
export function sealBodySecrets(body: string): SealedBody {
  const secrets: Record<string, string> = {};
  // Same value twice in one body (link in prose + link in a button) gets the
  // same slot, so re-hydration cannot produce two different URLs.
  const slotOf = new Map<string, number>();
  let ref: string | null = null;

  const storedBody = body.replace(SECRET_PARAM_RE, (_m, prefix: string, value: string) => {
    if (!ref) ref = randomBytes(12).toString('hex');
    let slot = slotOf.get(value);
    if (slot === undefined) {
      slot = slotOf.size + 1;
      slotOf.set(value, slot);
      secrets[String(slot)] = value;
    }
    return `${prefix}{{lbr-secret:${ref}:${slot}}}`;
  });

  return { storedBody, ref, secrets };
}

/** The Redis reference embedded in a stored body, or null if it has no secrets. */
export function sealedRef(storedBody: string): string | null {
  PLACEHOLDER_RE.lastIndex = 0;
  const m = PLACEHOLDER_RE.exec(storedBody);
  return m ? (m[1] as string) : null;
}

export type UnsealResult = {
  /** The body as the recipient would have seen it. */
  body: string;
  /** How many placeholders could not be resolved (0 = fully re-hydrated). */
  missing: number;
};

/**
 * Put the secrets back. `secrets` is whatever came out of Redis — pass `null`
 * when the key is gone. Unresolved placeholders become
 * {@link EXPIRED_SECRET_TEXT} rather than staying as `{{lbr-secret:…}}`, so
 * neither an operator nor a recipient is ever shown internal syntax.
 */
export function unsealBody(
  storedBody: string,
  secrets: Record<string, string> | null,
): UnsealResult {
  let missing = 0;
  const body = storedBody.replace(PLACEHOLDER_RE, (_m, _ref: string, slot: string) => {
    const value = secrets?.[slot];
    if (typeof value !== 'string') {
      missing++;
      return EXPIRED_SECRET_TEXT;
    }
    return value;
  });
  return { body, missing };
}

/**
 * Parse a Redis payload back into the slot map. Returns null for anything that
 * is not a flat string→string object, so a corrupted/foreign value degrades to
 * "expired" instead of throwing inside the send path.
 */
export function parseSecretPayload(raw: string | null): Record<string, string> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'string') out[k] = v;
    }
    return out;
  } catch {
    return null;
  }
}
