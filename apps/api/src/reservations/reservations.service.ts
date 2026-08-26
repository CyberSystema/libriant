import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type {
  BookCopyStatus,
  MemberStatus,
  Prisma,
  ReservationStatus,
  TenantPrismaClient,
} from '@libriant/db-tenant';
import type { TenantContext } from '../tenancy/tenant-context.js';
import { TenantPrismaService } from '../tenancy/tenant-prisma.service.js';
import { FieldDefinitionsService } from '../customization/field-definitions.service.js';
import { validateRecordOrThrow } from '../customization/dynamic-validator.js';
import { decodeCursor, encodeCursor } from '../platform/query.js';

const MS_PER_HOUR = 3_600_000;

/**
 * The two "live" statuses — a member holds an outstanding hold while it's
 * in either of these. Used by both the partial unique index and the queue
 * rebalancing logic below.
 */
const LIVE_STATUSES = ['queued', 'ready'] as const;

/**
 * Where each status sits under `ORDER BY status ASC` — i.e. the order the enum
 * is DECLARED in packages/db-tenant/prisma/schema.prisma, which is what
 * Postgres actually sorts by.
 *
 * Spelled out here because {@link ReservationsService.list} has to answer "which
 * statuses come after this one?" to build its keyset predicate (performance-10),
 * and Prisma's enum filters offer only equals/in/notIn — there is no `gt`.
 * It is also the only place the ordering is written where a reader can see it:
 * the list's own comment used to claim "ready first", and `queued` sorts first.
 *
 * `Record<ReservationStatus, number>` is load-bearing — a status added to the
 * schema and not to this map is a compile error here, rather than a silently
 * missing tier that drops rows off the end of a page. If the enum is ever
 * REORDERED, these numbers must move with it.
 */
const STATUS_RANK: Record<ReservationStatus, number> = {
  queued: 0,
  ready: 1,
  fulfilled: 2,
  expired: 3,
  canceled: 4,
};

const ALL_STATUSES = Object.keys(STATUS_RANK) as ReservationStatus[];

export type ReservationDto = {
  id: string;
  bookId: string;
  memberId: string;
  placedAt: Date;
  queuePosition: number | null;
  status: ReservationStatus;
  readyAt: Date | null;
  expiresAt: Date | null;
  fulfilledAt: Date | null;
  fulfilledByCopyId: string | null;
  canceledAt: Date | null;
  notes: string | null;
  placedByUserId: string | null;
  customFields: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
};

export type ReservationWithJoinsDto = ReservationDto & {
  book: { id: string; title: string };
  member: { id: string; memberNumber: string; fullName: string; status: MemberStatus };
  fulfilledByCopy: { id: string; barcode: string; status: BookCopyStatus } | null;
};

export type PlaceHoldResult = {
  reservation: ReservationWithJoinsDto;
  /**
   * `'queued'`  → joined the queue at `queuePosition`.
   * `'ready'`   → auto-promoted because a copy was immediately available.
   * `'declined-active-copy-available'` is NOT returned — the member is
   * simply allowed to join the queue; auto-promotion happens only when
   * they would land at position 1.
   */
  outcome: 'queued' | 'ready';
};

export type ListReservationsOptions = {
  bookId?: string;
  memberId?: string;
  status?: ReservationStatus;
  includeResolved?: boolean;
  after?: string;
  limit?: number;
};

@Injectable()
export class ReservationsService {
  private readonly logger = new Logger(ReservationsService.name);

  constructor(
    @Inject(TenantPrismaService) private readonly tenantPrisma: TenantPrismaService,
    @Inject(FieldDefinitionsService) private readonly fieldDefs: FieldDefinitionsService,
  ) {}

  // -------------------------------------------------------------------------
  // placeHold — member joins the queue (or skips it if a copy is available)
  // -------------------------------------------------------------------------

