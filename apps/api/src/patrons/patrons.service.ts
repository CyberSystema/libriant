import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { foldGreek } from '@libriant/shared/greek';
import { classifySearchTerm } from '@libriant/shared/search';
import { changeActorOf, setChangeActor } from '../tenancy/tenant-actor-guc.js';
import type { TenantActor } from '../tenancy/tenant-actor.js';
import type { TenantContext } from '../tenancy/tenant-context.js';
import { TenantAuditService } from '../tenancy/tenant-audit.service.js';
import { TenantPrismaService } from '../tenancy/tenant-prisma.service.js';
import {
  clampLimit,
  keysetCursorValues,
  keysetPredicate,
  pageOf,
  readKeysetCursor,
  type KeysetBoundary,
  type ListResult,
} from '../platform/list.js';
import { escapeLike } from '../platform/like.js';
import { acquireLocks, lockKey } from '../platform/locks.js';
import { TenantClockService } from '../policy/tenant-clock.service.js';
import { QuotaService } from '../customization/quota.service.js';
import { EffectivePlanService, isUnlimitedInt } from '../plans/effective-plan.service.js';
import { mintPatronNumber } from './patron-numbers.js';
import type { PatronRosterStatus } from './patrons.dto.js';

/**
 * The borrower record, and the scan that finds it.
 *
 * ## The card scan is ONE hop, and the join is the whole design
 *
 * ```sql
 * SELECT COALESCE(s.id, p.id) AS effective_patron_id, (s.id IS NOT NULL) AS was_merged
 *   FROM patron_cards c
 *   JOIN patrons p ON p.id = c.patron_id
 *   LEFT JOIN patrons s ON s.id = p.merged_into_id
 *  WHERE c.barcode_norm = $1
 * ```
 *
 * Measured on 200,000 patrons: a fixed `Nested Loop Left Join` of two index
 * scans and an index-only scan, 12 buffers and 0.026 ms, INDEPENDENT OF DEPTH. A
 * recursive walk over a 10-deep chain is 48 buffers and 0.087 ms and grows
 * without bound — but the buffers are not the argument. On a chained record the
 * one-hop query returns the WRONG patron, and the recursive one returns the
 * right one. The reason this join is correct is that
 * `lbr2_patrons_merge_one_hop` makes a chain unreachable, so there is never a
 * second hop to take.
 *
 * `was_merged` travels back with the answer on purpose: the desk should be able
 * to say "this card belongs to a record that has been merged into another"
 * rather than silently substituting a patron.
 */
/**
 * One patron record as the wire carries it (2.0 phase 20b-ii).
 *
 * Spelled out rather than inferred from Prisma, because an inferred return type
 * naming a generated enum across a module boundary is TS2883 — "the inferred
 * type cannot be named without a reference to 'PatronStatus' from
 * .prisma/tenant-v2-client". The enums are therefore written as string unions,
 * which is also what an API consumer actually gets.
 */
export type PatronRecord = {
  id: string;
  patronNumber: string | null;
  fullName: string;
  sortName: string;
  status: 'active' | 'suspended' | 'closed';
  email: string | null;
  phone: string | null;
  dateOfBirth: Date | null;
  photoAssetRef: string | null;
  patronCategoryId: string | null;
  homeBranchId: string | null;
  joinedAt: Date | null;
  expiresAt: Date | null;
  staffNotes: string | null;
  erasedAt: Date | null;
  archivedAt: Date | null;
  mergedIntoId: string | null;
  updatedAt: Date;
  /**
   * The tenant-defined fields, as stored (2.0 phase 20n).
   *
   * MIGRATED SINCE 19b AND UNREADABLE UNTIL NOW.
   * `prisma/upgrade/01-pre-catalog.sql` copies every 1.0 member's
   * `custom_fields` into this column, so for an upgraded library it holds real
   * data a librarian typed — and no route returned it, which made the cutover a
   * silent data loss rather than a deliberate one. The same shape as the book
   * cover 20k found, and worse for being full rather than empty.
   *
   * On the RECORD read only, never on the roster: it is a JSONB blob, and a
   * list that selects one pays a TOAST read per row for something no column
   * renders.
   *
   * Returned RAW. The definitions that give each key a label and a type come
   * from the customization controller, which is still on the 1.0 client — so a
   * screen can show what is stored but cannot yet say what it means. Naming that
   * limit is the point; the alternative was to leave the data invisible.
   */
  customFields: unknown;
  category: { id: string; code: string; name: string } | null;
  cards: readonly {
    id: string;
    barcode: string;
    status: string;
    issuedAt: Date;
    retiredAt: Date | null;
  }[];
};

@Injectable()
export class PatronsService {
  private readonly logger = new Logger(PatronsService.name);

  constructor(
    @Inject(TenantPrismaService) private readonly tenantPrisma: TenantPrismaService,
    @Inject(TenantAuditService) private readonly audit: TenantAuditService,
    @Inject(TenantClockService) private readonly clock: TenantClockService,
    @Inject(QuotaService) private readonly quota: QuotaService,
    @Inject(EffectivePlanService) private readonly plans: EffectivePlanService,
  ) {}

  // -------------------------------------------------------------------------
  // Enrolment
  // -------------------------------------------------------------------------

