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
      // End any still-active session for this tenant AND any other still-active
      // session held by this admin. The impersonation cookie tracks exactly one
      // session, so redeeming a second key would otherwise orphan the first as
      // 'active' for its full TTL (it could never be ended from the UI).
      // Invariant: one active session per tenant, and one per admin.
      await tx.supportSession.updateMany({
        where: { endedAt: null, OR: [{ tenantId: input.tenantId }, { adminId: input.adminId }] },
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

  /**
   * Library-side: end any active session for a tenant. Returns the
   * snapshot of each ended session so the caller (the controller) can
   * fire downstream notifications without re-querying — at most one row
   * per tenant under the model's invariants but we return an array to
   * be future-safe.
   */
  async endActiveForTenant(
    tenantId: string,
    reason: SupportSessionEndReason,
  ): Promise<Array<{ id: string; tenantId: string; actionCount: number }>> {
    return this.endWhere({ tenantId, endedAt: null }, reason);
  }

  /** Admin-side or expiry sweeper: end a single session. */
  async end(
    id: string,
    reason: SupportSessionEndReason,
  ): Promise<{ id: string; tenantId: string; actionCount: number } | null> {
    const ended = await this.endWhere({ id, endedAt: null }, reason);
    return ended[0] ?? null;
  }

  private async endWhere(
    where: { id?: string; tenantId?: string; endedAt: null },
    reason: SupportSessionEndReason,
  ): Promise<Array<{ id: string; tenantId: string; actionCount: number }>> {
    // Snapshot the targets *before* the update so we can return ids +
    // action counts back to the caller. Same-transaction so we don't
    // race a concurrent ender.
    return controlDb.$transaction(async (tx) => {
      const targets = await tx.supportSession.findMany({
        where,
        select: { id: true, tenantId: true, _count: { select: { actions: true } } },
      });
      if (targets.length === 0) return [];
      await tx.supportSession.updateMany({
        where,
        data: { endedAt: new Date(), endedReason: reason },
      });
      return targets.map((t) => ({
        id: t.id,
        tenantId: t.tenantId,
        actionCount: t._count.actions,
      }));
    });
  }
}
