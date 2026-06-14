import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { generateSecret, generateURI, verifySync } from 'otplib';
import { loadEnv } from '../config/env.js';
import { RedisService } from '../platform/redis.service.js';

/**
 * AES-256-GCM at-rest encryption for admin TOTP secrets.
 *
 * Layout of the DB columns:
 *   - `mfaSecretCipher` — raw ciphertext + 16-byte auth tag appended
 *   - `mfaNonce`        — 12-byte GCM nonce per row (NEVER reused)
 *   - `mfaKeyId`        — opaque label for the master key generation that
 *     produced the row. We keep it for future rotation; right now it's
 *     always `"v1"`.
 *
 * The master key (`MFA_MASTER_KEY`) is the only thing that can recover a
 * secret. Rotating it requires re-encrypting every row — out of MVP
 * scope but the layout makes the upgrade path clear.
 */
@Injectable()
export class MfaService {
  private readonly masterKey: Buffer;
  private readonly keyId = 'v1';
  /** TOTP issuer name shown in the authenticator app. */
  private readonly issuer = 'Libriant Admin';

  constructor(@Inject(RedisService) private readonly redis: RedisService) {
    const env = loadEnv();
    const hex = env.mfaMasterKey;
    if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
      throw new Error('MFA_MASTER_KEY must be 64 hex chars (32 bytes).');
    }
    this.masterKey = Buffer.from(hex, 'hex');
  }

  /** Generate a fresh base32 TOTP secret + the otpauth provisioning URI. */
  newSecret(email: string): { secret: string; otpauthUrl: string } {
    const secret = generateSecret({ length: 20 });
    const otpauthUrl = generateURI({ issuer: this.issuer, label: email, secret });
    return { secret, otpauthUrl };
  }

  /**
   * Encrypt a base32 secret for storage. Returns `Uint8Array` (not
   * `Buffer`) because Prisma 7 types `Bytes` columns as
   * `Uint8Array<ArrayBuffer>`; `new Uint8Array(...)` copies into a plain
   * ArrayBuffer-backed view that assigns cleanly to those columns.
   */
  encrypt(secret: string): {
    cipher: Uint8Array<ArrayBuffer>;
    nonce: Uint8Array<ArrayBuffer>;
    keyId: string;
  } {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.masterKey, nonce);
    const ct = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return {
      cipher: Uint8Array.from(Buffer.concat([ct, tag])),
      nonce: Uint8Array.from(nonce),
      keyId: this.keyId,
    };
  }

  /**
   * Decrypt a stored secret. Throws on tampered ciphertext. Accepts
   * `Uint8Array` so the values read back from Prisma's `Bytes` columns pass
   * straight through.
   */
  decrypt(cipherWithTag: Uint8Array, nonce: Uint8Array): string {
    if (cipherWithTag.length < 16) {
      throw new Error('Stored MFA ciphertext is truncated.');
    }
    const tag = cipherWithTag.subarray(cipherWithTag.length - 16);
    const ct = cipherWithTag.subarray(0, cipherWithTag.length - 16);
    const decipher = createDecipheriv('aes-256-gcm', this.masterKey, nonce);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(ct), decipher.final()]);
    return plain.toString('utf8');
  }

  /**
   * Verify a 6-digit TOTP code against a base32 secret. `epochTolerance: 30`
   * accepts ±1 step (≈30s) of clock skew, matching the prior `window: 1`.
   */
  verifyToken(secret: string, token: string): boolean {
    if (!/^\d{6}$/.test(token)) return false;
    return verifySync({ token, secret, epochTolerance: 30 }).valid;
  }

  /**
   * Replay-protected verification for the authentication paths (admin login,
   * support-key redemption). A TOTP is valid for ~60–90s, long enough for a
   * sniffed/shoulder-surfed code to be reused. After a successful check we burn
   * the exact code for this admin in Redis (TTL covering the validity window),
   * so the same code can't be presented twice.
   *
   * Returns false if the code is invalid OR has already been consumed. Fails
   * CLOSED if Redis is unreachable (a security path, unlike the edge limiter):
   * we'd rather reject a legitimate login than allow a replay.
   */
  async verifyTokenOnce(adminId: string, secret: string, token: string): Promise<boolean> {
    if (!this.verifyToken(secret, token)) return false;
    const key = `mfa:used:${adminId}:${token}`;
    try {
      // 120s comfortably outlives the ±1-step validity window.
      const res = await this.redis.client.set(key, '1', 'EX', 120, 'NX');
      return res === 'OK';
    } catch {
      return false;
    }
  }
}