  /**
   * Enrol a person.
   *
   * THE NUMBER IS MINTED BEFORE THE TRANSACTION OPENS, and that is measured
   * rather than stylistic: minting inside a 5 ms transaction body is 23.7×
   * slower (187 ms against 7.9 ms) because the counter's row lock is then held
   * for the whole transaction and every enrolment in the library queues behind
   * the slowest one.
   */
  async create(
    tenant: TenantContext,
    actor: TenantActor,
    input: CreatePatronInput,
  ): Promise<{ id: string; patronNumber: string | null }> {
    const client = this.tenantPrisma.getClientV2(tenant);
    const now = this.clock.now();

    // THE YEAR IS THE LIBRARY'S, not the process's. `M-2026-000001` minted at
    // 01:00 on 1 January in Athens must not say 2025 because the pod is on UTC —
    // the number goes on a card and a librarian reads it back. `TenantContext`
    // carries no zone (the zone is per branch, which is the `circ-5` fix), so it
    // comes from the branch: the patron's own if they have one, otherwise the
    // library's first. One tiny indexed read on a path that is not hot.
    const timezone = await this.enrolmentTimezone(client, input.homeBranchId);
    const patronNumber =
      input.patronNumber ?? (await mintPatronNumber(client, this.clock.civil(now, timezone).year));

    const enforce = !isUnlimitedInt(await this.plans.getInt(tenant.id, 'max_members'));
    const created = await client
      .$transaction(
        async (tx) => {
          await setChangeActor(tx, changeActorOf(actor));
          // THE CEILING, inside the same transaction as the insert (2.0 phase
          // 20g). 1.0 enforces `max_members` on `MembersController.create`; the
          // 2.0 patron surface enforced nothing.
          //
          // The predicate is 1.0's, MAPPED rather than copied. 1.0 excluded
          // archived rows and rows whose status was `archived`; 2.0's
          // `PatronStatus` is `active | suspended | closed` and has no such
          // value, because archiving is `archived_at`. `closed` is the reader
          // who left the library, which is the state 1.0's archived status
          // stood for, so it is excluded too — and `erasedAt` with it: a reader
          // erased under Article 17 is a row the library is required to keep
          // and has no business being billed for.
          if (enforce) {
            await this.quota.enforceWithinTx(tx, {
              tenantId: tenant.id,
              featureKey: 'max_members',
              count: () =>
                tx.patron.count({
                  where: { archivedAt: null, erasedAt: null, status: { not: 'closed' } },
                }),
            });
          }
          const patron = await tx.patron.create({
            data: {
              patronNumber,
              fullName: input.fullName,
              sortName: foldGreek(input.sortName ?? input.fullName),
              searchText: searchTextFor({
                fullName: input.fullName,
                patronNumber,
                email: input.email ?? null,
                phone: input.phone ?? null,
              }),
              email: input.email ?? null,
              phone: input.phone ?? null,
              dateOfBirth: input.dateOfBirth ?? null,
              patronCategoryId: input.patronCategoryId ?? null,
              homeBranchId: input.homeBranchId ?? null,
              expiresAt: input.expiresAt ?? null,
              staffNotes: input.staffNotes ?? null,
              joinedAt: now,
              createdAt: now,
              updatedAt: now,
            },
            select: { id: true, patronNumber: true },
          });

          if (input.barcode !== undefined) {
            await tx.patronCard.create({
              data: {
                patronId: patron.id,
                barcode: input.barcode,
                barcodeNorm: normaliseBarcode(input.barcode),
                issuedAt: now,
                createdAt: now,
                updatedAt: now,
              },
            });
          }
          return patron;
        },
        { isolationLevel: 'ReadCommitted' },
      )
      .catch((err: unknown) => {
        throw duplicate(err) ?? err;
      });

    await this.audit.record(tenant, actor, {
      action: 'patron.created',
      targetType: 'patron',
      targetId: created.id,
    });
    return created;
  }

  /**
   * The zone a patron number's year is read in.
   *
   * Falls back to UTC rather than throwing, because a library that has not
   * created a branch yet must still be able to enrol somebody — and a number
   * whose year is off by one for a few hours on New Year's morning is a cosmetic
   * problem, whereas a refused enrolment is a person standing at a desk.
   */
  private async enrolmentTimezone(
    client: { branch: { findFirst: (a: never) => Promise<{ timezone: string } | null> } },
    homeBranchId: string | undefined,
  ): Promise<string> {
    const branch = await client.branch.findFirst({
      where: homeBranchId === undefined ? { archivedAt: null } : { id: homeBranchId },
      select: { timezone: true },
      orderBy: { sortOrder: 'asc' },
    } as never);
    return branch?.timezone ?? 'UTC';
  }

  // -------------------------------------------------------------------------
  // The roster
  // -------------------------------------------------------------------------

