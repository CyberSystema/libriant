import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { callNumberSortKey, type CallNumberScheme } from '@libriant/shared/callnumber';
import { foldGreek } from '@libriant/shared/greek';
import { changeActorOf, setChangeActor } from '../tenancy/tenant-actor-guc.js';
import type { TenantActor } from '../tenancy/tenant-actor.js';
import type { TenantContext } from '../tenancy/tenant-context.js';
import type { TxV2 } from '../tenancy/tenant-tx-v2.js';
import { TenantAuditService } from '../tenancy/tenant-audit.service.js';
import { TenantPrismaService } from '../tenancy/tenant-prisma.service.js';
import { clampLimit, pageOf, type ListResult } from '../platform/list.js';
import { acquireLocks, lockKey } from '../platform/locks.js';
import { decodeCursor } from '../platform/query.js';
import { TenantClockService } from '../policy/tenant-clock.service.js';
import { ItemStatusService, type ItemStatusValue } from './item-status.service.js';

/**
 * Physical copies: creating them, describing them, and putting them in order.
 *
 * Everything about a copy EXCEPT `status` and `current_branch_id`, which belong
 * to `ItemStatusService` and to nothing else. That split is the phase's headline
 * claim and it is enforced from outside the language — see `check:item-status-writer`.
 *
 * ## Holdings auto-creation, and the race it would otherwise be
 *
 * §3 makes `items.holdings_record_id` NOT NULL and calls that "costless by
 * auto-creating a default holdings record on first item, which is how a village
 * library and a university share one schema". Costless it is; free it is not.
 * Measured, 25 concurrent creates of the first copy of one title at one branch,
 * with the obvious SELECT-then-INSERT: 25 holdings records, every run. A
 * cataloguer importing a batch produces exactly that shape.
 *
 * Three mechanisms, and all three are here on purpose:
 *
 *   - The ADVISORY LOCK on `bib:<id>`, taken first, serialises the creates for
 *     one title. `bib` outranks `item` in `LOCK_DOMAIN_RANK`, so a phase-16
 *     checkout taking both takes them in this order and cannot deadlock against
 *     this path.
 *   - `ON CONFLICT … DO NOTHING` on the partial unique, which holds even if a
 *     future caller forgets the lock. The predicate is repeated verbatim so it
 *     implies the index's; anything narrower is `42P10` at runtime.
 *   - The RE-SELECT, because `DO NOTHING` returns zero rows when it conflicted
 *     and the caller still needs the id. It is correct at ReadCommitted:
 *     speculative insertion makes the conflicting inserter WAIT for the other
 *     transaction to commit or abort, so by the time we re-select, the row we
 *     collided with is visible.
 *
 * A raw statement rather than `prisma.holdingsRecord.create`, and that is
 * forced: a unique violation inside a Prisma interactive transaction aborts the
 * whole transaction — there is no per-statement savepoint — so catch-then-select
 * cannot work here at all. It only looks like it does outside a transaction.
 */
@Injectable()
export class ItemsService {
  constructor(
    @Inject(TenantPrismaService) private readonly tenantPrisma: TenantPrismaService,
    @Inject(TenantAuditService) private readonly audit: TenantAuditService,
    @Inject(TenantClockService) private readonly clock: TenantClockService,
    @Inject(ItemStatusService) private readonly status: ItemStatusService,
  ) {}

  // -------------------------------------------------------------------------
  // Create
  // -------------------------------------------------------------------------

  async create(
    tenant: TenantContext,
    actor: TenantActor,
    input: CreateItemInput,
  ): Promise<{ id: string; holdingsRecordId: string; callNumberSort: string | null }> {
    const client = this.tenantPrisma.getClientV2(tenant);
    const now = this.clock.now();

    const created = await client
      .$transaction(
        async (tx) => {
          await acquireLocks(tx, [lockKey('bib', input.bibId)]);
          await setChangeActor(tx, changeActorOf(actor));

          const holdingsRecordId =
            input.holdingsRecordId ??
            (await this.defaultHoldingsFor(tx, input.bibId, input.owningBranchId, now));

          const barcode = input.barcode?.trim() ?? null;
          const item = await tx.item.create({
            data: {
              holdingsRecordId,
              bibId: input.bibId,
              barcode,
              barcodeNorm: barcode === null ? null : normaliseBarcode(barcode),
              itemTypeId: input.itemTypeId,
              materialTypeId: input.materialTypeId ?? null,
              owningBranchId: input.owningBranchId,
              // The copy starts where it is owned. Moving it is a transition,
              // and a transition is `ItemStatusService`'s.
              currentBranchId: input.owningBranchId,
              permanentLocationId: input.permanentLocationId,
              callNumberPrefix: input.callNumberPrefix ?? null,
              callNumberBase: input.callNumberBase ?? null,
              callNumberSuffix: input.callNumberSuffix ?? null,
              callNumberScheme: input.callNumberScheme ?? 'ddc',
              callNumberSort: sortKeyFor(input),
              copyNumber: input.copyNumber ?? null,
              enumeration: input.enumeration ?? null,
              chronology: input.chronology ?? null,
              priceCents: input.priceCents ?? null,
              replacementCostCents: input.replacementCostCents ?? null,
              accessionNumber: input.accessionNumber ?? null,
              publicNote: input.publicNote ?? null,
              staffNote: input.staffNote ?? null,
              statusSince: now,
              createdAt: now,
              updatedAt: now,
            },
            select: { id: true, holdingsRecordId: true, callNumberSort: true },
          });

          // In the same transaction, so a copy cannot exist with an empty
          // history. `ItemsService` is allowed to call this and nothing else on
          // the status service — it writes the row that has no `from`.
          await this.status.recordCreation(tx, {
            itemId: item.id,
            status: 'available',
            branchId: input.owningBranchId,
            source: input.source ?? 'desk',
            actorUserId: actor.userId ?? null,
            now,
          });

          return item;
        },
        { isolationLevel: 'ReadCommitted' },
      )
      .catch((err: unknown) => {
        throw duplicate(err) ?? err;
      });

    await this.audit.record(tenant, actor, {
      action: 'item.created',
      targetType: 'item',
      targetId: created.id,
    });
    return created;
  }