  async placeHold(
    tenant: TenantContext,
    input: {
      bookId: string;
      memberId: string;
      notes?: string;
      customFields?: Record<string, unknown>;
    },
    actingUserId: string,
  ): Promise<PlaceHoldResult> {
    const client = this.tenantPrisma.getClient(tenant);

    // 1. Custom-fields validation against the reservation entity's field defs.
    const defs = await this.fieldDefs.loadActiveForValidation(tenant, 'reservation');
    const cleanedCustom = validateRecordOrThrow(defs, input.customFields ?? {}, {
      unknownFields: 'reject',
    });

    // 2. Validate member.
    const member = await client.member.findUnique({
      where: { id: input.memberId },
      select: { id: true, status: true, archivedAt: true, fullName: true },
    });
    if (!member) throw new NotFoundException('Member not found.');
    if (member.archivedAt) {
      throw new BadRequestException(
        `${member.fullName} is archived. Restore the member before placing a hold.`,
      );
    }
    if (member.status !== 'active') {
      throw new BadRequestException(
        `${member.fullName} is ${member.status}. Reactivate the member before placing a hold.`,
      );
    }

    // 3. Validate book.
    const book = await client.book.findUnique({
      where: { id: input.bookId },
      select: { id: true, title: true, archivedAt: true },
    });
    if (!book) throw new NotFoundException('Book not found.');
    if (book.archivedAt) {
      throw new BadRequestException(
        `${book.title} is archived. Restore the book before placing a hold.`,
      );
    }

    // 4. Refuse if member already has an active hold on this book — the DB
    //    partial unique index would reject anyway, but we want a clear msg.
    const existingHold = await client.reservation.findFirst({
      where: {
        bookId: input.bookId,
        memberId: input.memberId,
        status: { in: [...LIVE_STATUSES] },
      },
      select: { id: true, status: true },
    });
    if (existingHold) {
      throw new ConflictException(
        existingHold.status === 'ready'
          ? `${member.fullName} already has a ready hold on ${book.title}. Pick it up first.`
          : `${member.fullName} is already on the wait list for ${book.title}.`,
      );
    }

    // 5. Refuse if the member already has the book on loan.
    const activeLoan = await client.loan.findFirst({
      where: { memberId: input.memberId, status: 'active', copy: { bookId: input.bookId } },
      select: { id: true },
    });
    if (activeLoan) {
      throw new BadRequestException(
        `${member.fullName} already has ${book.title} checked out — no hold needed.`,
      );
    }

    const settings = await this.requireSettings(client);
    if (!settings.reservationsEnabled) {
      throw new BadRequestException('Reservations are turned off for this library.');
    }
    const baseData = {
      bookId: input.bookId,
      memberId: input.memberId,
      placedByUserId: actingUserId,
      notes: input.notes ?? null,
      customFields: cleanedCustom as Prisma.InputJsonValue,
    } as const;

    // 6. Decide queued vs ready. If there are no other live holds AND a copy
    //    of this book is currently 'available', auto-promote — the member
    //    can pick it up immediately rather than waiting.
    let result: { id: string; outcome: 'queued' | 'ready' };
    try {
      result = await client.$transaction(async (tx) => {
        // data-integrity-07: join the MEMBER lock domain, and take it FIRST.
        // `MembersService.archive` counts a member's live reservations inside
        // `member:<id>` and refuses while any exist — but this path validated
        // the member at step 2 outside any transaction and then locked only
        // `book:<id>`, so archive and hold placement never excluded each other.
        // Firing both for the same patron at once produced precisely the state
        // archive() exists to prevent, 25 times out of 25 in the repro
        // (test/integration/circulation-lock-domains.spec.ts): an archived
        // member holding a `ready` hold, occupying their
        // `reservations_one_active_per_book_member` slot, blocking every other
        // member's renewal of that title, and pinning a physical copy in
        // `reserved` that nobody can collect until staff cancel the hold by
        // hand.
        //
        // ORDER MATTERS — member THEN book, and this is the only place in the
        // product that holds both. Archive, erase and checkout take `member:`
        // alone; return, renew, cancel/expire, the expiry sweep and the import
        // engine take `book:` alone. Nothing takes them the other way round, so
        // there is no cycle to deadlock on; keep it that way.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`member:${input.memberId}`}, 0))`;
        // Serialize concurrent holds on the SAME book so the queued vs.
        // ready decision and the `max(queuePosition) + 1` computation are
        // race-free (two parallel holds previously both read the same max
        // and landed on the same position). A transaction-scoped advisory
        // lock keyed on the book id auto-releases at commit/rollback and
        // only blocks other holds on this exact book.
        //
        // A7-01: ALL per-book copy-allocation paths (place / promote-on-return /
        // promote-on-expiry / cancel-expire / bulk-import) share the SAME
        // `book:<id>` lock domain so they mutually exclude — otherwise two paths
        // under different keys can both allocate a just-freed copy and strand
        // one in `reserved`.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`book:${input.bookId}`}, 0))`;

        // Re-read the member under the lock we now hold, exactly as
        // loans.service.ts:230 does. The named messages at step 2 stay — they
        // are what a librarian normally sees and they say who is archived —
        // but a check that ran before any lock existed cannot be the guard.
        const liveMember = await tx.member.findUnique({
          where: { id: input.memberId },
          select: { status: true, archivedAt: true },
        });
        if (!liveMember || liveMember.archivedAt || liveMember.status !== 'active') {
          throw new ConflictException(
            'That member was just archived or deactivated. Refresh and try again.',
          );
        }

        const liveCount = await tx.reservation.count({
          where: {
            bookId: input.bookId,
            status: { in: [...LIVE_STATUSES] },
          },
        });

        if (liveCount === 0) {
          const candidate = await tx.bookCopy.findFirst({
            where: { bookId: input.bookId, status: 'available', archivedAt: null },
            select: { id: true },
            orderBy: { createdAt: 'asc' },
          });
          if (candidate) {
            const now = new Date();
            const expiresAt = new Date(now.getTime() + settings.holdPickupHours * MS_PER_HOUR);
            const created = await tx.reservation.create({
              data: {
                ...baseData,
                // Pin both timestamps to the same instant — Prisma's
                // default(now()) for placedAt runs DB-side and would be
                // 1+ ms later than this client clock, tripping the
                // `readyAt >= placedAt` CHECK constraint.
                placedAt: now,
                status: 'ready',
                readyAt: now,
                expiresAt,
                fulfilledByCopyId: candidate.id,
              },
              select: { id: true },
            });
            // Lock the copy.
            const flipped = await tx.bookCopy.updateMany({
              where: { id: candidate.id, status: 'available' },
              data: { status: 'reserved' },
            });
            if (flipped.count === 0) {
              throw new ConflictException(
                'Another librarian just changed that copy. Refresh and try again.',
              );
            }
            return { id: created.id, outcome: 'ready' as const };
          }
        }

        // Either there's already a queue OR no copies are available right
        // now → join the back of the queue.
        const maxRow = await tx.reservation.aggregate({
          where: { bookId: input.bookId, status: 'queued' },
          _max: { queuePosition: true },
        });
        const position = (maxRow._max.queuePosition ?? 0) + 1;
        const created = await tx.reservation.create({
          data: { ...baseData, status: 'queued', queuePosition: position },
          select: { id: true },
        });
        return { id: created.id, outcome: 'queued' as const };
      });
    } catch (err) {
      throw this.translate(err);
    }

    const full = await this.getInternal(client, result.id);
    return { reservation: full, outcome: result.outcome };
  }