  /**
   * The patron roster — search, filter, page (2.0 phase 20a).
   *
   * ## THE THREE-CHARACTER SEARCH FLOOR IS NEW, and it is a behaviour CHANGE
   *
   * 1.0's `members.service.ts` writes `where.searchText = { contains:
   * normalizeText(opts.q) }` for any non-empty `q` and has no minimum length
   * anywhere in the call. So `Πα` today runs `search_text LIKE '%πα%'` across
   * the whole roster, and `patrons_search_trgm` is a GIN TRIGRAM index: a
   * pattern of fewer than three characters contains no trigram to seek with, so
   * the planner has nothing to use and falls to a sequential scan.
   * performance-12 measured that scan on the identical shape of query at 13,407
   * buffers against 7 for the indexed path. The roster is the worst place in the
   * product to leave it, because this is the list a librarian types INTO — one
   * keystroke, one request, at every desk in the library, while a reader waits.
   *
   * What a librarian sees change is that `Πα` now answers an EMPTY page carrying
   * `minQueryChars: 3` rather than a page of rows, and that is the right trade
   * in both directions. The scan is gone; and "keep typing" is a true sentence,
   * where 1.0's answer — everyone whose name, number, email or phone contains
   * those two characters, in sort-name order, which is no order at all for
   * relevance — looked like a result and was not one.
   *
   * The floor is not spelled out here on purpose. `classifySearchTerm` and
   * `SEARCH_MIN_CHARS` live in `@libriant/shared` because the endpoint and the
   * UI drifted once already: the pickers kept their own default of 1, so a
   * two-character term fired a request, got nothing back and rendered "No
   * matches." for a reader who is in the roster. The catalogue list calls the
   * same two functions, which is what keeps the two lists telling one story.
   *
   * ## Both sides of the search fold with the SAME function
   *
   * `patrons.search_text` is written through `foldGreek` (see `searchTextFor`
   * at the foot of this file) and the term is folded through `foldGreek` here.
   * That is why no SQL fold appears in this query: `libriant_fold_greek` is
   * installed by no migration, and wrapping the column in a function would
   * defeat `patrons_search_trgm` even if it were, because the GIN index is on
   * the column and not on a function of it. `'ΠΟΛΙΣ'.toLowerCase()` ends in
   * U+03C2 while a typist types U+03C3; one function on both sides is the whole
   * reason those are the same string by the time they meet.
   *
   * ## ARCHIVED IS OFF BY DEFAULT, and that is also how a merged record hides
   *
   * `archivedAt: null` is the default filter and it does two jobs at once. A
   * merge stamps `archived_at` on the loser in the same statement that sets
   * `merged_into_id` (`PatronMergeService.merge`), so a folded-away record
   * leaves the roster the moment it is folded — without a second predicate that
   * could disagree with the first. `mergedIntoId` rides on every row so that
   * `?includeArchived=1` can say "merged into …" instead of showing what looks
   * like a live duplicate of the person standing at the desk.
   *
   * ## The index this walks
   *
   * `patrons_sort_name_id_idx ON patrons (sort_name, id)`, ascending — which is
   * exactly the `orderBy` below and exactly the `direction` `keysetPredicate`
   * defaults to. The three have to agree: an ascending predicate under a
   * descending order returns the rows BEFORE the cursor, so "Load more" walks
   * backwards towards Α and the reader never reaches Ω, with no error anywhere.
   *
   * The tie tier matters more on this list than on any other in the product.
   * Greek rosters tie — same surname, same given name, different patron — and a
   * `sort_name >=` start key alone repeats those rows while a `>` alone drops
   * them. Either way the page still renders: one of the three Παπαδοπούλου
   * Μαρία silently missing from the roster, nothing logged, nobody told.
   * `keysetPredicate` emits both halves so no caller can ship one of them.
   */
  async list(tenant: TenantContext, opts: ListPatronsOptions = {}): Promise<PatronRosterPage> {
    const client = this.tenantPrisma.getClientV2(tenant);
    const limit = clampLimit(opts.limit);
    // ONE clock read for the whole page. `expired` below is derived from it,
    // and reading the clock per row could straddle midnight mid-page — two
    // readers with the same expiry date, one marked expired and one not, in one
    // screenful.
    const now = this.clock.now();

    const term = classifySearchTerm(opts.q, foldGreek);
    if (term.kind === 'short') {
      return { items: [], nextCursor: null, minQueryChars: term.minChars };
    }

    const where: Record<string, unknown> = {};
    if (!opts.includeArchived) where['archivedAt'] = null;
    if (opts.status !== undefined) where['status'] = opts.status;
    // `escapeLike` because Prisma renders `contains` as a LIKE and does NOT
    // escape the pattern metacharacters in it. Without this a reader who types
    // `%` is not searching for a per-cent sign, they are asking for a wildcard
    // that matches every patron in the library — and `%%%` is three characters,
    // so it clears the floor above and asks for that scan by the front door.
    if (term.kind === 'term') where['searchText'] = { contains: escapeLike(term.value) };

    const after = await this.decodeRosterCursor(client, opts.after);
    if (after) where['AND'] = keysetPredicate({ sortField: 'sortName', after });

    // EXPLICIT SELECT, and it stays explicit. Three columns on this table must
    // never reach a list page: `search_text` is the trigram haystack (name,
    // number, email and phone concatenated again), `custom_fields` is JSONB
    // whose size is the library's business, and `staff_notes` is a note written
    // ABOUT a reader for staff eyes — which a roster screen has no business
    // shipping to every client that can draw the list. A default `findMany`
    // takes all three on every row of every page.
    //
    // `patronCategoryId` and `homeBranchId` go out as ids rather than as joined
    // names because Prisma resolves a nested `select` as a SECOND statement,
    // not a join: naming them here would cost an extra query per page for two
    // tiny reference tables the roster screen already holds in order to draw
    // its own filter controls.
    const rows = await client.patron.findMany({
      where: where as never,
      orderBy: [{ sortName: 'asc' }, { id: 'asc' }],
      take: limit + 1,
      select: {
        id: true,
        sortName: true,
        patronNumber: true,
        fullName: true,
        status: true,
        email: true,
        phone: true,
        photoAssetRef: true,
        patronCategoryId: true,
        homeBranchId: true,
        expiresAt: true,
        joinedAt: true,
        mergedIntoId: true,
        erasedAt: true,
        archivedAt: true,
        updatedAt: true,
      },
    });

    return pageOf(
      rows,
      limit,
      (r) => ({
        id: r.id,
        patronNumber: r.patronNumber,
        fullName: r.fullName,
        status: r.status,
        email: r.email,
        phone: r.phone,
        photoAssetRef: r.photoAssetRef,
        patronCategoryId: r.patronCategoryId,
        homeBranchId: r.homeBranchId,
        expiresAt: r.expiresAt,
        // DERIVED, with the identical comparison the desk makes:
        // `CheckoutService` refuses a loan when
        // `expiresAt !== null && expiresAt <= at`. `PatronStatus` has no
        // `expired` member on purpose — "a status column that has to be swept
        // nightly to stay true is a column that is wrong every night until the
        // sweep runs" — so a list has to compute it, and computing it
        // DIFFERENTLY from the gate is how a roster says a card is fine on the
        // same morning the desk refuses it.
        expired: r.expiresAt !== null && r.expiresAt <= now,
        joinedAt: r.joinedAt,
        mergedIntoId: r.mergedIntoId,
        erasedAt: r.erasedAt,
        archivedAt: r.archivedAt,
        updatedAt: r.updatedAt,
      }),
      (r) => keysetCursorValues(r.sortName, r.id),
    );
  }

