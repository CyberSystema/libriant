import { Inject, Injectable } from '@nestjs/common';
import { controlDb, type AuditActorType } from '@libriant/db-control';
import type { Prisma } from '@libriant/db-tenant';
import type { TenantContext } from '../tenancy/tenant-context.js';
import { TenantPrismaService } from '../tenancy/tenant-prisma.service.js';

export type AuditRow = {
  id: string;
  occurredAt: Date;
  action: string;
  actorType: AuditActorType;
  /** Resolved display name; null for system/unknown actors. */
  actorLabel: string | null;
  targetType: string | null;
  targetId: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  /** True when the action happened during a Libriant support session. */
  viaSupport: boolean;
};

export type ListAuditOptions = {
  /** Exact action filter, e.g. `member.archived`. */
  action?: string;
  limit?: number;
  /** Cursor — the id of the last row from the previous page. */
  after?: string;
};

@Injectable()
export class AuditService {
  constructor(@Inject(TenantPrismaService) private readonly tenantPrisma: TenantPrismaService) {}

  async list(
    tenant: TenantContext,
    opts: ListAuditOptions,
  ): Promise<{ items: AuditRow[]; nextCursor: string | null }> {
    const client = this.tenantPrisma.getClient(tenant);
    const limit = Math.max(1, Math.min(100, opts.limit ?? 50));

    const where: Prisma.AuditEventWhereInput = {};
    if (opts.action) where.action = opts.action;

    const rows = await client.auditEvent.findMany({
      where,
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(opts.after ? { cursor: { id: opts.after }, skip: 1 } : {}),
      select: {
        id: true,
        occurredAt: true,
        action: true,
        actorType: true,
        actorId: true,
        targetType: true,
        targetId: true,
        beforeJson: true,
        afterJson: true,
        supportSessionId: true,
      },
    });

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const labels = await this.resolveActors(page);

    const items: AuditRow[] = page.map((r) => ({
      id: r.id,
      occurredAt: r.occurredAt,
      action: r.action,
      actorType: r.actorType,
      actorLabel: r.actorId ? (labels.get(`${r.actorType}:${r.actorId}`) ?? null) : null,
      targetType: r.targetType,
      targetId: r.targetId,
      before: (r.beforeJson as Record<string, unknown> | null) ?? null,
      after: (r.afterJson as Record<string, unknown> | null) ?? null,
      viaSupport: !!r.supportSessionId,
    }));

    return { items, nextCursor: hasMore ? page[page.length - 1]!.id : null };
  }

  /**
   * Resolve `actorType:actorId` → display name. Actor ids are control-plane
   * cuids (tenant Users for `user`, Admins for `admin`); we batch-fetch both
   * sets and key the map by `type:id` so collisions across tables can't blur.
   */
  private async resolveActors(
    rows: Array<{ actorType: AuditActorType; actorId: string | null }>,
  ): Promise<Map<string, string>> {
    const userIds = new Set<string>();
    const adminIds = new Set<string>();
    for (const r of rows) {
      if (!r.actorId) continue;
      if (r.actorType === 'user') userIds.add(r.actorId);
      else if (r.actorType === 'admin') adminIds.add(r.actorId);
    }

    const map = new Map<string, string>();
    const [users, admins] = await Promise.all([
      userIds.size
        ? controlDb.user.findMany({
            where: { id: { in: [...userIds] } },
            select: { id: true, fullName: true, email: true, username: true },
          })
        : Promise.resolve([]),
      adminIds.size
        ? controlDb.adminUser.findMany({
            where: { id: { in: [...adminIds] } },
            select: { id: true, fullName: true },
          })
        : Promise.resolve([]),
    ]);

    for (const u of users) {
      map.set(`user:${u.id}`, u.fullName || u.email || u.username || u.id);
    }
    for (const a of admins) {
      map.set(`admin:${a.id}`, a.fullName);
    }
    return map;
  }
}
