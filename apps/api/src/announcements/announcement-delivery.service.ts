import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { controlDb, type AnnouncementSeverity } from '@libriant/db-control';
import { EmailService } from '../email/email.service.js';
import { RedisService } from '../platform/redis.service.js';
import { audienceFromJson } from './audience.js';
import { AnnouncementService } from './announcement.service.js';

/**
 * One "active" announcement as returned to the tenant — already merged
 * with the delivery row state for the current user/tenant.
 */
export type ActiveAnnouncement = {
  id: string;
  title: string;
  bodyMarkdown: string;
  severity: AnnouncementSeverity;
  dismissible: boolean;
  requiresAck: boolean;
  publishedAt: Date;
  expiresAt: Date | null;
  /**
   * What scope this delivery lives in. `tenant` rows belong to no
   * specific user (any user can dismiss); `user` rows are per-user (each
   * must acknowledge).
   */
  deliveryScope: 'tenant' | 'user';
  /** State on THIS user's / tenant's delivery row. */
  delivery: {
    id: string;
    dismissedAt: Date | null;
    acknowledgedAt: Date | null;
  };
};

/**
 * Per-tenant cache TTL for the active announcement set. 60 s matches the
 * plan: "fetched on each app boot, cached for 60 s in Redis." Longer
 * would feel stale on a freshly published critical message; shorter
 * would beat the DB up on every page navigation.
 */
const CACHE_TTL_SEC = 60;

@Injectable()
export class AnnouncementDeliveryService {
  private readonly logger = new Logger(AnnouncementDeliveryService.name);

  constructor(
    @Inject(RedisService) private readonly redis: RedisService,
    @Inject(AnnouncementService) private readonly anns: AnnouncementService,
    @Inject(EmailService) private readonly emails: EmailService,
  ) {}