  /**
   * Turn an `?after=` token back into the two values {@link list} pages on.
   *
   * A bare patron id is accepted as well as a token we minted, for the reason
   * `decodeCursor` states: `?after=` WAS an id on every 1.0 list, and a
   * librarian who clicks "Load more" while a deploy swaps the format must not be
   * handed a 400 halfway down the roster. A cursor row that has since been
   * merged away or deleted resolves to `null`, which restarts them at page one —
   * the only honest answer, since the position it named no longer exists.
   */
  private async decodeRosterCursor(
    client: ReturnType<TenantPrismaService['getClientV2']>,
    after: string | undefined,
  ): Promise<KeysetBoundary | null> {
    if (after === undefined || after.length === 0) return null;
    const parts = readKeysetCursor(after);
    if (parts) return parts;
    const row = await client.patron.findUnique({
      where: { id: after },
      select: { sortName: true, id: true },
    });
    return row ? { sort: row.sortName, id: row.id } : null;
  }

  // -------------------------------------------------------------------------
  // Lookup
  // -------------------------------------------------------------------------

  /**
   * Resolve a scanned barcode to the patron who should be charged.
   *
   * One hop. See the class docblock for the measurement and for why one hop is
   * enough.
   */
  async resolveCard(tenant: TenantContext, barcode: string): Promise<CardResolution | null> {
    const client = this.tenantPrisma.getClientV2(tenant);
    const rows = await client.$queryRaw<CardRow[]>`
      SELECT c.id                             AS card_id,
             c.status::text                   AS card_status,
             (c.retired_at IS NOT NULL)       AS card_retired,
             p.id                             AS scanned_patron_id,
             COALESCE(s.id, p.id)             AS effective_patron_id,
             (s.id IS NOT NULL)               AS was_merged,
             COALESCE(s.full_name, p.full_name) AS full_name,
             COALESCE(s.patron_number, p.patron_number) AS patron_number,
             COALESCE(s.status, p.status)::text AS patron_status
        FROM patron_cards c
        JOIN patrons p ON p.id = c.patron_id
        LEFT JOIN patrons s ON s.id = p.merged_into_id
       WHERE c.barcode_norm = ${normaliseBarcode(barcode)}
       LIMIT 1`;
    const row = rows[0];
    if (row === undefined) return null;
    return {
      cardId: row.card_id,
      cardStatus: row.card_status,
      cardRetired: row.card_retired,
      scannedPatronId: row.scanned_patron_id,
      effectivePatronId: row.effective_patron_id,
      wasMerged: row.was_merged,
      fullName: row.full_name,
      patronNumber: row.patron_number,
      patronStatus: row.patron_status,
    };
  }

  /**
   * The desk's summary: who they are, what stops them, what they owe.
   *
   * THE BALANCE IS A SET OF ROWS, NEVER A SCALAR, and that is what §6's
   * "balances sum per currency" means. A patron with €774, £640 and $710 has
   * three balances; adding them gives 2,124 of nothing, and that number is the
   * bug the criterion exists to forbid. It is asserted as a negative in the
   * integration test.
   *
   * Phase 18 owns the ledger. Nothing writes `lbr2.fees` yet, so this returns an
   * empty array on every real library today — the SHAPE is what phase 14 owes,
   * and it is the shape phase 18 inherits.
   */
  /**
   * One patron, by id (2.0 phase 20b-ii).
   *
   * `lbr2` had no read-by-id at all — `patrons.controller.ts` said so outright —
   * and everything else in this phase needs one: the member detail screen, the
   * checkout form's prefill, the edit form, and the Article 15 bundle's own
   * existence check.
   *
   * NOT `deskSummary`, which is a different question. That one answers "what
   * stops this person borrowing right now" and carries live blocks, unread
   * staff messages and per-currency balances; it is the desk's view and it is
   * three queries. This is the record.
   *
   * `erasedAt` rides on the row deliberately. A screen that renders an erased
   * patron as an ordinary one with a blank name is how a librarian ends up
   * asking why the record looks broken.
   */
  async get(tenant: TenantContext, patronId: string): Promise<PatronRecord> {
    const client = this.tenantPrisma.getClientV2(tenant);
    const patron = await client.patron.findUnique({
      where: { id: patronId },
      select: {
        id: true,
        patronNumber: true,
        fullName: true,
        sortName: true,
        status: true,
        email: true,
        phone: true,
        dateOfBirth: true,
        photoAssetRef: true,
        patronCategoryId: true,
        homeBranchId: true,
        joinedAt: true,
        expiresAt: true,
        staffNotes: true,
        erasedAt: true,
        archivedAt: true,
        mergedIntoId: true,
        updatedAt: true,
        customFields: true,
        category: { select: { id: true, code: true, name: true } },
        cards: {
          where: { retiredAt: null },
          orderBy: { issuedAt: 'desc' },
          select: {
            id: true,
            barcode: true,
            status: true,
            issuedAt: true,
            retiredAt: true,
          },
        },
      },
    });
    if (patron === null) throw new NotFoundException(`No patron with id ${patronId}.`);
    return {
      ...patron,
      status: patron.status as PatronRecord['status'],
      cards: patron.cards.map((c) => ({ ...c, status: String(c.status) })),
    };
  }