  /**
   * The default holdings record for (bib, branch), created if it is not there.
   *
   * See the class docblock for why all three mechanisms are present and why this
   * is raw SQL. `gen_random_uuid()::text` rather than a cuid because the id is
   * minted inside a statement that may well not insert anything — the same
   * reason `patron_blocks` mints its ids in SQL.
   */
  private async defaultHoldingsFor(
    tx: TxV2,
    bibId: string,
    branchId: string,
    now: Date,
  ): Promise<string> {
    const inserted = await tx.$queryRaw<{ record_id: string }[]>`
      INSERT INTO lbr2.holdings_records (record_id, bib_id, branch_id, is_default, created_at, updated_at)
      VALUES (pg_catalog.gen_random_uuid()::text, ${bibId}, ${branchId}, true, ${now}, ${now})
      ON CONFLICT (bib_id, branch_id) WHERE is_default AND archived_at IS NULL
      DO NOTHING
      RETURNING record_id`;
    if (inserted.length > 0) return inserted[0]!.record_id;

    const existing = await tx.$queryRaw<{ record_id: string }[]>`
      SELECT record_id
        FROM lbr2.holdings_records
       WHERE bib_id = ${bibId} AND branch_id = ${branchId}
         AND is_default AND archived_at IS NULL`;
    if (existing.length > 0) return existing[0]!.record_id;

    // Unreachable unless the row was archived between the two statements, which
    // a librarian could do. Saying so beats a foreign-key error on `items`.
    throw new ConflictException(
      'The default holdings record for this title and branch was archived while the copy was ' +
        'being created. Try again.',
    );
  }

  // -------------------------------------------------------------------------
  // Update
  // -------------------------------------------------------------------------

  /**
   * Edit a copy — everything except where it is and what state it is in.
   *
   * `status` and `currentBranchId` are absent from `UpdateItemInput` by
   * construction, not filtered out at runtime: a field that does not exist
   * cannot be forgotten in a later refactor, and the ESLint rule that bans
   * `status` in an `item.update` call is what catches the attempt to add one.
   *
   * The call-number sort is RECOMPUTED whenever any part of the call number or
   * its scheme moves, and never stored from the client. A key that disagrees
   * with its call number puts a book in the wrong place on a shelf list, on an
   * inventory wand and in a spine-label batch, all silently.
   */
  async update(
    tenant: TenantContext,
    actor: TenantActor,
    itemId: string,
    input: UpdateItemInput,
  ): Promise<{ id: string; callNumberSort: string | null }> {
    const client = this.tenantPrisma.getClientV2(tenant);
    const now = this.clock.now();

    const updated = await client
      .$transaction(
        async (tx) => {
          await acquireLocks(tx, [lockKey('item', itemId)]);
          await setChangeActor(tx, changeActorOf(actor));

          const before = await tx.item.findUnique({
            where: { id: itemId },
            select: {
              callNumberPrefix: true,
              callNumberBase: true,
              callNumberSuffix: true,
              callNumberScheme: true,
            },
          });
          if (before === null) throw new NotFoundException('No such copy.');

          const barcode = input.barcode === undefined ? undefined : (input.barcode?.trim() ?? null);
          const callNumber = {
            callNumberPrefix: pick(input.callNumberPrefix, before.callNumberPrefix),
            callNumberBase: pick(input.callNumberBase, before.callNumberBase),
            callNumberSuffix: pick(input.callNumberSuffix, before.callNumberSuffix),
            callNumberScheme: input.callNumberScheme ?? before.callNumberScheme,
          };

          return tx.item.update({
            where: { id: itemId },
            data: {
              ...(barcode === undefined
                ? {}
                : { barcode, barcodeNorm: barcode === null ? null : normaliseBarcode(barcode) }),
              ...defined({
                itemTypeId: input.itemTypeId,
                temporaryItemTypeId: input.temporaryItemTypeId,
                materialTypeId: input.materialTypeId,
                permanentLocationId: input.permanentLocationId,
                temporaryLocationId: input.temporaryLocationId,
                copyNumber: input.copyNumber,
                enumeration: input.enumeration,
                chronology: input.chronology,
                notForLoanCode: input.notForLoanCode,
                damagedCode: input.damagedCode,
                lostCode: input.lostCode,
                restrictedAccess: input.restrictedAccess,
                holdable: input.holdable,
                bookable: input.bookable,
                priceCents: input.priceCents,
                replacementCostCents: input.replacementCostCents,
                accessionNumber: input.accessionNumber,
                publicNote: input.publicNote,
                staffNote: input.staffNote,
              }),
              ...callNumber,
              callNumberSort: sortKeyFor(callNumber),
              updatedAt: now,
            },
            select: { id: true, callNumberSort: true },
          });
        },
        { isolationLevel: 'ReadCommitted' },
      )
      .catch((err: unknown) => {
        throw duplicate(err) ?? err;
      });

    await this.audit.record(tenant, actor, {
      action: 'item.updated',
      targetType: 'item',
      targetId: itemId,
    });
    return updated;
  }