  // -------------------------------------------------------------------------
  // cancel — member or staff abandons the hold
  // -------------------------------------------------------------------------

  async cancel(tenant: TenantContext, id: string): Promise<ReservationWithJoinsDto> {
    const client = this.tenantPrisma.getClient(tenant);
    return this.resolveReservation(client, id, 'canceled');
  }

  /**
   * Mark a ready-but-uncollected hold as expired. Frees the copy and
   * promotes the next hold in the queue. Intended to be called from a
   * cron-driven sweep (Step 19 wires that) — but also exposed as an
   * admin endpoint so a librarian can force-expire on demand.
   */
  async expire(tenant: TenantContext, id: string): Promise<ReservationWithJoinsDto> {
    const client = this.tenantPrisma.getClient(tenant);
    return this.resolveReservation(client, id, 'expired');
  }

  /**
   * Common code path for cancel/expire. Frees a ready hold's copy if any,
   * marks the reservation as `terminalStatus`, rebalances the queue, then
   * tries to promote the next queued hold (so the line keeps moving even
   * when someone in the middle bails).
   */
  private async resolveReservation(
    client: TenantPrismaClient,
    id: string,
    terminalStatus: 'canceled' | 'expired',
  ): Promise<ReservationWithJoinsDto> {
    const existing = await client.reservation.findUnique({
      where: { id },
      select: {
        id: true,
        bookId: true,
        status: true,
        queuePosition: true,
        fulfilledByCopyId: true,
      },
    });
    if (!existing) throw new NotFoundException('Reservation not found.');
    if (existing.status === 'fulfilled') {
      throw new BadRequestException('This hold has already been fulfilled — no action needed.');
    }
    if (existing.status === 'canceled' || existing.status === 'expired') {
      // Idempotent: returning the same DTO matches the "you can hit the
      // button twice and nothing surprising happens" UX rule.
      return this.getInternal(client, id);
    }
    if (terminalStatus === 'expired' && existing.status !== 'ready') {
      throw new BadRequestException(
        "Only ready holds expire — queued ones haven't been offered yet.",
      );
    }

    const settings = await this.requireSettings(client);
    const nowDate = new Date();
    try {
      await client.$transaction(async (tx) => {
        // A7-01: take the SAME per-book lock the return path + expiry job use,
        // so a force-cancel/expire can't promote the queue head concurrently
        // with another promotion path and strand a freed copy in `reserved`.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`book:${existing.bookId}`}, 0))`;
        const updated = await tx.reservation.updateMany({
          where: { id, status: existing.status },
          data: {
            status: terminalStatus,
            queuePosition: null,
            canceledAt: terminalStatus === 'canceled' ? nowDate : null,
            // expiredAt isn't a column — we encode the timestamp by leaving
            // expiresAt as-is and letting status='expired' speak for itself.
          },
        });
        if (updated.count === 0) {
          throw new ConflictException('Another action just changed this reservation.');
        }

        // Free any copy that was held under this reservation.
        if (existing.fulfilledByCopyId) {
          // Only flip if it's currently 'reserved' — guards against the
          // librarian having manually changed the copy out from under us.
          await tx.bookCopy.updateMany({
            where: { id: existing.fulfilledByCopyId, status: 'reserved' },
            data: { status: 'available' },
          });
        }

        // Rebalance: every queued hold behind this one bumps down a slot.
        if (existing.status === 'queued' && existing.queuePosition !== null) {
          await tx.$executeRaw`
            UPDATE reservations
            SET "queuePosition" = "queuePosition" - 1, "updatedAt" = NOW() AT TIME ZONE 'UTC'
            WHERE "bookId" = ${existing.bookId}
              AND status = 'queued'
              AND "queuePosition" > ${existing.queuePosition}
          `;
        }

        // Try to promote the next queued hold — runs in two situations:
        //   (a) we just freed a copy (expired/canceled ready) → there's a
        //       fresh `available` copy and a queue waiting for it;
        //   (b) we canceled a queued hold and queue position 1 still has
        //       someone waiting, but nothing new freed up — the promotion
        //       attempt is cheap (no-op if no copy is available).
        await this.promoteNextHoldInTx(tx, existing.bookId, settings.holdPickupHours);
      });
    } catch (err) {
      throw this.translate(err);
    }
    return this.getInternal(client, id);
  }