  /**
   * Edit a patron record (2.0 phase 20b-ii).
   *
   * Every field optional and only the ones present are written, because a PATCH
   * that treated absent as null would blank a phone number every time somebody
   * corrected a spelling.
   *
   * `sortName` and `searchText` are RECOMPUTED whenever the name changes rather
   * than accepted from the caller. They are the roster's sort key and its search
   * column, both Greek-folded, and a client that computed them itself would fold
   * with whatever it had — which is precisely the defect phase 1 exists to fix.
   *
   * ## Addresses are NOT here, and that is a gap rather than a decision
   *
   * 1.0 carries `addressLine1/2`, `city`, `postalCode` and `country` as columns
   * on `members` and this method's 1.0 counterpart writes them. 2.0 moved them
   * to a `patron_addresses` table that NO route reads or writes, and
   * `deskSummary` does not include it either. Overdue notices that post a letter
   * need it. It needs its own CRUD and its own decisions — one address or
   * several, which is billing, which is postal — so it is named here as
   * outstanding rather than half-built into a patch method.
   */
  async update(
    tenant: TenantContext,
    patronId: string,
    input: {
      patronNumber?: string;
      fullName?: string;
      email?: string | null;
      phone?: string | null;
      dateOfBirth?: string | null;
      patronCategoryId?: string | null;
      homeBranchId?: string | null;
      expiresAt?: string | null;
      staffNotes?: string | null;
    },
  ): Promise<PatronRecord> {
    const client = this.tenantPrisma.getClientV2(tenant);
    // THE CONTRIBUTING FIELDS COME BACK WITH THE EXISTENCE CHECK, because the
    // haystack below is composed from the row as it will be AFTER this write,
    // and a PATCH carries only what changed.
    const existing = await client.patron.findUnique({
      where: { id: patronId },
      select: {
        id: true,
        erasedAt: true,
        fullName: true,
        sortName: true,
        patronNumber: true,
        email: true,
        phone: true,
      },
    });
    if (existing === null) throw new NotFoundException(`No patron with id ${patronId}.`);
    // An erased record is a tombstone. Editing it would put identifying data
    // back into a row somebody exercised Article 17 over.
    if (existing.erasedAt !== null) {
      throw new BadRequestException(
        'This patron was erased under Article 17 and cannot be edited.',
      );
    }

    const data: Record<string, unknown> = {};
    if (input.patronNumber !== undefined) data['patronNumber'] = input.patronNumber;
    if (input.email !== undefined) data['email'] = input.email;
    if (input.phone !== undefined) data['phone'] = input.phone;
    if (input.patronCategoryId !== undefined) data['patronCategoryId'] = input.patronCategoryId;
    if (input.homeBranchId !== undefined) data['homeBranchId'] = input.homeBranchId;
    if (input.staffNotes !== undefined) data['staffNotes'] = input.staffNotes;
    if (input.dateOfBirth !== undefined) {
      data['dateOfBirth'] = input.dateOfBirth === null ? null : new Date(input.dateOfBirth);
    }
    if (input.expiresAt !== undefined) {
      data['expiresAt'] = input.expiresAt === null ? null : new Date(input.expiresAt);
    }
    if (input.fullName !== undefined) {
      data['fullName'] = input.fullName;
      /**
       * A CURATED FILING NAME SURVIVES A RENAME; a derived one is recomputed.
       *
       * `create` accepts `sortName` and stores `foldGreek(sortName ?? fullName)`
       * — a Greek library files «Νίκος Καζαντζάκης» under «ΚΑΖΑΝΤΖΑΚΗΣ ΝΙΚΟΣ»,
       * and the roster is ordered by this column (`patrons_sort_name_id_idx`).
       * `UpdatePatronDto` does not accept it, so recomputing unconditionally
       * destroyed that choice on the first spelling correction, re-filed the
       * reader under the wrong letter, and left no way to put it back.
       *
       * Whether it was curated is DECIDABLE rather than guessed: a derived
       * `sort_name` is exactly `foldGreek(the previous full name)`. Anything
       * else was chosen by a librarian and is left alone.
       */
      const wasDerived = existing.sortName === foldGreek(existing.fullName);
      if (wasDerived) data['sortName'] = foldGreek(input.fullName);
    }

    /**
     * THE HAYSTACK, REBUILT FROM THE ROW AS IT WILL BE — not from the patch.
     *
     * Every one of the four contributing fields is independently patchable, and
     * `undefined` (absent) is distinguished from `null` (the librarian cleared
     * it), which is why this is a ternary per field and not `??`. Two defects
     * lived in the one line this replaces:
     *
     *   - a PATCH carrying `fullName` rewrote the haystack to the folded NAME
     *     ALONE, deleting the number, email and phone that `create` had put
     *     there — and the members editor sends `fullName` on every save, so the
     *     first correction to any field took the reader out of number, email
     *     and phone search for good;
     *   - a PATCH without `fullName` never rewrote it at all, so a new phone
     *     number was unsearchable and a CLEARED one stayed searchable.
     *
     * Recomputed on every update rather than only when a contributing field
     * changes: it is one fold over four short strings, and a conditional here
     * is the thing that rots. It also silently repairs a row damaged by the
     * defect above the next time anyone edits it.
     *
     * Last-writer-wins against a concurrent edit to the same patron, the same
     * as the scalar columns themselves — this method is not transactional and
     * 1.0's counterpart was not either. The outcome is a haystack matching one
     * of the two writes rather than a blend, and the next edit reconciles it.
     */
    if (Object.keys(data).length === 0) return this.get(tenant, patronId);

    data['searchText'] = searchTextFor({
      fullName: input.fullName ?? existing.fullName,
      patronNumber: input.patronNumber === undefined ? existing.patronNumber : input.patronNumber,
      email: input.email === undefined ? existing.email : input.email,
      phone: input.phone === undefined ? existing.phone : input.phone,
    });

    data['updatedAt'] = new Date();
    await client.patron.update({ where: { id: patronId }, data: data as never });
    return this.get(tenant, patronId);
  }