  /**
   * Archive a copy.
   *
   * Not a status. `withdrawn` is a thing a librarian does to a book that stays
   * on the system; `archived_at` is a row leaving the live set, and both partial
   * uniques on `items` (`barcode_norm`, `rfid_tag_uid`) are scoped on it so the
   * barcode becomes reusable. `is_shelf_available` also reads it, so an archived
   * copy leaves the availability index in the same statement.
   */
  async archive(tenant: TenantContext, actor: TenantActor, itemId: string): Promise<void> {
    const client = this.tenantPrisma.getClientV2(tenant);
    const now = this.clock.now();

    await client.$transaction(
      async (tx) => {
        await acquireLocks(tx, [lockKey('item', itemId)]);
        await setChangeActor(tx, changeActorOf(actor));

        const open = await tx.itemTransfer.findFirst({
          where: { itemId, receivedAt: null, cancelledAt: null },
          select: { id: true },
        });
        if (open !== null) {
          throw new ConflictException(
            'This copy is in transit. Receive or cancel the transfer before archiving it.',
          );
        }

        const done = await tx.item.updateMany({
          where: { id: itemId, archivedAt: null },
          data: { archivedAt: now, updatedAt: now },
        });
        if (done.count === 0) throw new NotFoundException('No such live copy.');
      },
      { isolationLevel: 'ReadCommitted' },
    );

    await this.audit.record(tenant, actor, {
      action: 'item.archived',
      targetType: 'item',
      targetId: itemId,
    });
  }

  // -------------------------------------------------------------------------
  // Read
  // -------------------------------------------------------------------------

  /**
   * The shelf list at a branch, in shelf order.
   *
   * `ORDER BY current_branch_id, call_number_sort, id` matches
   * `items_shelf_order_idx` leading-column for leading-column, which is what
   * makes it an Index Only Scan with NO SORT NODE — asserted by
   * `items.spec.ts`, because a plan change here is invisible until an inventory
   * session on a 200,000-copy library times out.
   *
   * Keyset paging, not OFFSET: `(call_number_sort, id)` is a total order, and
   * OFFSET 100000 re-walks a hundred thousand index entries to discard them.
   */
  async shelfList(
    tenant: TenantContext,
    branchId: string,
    opts: { after?: { callNumberSort: string | null; id: string }; take?: number } = {},
  ): Promise<ShelfRow[]> {
    const client = this.tenantPrisma.getClientV2(tenant);
    const take = Math.min(Math.max(opts.take ?? 100, 1), 500);
    return client.item.findMany({
      where: {
        currentBranchId: branchId,
        archivedAt: null,
        // The cursor has three branches because the sort key is NULLABLE and a
        // btree ASC index puts NULLs LAST. A copy with no call number is a copy
        // nobody has shelved yet; it belongs at the end of the list rather than
        // missing from it, and a two-branch keyset silently drops the whole
        // tail because `gt` never matches NULL.
        ...(opts.after === undefined
          ? {}
          : opts.after.callNumberSort === null
            ? { callNumberSort: null, id: { gt: opts.after.id } }
            : {
                OR: [
                  { callNumberSort: { gt: opts.after.callNumberSort } },
                  { callNumberSort: opts.after.callNumberSort, id: { gt: opts.after.id } },
                  { callNumberSort: null },
                ],
              }),
      },
      orderBy: [{ currentBranchId: 'asc' }, { callNumberSort: 'asc' }, { id: 'asc' }],
      take,
      select: {
        id: true,
        barcode: true,
        callNumberPrefix: true,
        callNumberBase: true,
        callNumberSuffix: true,
        callNumberSort: true,
        copyNumber: true,
        status: true,
        permanentLocationId: true,
      },
    });
  }