  /**
   * The set of announcements that should currently render for this user
   * inside this tenant. Lazy-materializes the per-tenant or per-user
   * delivery row on first fetch — that's how we get accurate "delivered"
   * stats without a scheduled worker (out of MVP).
   *
   * Cached in Redis 60 s per (tenant, user). Reads after a write (admin
   * publishes, user dismisses) should bust the cache via {@link bustTenant}
   * (admin side) or {@link bustUser} (user side).
   */
  async activeForUser(input: {
    tenantId: string;
    tenantTags: string[];
    tenantStatus: 'active' | 'suspended' | 'archived';
    userId: string;
    userEmail: string;
  }): Promise<ActiveAnnouncement[]> {
    const cacheKey = this.cacheKey(input.tenantId, input.userId);
    const cached = await this.redis.client.get(cacheKey);
    if (cached) {
      try {
        return JSON.parse(cached, reviveDates) as ActiveAnnouncement[];
      } catch {
        // Corrupt cache — fall through to a fresh read.
      }
    }

    const now = new Date();
    const candidates = await controlDb.announcement.findMany({
      where: {
        archivedAt: null,
        deliverInApp: true,
        publishedAt: { not: null, lte: now },
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
      orderBy: { publishedAt: 'desc' },
    });

    const out: ActiveAnnouncement[] = [];
    for (const ann of candidates) {
      const audience = audienceFromJson(ann.audienceFilter);
      const matches = await this.anns.tenantMatches(audience, {
        id: input.tenantId,
        tags: input.tenantTags,
        status: input.tenantStatus,
      });
      if (!matches) continue;

      // Critical announcements that require ack are PER-USER; everything
      // else is PER-TENANT (any user can dismiss on behalf of the library).
      const scope: 'tenant' | 'user' = ann.requiresAck ? 'user' : 'tenant';
      const delivery = await this.ensureDelivery({
        announcementId: ann.id,
        tenantId: input.tenantId,
        userId: scope === 'user' ? input.userId : null,
        markEmail: ann.deliverEmail
          ? { to: input.userEmail, title: ann.title, body: ann.bodyMarkdown }
          : null,
      });
      // Hide rows the audience has already moved past:
      // - per-tenant: hide once the tenant has dismissed it.
      // - per-user: hide once *this* user has acknowledged it.
      if (scope === 'tenant' && delivery.dismissedAt) continue;
      if (scope === 'user' && delivery.acknowledgedAt) continue;

      out.push({
        id: ann.id,
        title: ann.title,
        bodyMarkdown: ann.bodyMarkdown,
        severity: ann.severity,
        dismissible: ann.dismissible,
        requiresAck: ann.requiresAck,
        publishedAt: ann.publishedAt!,
        expiresAt: ann.expiresAt,
        deliveryScope: scope,
        delivery: {
          id: delivery.id,
          dismissedAt: delivery.dismissedAt,
          acknowledgedAt: delivery.acknowledgedAt,
        },
      });
    }

    await this.redis.client.set(cacheKey, JSON.stringify(out), 'EX', CACHE_TTL_SEC);
    return out;
  }

  async dismiss(input: { announcementId: string; tenantId: string; userId: string }) {
    const ann = await controlDb.announcement.findUnique({
      where: { id: input.announcementId },
      select: { dismissible: true, requiresAck: true },
    });
    if (!ann) throw new NotFoundException('Announcement not found.');
    if (!ann.dismissible) {
      throw new NotFoundException('This announcement cannot be dismissed.');
    }
    // requiresAck announcements use per-user delivery rows; dismiss makes
    // no sense for them (the user has to acknowledge). Honor the dismissible
    // flag and use the per-user row.
    const scope: 'tenant' | 'user' = ann.requiresAck ? 'user' : 'tenant';
    const where = {
      announcementId: input.announcementId,
      tenantId: input.tenantId,
      userId: scope === 'user' ? input.userId : null,
    };
    const now = new Date();
    await controlDb.announcementDelivery.updateMany({
      where,
      data: { dismissedAt: now },
    });
    await this.bustTenant(input.tenantId);
    return { dismissedAt: now };
  }

  async acknowledge(input: { announcementId: string; tenantId: string; userId: string }) {
    const ann = await controlDb.announcement.findUnique({
      where: { id: input.announcementId },
      select: { requiresAck: true },
    });
    if (!ann) throw new NotFoundException('Announcement not found.');
    if (!ann.requiresAck) {
      throw new NotFoundException("This announcement doesn't need an acknowledgement.");
    }
    const now = new Date();
    // Per-user ack — the delivery row is always tenant+user scoped here.
    await controlDb.announcementDelivery.updateMany({
      where: {
        announcementId: input.announcementId,
        tenantId: input.tenantId,
        userId: input.userId,
      },
      data: { acknowledgedAt: now },
    });
    await this.bustUser(input.tenantId, input.userId);
    return { acknowledgedAt: now };
  }

  /**
   * Bust the active set cache for every user in a tenant. Called when
   * admin publishes/edits an announcement, or when a tenant-wide
   * dismissal happens.
   *
   * Uses SCAN under the namespaced prefix; KEYS is forbidden in prod-
   * sized Redises but SCAN with a tight MATCH is fine.
   */
  async bustTenant(tenantId: string): Promise<void> {
    const pattern = `${this.cacheKey(tenantId, '*')}`;
    // ioredis strips the keyPrefix on SCAN args but not on returned keys —
    // we have to add it back when deleting via DEL, OR use scanStream
    // which behaves the same way. Simpler: scan everything under the
    // tenant prefix and DEL by trimming the namespace back off.
    const keysToDel: string[] = [];
    let cursor = '0';
    do {
      const [next, batch] = (await this.redis.client.scan(
        cursor,
        'MATCH',
        `lbr:${pattern}`,
        'COUNT',
        100,
      )) as [string, string[]];
      cursor = next;
      for (const k of batch) keysToDel.push(k.startsWith('lbr:') ? k.slice(4) : k);
    } while (cursor !== '0');
    if (keysToDel.length) await this.redis.client.del(...keysToDel);
  }

  async bustUser(tenantId: string, userId: string): Promise<void> {
    await this.redis.client.del(this.cacheKey(tenantId, userId));
  }

  /**
   * Insert-if-missing using the partial unique indexes (`(annId,tenantId)
   * WHERE userId IS NULL` for tenant scope, plus the base unique
   * `(annId,tenantId,userId)` for per-user). Race-safe via
   * `ON CONFLICT DO NOTHING` then re-read.
   */
  private async ensureDelivery(input: {
    announcementId: string;
    tenantId: string;
    userId: string | null;
    markEmail: { to: string; title: string; body: string } | null;
  }) {
    const existing = await controlDb.announcementDelivery.findFirst({
      where: {
        announcementId: input.announcementId,
        tenantId: input.tenantId,
        userId: input.userId,
      },
    });
    if (existing) return existing;
    const now = new Date();
    let deliveredEmailAt: Date | null = null;
    if (input.markEmail) {
      try {
        // Idempotency key ties (announcement, tenant) so a publisher retry
        // never duplicates the library's email. The worker decides
        // deliveredAt; we record the enqueue moment so the in-app stats
        // can show "queued" before the worker picks it up.
        await this.emails.enqueue({
          kind: 'announcement',
          toEmail: input.markEmail.to,
          subject: input.markEmail.title,
          bodyMarkdown: input.markEmail.body,
          tenantId: input.tenantId,
          idempotencyKey: `announcement:${input.announcementId}:tenant:${input.tenantId}`,
          metadata: { announcementId: input.announcementId },
        });
        deliveredEmailAt = now;
      } catch (err) {
        this.logger.warn(
          `Email enqueue failed for announcement ${input.announcementId}: ${(err as Error).message}`,
        );
      }
    }
    try {
      return await controlDb.announcementDelivery.create({
        data: {
          announcementId: input.announcementId,
          tenantId: input.tenantId,
          userId: input.userId,
          deliveredInAppAt: now,
          deliveredEmailAt,
        },
      });
    } catch (err) {
      // Lost a race against another concurrent first-fetch — re-read.
      const winner = await controlDb.announcementDelivery.findFirst({
        where: {
          announcementId: input.announcementId,
          tenantId: input.tenantId,
          userId: input.userId,
        },
      });
      if (winner) return winner;
      throw err;
    }
  }

  private cacheKey(tenantId: string, userId: string): string {
    return `announcements:active:${tenantId}:${userId}`;
  }
}

/**
 * `JSON.parse` reviver that turns ISO-8601 strings back into `Date`
 * instances when the key looks like a date column (`*At`, `publishedAt`,
 * etc.). Keeps the cached payload structurally identical to the live
 * one, so callers don't have to special-case cache vs miss.
 */
function reviveDates(key: string, value: unknown) {
  if (typeof value === 'string' && /At$/.test(key) && /^\d{4}-\d{2}-\d{2}T/.test(value)) {
    return new Date(value);
  }
  return value;
}