  /**
   * Suspend, reinstate, or close a patron.
   *
   * `closed` is 2.0's third value and 1.0 had no equivalent — 1.0 offered only
   * `active` and `suspended` and used `archivedAt` for everything else. It is
   * NOT archiving: a closed patron is one the library has ended the relationship
   * with and whose record it still keeps, which is a different fact from a row
   * hidden from the roster.
   */
  async setStatus(
    tenant: TenantContext,
    patronId: string,
    status: 'active' | 'suspended' | 'closed',
  ): Promise<PatronRecord> {
    const client = this.tenantPrisma.getClientV2(tenant);
    const existing = await client.patron.findUnique({
      where: { id: patronId },
      select: { id: true, archivedAt: true, erasedAt: true },
    });
    if (existing === null) throw new NotFoundException(`No patron with id ${patronId}.`);
    if (existing.erasedAt !== null) {
      throw new BadRequestException('This patron was erased under Article 17.');
    }
    if (existing.archivedAt !== null) {
      throw new BadRequestException(
        'This patron is archived. Restore them before changing their status.',
      );
    }
    await client.patron.update({
      where: { id: patronId },
      data: { status, updatedAt: new Date() },
    });
    return this.get(tenant, patronId);
  }

  /**
   * Archive a patron, refusing while they still have open business.
   *
   * ## The invariant, and why it needs a lock
   *
   * An archived patron holding an active loan is a record nobody can act on: the
   * roster hides them, so the copy they have is out with someone the desk cannot
   * find. 1.0 does the open-business check and the archive write in ONE
   * transaction under a member-scoped advisory lock, for the stated reason that
   * otherwise a checkout can land between the check and the write.
   *
   * 2.0 keeps that and takes the lock through `platform/locks.ts`, which ranks
   * domains `patron < bib < item` and is what the checkout path takes first —
   * so the two serialize against each other by construction rather than by two
   * services happening to agree on a key format.
   *
   * "Open business" is wider than 1.0's, because 2.0 has holds: an open loan, a
   * live hold, or an unpaid fee. `owed_cents`, not `outstanding_cents` — phase
   * 18's distinction, where a cancelled charge closes without its settlement
   * counters moving, so the second stays positive on a debt nobody owes.
   */
  async archive(tenant: TenantContext, patronId: string): Promise<PatronRecord> {
    const client = this.tenantPrisma.getClientV2(tenant);
    await client.$transaction(async (tx) => {
      await acquireLocks(tx as never, [lockKey('patron', patronId)]);
      const existing = await tx.patron.findUnique({
        where: { id: patronId },
        select: { id: true, archivedAt: true, erasedAt: true },
      });
      if (existing === null) throw new NotFoundException(`No patron with id ${patronId}.`);
      if (existing.erasedAt !== null) {
        throw new BadRequestException('This patron was erased under Article 17.');
      }
      if (existing.archivedAt !== null) return;

      const open = await tx.$queryRaw<{ loans: bigint; holds: bigint; owed: bigint }[]>`
        SELECT (SELECT pg_catalog.count(*) FROM loans
                 WHERE patron_id = ${patronId} AND closed_at IS NULL) AS loans,
               (SELECT pg_catalog.count(*) FROM holds
                 WHERE patron_id = ${patronId}
                   AND fulfilled_at IS NULL AND cancelled_at IS NULL AND expired_at IS NULL) AS holds,
               -- coalesce is BARE on purpose: it is one of the constructs
               -- Postgres refuses to schema-qualify (with NULLIF, GREATEST,
               -- LEAST, CASE and the FROM-form of EXTRACT/SUBSTRING), and
               -- pg_catalog.coalesce(...) is a hard 42883.
               (SELECT coalesce(pg_catalog.sum(owed_cents), 0) FROM fees
                 WHERE patron_id = ${patronId} AND owed_cents > 0) AS owed`;
      const row = open[0];
      if (row !== undefined && (row.loans > 0n || row.holds > 0n || row.owed > 0n)) {
        throw new ConflictException({
          statusCode: 409,
          error: 'Conflict',
          code: 'patron.hasOpenBusiness',
          openLoans: Number(row.loans),
          openHolds: Number(row.holds),
          owedCents: String(row.owed),
          message:
            'This patron still has open business — ' +
            `${row.loans} loan(s), ${row.holds} hold(s), ${row.owed} owed. ` +
            'Archiving them would hide a record the desk still needs to act on.',
        });
      }
      await tx.patron.update({
        where: { id: patronId },
        data: { archivedAt: new Date(), updatedAt: new Date() },
      });
    });
    return this.get(tenant, patronId);
  }

