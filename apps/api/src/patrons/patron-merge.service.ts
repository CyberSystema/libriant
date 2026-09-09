import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { changeActorOf, setChangeActor } from '../tenancy/tenant-actor-guc.js';
import type { TenantActor } from '../tenancy/tenant-actor.js';
import type { TenantContext } from '../tenancy/tenant-context.js';
import { TenantAuditService } from '../tenancy/tenant-audit.service.js';
import { TenantPrismaService } from '../tenancy/tenant-prisma.service.js';
import type { TxV2 } from '../tenancy/tenant-tx-v2.js';
import { acquireLocks, lockKey } from '../platform/locks.js';

/**
 * Folding two records for the same person into one.
 *
 * §6 phase 14: "Merge is transactional under sorted `patron:` locks; an old card
 * barcode resolves through `merged_into_id` in **one hop**, never a chain."
 *
 * ## The trigger and the locks are two halves of one guarantee
 *
 * The database refuses a chain — `lbr2_patrons_merge_one_hop`, a deferred
 * constraint trigger with two clauses, because clause (a) ("my survivor must be
 * terminal") never fires on the transaction that CREATES the chain: when A is
 * merged into C it is A's row that changes, A's survivor C is terminal, and the
 * row that is now wrong is B, which nobody touched. Clause (b) catches B.
 *
 * That is not sufficient on its own, and this is the measurement that decides
 * the design. 60 concurrent pairs where T1 merges B into A while T2 merges A
 * into C:
 *
 * ```
 *   trigger only, no locks    59 of 60 chains formed
 *   trigger + sorted locks     0 of 60
 *   SERIALIZABLE               0 of 60, and a 40001 on one side of every pair
 * ```
 *
 * Each transaction's deferred check passes on a snapshot that cannot see the
 * other's uncommitted row. `SERIALIZABLE` also closes it and buys correctness
 * with a retry storm; sorted advisory locks close it for nothing.
 *
 * **Why the locks are sufficient**, which is worth stating because it is not
 * obvious: any two merges that could form a chain necessarily share the middle
 * patron — B→A and A→C both name A — so patron-keyed locks always serialise
 * them. There is no chain-forming pair the lock set misses.
 *
 * **Why they must be SORTED**: two operators merging the same pair in opposite
 * directions, 12 iterations each, measured —
 *
 * ```
 *   caller order   {40P01: 8, 23514: 4, committed: 12}
 *   orderLocks     {23514: 12, committed: 12}      ← zero deadlocks
 * ```
 *
 * Sorting converts a random `40P01` into a deterministic `23514` the librarian
 * can be shown: "these two records would form a merge cycle."
 *
 * ## What a chain actually costs, which is not what it looks like
 *
 * Measured on 200,000 patrons with a deliberately constructed 10-deep chain: the
 * one-hop lookup is a fixed 12 buffers and 0.026 ms whatever the depth, and on
 * the chained record it returns **the wrong patron** — `p00000102` where the
 * survivor is `p00000111`. A chain does not make the card scan slow. It makes it
 * silently wrong, and the desk then charges the loan to a record with no cards,
 * no blocks and a balance nobody sees. That is the argument for enforcing the
 * invariant on the write side rather than making every reader recursive.
 */
@Injectable()
export class PatronMergeService {
  private readonly logger = new Logger(PatronMergeService.name);

  constructor(
    @Inject(TenantPrismaService) private readonly tenantPrisma: TenantPrismaService,
    @Inject(TenantAuditService) private readonly audit: TenantAuditService,
  ) {}

