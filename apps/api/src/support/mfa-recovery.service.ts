import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { controlDb } from '@libriant/db-control';

/**
 * Single-use recovery codes for admin TOTP.
 *
 * ## The failure this exists to stop (launch-readiness-13)
 *
 * `ADMIN_MFA_REQUIRED` defaults to `!isDev`, so in production the bootstrapped
 * admin is forced into TOTP enrollment before anything else, and
 * `admin-auth.controller.ts` refuses a correct password without a valid code.
 * The `AdminUser` model has no recovery field, `scripts/bootstrap-admin.ts`
 * does not touch `mfaEnabled` or the secret on an existing row, and the seed is
 * encrypted under `MFA_MASTER_KEY`, which lives in one password manager and by
 * design in no backup. One lost or wiped phone therefore locked the sole
 * operator out of admin.libriant.com — where edit-requests are approved, plans
 * are set, billing is flipped and support access is granted — with recovery
 * being SSH plus a hand-written UPDATE against `admin_users`.
 *
 * ## Why PlatformSetting and not a column
 *
 * A column on `AdminUser` is the right home and this is not it. The schema
 * lives in `packages/db-control` and is outside this change's remit, so the
 * codes go in `platform_settings` — a control-plane key/value table in the same
 * database, covered by the same backup and the same restore. One row per admin,
 * keyed by id. Migrating to a column later is a copy of these rows; the shape
 * below is versioned (`v`) so that migration can tell what it is reading.
 *
 * ## Why SHA-256 and not bcrypt
 *
 * A code is 20 random base32 characters — 100 bits. Password hashing exists to
 * slow down guessing at human-chosen secrets; there is nothing to guess here,
 * and bcrypt at cost 12 against ten stored codes would put 2.5 seconds into
 * every recovery login. Stored digests are compared with a constant-time
 * equality so the store cannot be probed by timing.
 */
@Injectable()
export class MfaRecoveryService {
  private readonly logger = new Logger(MfaRecoveryService.name);

  /** How many codes an enrollment issues. */
  static readonly CODE_COUNT = 10;
  /** Characters per code, before grouping. 20 × 5 bits = 100 bits of entropy. */
  private static readonly CODE_LEN = 20;
  /** Crockford-ish base32: no I, L, O, U — a code gets read off a printout. */
  private static readonly ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ0123456789';

  static settingKey(adminId: string): string {
    return `admin.mfa.recovery:${adminId}`;
  }

  /**
   * Mint a fresh set, REPLACING any previous one, and return the plaintext.
   * The caller shows these to the admin once; nothing can recover them after.
   */
  async issue(adminId: string): Promise<string[]> {
    const codes = Array.from({ length: MfaRecoveryService.CODE_COUNT }, () =>
      MfaRecoveryService.newCode(),
    );
    const value = JSON.stringify({
      v: 1,
      issuedAt: new Date().toISOString(),
      digests: codes.map((c) => MfaRecoveryService.digest(c)),
    });
    await controlDb.platformSetting.upsert({
      where: { key: MfaRecoveryService.settingKey(adminId) },
      create: { key: MfaRecoveryService.settingKey(adminId), value },
      update: { value },
    });
    return codes;
  }

  /** How many unused codes this admin has left (0 when never enrolled). */
  async remaining(adminId: string): Promise<number> {
    return (await this.load(adminId))?.digests.length ?? 0;
  }

  /**
   * Consume a code. Returns true only if it matched an unused one, which is
   * then deleted — a recovery code is single-use or it is a second password.
   *
   * Fails CLOSED on any storage error: this is an authentication path, and a
   * "the DB was unreachable so we let you in" branch would be worse than the
   * lockout it is meant to relieve.
   */
  async consume(adminId: string, submitted: string): Promise<boolean> {
    const normalized = MfaRecoveryService.normalize(submitted);
    if (normalized.length !== MfaRecoveryService.CODE_LEN) return false;
    const stored = await this.load(adminId);
    if (!stored || stored.digests.length === 0) return false;

    const want = MfaRecoveryService.digest(normalized);
    const idx = stored.digests.findIndex((d) => MfaRecoveryService.digestsEqual(d, want));
    if (idx === -1) return false;

    const left = stored.digests.filter((_, i) => i !== idx);
    try {
      await controlDb.platformSetting.update({
        where: { key: MfaRecoveryService.settingKey(adminId) },
        data: { value: JSON.stringify({ ...stored, digests: left }) },
      });
    } catch (err) {
      // Could not burn it → do not honour it. A code that survives its own use
      // is a static password with a nice name.
      this.logger.error(
        `Refusing an admin recovery code for ${adminId}: it matched, but could not be marked ` +
          `used, and a reusable recovery code is worse than none: ${(err as Error).message}`,
      );
      return false;
    }
    this.logger.warn(
      `Admin ${adminId} signed in with a RECOVERY CODE (${left.length} left). If this was not a ` +
        'lost-authenticator recovery, treat the account as compromised.',
    );
    return true;
  }

  /** Drop every code (e.g. when MFA is re-enrolled and a new set is issued). */
  async clear(adminId: string): Promise<void> {
    await controlDb.platformSetting
      .delete({ where: { key: MfaRecoveryService.settingKey(adminId) } })
      .catch(() => undefined);
  }

  private async load(adminId: string): Promise<{ v: number; digests: string[] } | null> {
    const row = await controlDb.platformSetting.findUnique({
      where: { key: MfaRecoveryService.settingKey(adminId) },
      select: { value: true },
    });
    if (!row) return null;
    try {
      const parsed = JSON.parse(row.value) as { v?: number; digests?: unknown };
      if (!Array.isArray(parsed.digests)) return null;
      return { v: parsed.v ?? 1, digests: parsed.digests.filter((d) => typeof d === 'string') };
    } catch {
      this.logger.error(`Recovery-code record for admin ${adminId} is unreadable.`);
      return null;
    }
  }

  /** `ABCDE-FGHJK-MNPQR-STVWX` — grouped for transcription, not for entropy. */
  private static newCode(): string {
    const bytes = randomBytes(MfaRecoveryService.CODE_LEN);
    let raw = '';
    for (const b of bytes) raw += MfaRecoveryService.ALPHABET[b % 32];
    return (raw.match(/.{1,5}/g) ?? [raw]).join('-');
  }

  /** Strip grouping + case so a hand-typed code matches what we stored. */
  static normalize(code: string): string {
    return code.replace(/[^0-9a-zA-Z]/g, '').toUpperCase();
  }

  private static digest(code: string): string {
    return createHash('sha256').update(MfaRecoveryService.normalize(code), 'utf8').digest('hex');
  }

  private static digestsEqual(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
  }
}