  /**
   * The copies of ONE record, in shelf order (2.0 phase 20a).
   *
   * ## `bibId` is required, and that is the whole design of this endpoint
   *
   * There is deliberately no library-wide copy list. Nothing indexes one —
   * `items_shelf_order_idx` leads on `current_branch_id` and
   * `items_shelf_available_idx` is partial on a generated boolean — so an
   * unfiltered list is a sequential scan of every copy the library owns, and no
   * screen wants it: the copies table lives on a record page, and the
   * branch-wide walk is {@link shelfList}, which has the index for it. A
   * required filter is cheaper to explain to a caller than an endpoint that is
   * slow for a reason nobody meant to invoke.
   *
   * ## The sort key is NULLABLE, and the shared predicate cannot say so
   *
   * `platform/list.ts` builds `sortField >= s` as a start key the planner can
   * seek to, and that is exactly what a NULL cannot survive: every comparison
   * against NULL is NULL, never true. Handed a nullable `call_number_sort` it
   * drops the entire unshelved tail out of the list, and a cursor that lands IN
   * that tail (`sort` is null) matches nothing at all — which renders as "the
   * list ended" while three copies are still missing from it. So the predicate
   * is the three-branch one {@link shelfList} already carries, written out here
   * rather than pushed into the shared helper, because the start-key
   * optimisation the helper exists for is the part that cannot be made NULL-safe.
   *
   * ASC on a nullable column is NULLS LAST in Postgres, which is the order this
   * wants: a copy nobody has shelved yet belongs at the end of the list rather
   * than missing from it.
   *
   * ## What it walks today
   *
   * NOTHING, and that is a gap the operator has to close: Postgres creates no
   * index for a foreign key, phase 15 added none on `bib_id`, so
   * `WHERE bib_id = $1` is a sequential scan of `items` and the ORDER BY is a
   * sort node on top of it. The list is correct and it does not scale — a
   * 200,000-copy library pays the whole table for a record page. The index that
   * fixes it is `items (bib_id, call_number_sort, id)`, which matches this
   * filter and this order leading-column for leading-column and turns the sort
   * node into an index walk. It is named in the phase-20a report.
   */
  async copies(tenant: TenantContext, opts: ItemListOptions): Promise<ItemListPage> {
    const client = this.tenantPrisma.getClientV2(tenant);
    const limit = clampLimit(opts.limit);

    // Live copies only. `archived_at` is not a status — it is the row leaving
    // the live set, which is also what releases its barcode for re-use — so an
    // archived copy on a record page would be a copy a librarian cannot find,
    // scan or check out.
    const where: Record<string, unknown> = { bibId: opts.bibId, archivedAt: null };
    const after = await this.decodeCopiesCursor(client, opts.bibId, opts.after);
    if (after !== null) {
      Object.assign(
        where,
        after.callNumberSort === null
          ? { callNumberSort: null, id: { gt: after.id } }
          : {
              OR: [
                { callNumberSort: { gt: after.callNumberSort } },
                { callNumberSort: after.callNumberSort, id: { gt: after.id } },
                { callNumberSort: null },
              ],
            },
      );
    }

    // EXPLICIT SELECT. `public_note` and `staff_note` are 2,000 characters each
    // and `custom_fields` is JSONB, so a default `findMany` would drag up to
    // 4 KB of prose and a TOAST read per row onto a page that shows a call
    // number and a status. None of the three has a column on the copies table
    // in the UI.
    const rows = await client.item.findMany({
      where: where as never,
      orderBy: [{ callNumberSort: 'asc' }, { id: 'asc' }],
      take: limit + 1,
      select: {
        id: true,
        barcode: true,
        callNumberPrefix: true,
        callNumberBase: true,
        callNumberSuffix: true,
        callNumberSort: true,
        copyNumber: true,
        enumeration: true,
        chronology: true,
        status: true,
        statusSince: true,
        statusReasonId: true,
        itemTypeId: true,
        temporaryItemTypeId: true,
        materialTypeId: true,
        owningBranchId: true,
        currentBranchId: true,
        permanentLocationId: true,
        temporaryLocationId: true,
        notForLoanCode: true,
        damagedCode: true,
        lostCode: true,
        withdrawnAt: true,
        restrictedAccess: true,
        holdable: true,
        bookable: true,
        priceCents: true,
        replacementCostCents: true,
        accessionNumber: true,
        checkoutCount: true,
        renewalCount: true,
        updatedAt: true,
      },
    });

    return pageOf(
      rows,
      limit,
      (r) => ({
        id: r.id,
        barcode: r.barcode,
        callNumberPrefix: r.callNumberPrefix,
        callNumberBase: r.callNumberBase,
        callNumberSuffix: r.callNumberSuffix,
        callNumberSort: r.callNumberSort,
        copyNumber: r.copyNumber,
        enumeration: r.enumeration,
        chronology: r.chronology,
        status: r.status,
        statusSince: r.statusSince,
        statusReasonId: r.statusReasonId,
        itemTypeId: r.itemTypeId,
        temporaryItemTypeId: r.temporaryItemTypeId,
        materialTypeId: r.materialTypeId,
        owningBranchId: r.owningBranchId,
        currentBranchId: r.currentBranchId,
        permanentLocationId: r.permanentLocationId,
        temporaryLocationId: r.temporaryLocationId,
        notForLoanCode: r.notForLoanCode,
        damagedCode: r.damagedCode,
        lostCode: r.lostCode,
        withdrawnAt: r.withdrawnAt,
        restrictedAccess: r.restrictedAccess,
        holdable: r.holdable,
        bookable: r.bookable,
        priceCents: money(r.priceCents),
        replacementCostCents: money(r.replacementCostCents),
        accessionNumber: r.accessionNumber,
        checkoutCount: r.checkoutCount,
        renewalCount: r.renewalCount,
        updatedAt: r.updatedAt,
      }),
      // NOT `keysetCursorValues`, which takes a non-null sort value. The token
      // carries a JSON null for an unshelved copy, which `decodeCursor` round-
      // trips and the three-branch predicate above reads as "the NULL tail".
      (r) => [r.callNumberSort, r.id],
    );
  }

  /**
   * Turn an `?after=` token back into the two values {@link copies} pages on.
   *
   * A bare item id is accepted beside a token we minted, for the reason
   * `decodeCursor` states: `?after=` was an id everywhere in 1.0, and a
   * librarian clicking "Load more" while a deploy swaps the format must not be
   * handed a 400 halfway down a list of copies.
   *
   * The bare-id lookup is scoped to the SAME record, not to the copy alone. An
   * id belonging to a different title would otherwise resume this list at that
   * copy's call number — a page that silently starts in the middle of the
   * copies it was asked for. Scoped, it resolves to `null` and restarts at page
   * one, which is also what a deleted cursor row does.
   */
  private async decodeCopiesCursor(
    client: ReturnType<TenantPrismaService['getClientV2']>,
    bibId: string,
    after: string | undefined,
  ): Promise<{ callNumberSort: string | null; id: string } | null> {
    if (after === undefined || after.length === 0) return null;
    const parts = decodeCursor(after, 2);
    if (parts !== null) {
      const [sort, id] = parts;
      // A token of the right arity carrying the wrong types came from another
      // list. Page one is the right answer to it — resuming at a position read
      // out of somebody else's columns is not.
      if (typeof id !== 'string') return null;
      if (sort !== null && typeof sort !== 'string') return null;
      return { callNumberSort: sort, id };
    }
    const row = await client.item.findFirst({
      where: { id: after, bibId },
      select: { id: true, callNumberSort: true },
    });
    return row === null ? null : { callNumberSort: row.callNumberSort, id: row.id };
  }