  // -------------------------------------------------------------------------
  // update — staff edits notes / customFields on a live or resolved hold
  // -------------------------------------------------------------------------

  async update(
    tenant: TenantContext,
    id: string,
    input: { notes?: string | null; customFields?: Record<string, unknown> },
  ): Promise<ReservationWithJoinsDto> {
    const client = this.tenantPrisma.getClient(tenant);
    const existing = await client.reservation.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Reservation not found.');

    let cleanedCustom: Record<string, unknown> | undefined;
    if (input.customFields !== undefined) {
      const defs = await this.fieldDefs.loadActiveForValidation(tenant, 'reservation');
      cleanedCustom = validateRecordOrThrow(defs, input.customFields, {
        unknownFields: 'reject',
        partial: true,
      });
    }

    const data: Prisma.ReservationUpdateInput = {};
    if (input.notes !== undefined) data.notes = input.notes;
    if (cleanedCustom !== undefined) {
      data.customFields = {
        ...((existing.customFields as Record<string, unknown>) ?? {}),
        ...cleanedCustom,
      } as Prisma.InputJsonValue;
    }

    await client.reservation.update({ where: { id }, data });
    return this.getInternal(client, id);
  }

  // -------------------------------------------------------------------------
  // list / get
  // -------------------------------------------------------------------------

