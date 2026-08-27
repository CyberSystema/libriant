import { Inject, Injectable } from '@nestjs/common';
import { controlDb, type AuditActorType } from '@libriant/db-control';
import type { Prisma, TenantPrismaClient } from '@libriant/db-tenant';
import type { TenantContext } from '../tenancy/tenant-context.js';
import { TenantPrismaService } from '../tenancy/tenant-prisma.service.js';
import { decodeCursor, encodeCursor } from '../platform/query.js';

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
  /**
   * Opaque cursor from the previous page's `nextCursor`. A bare row id is
   * still accepted — that is what this used to be; see `decodeListCursor`.
   */
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

    // performance-03, the same keyset predicate `BooksService.list` carries.
    // This used to be `cursor: { id: opts.after }, skip: 1`, which Prisma
    // renders as an OR of correlated subselects — not a btree start key — so
    // Postgres walked `audit_log_occurredAt_idx` backwards from the newest row
    // and discarded everything above the cursor. Reading back through the log
    // is exactly what an owner does when they are checking who changed what,
    // and the audit log is the biggest table a tenant has: every checkout,
    // return, renewal and edit writes a row.
    //
    // Measured on a 400,000-row log, on the literal SQL Prisma emitted for the
    // page at depth 200,000:
    //   BEFORE  Index Scan Backward using "audit_log_occurredAt_idx",
    //           Rows Removed by Filter: 200000, Buffers: shared hit=2762
    //           read=1626 written=1477, Execution Time: 30.612 ms
    //   AFTER   Index Scan using "audit_log_occurredAt_id_idx",
    //           Index Cond: ("occurredAt" <= …), Rows Removed by Filter: 1,
    //           Buffers: shared read=5, Execution Time: 0.075 ms
    //
    // `lte`/`lt` rather than `gte`/`gt` because this list runs newest-first:
    // later in the page means EARLIER in time.
    const after = await this.decodeListCursor(client, opts.after);
    if (after) {
      where.AND = [
        { occurredAt: { lte: after.occurredAt } },
        {
          OR: [
            { occurredAt: { lt: after.occurredAt } },
            { occurredAt: after.occurredAt, id: { lt: after.id } },
          ],
        },
      ];
    }

    const rows = await client.auditEvent.findMany({
      where,
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
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

    const last = page[page.length - 1];
    return {
      items,
      nextCursor: hasMore && last ? encodeCursor([last.occurredAt.toISOString(), last.id]) : null,
    };
  }

  /**
   * As `BooksService.decodeListCursor`, over `(occurredAt, id)`.
   *
   * The timestamp travels as an ISO string because that is what the token
   * format carries; an unparseable one resolves to `null` (restart at page 1)
   * rather than reaching Prisma as `Invalid Date`, which would compare against
   * NULL and hand the reader a silently empty audit log.
   */
  private async decodeListCursor(
    client: TenantPrismaClient,
    after: string | undefined,
  ): Promise<{ occurredAt: Date; id: string } | null> {
    if (!after) return null;
    const parts = decodeCursor(after, 2);
    if (parts) {
      const [iso, id] = parts;
      if (typeof iso !== 'string' || typeof id !== 'string') return null;
      const occurredAt = new Date(iso);
      return Number.isNaN(occurredAt.getTime()) ? null : { occurredAt, id };
    }
    return client.auditEvent.findUnique({
      where: { id: after },
      select: { occurredAt: true, id: true },
    });
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