  /**
   * One copy, found by the barcode on its spine, with its title attached
   * (2.0 phase 20a).
   *
   * ## Why the bib travels with the copy
   *
   * Every caller of this is holding the book — a return scan, a checkout, an
   * inventory wand — and none of them can do anything with a `bibId`. The first
   * thing that has to appear on the screen is the title, so leaving it out buys
   * a second round trip on every single scan at the busiest desk in the
   * building. One request in, one screen out.
   *
   * ## One statement, and that is why it is raw
   *
   * The projection hangs off `marc_records` rather than off `items`, so the
   * model-API spelling of this join is a two-level nested select — item → bib →
   * bib — and Prisma resolves each relation level with a statement of its own,
   * because `relationJoins` is not among the preview features this client is
   * generated with (see the generator block in `00-datasource.prisma`). Three
   * round trips for what Postgres does with one index seek and one primary-key
   * lookup is not a trade to make on a scan.
   *
   * The INNER join is deliberate: §2 recomputes the projection inside the same
   * transaction as every record write, so a copy whose record has no
   * `bib_records` row cannot be committed. Were one ever to exist, this answers
   * 404 for a copy that is really there — the loud failure, and the one
   * `catalog-verify` exists to find.
   *
   * ## The ITEMS normalisation, not the patron-card one
   *
   * `normaliseBarcode` strips whitespace, folds and uppercases, because
   * `items_barcode_unique_active` is on `barcode_norm`: a copy catalogued
   * `ΑΒΓ-1` has to be found by a hand typing `αβγ-1`, which is the normal case
   * on legacy Greek accession numbers. `patron_cards` deliberately does NOT
   * fold, and reaching for that rule here would make the lookup miss the row
   * the unique index says is there.
   *
   * Walks `items_barcode_unique_active ON items (barcode_norm) WHERE
   * barcode_norm IS NOT NULL AND archived_at IS NULL`. Both halves of the index
   * predicate are implied by the WHERE — `barcode_norm = $1` cannot match a
   * NULL, and `archived_at IS NULL` is written out rather than assumed — which
   * is the condition for Postgres to use a partial index at all.
   */
  async byBarcode(tenant: TenantContext, barcode: string): Promise<ItemByBarcodeRow> {
    const client = this.tenantPrisma.getClientV2(tenant);
    const rows = await client.$queryRaw<BarcodeRow[]>`
      SELECT i.id, i.bib_id, i.barcode,
             i.item_type_id, i.temporary_item_type_id, i.material_type_id,
             i.owning_branch_id, i.current_branch_id,
             i.permanent_location_id, i.temporary_location_id,
             i.call_number_prefix, i.call_number_base, i.call_number_suffix,
             i.call_number_sort, i.copy_number, i.enumeration, i.chronology,
             i.status::text AS status, i.status_since, i.status_reason_id,
             i.not_for_loan_code, i.damaged_code, i.lost_code, i.withdrawn_at,
             i.restricted_access, i.holdable, i.bookable,
             i.price_cents, i.replacement_cost_cents, i.accession_number,
             i.checkout_count, i.renewal_count, i.updated_at,
             b.title, b.main_entry_display, b.browse_author, b.publication_year
        FROM lbr2.items i
        JOIN lbr2.bib_records b ON b.bib_id = i.bib_id
       WHERE i.barcode_norm = ${normaliseBarcode(barcode)}
         AND i.archived_at IS NULL`;
    const row = rows[0];
    if (row === undefined) {
      throw new NotFoundException(
        `No copy in this library carries the barcode ${barcode}. Check that the whole barcode ` +
          'was scanned or typed, and that the copy has not been archived — archiving takes a ' +
          'copy out of the live set and releases its barcode, so an archived copy cannot be ' +
          'found by scanning it.',
      );
    }

    return {
      id: row.id,
      bibId: row.bib_id,
      barcode: row.barcode,
      itemTypeId: row.item_type_id,
      temporaryItemTypeId: row.temporary_item_type_id,
      materialTypeId: row.material_type_id,
      owningBranchId: row.owning_branch_id,
      currentBranchId: row.current_branch_id,
      permanentLocationId: row.permanent_location_id,
      temporaryLocationId: row.temporary_location_id,
      callNumberPrefix: row.call_number_prefix,
      callNumberBase: row.call_number_base,
      callNumberSuffix: row.call_number_suffix,
      callNumberSort: row.call_number_sort,
      copyNumber: row.copy_number,
      enumeration: row.enumeration,
      chronology: row.chronology,
      status: row.status,
      statusSince: row.status_since,
      statusReasonId: row.status_reason_id,
      notForLoanCode: row.not_for_loan_code,
      damagedCode: row.damaged_code,
      lostCode: row.lost_code,
      withdrawnAt: row.withdrawn_at,
      restrictedAccess: row.restricted_access,
      holdable: row.holdable,
      bookable: row.bookable,
      priceCents: money(row.price_cents),
      replacementCostCents: money(row.replacement_cost_cents),
      accessionNumber: row.accession_number,
      checkoutCount: row.checkout_count,
      renewalCount: row.renewal_count,
      updatedAt: row.updated_at,
      bib: {
        id: row.bib_id,
        title: row.title,
        mainEntryDisplay: row.main_entry_display,
        browseAuthor: row.browse_author,
        publicationYear: row.publication_year,
      },
    };
  }