  async list(
    tenant: TenantContext,
    opts: ListReservationsOptions = {},
  ): Promise<{ items: ReservationWithJoinsDto[]; nextCursor: string | null }> {
    const client = this.tenantPrisma.getClient(tenant);
    const limit = Math.max(1, Math.min(100, opts.limit ?? 25));
    const where: Prisma.ReservationWhereInput = {};
    if (opts.bookId) where.bookId = opts.bookId;
    if (opts.memberId) where.memberId = opts.memberId;
    // Always an explicit `IN`, even for "everything": `status` leads
    // `reservations_status_queuePosition_placedAt_id_idx`, and an index cond on
    // the leading column is what lets the planner walk the index already in
    // sort order instead of reading the table and top-N sorting it.
    let statuses: ReservationStatus[] = ALL_STATUSES;
    if (opts.status) statuses = [opts.status];
    else if (!opts.includeResolved) statuses = [...LIVE_STATUSES];

    const cursor = await this.decodeListCursor(client, opts.after);
    if (cursor) {
      // performance-10. This used to be `cursor: { id: after }, skip: 1`, and
      // Prisma cannot render an exact cursor predicate over a NULLABLE sort key
      // (`queuePosition`): it emits an over-broad OR of correlated subselects,
      // EMITS NO LIMIT AT ALL, and then trims the page down in the client. So
      // every "Load more" on the holds screen pulled the whole remaining
      // live-hold set across the wire to render 25 rows. Measured on a library
      // with 40,000 live holds: `count(*)` over the literal SQL Prisma emitted
      // for page 2 came back with 39,976 rows, `Parallel Seq Scan on
      // reservations`, 85.7 ms.
      //
      // Written out by hand instead, over the values carried in the cursor
      // token, so there is a LIMIT and a start key. Same page, 0.89 ms.
      const rank = STATUS_RANK[cursor.status];
      const laterStatuses = statuses.filter((s) => STATUS_RANK[s] > rank);
      // Nothing before the cursor's status can be on a later page, so drop
      // those from the `IN` too — it moves the index seek forward.
      statuses = statuses.filter((s) => STATUS_RANK[s] >= rank);
      // `queuePosition ASC NULLS LAST`: from a positioned hold the tail is
      // "a higher position, or an unpositioned one"; from an unpositioned hold
      // there is no further queuePosition tier at all.
      const samePosition =
        cursor.queuePosition === null
          ? { queuePosition: null }
          : { queuePosition: cursor.queuePosition };
      const laterPosition =
        cursor.queuePosition === null
          ? []
          : [
              {
                status: cursor.status,
                OR: [{ queuePosition: { gt: cursor.queuePosition } }, { queuePosition: null }],
              },
            ];
      where.AND = [
        {
          OR: [
            ...(laterStatuses.length ? [{ status: { in: laterStatuses } }] : []),
            ...laterPosition,
            // `placedAt DESC` — later in the page means EARLIER in time.
            { status: cursor.status, ...samePosition, placedAt: { lt: cursor.placedAt } },
            {
              status: cursor.status,
              ...samePosition,
              placedAt: cursor.placedAt,
              id: { gt: cursor.id },
            },
          ],
        },
      ];
    }
    where.status = { in: statuses };

    const rows = await client.reservation.findMany({
      where,
      orderBy: [
        // Outstanding holds first (`queued` sorts before `ready`; see
        // STATUS_RANK), each block in queue-position order with the
        // unpositioned holds last, then most recently placed first.
        { status: 'asc' },
        { queuePosition: { sort: 'asc', nulls: 'last' } },
        { placedAt: 'desc' },
        { id: 'asc' },
      ],
      take: limit + 1,
      include: this.fullInclude,
    });
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const items = page.map((r) => this.toJoinsDto(r));
    const last = page[page.length - 1];
    return {
      items,
      nextCursor:
        hasMore && last
          ? encodeCursor([last.status, last.queuePosition, last.placedAt.toISOString(), last.id])
          : null,
    };
  }

