import { Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@libriant/db-tenant';
import type { TenantContext } from '../tenancy/tenant-context.js';
import { TenantPrismaService } from '../tenancy/tenant-prisma.service.js';
import { RedisService } from '../platform/redis.service.js';

/**
 * The five numbers the tenant home page shows. Real counts, not page sizes.
 */
export type TenantSummary = {
  books: number;
  members: number;
  activeLoans: number;
  overdueLoans: number;
  queuedHolds: number;
  /** Seconds this snapshot may be served from cache. 0 = computed just now. */
  cachedForSeconds: number;
};

/**
 * How long a computed summary may be served from Redis.
 *
 * A dashboard tile is an at-a-glance figure, not a ledger, so a few tens of
 * seconds of staleness is invisible; what it buys is that twenty librarians
 * refreshing the home page cost ONE computation rather than twenty. Kept at the
 * short end of the 30-60 s the finding suggests because `queuedHolds` moves
 * every time somebody places a hold at the desk.
 */
const SUMMARY_TTL_SECONDS = 30;

const cacheKey = (tenantId: string) => `dashboard:summary:${tenantId}`;

@Injectable()
export class DashboardService {
  private readonly logger = new Logger(DashboardService.name);

  constructor(
    @Inject(TenantPrismaService) private readonly tenantPrisma: TenantPrismaService,
    @Inject(RedisService) private readonly redis: RedisService,
  ) {}

  /**
   * performance-11.
   *
   * The tenant home page used to derive each tile from `res.items.length` of a
   * LIST endpoint — the page size, not a total. Two consequences, and the
   * second is the worse one:
   *
   *   - The numbers were wrong. The books and members tiles were fetched with
   *     `limit=1`, so a 400,000-title catalogue rendered its tile as "1"; the
   *     loans tiles were fetched with `limit=100` and saturated at 100.
   *   - Every server-rendered visit ran five list queries plus Prisma's
   *     relation batches — measured at ~4,400 shared buffers across ~15
   *     statements on the audit's Institutional-sized tenant — to produce
   *     them.
   *
   * WHY NOT THE `count(*) FILTER` THE FINDING SUGGESTS. Measured, because an
   * aggregate is not automatically cheaper than a list:
   *
   *   SELECT count(*) FILTER (WHERE status='active'),
   *          count(*) FILTER (WHERE status='active' AND "dueAt" < now())
   *     FROM loans
   *   -> Parallel Seq Scan on loans, Buffers: shared hit=3087 read=29500,
   *      Execution Time: 90.983 ms
   *
   * A `FILTER` clause is evaluated per row, so the aggregate has no WHERE for
   * the planner to seek with and reads the entire 899 MB table. Written as
   * separate subqueries each predicate stays indexable:
   *
   *   loans active   Parallel Index Only Scan loans_status_loanedAt_id_idx  2,174 buffers
   *   loans overdue  Parallel Index Only Scan loans_status_dueAt_id_idx       213 buffers
   *   members        Index Only Scan members_member_number_unique_active      387 buffers
   *   reservations   Seq Scan (no index leads with status)                  1,083 buffers
   *   books          Seq Scan (nothing indexes "archivedAt" IS NULL)       13,333 buffers
   *
   * — one round trip, 17,102 buffers, 62 ms warm, versus 32,587 buffers for the
   * FILTER form. `books` dominates and is the same missing index performance-05
   * needs; with `CREATE INDEX books_active_idx ON books (id) WHERE "archivedAt"
   * IS NULL` it becomes a 1,528-buffer index-only scan and the whole summary
   * drops to ~5,400. That index is a tenant migration and is reported
   * separately.
   */
  async summary(tenant: TenantContext): Promise<TenantSummary> {
    const cached = await this.readCache(tenant.id);
    if (cached) return cached;

    const client = this.tenantPrisma.getClient(tenant);
    const now = new Date();
    // One statement, five independently-indexable subqueries. `now` is bound
    // rather than `now()` so the overdue count matches the overdue LIST a
    // librarian clicks through to from the tile.
    const rows = await client.$queryRaw<
      Array<{
        books: bigint;
        members: bigint;
        activeLoans: bigint;
        overdueLoans: bigint;
        queuedHolds: bigint;
      }>
    >(
      Prisma.sql`
        SELECT (SELECT count(*) FROM "books"   WHERE "archivedAt" IS NULL)                     AS "books",
               (SELECT count(*) FROM "members" WHERE "archivedAt" IS NULL)                     AS "members",
               (SELECT count(*) FROM "loans"   WHERE "status" = 'active'::"LoanStatus")        AS "activeLoans",
               (SELECT count(*) FROM "loans"   WHERE "status" = 'active'::"LoanStatus"
                                                 AND "dueAt" < ${now})                         AS "overdueLoans",
               (SELECT count(*) FROM "reservations"
                 WHERE "status" = 'queued'::"ReservationStatus")                               AS "queuedHolds"`,
    );
    const r = rows[0];
    const summary: TenantSummary = {
      // count(*) is bigint over the wire; every one of these is a row count
      // that cannot exceed a library's plan ceiling, so Number is safe.
      books: Number(r?.books ?? 0),
      members: Number(r?.members ?? 0),
      activeLoans: Number(r?.activeLoans ?? 0),
      overdueLoans: Number(r?.overdueLoans ?? 0),
      queuedHolds: Number(r?.queuedHolds ?? 0),
      cachedForSeconds: 0,
    };

    // Do NOT cache the empty state. The home page decides whether to show the
    // onboarding welcome from `books === 0 && members === 0`, so a cached zero
    // would keep telling a library that has just catalogued its first book to
    // go and catalogue its first book, for the whole TTL. A library at zero is
    // also the one case where computing this costs nothing.
    if (summary.books > 0 && summary.members > 0) {
      await this.writeCache(tenant.id, summary);
    }
    return summary;
  }

  private async readCache(tenantId: string): Promise<TenantSummary | null> {
    try {
      const raw = await this.redis.client.get(cacheKey(tenantId));
      if (!raw) return null;
      const parsed = JSON.parse(raw) as TenantSummary;
      return { ...parsed, cachedForSeconds: SUMMARY_TTL_SECONDS };
    } catch (err) {
      // Fail OPEN: a Redis blip must degrade the dashboard to "slower", never
      // to "broken". Same posture as every other cached read in the product.
      this.logger.warn(`summary cache read failed for tenant=${tenantId}: ${String(err)}`);
      return null;
    }
  }

  private async writeCache(tenantId: string, summary: TenantSummary): Promise<void> {
    try {
      await this.redis.client.set(
        cacheKey(tenantId),
        JSON.stringify(summary),
        'EX',
        SUMMARY_TTL_SECONDS,
      );
    } catch (err) {
      this.logger.warn(`summary cache write failed for tenant=${tenantId}: ${String(err)}`);
    }
  }
}
