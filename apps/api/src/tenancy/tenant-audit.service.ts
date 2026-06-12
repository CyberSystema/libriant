import { Inject, Injectable, Logger } from '@nestjs/common';
import type { AuditActorType, Prisma } from '@libriant/db-tenant';
import { TenantPrismaService } from './tenant-prisma.service.js';
import type { TenantContext } from './tenant-context.js';

/**
 * One tenant-side audit entry. `before`/`after` are small, JSON-safe snapshots
 * of the changed fields (Dates already stringified) — a focused diff, not a
 * dump of the whole row. Omit `before` for creates and `after` for hard
 * deletes; the column stays NULL.
 */
export type AuditEntry = {
  /** Dot-namespaced verb, e.g. `member.archived`, `loan.checked_out`. */
  action: string;
  /** Control-plane User.id of whoever acted; null for system jobs. */
  actorId?: string | null;
  /** Defaults to `user`. `admin` is reserved for support-session actions. */
  actorType?: AuditActorType;
  targetType?: string;
  targetId?: string;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  ip?: string | null;
  userAgent?: string | null;
  supportSessionId?: string | null;
};

/**
 * Appends entries to the per-tenant `audit_log`. The tenant `AuditEvent` model
 * has shipped since day one but nothing wrote to it; this is the writer for
 * circulation + patron-lifecycle actions.
 *
 * Deliberately a plain singleton (like the data services it's called from):
 * it resolves the right per-tenant client via {@link TenantPrismaService} on
 * each call, so one instance serves every tenant.
 *
 * **Best-effort by design.** A failed audit write is logged and swallowed —
 * losing an audit row must never turn a successful checkout/return into a 500.
 * Callers therefore invoke `record()` *after* the mutation has committed, never
 * inside its transaction.
 */
@Injectable()
export class TenantAuditService {
  private readonly logger = new Logger(TenantAuditService.name);

  constructor(@Inject(TenantPrismaService) private readonly tenantPrisma: TenantPrismaService) {}

  async record(tenant: TenantContext, entry: AuditEntry): Promise<void> {
    try {
      const client = this.tenantPrisma.getClient(tenant);
      await client.auditEvent.create({
        data: {
          actorType: entry.actorType ?? 'user',
          actorId: entry.actorId ?? null,
          action: entry.action,
          targetType: entry.targetType ?? null,
          targetId: entry.targetId ?? null,
          // `undefined` omits the column (NULL); we never pass a raw `null`,
          // which Prisma rejects for Json fields.
          beforeJson: entry.before as Prisma.InputJsonValue | undefined,
          afterJson: entry.after as Prisma.InputJsonValue | undefined,
          ip: entry.ip ?? null,
          userAgent: entry.userAgent ?? null,
          supportSessionId: entry.supportSessionId ?? null,
        },
      });
    } catch (err) {
      this.logger.warn(`audit write failed for "${entry.action}": ${(err as Error).message}`);
    }
  }
}