  /**
   * Turn an `?after=` token back into the four sort values {@link list} pages on.
   *
   * Two shapes are accepted. Ours is the opaque tuple {@link encodeCursor}
   * mints. The other is a bare reservation id — what `after` used to be, what
   * the controller's URL comment still invites, and what a client mid-scroll
   * across a deploy will hand back. That one costs one primary-key lookup, and
   * a row that has since been deleted resolves to `null`, which restarts the
   * caller at page 1 rather than 400-ing them out of a list they were reading.
   */
  private async decodeListCursor(
    client: TenantPrismaClient,
    after: string | undefined,
  ): Promise<{
    status: ReservationStatus;
    queuePosition: number | null;
    placedAt: Date;
    id: string;
  } | null> {
    if (!after) return null;
    const parts = decodeCursor(after, 4);
    if (parts) {
      const [status, queuePosition, placedAt, id] = parts;
      if (
        typeof status === 'string' &&
        status in STATUS_RANK &&
        (queuePosition === null || typeof queuePosition === 'number') &&
        typeof placedAt === 'string' &&
        typeof id === 'string'
      ) {
        const at = new Date(placedAt);
        if (!Number.isNaN(at.getTime())) {
          return { status: status as ReservationStatus, queuePosition, placedAt: at, id };
        }
      }
      return null;
    }
    const row = await client.reservation.findUnique({
      where: { id: after },
      select: { id: true, status: true, queuePosition: true, placedAt: true },
    });
    return row ?? null;
  }

  async get(tenant: TenantContext, id: string): Promise<ReservationWithJoinsDto> {
    const client = this.tenantPrisma.getClient(tenant);
    return this.getInternal(client, id);
  }

  // -------------------------------------------------------------------------
  // Queue mechanics. Both used internally; the same logic is intentionally
  // duplicated in LoansService.returnLoan to avoid a circular module
  // dependency (Reservations already imports Loans for fulfill).
  // -------------------------------------------------------------------------

  /**
   * Promote the head of the queue for `bookId` to `ready`, if there's any
   * queued hold AND a free copy to assign. Must run inside an existing
   * transaction so the reservation + copy flip stay atomic.
   *
   * Returns the promoted reservation's id and the copy id used, or null
   * when no promotion happened.
   */
  private async promoteNextHoldInTx(
    tx: Prisma.TransactionClient,
    bookId: string,
    holdPickupHours: number,
    preferredCopyId?: string,
  ): Promise<{ reservationId: string; copyId: string } | null> {
    const head = await tx.reservation.findFirst({
      where: { bookId, status: 'queued' },
      orderBy: { queuePosition: 'asc' },
      select: { id: true },
    });
    if (!head) return null;

    let candidateCopyId: string | null = null;
    if (preferredCopyId) {
      // Caller already arranged for this exact copy to become available
      // (typical case: LoansService.returnLoan just freed it). Validate.
      const probe = await tx.bookCopy.findFirst({
        where: { id: preferredCopyId, status: 'available', archivedAt: null, bookId },
        select: { id: true },
      });
      if (probe) candidateCopyId = probe.id;
    }
    if (!candidateCopyId) {
      const probe = await tx.bookCopy.findFirst({
        where: { bookId, status: 'available', archivedAt: null },
        select: { id: true },
        orderBy: { createdAt: 'asc' },
      });
      if (probe) candidateCopyId = probe.id;
    }
    if (!candidateCopyId) return null;

    const now = new Date();
    const expiresAt = new Date(now.getTime() + holdPickupHours * MS_PER_HOUR);
    // A7-01: CAS on status='queued'. Belt-and-braces against the head being
    // promoted by a concurrent path (the per-book advisory lock should already
    // serialize promotions, but an unlocked/forgotten caller must NOT be able to
    // double-promote the same head and strand a second copy). If we lost the
    // race the copy we'd have used stays `available` for the winner.
    const promoted = await tx.reservation.updateMany({
      where: { id: head.id, status: 'queued' },
      data: {
        status: 'ready',
        readyAt: now,
        expiresAt,
        fulfilledByCopyId: candidateCopyId,
        queuePosition: null,
      },
    });
    if (promoted.count === 0) return null;
    const flipped = await tx.bookCopy.updateMany({
      where: { id: candidateCopyId, status: 'available' },
      data: { status: 'reserved' },
    });
    if (flipped.count === 0) {
      // The copy slipped out from under us in this tx — extremely unlikely
      // since we're holding row locks, but defensive nonetheless.
      throw new ConflictException('A copy changed state mid-promotion. Please refresh and retry.');
    }

    // Cascade-rebalance: now that head-of-queue moved out, everyone behind
    // bumps up one slot so the next promotion targets the right person.
    await tx.$executeRaw`
      UPDATE reservations
      SET "queuePosition" = "queuePosition" - 1, "updatedAt" = NOW() AT TIME ZONE 'UTC'
      WHERE "bookId" = ${bookId}
        AND status = 'queued'
        AND "queuePosition" > 0
    `;

    return { reservationId: head.id, copyId: candidateCopyId };
  }

