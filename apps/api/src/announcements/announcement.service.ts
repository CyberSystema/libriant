import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { controlDb, type AnnouncementSeverity, type Prisma } from '@libriant/db-control';
import {
  type AudienceFilter,
  audienceFromJson,
  audienceToJson,
  validateAudience,
} from './audience.js';

type CreateInput = {
  title: string;
  bodyMarkdown: string;
  severity: AnnouncementSeverity;
  audience: AudienceFilter;
  deliverInApp: boolean;
  deliverEmail: boolean;
  publishAt: Date | null;
  expiresAt: Date | null;
  dismissible: boolean;
  requiresAck: boolean;
  createdByAdminId: string;
};

type UpdateInput = Partial<Omit<CreateInput, 'createdByAdminId'>>;

/**
 * Admin-facing CRUD + lifecycle for announcements. Delivery materialization
 * and per-tenant fetching live next door in {@link AnnouncementDeliveryService}.
 */
@Injectable()
export class AnnouncementService {
  async create(input: CreateInput) {
    validateAudience(input.audience);
    // If publishAt is null or in the past, the announcement goes live
    // immediately — we stamp publishedAt now. Otherwise the scheduled
    // job will flip publishedAt at publishAt time (out of MVP — for now
    // we just compare publishAt at read time so live behavior matches).
    const now = new Date();
    const publishesNow = !input.publishAt || input.publishAt <= now;
    return controlDb.announcement.create({
      data: {
        title: input.title,
        bodyMarkdown: input.bodyMarkdown,
        severity: input.severity,
        audienceFilter: audienceToJson(input.audience) as unknown as Prisma.InputJsonValue,
        deliverInApp: input.deliverInApp,
        deliverEmail: input.deliverEmail,
        publishAt: input.publishAt,
        expiresAt: input.expiresAt,
        dismissible: input.dismissible,
        requiresAck: input.requiresAck,
        createdByAdminId: input.createdByAdminId,
        publishedAt: publishesNow ? now : null,
      },
    });
  }

  async update(id: string, patch: UpdateInput) {
    const existing = await controlDb.announcement.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Announcement not found.');
    if (existing.archivedAt) {
      throw new BadRequestException('This announcement is archived and cannot be edited.');
    }
    if (patch.audience) validateAudience(patch.audience);
    const data: Prisma.AnnouncementUpdateInput = {
      ...(patch.title !== undefined && { title: patch.title }),
      ...(patch.bodyMarkdown !== undefined && { bodyMarkdown: patch.bodyMarkdown }),
      ...(patch.severity !== undefined && { severity: patch.severity }),
      ...(patch.audience !== undefined && {
        audienceFilter: audienceToJson(patch.audience) as unknown as Prisma.InputJsonValue,
      }),
      ...(patch.deliverInApp !== undefined && { deliverInApp: patch.deliverInApp }),
      ...(patch.deliverEmail !== undefined && { deliverEmail: patch.deliverEmail }),
      ...(patch.publishAt !== undefined && { publishAt: patch.publishAt }),
      ...(patch.expiresAt !== undefined && { expiresAt: patch.expiresAt }),
      ...(patch.dismissible !== undefined && { dismissible: patch.dismissible }),
      ...(patch.requiresAck !== undefined && { requiresAck: patch.requiresAck }),
    };
    return controlDb.announcement.update({ where: { id }, data });
  }

  async expireNow(id: string) {
    const existing = await controlDb.announcement.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Announcement not found.');
    return controlDb.announcement.update({
      where: { id },
      data: { expiresAt: new Date() },
    });
  }

  async archive(id: string) {
    const existing = await controlDb.announcement.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Announcement not found.');
    if (existing.archivedAt) return existing;
    return controlDb.announcement.update({
      where: { id },
      data: { archivedAt: new Date() },
    });
  }