  /**
   * Is there a copy of this title on the shelf at this branch?
   *
   * The hold-promotion probe of §6 phase 15, and phase 17 is its real caller.
   * `isShelfAvailable` is the GENERATED column, so this is an Index Scan on
   * `items_shelf_available_idx` — measured 3 buffers at 200,000 copies. Written
   * as a boolean and never as `status: 'available'`, which cannot use an index
   * at all through Prisma.
   */
  async shelfAvailableAt(
    tenant: TenantContext,
    bibId: string,
    branchId: string,
  ): Promise<{ id: string } | null> {
    const client = this.tenantPrisma.getClientV2(tenant);
    // RAW, and it has to be: `is_shelf_available` is a STORED generated column,
    // Prisma has no generated-column concept, so the field does not exist on the
    // model at all. It is allowlisted in `check:schema-drift` for that reason.
    const rows = await client.$queryRaw<{ id: string }[]>`
      SELECT id
        FROM lbr2.items
       WHERE bib_id = ${bibId}
         AND current_branch_id = ${branchId}
         AND is_shelf_available
       LIMIT 1`;
    return rows[0] ?? null;
  }

  /**
   * One copy, with what a record page shows beside it.
   *
   * The return type is written out for the reason `StatusReasonRow` is: an
   * inferred one names Prisma's generated `ItemStatus` and `CallNumberScheme`
   * from inside `node_modules/.prisma`, which is `TS2883` and a failed build.
   */
  async get(tenant: TenantContext, itemId: string): Promise<ItemRow> {
    const client = this.tenantPrisma.getClientV2(tenant);
    const item = await client.item.findUnique({
      where: { id: itemId },
      select: {
        id: true,
        bibId: true,
        holdingsRecordId: true,
        barcode: true,
        itemTypeId: true,
        temporaryItemTypeId: true,
        materialTypeId: true,
        owningBranchId: true,
        currentBranchId: true,
        permanentLocationId: true,
        temporaryLocationId: true,
        callNumberPrefix: true,
        callNumberBase: true,
        callNumberSuffix: true,
        callNumberSort: true,
        callNumberScheme: true,
        copyNumber: true,
        enumeration: true,
        chronology: true,
        status: true,
        statusSince: true,
        statusReasonId: true,
        notForLoanCode: true,
        damagedCode: true,
        lostCode: true,
        withdrawnAt: true,
        restrictedAccess: true,
        holdable: true,
        bookable: true,
        priceCents: true,
        replacementCostCents: true,
        accessionNumber: true,
        publicNote: true,
        staffNote: true,
        checkoutCount: true,
        renewalCount: true,
        archivedAt: true,
      },
    });
    if (item === null) throw new NotFoundException('No such copy.');
    return item;
  }

  // -------------------------------------------------------------------------
  // Notes
  // -------------------------------------------------------------------------

  /**
   * A dated, attributed note.
   *
   * `items.public_note` and `staff_note` are NOT replaced by this. A one-line
   * "spine label damaged" that prints on the record page is a field, and forcing
   * it to be a dated attributed note is how a field stops being used. This is
   * for the second note and the third — the conservation history a copy
   * accumulates over twenty years.
   */
  async addNote(
    tenant: TenantContext,
    actor: TenantActor,
    itemId: string,
    input: { body: string; publicNote?: boolean },
  ): Promise<{ id: string }> {
    const client = this.tenantPrisma.getClientV2(tenant);
    const now = this.clock.now();
    return client.$transaction(
      async (tx) => {
        await setChangeActor(tx, changeActorOf(actor));
        return tx.itemNote.create({
          data: {
            itemId,
            body: input.body,
            // Staff-only unless asked otherwise. A note written on the
            // assumption that nobody outside the building reads it must not
            // become public because a later screen offered the choice and
            // defaulted the other way.
            publicNote: input.publicNote ?? false,
            createdByUserId: actor.userId ?? null,
            createdAt: now,
            updatedAt: now,
          },
          select: { id: true },
        });
      },
      { isolationLevel: 'ReadCommitted' },
    );
  }

  async notes(tenant: TenantContext, itemId: string, includeStaff: boolean) {
    const client = this.tenantPrisma.getClientV2(tenant);
    return client.itemNote.findMany({
      where: { itemId, archivedAt: null, ...(includeStaff ? {} : { publicNote: true }) },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 200,
      select: {
        id: true,
        body: true,
        publicNote: true,
        createdAt: true,
        createdByUserId: true,
      },
    });
  }

  async archiveNote(tenant: TenantContext, actor: TenantActor, noteId: string): Promise<void> {
    const client = this.tenantPrisma.getClientV2(tenant);
    const now = this.clock.now();
    const done = await client.$transaction(
      async (tx) => {
        await setChangeActor(tx, changeActorOf(actor));
        return tx.itemNote.updateMany({
          where: { id: noteId, archivedAt: null },
          data: { archivedAt: now, updatedAt: now },
        });
      },
      { isolationLevel: 'ReadCommitted' },
    );
    if (done.count === 0) throw new NotFoundException('No such live note.');
  }
}

// ---------------------------------------------------------------------------

/**
 * The shelf key. Pure ASCII, fixed width, computed here and never accepted from
 * a client.
 *
 * Tenant databases are created `el_GR.UTF-8`; a non-ASCII key reorders under
 * that collation — the perf-13 trap — and shelf order has to be byte-identical
 * in Postgres, in the browser and in the offline inventory wand.
 */