  async merge(
    tenant: TenantContext,
    actor: TenantActor,
    input: { loserId: string; survivorId: string; reason?: string; now: Date },
  ): Promise<MergeResult> {
    if (input.loserId === input.survivorId) {
      throw new BadRequestException(
        'A record cannot be merged into itself. Pick the record to keep and the record to fold ' +
          'into it.',
      );
    }
    const client = this.tenantPrisma.getClientV2(tenant);

    const outcome = await client
      .$transaction(
        async (tx) => {
          // BOTH LOCKS, SORTED, FIRST. `orderLocks` inside `acquireLocks` dedupes
          // and sorts by domain rank and then by id — both of these are rank 1
          // (`patron`), so the id tiebreak IS the total order that stops two
          // operators deadlocking on the same pair in opposite directions.
          await acquireLocks(tx, [
            lockKey('patron', input.loserId),
            lockKey('patron', input.survivorId),
          ]);
          await setChangeActor(tx, changeActorOf(actor));

          const [loser, survivor] = await Promise.all([
            this.requirePatron(tx, input.loserId, 'loser'),
            this.requirePatron(tx, input.survivorId, 'survivor'),
          ]);

          // Re-read INSIDE the lock. A merge that resolved these ids before
          // taking the lock has protected nothing: another merge can commit in
          // between and this one proceeds against a record that is already
          // folded away.
          if (survivor.mergedIntoId !== null) {
            throw new ConflictException({
              statusCode: 409,
              error: 'Conflict',
              code: 'patron.survivorAlreadyMerged',
              message:
                'The record you chose to keep has itself been merged into another one. Merge into ' +
                `${survivor.mergedIntoId} instead — a survivor has to be the end of the line, or ` +
                'a scanned card resolves to a record with no history on it.',
            });
          }
          if (loser.mergedIntoId !== null) {
            throw new ConflictException({
              statusCode: 409,
              error: 'Conflict',
              code: 'patron.loserAlreadyMerged',
              message: `That record was already merged into ${loser.mergedIntoId}.`,
            });
          }

          const carried = await this.carrySatellites(
            tx,
            input.loserId,
            input.survivorId,
            input.now,
          );

          // The two statements the deferred trigger judges together, at COMMIT.
          // Order does not matter — measured both ways — which is the whole
          // point of the deferral.
          await tx.patron.update({
            where: { id: input.loserId },
            data: {
              mergedIntoId: input.survivorId,
              archivedAt: input.now,
              updatedAt: input.now,
            },
          });
          // RE-POINT EVERY ROW THAT POINTED AT THE LOSER. This is the statement
          // that keeps the invariant one hop deep, and leaving it out is what
          // 59 of 60 concurrent pairs did without the locks.
          await tx.$executeRaw`
            UPDATE lbr2.patrons
               SET merged_into_id = ${input.survivorId}, updated_at = ${input.now}
             WHERE merged_into_id = ${input.loserId}
               AND id <> ${input.survivorId}`;

          const record = await tx.patronMerge.create({
            data: {
              loserPatronId: input.loserId,
              survivorPatronId: input.survivorId,
              carried: carried.carried as never,
              collided: carried.collided as never,
              reason: input.reason ?? null,
              mergedAt: input.now,
              mergedByUserId: actor.userId,
            },
            select: { id: true },
          });

          return { mergeId: record.id, ...carried };
        },
        { isolationLevel: 'ReadCommitted' },
      )
      .catch((err: unknown) => {
        throw mergeChainToHttp(err) ?? err;
      });

    await this.audit.record(tenant, actor, {
      action: 'patron.merged',
      targetType: 'patron',
      targetId: input.survivorId,
      after: { loserId: input.loserId, ...outcome },
    });
    this.logger.log(
      `Merged patron ${input.loserId} into ${input.survivorId} for tenant ${tenant.id}.`,
    );
    return outcome;
  }