  // -------- internals -----------------------------------------------------

  private readonly fullInclude = {
    member: {
      select: { id: true, memberNumber: true, fullName: true, status: true },
    },
    book: { select: { id: true, title: true } },
    fulfilledByCopy: { select: { id: true, barcode: true, status: true } },
  } as const;

  private async getInternal(
    client: TenantPrismaClient,
    id: string,
  ): Promise<ReservationWithJoinsDto> {
    const row = await client.reservation.findUnique({
      where: { id },
      include: this.fullInclude,
    });
    if (!row) throw new NotFoundException('Reservation not found.');
    return this.toJoinsDto(row);
  }

  private async requireSettings(client: TenantPrismaClient): Promise<{
    reservationsEnabled: boolean;
    holdPickupHours: number;
    loanPeriodDays: number;
    currency: string;
  }> {
    const settings = await client.tenantSetting.findUnique({ where: { id: 1 } });
    if (!settings) {
      throw new Error('Tenant settings row missing; tenant DB is in a corrupt state.');
    }
    return settings;
  }

  private translate(err: unknown): Error {
    if (
      err instanceof BadRequestException ||
      err instanceof ConflictException ||
      err instanceof NotFoundException
    ) {
      return err;
    }
    if (typeof err === 'object' && err !== null) {
      const code = (err as { code?: string }).code;
      if (code === 'P2002') {
        return new ConflictException(
          'This member already has an active hold on this book — cancel the existing one first.',
        );
      }
      const message = (err as { message?: string }).message ?? '';
      const m = message.match(/violates check constraint "([^"]+)"/);
      if (m) {
        return new BadRequestException(
          `The database rejected the value (${m[1]}). Please double-check the highlighted fields.`,
        );
      }
    }
    return err instanceof Error ? err : new Error(String(err));
  }

  private toJoinsDto(row: {
    id: string;
    bookId: string;
    memberId: string;
    placedAt: Date;
    queuePosition: number | null;
    status: ReservationStatus;
    readyAt: Date | null;
    expiresAt: Date | null;
    fulfilledAt: Date | null;
    fulfilledByCopyId: string | null;
    canceledAt: Date | null;
    notes: string | null;
    placedByUserId: string | null;
    customFields: unknown;
    createdAt: Date;
    updatedAt: Date;
    book: { id: string; title: string };
    member: { id: string; memberNumber: string; fullName: string; status: MemberStatus };
    fulfilledByCopy: { id: string; barcode: string; status: BookCopyStatus } | null;
  }): ReservationWithJoinsDto {
    return {
      id: row.id,
      bookId: row.bookId,
      memberId: row.memberId,
      placedAt: row.placedAt,
      queuePosition: row.queuePosition,
      status: row.status,
      readyAt: row.readyAt,
      expiresAt: row.expiresAt,
      fulfilledAt: row.fulfilledAt,
      fulfilledByCopyId: row.fulfilledByCopyId,
      canceledAt: row.canceledAt,
      notes: row.notes,
      placedByUserId: row.placedByUserId,
      customFields: (row.customFields as Record<string, unknown>) ?? {},
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      book: row.book,
      member: row.member,
      fulfilledByCopy: row.fulfilledByCopy,
    };
  }
}