  async list(input: { status?: 'active' | 'scheduled' | 'expired' | 'archived'; limit?: number }) {
    const limit = Math.max(1, Math.min(200, input.limit ?? 50));
    const now = new Date();
    const baseWhere: Prisma.AnnouncementWhereInput = {};
    switch (input.status) {
      case 'active':
        baseWhere.archivedAt = null;
        baseWhere.publishedAt = { not: null, lte: now };
        baseWhere.OR = [{ expiresAt: null }, { expiresAt: { gt: now } }];
        break;
      case 'scheduled':
        baseWhere.archivedAt = null;
        baseWhere.publishedAt = null;
        break;
      case 'expired':
        baseWhere.archivedAt = null;
        baseWhere.expiresAt = { not: null, lte: now };
        break;
      case 'archived':
        baseWhere.archivedAt = { not: null };
        break;
    }
    const rows = await controlDb.announcement.findMany({
      where: baseWhere,
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: {
        createdByAdmin: { select: { email: true, fullName: true } },
        _count: { select: { deliveries: true } },
      },
    });
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      severity: r.severity,
      audience: audienceFromJson(r.audienceFilter),
      deliverInApp: r.deliverInApp,
      deliverEmail: r.deliverEmail,
      publishAt: r.publishAt,
      publishedAt: r.publishedAt,
      expiresAt: r.expiresAt,
      archivedAt: r.archivedAt,
      dismissible: r.dismissible,
      requiresAck: r.requiresAck,
      createdAt: r.createdAt,
      createdBy: r.createdByAdmin,
      deliveryCount: r._count.deliveries,
    }));
  }

  async getById(id: string) {
    const row = await controlDb.announcement.findUnique({
      where: { id },
      include: {
        createdByAdmin: { select: { email: true, fullName: true } },
      },
    });
    if (!row) throw new NotFoundException('Announcement not found.');
    return {
      id: row.id,
      title: row.title,
      bodyMarkdown: row.bodyMarkdown,
      severity: row.severity,
      audience: audienceFromJson(row.audienceFilter),
      deliverInApp: row.deliverInApp,
      deliverEmail: row.deliverEmail,
      publishAt: row.publishAt,
      publishedAt: row.publishedAt,
      expiresAt: row.expiresAt,
      archivedAt: row.archivedAt,
      dismissible: row.dismissible,
      requiresAck: row.requiresAck,
      createdAt: row.createdAt,
      createdBy: row.createdByAdmin,
    };
  }

  /**
   * Aggregate stats for the detail page: how many tenants currently match
   * the audience, how many deliveries we've materialized, how many users
   * have dismissed / acknowledged.
   *
   * `targetCount` is computed live against `tenants` (active only). It can
   * legitimately drift from `deliveryCount` over time — e.g. a tenant is
   * archived after the announcement was delivered, or added to an audience
   * tag after the announcement was published. That's by design: the
   * "delivered" number is historical; "target" is the current audience.
   */
  async stats(id: string) {
    const ann = await controlDb.announcement.findUnique({ where: { id } });
    if (!ann) throw new NotFoundException('Announcement not found.');
    const audience = audienceFromJson(ann.audienceFilter);
    const [targetCount, agg] = await Promise.all([
      this.countTargetTenants(audience),
      controlDb.announcementDelivery.aggregate({
        where: { announcementId: id },
        _count: {
          _all: true,
          deliveredInAppAt: true,
          deliveredEmailAt: true,
          dismissedAt: true,
          acknowledgedAt: true,
        },
      }),
    ]);
    return {
      targetTenantCount: targetCount,
      deliveryCount: agg._count._all,
      deliveredInAppCount: agg._count.deliveredInAppAt,
      deliveredEmailCount: agg._count.deliveredEmailAt,
      dismissedCount: agg._count.dismissedAt,
      acknowledgedCount: agg._count.acknowledgedAt,
    };
  }

  /** Resolve a tenant id list matching the audience filter. */
  async resolveTargetTenantIds(audience: AudienceFilter): Promise<string[]> {
    const baseWhere: Prisma.TenantWhereInput = { status: 'active' };
    switch (audience.kind) {
      case 'all':
        return (await controlDb.tenant.findMany({ where: baseWhere, select: { id: true } })).map(
          (t) => t.id,
        );
      case 'tenant_ids':
        return (
          await controlDb.tenant.findMany({
            where: { ...baseWhere, id: { in: audience.tenantIds } },
            select: { id: true },
          })
        ).map((t) => t.id);
      case 'plan_slugs':
        return (
          await controlDb.tenant.findMany({
            where: {
              ...baseWhere,
              subscription: { plan: { slug: { in: audience.planSlugs } } },
            },
            select: { id: true },
          })
        ).map((t) => t.id);
      case 'tags':
        return (
          await controlDb.tenant.findMany({
            where: { ...baseWhere, tags: { hasSome: audience.tags } },
            select: { id: true },
          })
        ).map((t) => t.id);
    }
  }

  private async countTargetTenants(audience: AudienceFilter): Promise<number> {
    const baseWhere: Prisma.TenantWhereInput = { status: 'active' };
    switch (audience.kind) {
      case 'all':
        return controlDb.tenant.count({ where: baseWhere });
      case 'tenant_ids':
        return controlDb.tenant.count({
          where: { ...baseWhere, id: { in: audience.tenantIds } },
        });
      case 'plan_slugs':
        return controlDb.tenant.count({
          where: { ...baseWhere, subscription: { plan: { slug: { in: audience.planSlugs } } } },
        });
      case 'tags':
        return controlDb.tenant.count({
          where: { ...baseWhere, tags: { hasSome: audience.tags } },
        });
    }
  }

  /**
   * Does this announcement target the given tenant *right now*? Used by
   * the per-tenant active fetcher to filter the live set. Cheap-ish —
   * three of the four shapes are array membership checks; only
   * `plan_slugs` needs the subscription join.
   */
  async tenantMatches(
    audience: AudienceFilter,
    tenant: { id: string; tags: string[]; status: 'active' | 'suspended' | 'archived' },
  ): Promise<boolean> {
    if (tenant.status !== 'active') return false;
    switch (audience.kind) {
      case 'all':
        return true;
      case 'tenant_ids':
        return audience.tenantIds.includes(tenant.id);
      case 'tags':
        return audience.tags.some((t) => tenant.tags.includes(t));
      case 'plan_slugs': {
        const sub = await controlDb.subscription.findUnique({
          where: { tenantId: tenant.id },
          include: { plan: { select: { slug: true } } },
        });
        return !!sub && audience.planSlugs.includes(sub.plan.slug);
      }
    }
  }
}
