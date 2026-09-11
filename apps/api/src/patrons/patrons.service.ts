import { ConflictException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { foldGreek } from '@libriant/shared/greek';
import { changeActorOf, setChangeActor } from '../tenancy/tenant-actor-guc.js';
import type { TenantActor } from '../tenancy/tenant-actor.js';
import type { TenantContext } from '../tenancy/tenant-context.js';
import { TenantAuditService } from '../tenancy/tenant-audit.service.js';
import { TenantPrismaService } from '../tenancy/tenant-prisma.service.js';
import { acquireLocks, lockKey } from '../platform/locks.js';
import { TenantClockService } from '../policy/tenant-clock.service.js';
import { mintPatronNumber } from './patron-numbers.js';

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
@Injectable()
export class PatronsService {
  private readonly logger = new Logger(PatronsService.name);

  constructor(
    @Inject(TenantPrismaService) private readonly tenantPrisma: TenantPrismaService,
    @Inject(TenantAuditService) private readonly audit: TenantAuditService,
    @Inject(TenantClockService) private readonly clock: TenantClockService,
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

    const created = await client
      .$transaction(
        async (tx) => {
          await setChangeActor(tx, changeActorOf(actor));
          const patron = await tx.patron.create({
            data: {
              patronNumber,
              fullName: input.fullName,
              sortName: foldGreek(input.sortName ?? input.fullName),
              searchText: searchTextFor(input, patronNumber),
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
        FROM lbr2.patron_cards c
        JOIN lbr2.patrons p ON p.id = c.patron_id
        LEFT JOIN lbr2.patrons s ON s.id = p.merged_into_id
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
        FROM lbr2.fees
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

function searchTextFor(input: CreatePatronInput, patronNumber: string | null): string {
  return foldGreek(
    [input.fullName, patronNumber ?? '', input.email ?? '', input.phone ?? '']
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
