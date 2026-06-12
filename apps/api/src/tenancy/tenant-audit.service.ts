import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@libriant/db-tenant';
import { TenantPrismaService } from './tenant-prisma.service.js';
import type { TenantContext } from './tenant-context.js';
import type { TenantActor } from './tenant-actor.js';

/**
 * One tenant-side audit entry. `before`/`after` are small, JSON-safe snapshots
 * of the changed fields (Dates already stringified) — a focused diff, not a
 * dump of the whole row. Omit `before` for creates and `after` for hard
 * deletes; the column stays NULL.
 *
 * Actor attribution (who/admin-vs-user/support-session) is derived from the
 * {@link TenantActor} passed to `record()`, not duplicated here.
 */
export type AuditEntry = {
  /** Dot-namespaced verb, e.g. `member.archived`, `loan.checked_out`. */
  action: string;
  targetType?: string;
  targetId?: string;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
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

  async record(tenant: TenantContext, actor: TenantActor, entry: AuditEntry): Promise<void> {
    try {
      const client = this.tenantPrisma.getClient(tenant);
      await client.auditEvent.create({
        data: {
          actorType: actor.actorType,
          actorId: actor.actorId,
          action: entry.action,
          targetType: entry.targetType ?? null,
          targetId: entry.targetId ?? null,
          // `undefined` omits the column (NULL); we never pass a raw `null`,
          // which Prisma rejects for Json fields.
          beforeJson: entry.before as Prisma.InputJsonValue | undefined,
          afterJson: entry.after as Prisma.InputJsonValue | undefined,
          supportSessionId: actor.supportSessionId,
        },
      });
    } catch (err) {
      this.logger.warn(`audit write failed for "${entry.action}": ${(err as Error).message}`);
    }
  }
}