function sortKeyFor(input: {
  callNumberPrefix?: string | null;
  callNumberBase?: string | null;
  callNumberSuffix?: string | null;
  callNumberScheme?: CallNumberScheme | null;
}): string | null {
  const base = input.callNumberBase?.trim();
  if (base === undefined || base === '') return null;
  return callNumberSortKey(input.callNumberScheme ?? 'ddc', {
    prefix: input.callNumberPrefix ?? null,
    callNumber: base,
    suffix: input.callNumberSuffix ?? null,
  });
}

/**
 * The barcode, folded.
 *
 * The uniqueness index is on `barcode_norm`, so two copies cannot differ only by
 * case or by a Greek accent — which is exactly what happens when one is typed
 * and the other is scanned.
 *
 * DELIBERATELY NOT `patron_cards`' normaliser, which trims, strips whitespace
 * and uppercases and does NOT fold. The difference is in the two column
 * docblocks and it is a real one: a patron card barcode is machine-issued and
 * printed, and folding it would let two people's cards collide. An item barcode
 * is frequently a hand-typed accession number on legacy Greek stock, which is
 * why `items.barcode_norm` says "folded per `@libriant/shared/greek`" and
 * `patron_cards.barcode_norm` does not.
 */
function normaliseBarcode(barcode: string): string {
  return foldGreek(barcode.replace(/\s+/g, '')).toUpperCase();
}

/**
 * Minor units, as a DECIMAL STRING, on the way out.
 *
 * `items.price_cents` and `replacement_cost_cents` are `BigInt`, and there is no
 * `BigInt.prototype.toJSON` in this repository: a raw bigint reaching
 * `res.json()` throws `TypeError: Do not know how to serialize a BigInt` — a 500
 * on a route that read the row correctly, and only for the copies that happen to
 * carry a price. `fees.controller.ts` already settled the convention for every
 * amount crossing this wire, and this is the same one. NOT `Number()`: a
 * 64-bit minor-unit amount is not safely representable as a double, and a
 * silently rounded replacement cost is a bill somebody disputes.
 */
function money(cents: bigint | null): string | null {
  return cents === null ? null : String(cents);
}

/** `undefined` means "leave alone"; `null` means "clear". */
function pick<T>(given: T | null | undefined, current: T | null): T | null {
  return given === undefined ? current : given;
}

/** Drops the keys the caller did not mention, so Prisma leaves those columns. */
function defined<T extends object>(patch: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) if (v !== undefined) out[k] = v;
  return out as Partial<T>;
}

/** The two live uniques on `items`, translated. */
function duplicate(err: unknown): ConflictException | null {
  const target = (err as { code?: string; meta?: { target?: unknown } } | null)?.code === 'P2002';
  if (!target) return null;
  const meta = String((err as { meta?: { target?: unknown } }).meta?.target ?? '');
  if (meta.includes('rfid')) {
    return new ConflictException('Another copy already carries that RFID tag.');
  }
  return new ConflictException('Another copy already has that barcode.');
}

// ---------------------------------------------------------------------------

export type CreateItemInput = {
  readonly bibId: string;
  /** Omit to use — or create — the default holdings record for this branch. */
  readonly holdingsRecordId?: string;
  readonly itemTypeId: string;
  readonly materialTypeId?: string | null;
  readonly owningBranchId: string;
  readonly permanentLocationId: string;
  readonly barcode?: string | null;
  readonly callNumberPrefix?: string | null;
  readonly callNumberBase?: string | null;
  readonly callNumberSuffix?: string | null;
  readonly callNumberScheme?: CallNumberScheme;
  readonly copyNumber?: string | null;
  readonly enumeration?: string | null;
  readonly chronology?: string | null;
  readonly priceCents?: bigint | null;
  readonly replacementCostCents?: bigint | null;
  readonly accessionNumber?: string | null;
  readonly publicNote?: string | null;
  readonly staffNote?: string | null;
  readonly source?: 'desk' | 'opac' | 'sip2' | 'ncip' | 'api' | 'offline' | 'kiosk';
};

/**
 * Everything a copy has that is not where it is or what state it is in.
 *
 * `status` and `currentBranchId` are absent BY CONSTRUCTION. Adding them here
 * is the change `check:item-status-writer` exists to refuse.
 */
export type UpdateItemInput = {
  readonly barcode?: string | null;
  readonly itemTypeId?: string;
  readonly temporaryItemTypeId?: string | null;
  readonly materialTypeId?: string | null;
  readonly permanentLocationId?: string;
  readonly temporaryLocationId?: string | null;
  readonly callNumberPrefix?: string | null;
  readonly callNumberBase?: string | null;
  readonly callNumberSuffix?: string | null;
  readonly callNumberScheme?: CallNumberScheme;
  readonly copyNumber?: string | null;
  readonly enumeration?: string | null;
  readonly chronology?: string | null;
  readonly notForLoanCode?: string | null;
  readonly damagedCode?: string | null;
  readonly lostCode?: string | null;
  readonly restrictedAccess?: boolean;
  readonly holdable?: boolean;
  readonly bookable?: boolean;
  readonly priceCents?: bigint | null;
  readonly replacementCostCents?: bigint | null;
  readonly accessionNumber?: string | null;
  readonly publicNote?: string | null;
  readonly staffNote?: string | null;
};

