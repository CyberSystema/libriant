import { Logger } from '@nestjs/common';
import type { Request } from 'express';
import { controlDb } from '@libriant/db-control';
import type { Prisma } from '@libriant/db-control';
import { clientIp } from './client-ip.js';

const logger = new Logger('AdminAudit');

/**
 * Who performed a control-plane (Libriant-staff) mutation, plus the request
 * context we attribute it to. Built once in the controller from the decoded
 * admin session + the Express request, then threaded to wherever the audit is
 * actually written (the controller itself, or a service method that owns the
 * "exactly once per state change" guarantee, e.g. BillingService).
 */
export type AdminAuditActor = {
  adminId: string;
  ip?: string;
  userAgent?: string;
};

/** Derive an {@link AdminAuditActor} from the request + decoded admin session. */
export function adminAuditActor(req: Request, admin: { sub: string }): AdminAuditActor {
  const ua = req.headers['user-agent'];
  return {
    adminId: admin.sub,
    ip: clientIp(req),
    userAgent: (Array.isArray(ua) ? ua[0] : ua) || undefined,
  };
}

export type AdminAuditEntry = {
  /** NULL = platform-wide event (e.g. a plan edit or a global maintenance window). */
  tenantId?: string | null;
  /** Dot-namespaced verb, e.g. `subscription.changed`, `system_mode.set`. */
  action: string;
  targetType?: string;
  targetId?: string;
  /** Small JSON-safe snapshots of the changed fields — a focused diff, not the
   *  whole row. Stringify Dates before passing them. Omit for creates/clears. */
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
};

/**
 * Append one row to the control-plane `audit_log` for a Libriant-staff (admin)
 * mutation. Mirrors {@link TenantAuditService.record}'s contract:
 *
 * **Best-effort by design.** Invoke it AFTER the mutation has committed; a
 * failed audit write is logged and swallowed so losing an audit row never turns
 * a successful 200 into a 500.
 */
export async function recordAdminAudit(
  actor: AdminAuditActor,
  entry: AdminAuditEntry,
): Promise<void> {
  try {
    await controlDb.auditEvent.create({
      data: {
        tenantId: entry.tenantId ?? null,
        actorType: 'admin',
        actorId: actor.adminId,
        action: entry.action,
        targetType: entry.targetType ?? null,
        targetId: entry.targetId ?? null,
        // `undefined` omits the column (NULL); Prisma rejects a raw `null` for a
        // Json field, so never coerce these to null.
        beforeJson: entry.before as Prisma.InputJsonValue | undefined,
        afterJson: entry.after as Prisma.InputJsonValue | undefined,
        ip: actor.ip ?? null,
        userAgent: actor.userAgent ?? null,
      },
    });
  } catch (err) {
    logger.warn(`admin audit write failed for "${entry.action}": ${(err as Error).message}`);
  }
}
