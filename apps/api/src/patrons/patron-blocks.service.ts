import { ConflictException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { changeActorOf, setChangeActor } from '../tenancy/tenant-actor-guc.js';
import type { TenantActor } from '../tenancy/tenant-actor.js';
import type { TenantContext } from '../tenancy/tenant-context.js';
import { TenantAuditService } from '../tenancy/tenant-audit.service.js';
import { TenantPrismaService } from '../tenancy/tenant-prisma.service.js';
import type { TxV2 } from '../tenancy/tenant-tx-v2.js';
import { acquireLocks, lockKey } from '../platform/locks.js';

/**
 * The stored reasons a patron may not borrow, and the race that shapes them.
 *
 * ## Two vocabularies, and why both exist
 *
 * `packages/circ-policy`'s `BLOCK_CODE` is COMPUTED: `evaluateBlocks` derives
 * `TOO_MANY_LOANS` from the state and the policy every time it is asked, and
 * stores nothing. These are the STORED ones — a reason that outlives the
 * request, that a librarian sees on the patron's screen before the patron
 * reaches the desk, and that a nightly sweep maintains.
 *
 * Three codes appear in both lists (`too_many_overdues`, `fine_limit_exceeded`,
 * `card_expired`) and that is not duplication: the resolver still computes its
 * own answer at checkout, and the two agree because both read the same policy.
 * The stored copy is what makes the answer VISIBLE in advance. The rest —
 * `manual`, `address_unconfirmed`, `items_long_overdue`, `lost_card` — have no
 * computed equivalent at all.
 *
 * ## The recompute is an upsert, and §3 says why
 *
 * "so block recalculation is an `INSERT … ON CONFLICT DO UPDATE` and a sweep
 * racing a desk transaction settles in Postgres instead of aborting the
 * librarian's checkout — the DATA-1 lesson applied to blocks."
 *
 * Measured, 25 concurrent sweeps against one patron while a desk transaction
 * holds it, 20 iterations (so 20 desk transactions and 500 sweeps per row):
 *
 * ```
 *   desk lock     recompute form        desk    sweeps      loans  dupes
 *   advisory      ON CONFLICT           20/20   500/500        20      0
 *   advisory      DELETE-then-INSERT    20/20   272/500        20      0
 *   FOR UPDATE    DELETE-then-INSERT     0/20    20/500         0      0
 *   FOR UPDATE    ON CONFLICT (cold)     0/20   476/500         0      0
 *   FOR NO KEY U. ON CONFLICT           20/20   500/500        20      0
 * ```
 *
 * Two separate findings live in that table.
 *
 * **`DELETE`-then-`INSERT` loses a fifth of the sweeps to `23505`** even with no
 * desk lock at all, and churns the block's `id` on every pass, which breaks any
 * notice or audit row that referenced it. It never corrupts the data — the
 * partial unique index sees to that — but the index and the upsert are two
 * different guarantees, and §3's sentence conflates them: the INDEX makes
 * duplication impossible, the `ON CONFLICT` makes the librarian's transaction
 * survive.
 *
 * **The desk's `SELECT … FOR UPDATE` is itself the poison**, and this is the
 * finding worth carrying into every later phase. `patron_blocks.patron_id`
 * references `patrons`, so every genuine block INSERT runs the FK check, which
 * takes a `FOR KEY SHARE` tuple lock on the patron row. That lock and a desk
 * `FOR UPDATE` on the same row deadlock (`40P01`), and twenty librarians'
 * checkouts are destroyed — `loans_written = 0`. An advisory lock does not
 * participate in the FK row-lock graph at all, which is why `platform/locks.ts`
 * is the mechanism and a row lock is not. If a row lock on `patrons` is ever
 * genuinely wanted it must be `FOR NO KEY UPDATE`, which measured clean in every
 * form.
 *
 * ## ReadCommitted, pinned, with the number in the comment
 *
 * At REPEATABLE READ, `ON CONFLICT DO UPDATE` onto a concurrently-updated row
 * raises `40001` and the desk aborts 15/15. Every writer here pins
 * `ReadCommitted` explicitly rather than relying on the default, because the
 * default is a thing somebody can change.
 */
@Injectable()
export class PatronBlocksService {
  private readonly logger = new Logger(PatronBlocksService.name);

  constructor(
    @Inject(TenantPrismaService) private readonly tenantPrisma: TenantPrismaService,
    @Inject(TenantAuditService) private readonly audit: TenantAuditService,
  ) {}

  /**
   * Assert an automatic block, or refresh the one that is already there.
   *
   * Callable INSIDE a caller's transaction — the sweep and the desk both want
   * it, and the desk wants it in the same transaction as the checkout it is
   * about to refuse. That is why it takes a `TxV2` rather than opening its own.
   *
   * THE `ON CONFLICT` CLAUSE REPEATS THE INDEX PREDICATE WORD FOR WORD, and it
   * has to. Inference requires the clause to IMPLY the index's `WHERE`, and
   * Postgres reports every way of getting it wrong as the same unhelpful
   * `42P10 there is no unique or exclusion constraint matching the ON CONFLICT
   * specification` — verified against this table: dropping the `WHERE` is
   * 42P10, weakening it to `WHERE auto_generated` is 42P10, and
   * `ON CONFLICT ON CONSTRAINT patron_blocks_one_auto_per_code` is `42704`,
   * because a partial unique INDEX is not a CONSTRAINT and never can be named
   * that way.
   *
   * `DO UPDATE` rather than `DO NOTHING`, and not only because the observation
   * should be refreshed: `DO NOTHING` returns ZERO rows, so a `RETURNING id`
   * would come back empty and the caller's `rows[0]!.id` would throw. `DO
   * UPDATE` always returns exactly one row, which is asserted below.
   *
   * THE ID IS GENERATED SERVER-SIDE, and the obvious alternative is a bug. A
   * deterministic `pb_<patron>_<code>` reads well and would mean a re-asserted
   * block after a cleared one collides on the PRIMARY KEY — which the
   * `ON CONFLICT` above does NOT catch, because it infers the partial unique and
   * not the pkey, so the sweep would start failing with `23505` the first time a
   * block was lifted and came back. Prisma's `@default(cuid())` is client-side
   * and unavailable to a raw statement, so the generator is Postgres's.
   */
  async assertAutoBlock(
    tx: TxV2,
    input: {
      patronId: string;
      code: AutoBlockCode;
      reason?: string | null;
      severity?: 'block' | 'warn';
      observed?: Record<string, unknown>;
      now: Date;
    },
  ): Promise<{ id: string }> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO lbr2.patron_blocks
        (id, patron_id, code, reason, auto_generated, observed, severity, placed_at)
      VALUES (
        pg_catalog.gen_random_uuid()::text, ${input.patronId},
        ${input.code}::lbr2.patron_block_code, ${input.reason ?? null},
        true, ${JSON.stringify(input.observed ?? {})}::jsonb,
        ${input.severity ?? 'block'}, ${input.now})
      ON CONFLICT (patron_id, code) WHERE auto_generated AND cleared_at IS NULL
      DO UPDATE SET
        reason   = EXCLUDED.reason,
        observed = EXCLUDED.observed,
        severity = EXCLUDED.severity
      RETURNING id`;
    if (rows.length !== 1) {
      // Unreachable with DO UPDATE, and asserted because the failure mode of the
      // DO NOTHING form is a confident `undefined` two lines later.
      throw new Error(
        `The block upsert for patron ${input.patronId} returned ${rows.length} rows. ` +
          'It must return exactly one; a zero-row return means somebody changed DO UPDATE to ' +
          'DO NOTHING.',
      );
    }
    return { id: rows[0]!.id };
  }

  /**
   * Withdraw an automatic block that no longer applies.
   *
   * Sets `cleared_at` rather than deleting, so "why could this person not borrow
   * last Tuesday?" stays answerable — and so the partial unique lets the next
   * assertion insert a fresh row rather than resurrecting this one, which keeps
   * the history a history.
   */
  async clearAutoBlock(
    tx: TxV2,
    input: { patronId: string; code: AutoBlockCode; reason: string; now: Date },
  ): Promise<number> {
    const result = await tx.$executeRaw`
      UPDATE lbr2.patron_blocks
         SET cleared_at = ${input.now}, cleared_reason = ${input.reason}
       WHERE patron_id = ${input.patronId}
         AND code = ${input.code}::lbr2.patron_block_code
         AND auto_generated
         AND cleared_at IS NULL`;
    return result;
  }

  /** A librarian's own block. Never touched by a sweep. */
  async placeManualBlock(
    tenant: TenantContext,
    actor: TenantActor,
    input: { patronId: string; reason: string; severity?: 'block' | 'warn'; now: Date },
  ): Promise<{ id: string }> {
    if (input.reason.trim().length === 0) {
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        code: 'patron.blockNeedsReason',
        message:
          'A block needs a reason. It is what the next person at the desk reads to the patron, ' +
          'and what whoever reviews it later has to go on.',
      });
    }
    const client = this.tenantPrisma.getClientV2(tenant);
    const created = await client.$transaction(
      async (tx) => {
        // FIRST STATEMENT, before any read — `platform/locks.ts` measured that a
        // lock taken after the read gives exactly the protection of no lock.
        await acquireLocks(tx, [lockKey('patron', input.patronId)]);
        await setChangeActor(tx, changeActorOf(actor));
        await this.requirePatron(tx, input.patronId);
        return tx.patronBlock.create({
          data: {
            patronId: input.patronId,
            code: 'manual',
            reason: input.reason.trim(),
            severity: input.severity ?? 'block',
            autoGenerated: false,
            placedAt: input.now,
            placedByUserId: actor.userId,
          },
          select: { id: true },
        });
      },
      { isolationLevel: 'ReadCommitted' },
    );
    await this.audit.record(tenant, actor, {
      action: 'patron.block.placed',
      targetType: 'patron',
      targetId: input.patronId,
      after: { blockId: created.id, reason: input.reason },
    });
    return created;
  }

  /** Lift a block a librarian placed. Auto blocks are lifted by the sweep. */
  async clearBlock(
    tenant: TenantContext,
    actor: TenantActor,
    input: { blockId: string; reason: string; now: Date },
  ): Promise<void> {
    const client = this.tenantPrisma.getClientV2(tenant);
    const block = await client.patronBlock.findUnique({
      where: { id: input.blockId },
      select: { id: true, patronId: true, clearedAt: true },
    });
    if (block === null) throw new NotFoundException(`No block with id ${input.blockId}.`);
    if (block.clearedAt !== null) {
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        code: 'patron.blockAlreadyCleared',
        message: 'That block was already lifted. Nothing was changed.',
      });
    }

    await client.$transaction(
      async (tx) => {
        await acquireLocks(tx, [lockKey('patron', block.patronId)]);
        await setChangeActor(tx, changeActorOf(actor));
        await tx.patronBlock.update({
          where: { id: input.blockId },
          data: {
            clearedAt: input.now,
            clearedReason: input.reason,
            clearedByUserId: actor.userId,
          },
        });
      },
      { isolationLevel: 'ReadCommitted' },
    );
    await this.audit.record(tenant, actor, {
      action: 'patron.block.cleared',
      targetType: 'patron',
      targetId: block.patronId,
      after: { blockId: input.blockId, reason: input.reason },
    });
  }

  /**
   * Every live block on a patron, for the desk.
   *
   * The return type is written out rather than inferred, because the inferred
   * one names `JsonValue` and `PatronBlockCode` from inside the generated
   * client's directory and `tsc` refuses it as unportable (TS2883). Selecting
   * the columns explicitly also keeps `observed` — arbitrary JSON a sweep wrote
   * — out of a shape callers might start relying on.
   */
  async liveBlocks(tenant: TenantContext, patronId: string): Promise<LiveBlock[]> {
    const client = this.tenantPrisma.getClientV2(tenant);
    const rows = await client.patronBlock.findMany({
      where: { patronId, clearedAt: null },
      orderBy: [{ severity: 'asc' }, { placedAt: 'desc' }],
      select: {
        id: true,
        code: true,
        reason: true,
        severity: true,
        autoGenerated: true,
        observed: true,
        placedAt: true,
      },
    });
    return rows.map((r) => ({
      id: r.id,
      code: String(r.code),
      reason: r.reason,
      severity: r.severity,
      autoGenerated: r.autoGenerated,
      observed: r.observed as Record<string, unknown>,
      placedAt: r.placedAt,
    }));
  }

  private async requirePatron(tx: TxV2, patronId: string): Promise<void> {
    const patron = await tx.patron.findUnique({ where: { id: patronId }, select: { id: true } });
    if (patron === null) throw new NotFoundException(`No patron with id ${patronId}.`);
  }
}

/** One live block, in a shape that does not leak the generated client's types. */
export type LiveBlock = {
  id: string;
  code: string;
  reason: string | null;
  severity: string;
  autoGenerated: boolean;
  observed: Record<string, unknown>;
  placedAt: Date;
};

/** The stored codes a sweep may assert. `manual` is not one of them. */
export type AutoBlockCode =
  | 'too_many_overdues'
  | 'fine_limit_exceeded'
  | 'card_expired'
  | 'address_unconfirmed'
  | 'items_long_overdue'
  | 'lost_card';
