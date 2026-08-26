import { createHash } from 'node:crypto';

/**
 * Redis key for a one-time link token, derived from the token instead of being
 * the token.
 *
 * authn-authz-11: `pwreset:<token>` and `emailverify:<token>` stored the bearer
 * secret at rest exactly as it appears in the email link, with the account it
 * unlocks as the value. Production Redis runs with no `requirepass` on the
 * internal Docker network and `--appendonly yes`, so the tokens are also on
 * disk in the `redis_data` volume and therefore in any volume-level backup —
 * meaning a read-only foothold (an operator, a sidecar, a monitoring exporter,
 * an old backup archive) yielded `KEYS pwreset:*` and a working password reset
 * for every library that had clicked "forgot password" in the last hour,
 * tenant owners included. Storing the digest turns that read into nothing: the
 * key names a token nobody can invert, and the plaintext exists only in the
 * message and in the browser of whoever opens the link.
 *
 * A plain SHA-256 rather than a KDF, deliberately: the input is
 * `randomBytes(32)`, 256 bits of CSPRNG output with no structure to guess.
 * bcrypt/argon2 exist to make LOW-entropy secrets expensive to enumerate, and
 * they would put a ~100ms hash on the redeem path — which is also the path a
 * stranger can hammer with junk tokens — while buying nothing here.
 *
 * The GETDEL claim in the redeem paths is unchanged: it just deletes the
 * derived key instead of the literal one, so the atomic single-use property
 * (AUTH-08) is exactly as it was.
 */
export function tokenKey(prefix: 'pwreset' | 'emailverify', token: string): string {
  return `${prefix}:${createHash('sha256').update(token, 'utf8').digest('hex')}`;
}