  /**
   * Move everything the loser owned onto the survivor.
   *
   * COLLISIONS ARE RESOLVED BEFORE THE MOVE, not after, and that ordering is the
   * one the 1.0 author dedup already established: `patron_cards` and
   * `patron_identifiers` both carry uniques, so re-pointing a duplicate barcode
   * or a second copy of the same ΑΦΜ trips the index and takes the whole merge
   * down. A colliding row is RETIRED rather than deleted and counted in
   * `collided`, so the librarian can see what happened rather than discovering a
   * card has silently stopped working.
   */
  private async carrySatellites(
    tx: TxV2,
    loserId: string,
    survivorId: string,
    now: Date,
  ): Promise<{ carried: Record<string, number>; collided: Record<string, number> }> {
    const carried: Record<string, number> = {};
    const collided: Record<string, number> = {};

    // CARDS CANNOT COLLIDE, and the first draft of this method spent eleven lines
    // making sure they could not. `patron_cards_barcode_unique_live` is
    // LIBRARY-WIDE and not per patron, so two live cards never share a barcode
    // in the first place — the state a merge would have to resolve is one the
    // index already makes unreachable. The test that tried to construct it
    // failed on the index, which is how this was found. Retired cards are
    // outside the predicate and so cannot collide either.
    //
    // Identifiers and primary addresses are the opposite case: their uniques are
    // scoped PER PATRON, so two records for one person legitimately hold the
    // same ΑΦΜ and two primary addresses — which is precisely what a duplicate
    // record is — and the merge has to resolve both before it re-points
    // anything, or the `UPDATE` trips the index and takes the whole merge down.
    carried.cards = await tx.$executeRaw`
      UPDATE lbr2.patron_cards SET patron_id = ${survivorId}, updated_at = ${now}
       WHERE patron_id = ${loserId}`;

    // Identifiers: unique on (patron, scheme, value), so a duplicate ΑΦΜ is a
    // collision. Deleted rather than retired — there is no `retired_at` and a
    // second identical identifier carries no information the survivor's does
    // not.
    collided.identifiers = await tx.$executeRaw`
      DELETE FROM lbr2.patron_identifiers l
       WHERE l.patron_id = ${loserId}
         AND EXISTS (SELECT 1 FROM lbr2.patron_identifiers s
                      WHERE s.patron_id = ${survivorId}
                        AND s.scheme = l.scheme
                        AND s.value_norm = l.value_norm)`;
    carried.identifiers = await tx.$executeRaw`
      UPDATE lbr2.patron_identifiers SET patron_id = ${survivorId} WHERE patron_id = ${loserId}`;

    // Addresses: only one may be primary, so the loser's demotes.
    collided.addresses = await tx.$executeRaw`
      UPDATE lbr2.patron_addresses SET is_primary = false, updated_at = ${now}
       WHERE patron_id = ${loserId} AND is_primary
         AND EXISTS (SELECT 1 FROM lbr2.patron_addresses s
                      WHERE s.patron_id = ${survivorId} AND s.is_primary)`;
    carried.addresses = await tx.$executeRaw`
      UPDATE lbr2.patron_addresses SET patron_id = ${survivorId}, updated_at = ${now}
       WHERE patron_id = ${loserId}`;

    carried.blocks = await tx.$executeRaw`
      UPDATE lbr2.patron_blocks SET patron_id = ${survivorId}
       WHERE patron_id = ${loserId}
         AND NOT EXISTS (SELECT 1 FROM lbr2.patron_blocks s
                          WHERE s.patron_id = ${survivorId} AND s.code = lbr2.patron_blocks.code
                            AND s.auto_generated AND s.cleared_at IS NULL)`;
    carried.messages = await tx.$executeRaw`
      UPDATE lbr2.patron_messages SET patron_id = ${survivorId} WHERE patron_id = ${loserId}`;
    carried.notes = await tx.$executeRaw`
      UPDATE lbr2.patron_notes SET patron_id = ${survivorId}, updated_at = ${now}
       WHERE patron_id = ${loserId}`;

    // Relationships: a row must not end up pointing at itself.
    collided.relationships = await tx.$executeRaw`
      DELETE FROM lbr2.patron_relationships
       WHERE (from_patron_id = ${loserId} AND to_patron_id = ${survivorId})
          OR (from_patron_id = ${survivorId} AND to_patron_id = ${loserId})`;
    carried.relationships = await tx.$executeRaw`
      UPDATE lbr2.patron_relationships SET from_patron_id = ${survivorId}, updated_at = ${now}
       WHERE from_patron_id = ${loserId}`;
    carried.relationships += await tx.$executeRaw`
      UPDATE lbr2.patron_relationships SET to_patron_id = ${survivorId}, updated_at = ${now}
       WHERE to_patron_id = ${loserId}`;

    carried.loans = await tx.$executeRaw`
      UPDATE lbr2.loans SET patron_id = ${survivorId}, updated_at = ${now}
       WHERE patron_id = ${loserId}`;

    // Fees carry NO foreign key to `patrons` until phase 9d, so nothing at the
    // database level catches a merge that forgets them: the money simply points
    // at a record nobody looks at and vanishes from the survivor's balance.
    // Until that FK exists, the integration test's `orphaned_money = 0`
    // assertion is the only thing standing in for it.
    carried.fees = await tx.$executeRaw`
      UPDATE lbr2.fees SET patron_id = ${survivorId} WHERE patron_id = ${loserId}`;

    return { carried, collided };
  }

  private async requirePatron(tx: TxV2, id: string, role: 'loser' | 'survivor') {
    const p = await tx.patron.findUnique({
      where: { id },
      select: { id: true, mergedIntoId: true, erasedAt: true },
    });
    if (p === null) throw new NotFoundException(`No patron with id ${id} (the ${role}).`);
    if (p.erasedAt !== null) {
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        code: 'patron.erasedCannotMerge',
        message:
          `Record ${id} has been erased under GDPR Article 17. Merging it would move a name and ` +
          'an address back onto a live record, which is the erasure being undone.',
      });
    }
    return p;
  }
}

export type MergeResult = {
  mergeId: string;
  carried: Record<string, number>;
  collided: Record<string, number>;
};

/**
 * The deferred trigger's `23514` → a 409 the librarian can read.
 *
 * It surfaces at COMMIT rather than at the statement, so in a Prisma interactive
 * transaction it comes out of `$transaction()` rather than out of the model
 * call. Matching on the message text is therefore the honest route: the
 * constraint name is not on the error object at that point, and the message is
 * the one the trigger raised.
 */
function mergeChainToHttp(err: unknown): ConflictException | null {
  const message = err instanceof Error ? err.message : String(err);
  if (!message.includes('merge chain:')) return null;
  return new ConflictException({
    statusCode: 409,
    error: 'Conflict',
    code: 'patron.mergeWouldChain',
    message:
      'That merge would leave one record pointing at another that is itself merged away. A card ' +
      'scanned against the first would then resolve to a record with no cards, no blocks and a ' +
      'balance nobody sees — so it is refused rather than repaired. Nothing was changed.',
    detail: message,
  });
}