  /** Put an archived patron back on the roster. */
  async restore(tenant: TenantContext, patronId: string): Promise<PatronRecord> {
    const client = this.tenantPrisma.getClientV2(tenant);
    const existing = await client.patron.findUnique({
      where: { id: patronId },
      select: { id: true, erasedAt: true },
    });
    if (existing === null) throw new NotFoundException(`No patron with id ${patronId}.`);
    if (existing.erasedAt !== null) {
      throw new BadRequestException('This patron was erased under Article 17.');
    }
    await client.patron.update({
      where: { id: patronId },
      data: { archivedAt: null, updatedAt: new Date() },
    });
    return this.get(tenant, patronId);
  }

  async deskSummary(tenant: TenantContext, patronId: string): Promise<DeskSummary> {
    const client = this.tenantPrisma.getClientV2(tenant);
    const patron = await client.patron.findUnique({
      where: { id: patronId },
      include: {
        category: { select: { id: true, code: true, name: true } },
        cards: { where: { retiredAt: null }, orderBy: { issuedAt: 'desc' } },
        blocks: { where: { clearedAt: null }, orderBy: { placedAt: 'desc' } },
        messages: { where: { acknowledgedAt: null, audience: 'staff' } },
      },
    });
    if (patron === null) throw new NotFoundException(`No patron with id ${patronId}.`);

    const balances = await client.$queryRaw<{ currency: string; outstanding: bigint }[]>`
      -- owed_cents, NOT outstanding_cents (2.0 phase 18). The two differ for
      -- exactly one row: a CANCELLED charge is closed without its settlement
      -- counters moving, so outstanding_cents stays positive on a debt nobody
      -- owes. This query and circulation-state.ts's checkout gate used to filter
      -- differently -- outstanding_cents > 0 here, closed_at IS NULL there --
      -- and agreed only because nothing wrote fees yet. From the first void they
      -- would have shown a patron two different balances at one desk.
      SELECT currency, pg_catalog.sum(owed_cents)::bigint AS outstanding
        FROM fees
       WHERE patron_id = ${patronId} AND owed_cents > 0
       GROUP BY currency
       ORDER BY currency`;

    return {
      patron,
      balances: balances.map((b) => ({
        currency: b.currency,
        outstandingCents: Number(b.outstanding),
      })),
    };
  }

  // -------------------------------------------------------------------------
  // Cards
  // -------------------------------------------------------------------------

  /**
   * Retire a card and, optionally, issue its replacement.
   *
   * The retired barcode keeps resolving. That is the whole reason cards are a
   * table: a found card should be recognised as the one that was reported lost
   * on the 3rd, not rejected as an unknown number.
   */
  async replaceCard(
    tenant: TenantContext,
    actor: TenantActor,
    input: { cardId: string; reason: string; newBarcode?: string },
  ): Promise<{ retiredCardId: string; newCardId: string | null }> {
    const client = this.tenantPrisma.getClientV2(tenant);
    const now = this.clock.now();
    const card = await client.patronCard.findUnique({
      where: { id: input.cardId },
      select: { id: true, patronId: true, retiredAt: true },
    });
    if (card === null) throw new NotFoundException(`No card with id ${input.cardId}.`);
    if (card.retiredAt !== null) {
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        code: 'patron.cardAlreadyRetired',
        message: 'That card was already retired. Nothing was changed.',
      });
    }

    const out = await client
      .$transaction(
        async (tx) => {
          await acquireLocks(tx, [lockKey('patron', card.patronId)]);
          await setChangeActor(tx, changeActorOf(actor));
          await tx.patronCard.update({
            where: { id: input.cardId },
            data: {
              status: 'replaced',
              retiredAt: now,
              retiredReason: input.reason,
              updatedAt: now,
            },
          });
          if (input.newBarcode === undefined) {
            return { retiredCardId: input.cardId, newCardId: null };
          }
          const fresh = await tx.patronCard.create({
            data: {
              patronId: card.patronId,
              barcode: input.newBarcode,
              barcodeNorm: normaliseBarcode(input.newBarcode),
              issuedAt: now,
              createdAt: now,
              updatedAt: now,
            },
            select: { id: true },
          });
          return { retiredCardId: input.cardId, newCardId: fresh.id };
        },
        { isolationLevel: 'ReadCommitted' },
      )
      .catch((err: unknown) => {
        throw duplicate(err) ?? err;
      });

    await this.audit.record(tenant, actor, {
      action: 'patron.card.replaced',
      targetType: 'patron',
      targetId: card.patronId,
      after: out as never,
    });
    return out;
  }
}

// ---------------------------------------------------------------------------

export type CreatePatronInput = {
  fullName: string;
  sortName?: string;
  patronNumber?: string;
  barcode?: string;
  email?: string;
  phone?: string;
  dateOfBirth?: Date;
  patronCategoryId?: string;
  homeBranchId?: string;
  expiresAt?: Date;
  staffNotes?: string;
};

