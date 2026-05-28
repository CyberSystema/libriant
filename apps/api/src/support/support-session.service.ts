import { Injectable } from '@nestjs/common';
import { controlDb } from '@libriant/db-control';
import type { SupportSessionEndReason } from '@libriant/db-control';
import { loadEnv } from '../config/env.js';

export type ActiveSession = {
  id: string;
  tenantId: string;
  adminId: string;
  expiresAt: Date;
  startedAt: Date;
  ipAddress: string | null;
  userAgent: string | null;
};

@Injectable()
export class SupportSessionService {
  /**
   * Open a brand-new session from a redeemed support key. Stamps the key
   * as `redeemed` in the same transaction so the key is single-use.
   */
  async open(input: {
    keyId: string;
    tenantId: string;
    adminId: string;
    ipAddress?: string;
    userAgent?: string;
  }): Promise<ActiveSession> {
    const env = loadEnv();
    const expiresAt = new Date(Date.now() + env.supportSessionTtlSec * 1000);

    return controlDb.$transaction(async (tx) => {
      // End any still-active session for this tenant. The plan: one
      // active session per tenant at a time.
      await tx.supportSession.updateMany({
        where: { tenantId: input.tenantId, endedAt: null },
        data: { endedAt: new Date(), endedReason: 'admin_ended' },
      });

      const session = await tx.supportSession.create({
        data: {
          tenantId: input.tenantId,
          adminId: input.adminId,
          supportKeyId: input.keyId,
          expiresAt,
          ipAddress: input.ipAddress ?? null,
          userAgent: input.userAgent ?? null,
        },
      });

      // Mark the key as redeemed + link to the session.
      await tx.supportKey.update({
        where: { id: input.keyId },
        data: {
          status: 'redeemed',
          redeemedAt: new Date(),
          redeemedByAdminId: input.adminId,
          redeemedFromIp: input.ipAddress ?? null,
          sessionId: session.id,
        },
      });

      return {
        id: session.id,
        tenantId: session.tenantId,
        adminId: session.adminId,
        expiresAt: session.expiresAt,
        startedAt: session.startedAt,
        ipAddress: session.ipAddress,
        userAgent: session.userAgent,
      };
    });
  }

  /**
   * Look up a session by id. Returns the active row (not yet ended and
   * not yet expired) or null.
   */
  async getActive(id: string): Promise<ActiveSession | null> {
    const row = await controlDb.supportSession.findUnique({
      where: { id },
      select: {
        id: true,
        tenantId: true,
        adminId: true,
        startedAt: true,
        expiresAt: true,
        endedAt: true,
        ipAddress: true,
        userAgent: true,
      },
    });
    if (!row) return null;
    if (row.endedAt) return null;
    if (row.expiresAt < new Date()) {
      await this.end(id, 'expired');
      return null;
    }
    return row;
  }

  /** Library-side: end any active session for a tenant. */
  async endActiveForTenant(tenantId: string, reason: SupportSessionEndReason): Promise<number> {
    const result = await controlDb.supportSession.updateMany({
      where: { tenantId, endedAt: null },
      data: { endedAt: new Date(), endedReason: reason },
    });
    return result.count;
  }

  /** Admin-side or expiry sweeper: end a single session. */
  async end(id: string, reason: SupportSessionEndReason): Promise<void> {
    await controlDb.supportSession.updateMany({
      where: { id, endedAt: null },
      data: { endedAt: new Date(), endedReason: reason },
    });
  }
}
