import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { callNumberSortKey, type CallNumberScheme } from '@libriant/shared/callnumber';
import { foldGreek } from '@libriant/shared/greek';
import { changeActorOf, setChangeActor } from '../tenancy/tenant-actor-guc.js';
import type { TenantActor } from '../tenancy/tenant-actor.js';
import type { TenantContext } from '../tenancy/tenant-context.js';
import type { TxV2 } from '../tenancy/tenant-tx-v2.js';
import { TenantAuditService } from '../tenancy/tenant-audit.service.js';
import { TenantPrismaService } from '../tenancy/tenant-prisma.service.js';
import { acquireLocks, lockKey } from '../platform/locks.js';
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