export type ItemRow = {
  readonly id: string;
  readonly bibId: string;
  readonly holdingsRecordId: string;
  readonly barcode: string | null;
  readonly itemTypeId: string;
  readonly temporaryItemTypeId: string | null;
  readonly materialTypeId: string | null;
  readonly owningBranchId: string;
  readonly currentBranchId: string;
  readonly permanentLocationId: string;
  readonly temporaryLocationId: string | null;
  readonly callNumberPrefix: string | null;
  readonly callNumberBase: string | null;
  readonly callNumberSuffix: string | null;
  readonly callNumberSort: string | null;
  readonly callNumberScheme: CallNumberScheme;
  readonly copyNumber: string | null;
  readonly enumeration: string | null;
  readonly chronology: string | null;
  readonly status: ItemStatusValue;
  readonly statusSince: Date;
  readonly statusReasonId: string | null;
  readonly notForLoanCode: string | null;
  readonly damagedCode: string | null;
  readonly lostCode: string | null;
  readonly withdrawnAt: Date | null;
  readonly restrictedAccess: boolean;
  readonly holdable: boolean;
  readonly bookable: boolean;
  readonly priceCents: bigint | null;
  readonly replacementCostCents: bigint | null;
  readonly accessionNumber: string | null;
  readonly publicNote: string | null;
  readonly staffNote: string | null;
  readonly checkoutCount: number;
  readonly renewalCount: number;
  readonly archivedAt: Date | null;
};

export type ShelfRow = {
  readonly id: string;
  readonly barcode: string | null;
  readonly callNumberPrefix: string | null;
  readonly callNumberBase: string | null;
  readonly callNumberSuffix: string | null;
  readonly callNumberSort: string | null;
  readonly copyNumber: string | null;
  readonly status: ItemStatusValue;
  readonly permanentLocationId: string;
};

/** What the copies list accepts. Validated by `ItemListQueryDto`. */
export type ItemListOptions = {
  /** REQUIRED. See {@link ItemsService.copies} for why there is no unfiltered list. */
  readonly bibId: string;
  readonly after?: string;
  readonly limit?: number;
};

/**
 * One row of the copies list.
 *
 * `id` is spelled out as a literal field rather than left to a spread, because
 * `DataTable` is `T extends { id: string }` and uses it as the React key: a row
 * shape that loses it renders a list whose rows re-mount on every refresh.
 *
 * The two amounts are DECIMAL STRINGS of minor units — see {@link money}. The
 * three fat columns (`public_note`, `staff_note`, `custom_fields`) are absent by
 * construction, which is what keeps the page off TOAST.
 */
export type ItemListRow = {
  readonly id: string;
  readonly barcode: string | null;
  readonly callNumberPrefix: string | null;
  readonly callNumberBase: string | null;
  readonly callNumberSuffix: string | null;
  readonly callNumberSort: string | null;
  readonly copyNumber: string | null;
  readonly enumeration: string | null;
  readonly chronology: string | null;
  readonly status: ItemStatusValue;
  readonly statusSince: Date;
  readonly statusReasonId: string | null;
  readonly itemTypeId: string;
  readonly temporaryItemTypeId: string | null;
  readonly materialTypeId: string | null;
  readonly owningBranchId: string;
  readonly currentBranchId: string;
  readonly permanentLocationId: string;
  readonly temporaryLocationId: string | null;
  readonly notForLoanCode: string | null;
  readonly damagedCode: string | null;
  readonly lostCode: string | null;
  readonly withdrawnAt: Date | null;
  readonly restrictedAccess: boolean;
  readonly holdable: boolean;
  readonly bookable: boolean;
  readonly priceCents: string | null;
  readonly replacementCostCents: string | null;
  readonly accessionNumber: string | null;
  readonly checkoutCount: number;
  readonly renewalCount: number;
  readonly updatedAt: Date;
};

export type ItemListPage = ListResult<ItemListRow>;

/**
 * One copy resolved from a scan, and the record it is a copy of.
 *
 * The same columns as {@link ItemListRow} plus `bibId` and `bib`: a list already
 * knows which record it is listing, and a scan is the case where nothing is
 * known until the barcode comes back.
 */
export type ItemByBarcodeRow = ItemListRow & {
  readonly bibId: string;
  readonly bib: {
    readonly id: string;
    readonly title: string;
    readonly mainEntryDisplay: string | null;
    readonly browseAuthor: string | null;
    readonly publicationYear: number | null;
  };
};

/**
 * The raw row {@link ItemsService.byBarcode} selects.
 *
 * Written out because `$queryRaw` cannot infer one, and snake_case because that
 * is what Postgres hands back — the mapping to the camelCase wire shape happens
 * once, in the method, where the two lists can be read against each other.
 */
type BarcodeRow = {
  id: string;
  bib_id: string;
  barcode: string | null;
  item_type_id: string;
  temporary_item_type_id: string | null;
  material_type_id: string | null;
  owning_branch_id: string;
  current_branch_id: string;
  permanent_location_id: string;
  temporary_location_id: string | null;
  call_number_prefix: string | null;
  call_number_base: string | null;
  call_number_suffix: string | null;
  call_number_sort: string | null;
  copy_number: string | null;
  enumeration: string | null;
  chronology: string | null;
  /** Selected as `::text`, so the six-value union is the honest type for it. */
  status: ItemStatusValue;
  status_since: Date;
  status_reason_id: string | null;
  not_for_loan_code: string | null;
  damaged_code: string | null;
  lost_code: string | null;
  withdrawn_at: Date | null;
  restricted_access: boolean;
  holdable: boolean;
  bookable: boolean;
  /** `bigint` here and a decimal string on the wire. See {@link money}. */
  price_cents: bigint | null;
  replacement_cost_cents: bigint | null;
  accession_number: string | null;
  checkout_count: number;
  renewal_count: number;
  updated_at: Date;
  title: string;
  main_entry_display: string | null;
  browse_author: string | null;
  publication_year: number | null;
};