/** What the roster accepts. Validated by `ListPatronsQueryDto`. */
export type ListPatronsOptions = {
  readonly q?: string;
  readonly status?: PatronRosterStatus;
  readonly after?: string;
  readonly limit?: number;
  /** Archived rows — which includes every merged-away and erased record. */
  readonly includeArchived?: boolean;
};

/**
 * One row of the roster.
 *
 * `id` is a literal `string` because `DataTable` is `T extends { id: string }`
 * and uses it as the React key; a row without one renders as a list that
 * reorders itself on every re-render.
 *
 * There is no balance and no loan count here, and their absence is a decision
 * rather than an omission. `deskSummary` answers those for ONE patron, per
 * currency, out of `lbr2.fees` — and a roster that answered them for
 * twenty-five would be twenty-five aggregates over the ledger to draw one
 * screen, or one aggregate summed across currencies, which §6 names as the bug
 * the per-currency shape exists to forbid.
 */
export type PatronRosterRow = {
  readonly id: string;
  readonly patronNumber: string | null;
  readonly fullName: string;
  readonly status: PatronRosterStatus;
  readonly email: string | null;
  readonly phone: string | null;
  readonly photoAssetRef: string | null;
  readonly patronCategoryId: string | null;
  readonly homeBranchId: string | null;
  readonly expiresAt: Date | null;
  /** `expiresAt` against the instant this page was built. See {@link PatronsService.list}. */
  readonly expired: boolean;
  readonly joinedAt: Date;
  /** Non-null on a record folded into another. Only visible with `includeArchived`. */
  readonly mergedIntoId: string | null;
  /** Non-null once GDPR Art. 17 has overwritten the identifiers above. */
  readonly erasedAt: Date | null;
  readonly archivedAt: Date | null;
  readonly updatedAt: Date;
};

export type PatronRosterPage = ListResult<PatronRosterRow>;

export type CardResolution = {
  cardId: string;
  cardStatus: string;
  cardRetired: boolean;
  /** The patron the card is filed under. */
  scannedPatronId: string;
  /** The patron to charge. Differs from the above exactly when `wasMerged`. */
  effectivePatronId: string;
  wasMerged: boolean;
  fullName: string;
  patronNumber: string | null;
  patronStatus: string;
};

export type DeskSummary = {
  patron: unknown;
  /** One row per currency. Never summed across currencies. */
  balances: { currency: string; outstandingCents: number }[];
};

type CardRow = {
  card_id: string;
  card_status: string;
  card_retired: boolean;
  scanned_patron_id: string;
  effective_patron_id: string;
  was_merged: boolean;
  full_name: string;
  patron_number: string | null;
  patron_status: string;
};

/**
 * A scanner adds things. Strip them, upper-case, and that is the key.
 *
 * UPPER-CASING IS LOAD-BEARING and not cosmetic: `patron_cards_barcode_idx` and
 * the shape CHECK both assume it, and — measured — `text_pattern_ops` REFUSES a
 * non-deterministic (case-insensitive) collation outright, as does `LIKE`. A
 * case-insensitive barcode is not merely slower here, it is unimplementable with
 * the index the desk scan depends on.
 */
export function normaliseBarcode(raw: string): string {
  return raw.trim().replace(/\s+/g, '').toUpperCase();
}

/**
 * THE HAYSTACK `GET /t/:slug/patrons?q=` matches, and the ONE place that knows
 * the recipe.
 *
 * Takes the four RESOLVED values rather than a create input, so that `update()`
 * composes it from the row as it will be AFTER the write rather than from the
 * fields the caller happened to send. That is the whole defect this signature
 * exists to make unrepresentable: while this took a `CreatePatronInput`, the
 * update path could not call it, hand-rolled `foldGreek(fullName)` instead, and
 * silently deleted the number, the email and the phone from the haystack on
 * every save.
 *
 * Empty parts are dropped rather than joined as blanks — two adjacent spaces
 * would make `contains` fail on a term that spans the gap.
 */
function searchTextFor(parts: {
  fullName: string;
  patronNumber: string | null;
  email: string | null;
  phone: string | null;
}): string {
  return foldGreek(
    [parts.fullName, parts.patronNumber ?? '', parts.email ?? '', parts.phone ?? '']
      .filter((p) => p.length > 0)
      .join(' '),
  );
}

/** A duplicate barcode or patron number → a 409 naming which. */
function duplicate(err: unknown): ConflictException | null {
  const e = err as { code?: string; meta?: unknown; message?: string };
  if (e?.code !== 'P2002') return null;
  // The WHOLE stringified meta plus the message: Prisma 7 with a driver adapter
  // leaves `meta.target` undefined and reports the constraint at
  // `meta.driverAdapterError.cause.constraint.fields`.
  const evidence = `${JSON.stringify(e.meta ?? '')} ${e.message ?? ''}`;
  if (evidence.includes('barcode')) {
    return new ConflictException({
      statusCode: 409,
      error: 'Conflict',
      code: 'patron.duplicateBarcode',
      message:
        'Another live card in this library already carries that barcode. Retire the old card ' +
        'first — a barcode that resolves to two people is a loan charged to the wrong one.',
    });
  }
  if (evidence.includes('patron_number') || evidence.includes('patrons_number')) {
    return new ConflictException({
      statusCode: 409,
      error: 'Conflict',
      code: 'patron.duplicateNumber',
      message: 'Another patron in this library already has that number.',
    });
  }
  return null;
}
