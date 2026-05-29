import { randomBytes } from 'node:crypto';
import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import bcrypt from 'bcryptjs';
import { controlDb } from '@libriant/db-control';
import { loadEnv } from '../config/env.js';

const PREFIX_LEN = 4;
const BODY_LEN = 6;
/** Bcrypt cost — same as passwords (12 ≈ 250ms). */
const COST = 12;
/** Alphabet for the random body: digits + uppercase, minus visually-ambiguous chars. */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function pickRandom(): string {
  let out = '';
  const bytes = randomBytes(PREFIX_LEN + BODY_LEN);
  for (let i = 0; i < bytes.length; i++) {
    out += ALPHABET[bytes[i]! % ALPHABET.length]!;
  }
  return out;
}

export type GeneratedKey = {
  id: string;
  /** Plain-text code the library copies to clipboard once. */
  code: string;
  prefix: string;
  expiresAt: Date;
};

/**
 * Support-key lifecycle. Tenants generate a key, hand it to a Libriant
 * admin, the admin redeems it (with TOTP MFA), and a 4-hour
 * `SupportSession` opens for that tenant. The plaintext code is never
 * persisted or logged — only the bcrypt hash.
 */
@Injectable()
export class SupportKeyService {
  /**
   * Generate a key for the tenant. Per the plan: at most one pending key
   * per tenant — generating revokes the previous one in the same tx.
   */
  async generate(input: { tenantId: string; createdByUserId: string }): Promise<GeneratedKey> {
    const env = loadEnv();
    const random = pickRandom();
    const prefix = random.slice(0, PREFIX_LEN);
    const body = random.slice(PREFIX_LEN);
    const code = `SUPPORT-${random}`;
    const codeHash = await bcrypt.hash(body, COST);
    const expiresAt = new Date(Date.now() + env.supportKeyTtlSec * 1000);

    return controlDb.$transaction(async (tx) => {
      // Revoke any previously-pending key for this tenant.
      await tx.supportKey.updateMany({
        where: { tenantId: input.tenantId, status: 'pending' },
        data: {
          status: 'revoked',
          revokedAt: new Date(),
          revokedReason: 'superseded',
        },
      });
      const row = await tx.supportKey.create({
        data: {
          tenantId: input.tenantId,
          createdByUserId: input.createdByUserId,
          codeHash,
          codePrefix: prefix,
          expiresAt,
        },
      });
      return { id: row.id, code, prefix, expiresAt };
    });
  }

  /**
   * The currently-pending key for a tenant (or null). The plaintext code
   * is never stored, so we only return identifying metadata.
   */
  async pendingForTenant(tenantId: string): Promise<{
    id: string;
    prefix: string;
    generatedAt: Date;
    expiresAt: Date;
  } | null> {
    const row = await controlDb.supportKey.findFirst({
      where: { tenantId, status: 'pending' },
      orderBy: { generatedAt: 'desc' },
      select: { id: true, codePrefix: true, generatedAt: true, expiresAt: true },
    });
    if (!row) return null;
    if (row.expiresAt < new Date()) {
      await this.expire(row.id);
      return null;
    }
    return {
      id: row.id,
      prefix: row.codePrefix,
      generatedAt: row.generatedAt,
      expiresAt: row.expiresAt,
    };
  }

  async revokePending(tenantId: string): Promise<void> {
    await controlDb.supportKey.updateMany({
      where: { tenantId, status: 'pending' },
      data: { status: 'revoked', revokedAt: new Date(), revokedReason: 'library_revoked' },
    });
  }

  private async expire(id: string): Promise<void> {
    await controlDb.supportKey
      .update({ where: { id }, data: { status: 'expired' } })
      .catch(() => undefined);
  }

  /**
   * Verify a plaintext code against pending rows. Returns the matched
   * key id and tenant on success, or throws.
   *
   * Uses the prefix to narrow the bcrypt search to a tiny candidate set
   * (almost always 0 or 1 row).
   */
  async verifyAndConsume(input: {
    code: string;
    adminId: string;
    redeemedFromIp?: string;
  }): Promise<{
    keyId: string;
    tenantId: string;
  }> {
    const cleaned = input.code
      .replace(/^SUPPORT-/i, '')
      .toUpperCase()
      .trim();
    if (!/^[A-Z0-9]{10}$/.test(cleaned)) {
      throw new BadRequestException('That code does not look right.');
    }
    const prefix = cleaned.slice(0, PREFIX_LEN);
    const body = cleaned.slice(PREFIX_LEN);
    const candidates = await controlDb.supportKey.findMany({
      where: { codePrefix: prefix, status: 'pending' },
      select: { id: true, tenantId: true, codeHash: true, expiresAt: true },
    });
    for (const c of candidates) {
      if (c.expiresAt < new Date()) continue;
      const ok = await bcrypt.compare(body, c.codeHash);
      if (ok) return { keyId: c.id, tenantId: c.tenantId };
    }
    // Use 401 (not 404) so a wrong, expired, or already-redeemed code is
    // indistinguishable from any other failed redemption — matches the
    // support-access security contract (no key-existence enumeration).
    throw new UnauthorizedException(
      'No matching support key. Ask the library to generate a new one.',
    );
  }
}
