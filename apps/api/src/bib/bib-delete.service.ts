import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { TenantPrismaService } from '../tenancy/tenant-prisma.service.js';
import type { TenantContext } from '../tenancy/tenant-context.js';
import type { TenantActor } from '../tenancy/tenant-actor.js';

/**
 * Delete and restore a catalogue record (2.0 phase 20b-ii).
 *
 * ## `lbr2` had no way to remove a record at all
 *
 * `marc_records.deleted_at` and the `deleted` and `suppressed` values of
 * `marc_record_status` have existed since the phase-9 baseline, and every
 * reference to them in `apps/api/src/bib` is a READ. `BibController` has no
 * `@Delete`. A cataloguer who imported a file twice could not remove the
 * duplicate.
 *
 * ## It is a TOMBSTONE, not a row that goes away
 *
 * §5 commits to OAI-PMH `deletedRecord=persistent`, and the matrix says in as
 * many words that this "is a promise about the database". A harvester that saw
 * a record last month must be told it was deleted, which is impossible if the
 * row is gone. So the record, its contents, and its whole version history stay;
 * `deleted_at` is stamped and the status becomes `deleted`.
 *
 * The MARC side follows: Leader/05 is `d` for a deleted record, and
 * `record_status_code` is derived from `status` rather than set independently —
 * §2's asymmetric write rule, where the leader is always emitted correct.
 *
 * ## THE PROJECTION ROW MUST GO, and that is an obligation this phase inherited
 *
 * `bib_records` is the discovery projection and it has no `deleted_at`. The
 * catalogue list added in 20a reads it directly, while `BibReadService.read`
 * filters `marc_records.deleted_at IS NULL`. If the projection row survived a
 * delete, the record would stay in the catalogue list for ever while opening it
 * returned 404 — the worst of both, and invisible to anyone not clicking.
 *
 * `bib-projection-verify.ts` records exactly this: `deleted_at IS NULL` is
 * excluded from the projection BY CONSTRUCTION, and "whichever phase first sets
 * `deleted_at` owes the matching `bib_records` write". This is that phase, and
 * this is that write.
 *
 * ## What it refuses
 *
 * A record with items. The copies would be orphaned — `items.bib_id` is NOT
 * NULL and the record is what gives a copy its title — so the answer is to
 * withdraw the copies first. A 409 naming the count, because the request is
 * well-formed and will succeed once the shelf is clear.
 */
export type BibDeleteOutcome = {
  readonly bibId: string;
  readonly deletedAt: Date;
  readonly projectionRemoved: boolean;
};

@Injectable()
export class BibDeleteService {
  constructor(@Inject(TenantPrismaService) private readonly tenantPrisma: TenantPrismaService) {}

  async delete(
    tenant: TenantContext,
    actor: TenantActor,
    recordId: string,
    reason: string,
  ): Promise<BibDeleteOutcome> {
    const client = this.tenantPrisma.getClientV2(tenant);
    const now = new Date();

    return client.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<
        { id: string; deleted_at: Date | null; current_version: number; items: bigint }[]
      >`
        SELECT r.id, r.deleted_at, r.current_version,
               (SELECT pg_catalog.count(*) FROM lbr2.items i
                 WHERE i.bib_id = r.id AND i.archived_at IS NULL) AS items
          FROM lbr2.marc_records r
         WHERE r.id = ${recordId}`;
      const row = rows[0];
      if (row === undefined) throw new NotFoundException(`No catalogue record ${recordId}.`);
      if (row.deleted_at !== null) {
        throw new ConflictException({
          statusCode: 409,
          error: 'Conflict',
          code: 'catalog.alreadyDeleted',
          message: `This record was deleted on ${row.deleted_at.toISOString()}.`,
        });
      }
      if (row.items > 0n) {
        throw new ConflictException({
          statusCode: 409,
          error: 'Conflict',
          code: 'catalog.hasItems',
          items: Number(row.items),
          message:
            `This record still has ${row.items} copy/copies. Deleting it would leave them with ` +
            'no title. Withdraw the copies first.',
        });
      }

      // The tombstone. `record_status_code` follows `status` — §2's rule that
      // the leader is always emitted correct rather than echoed from the source.
      await tx.$executeRaw`
        UPDATE lbr2.marc_records
           SET deleted_at = ${now}, status = 'deleted', record_status_code = 'd',
               updated_at = ${now}
         WHERE id = ${recordId}`;

      // The history keeps going. A deletion is a change like any other and the
      // version chain is append-only, so restoring is a copy rather than a
      // replay — and an auditor asking who removed a record has a row to read.
      await tx.$executeRaw`
        INSERT INTO lbr2.marc_record_versions
          (record_id, version, leader, content, content_hash, change_kind, changed_tags,
           actor_kind, actor_id, created_at)
        SELECT r.id, ${row.current_version + 1}, r.leader, c.content, r.content_hash,
               'delete', ARRAY[]::text[], 'user', ${actor.actorId}, ${now}
          FROM lbr2.marc_records r
          JOIN lbr2.marc_record_contents c ON c.record_id = r.id
         WHERE r.id = ${recordId}`;
      await tx.$executeRaw`
        UPDATE lbr2.marc_records SET current_version = ${row.current_version + 1}
         WHERE id = ${recordId}`;

      // The obligation. Identifiers and classifications cascade from it.
      const removed = await tx.$executeRaw`
        DELETE FROM lbr2.bib_records WHERE bib_id = ${recordId}`;

      await tx.$executeRaw`
        INSERT INTO lbr2.audit_log
          (id, occurred_at, actor_kind, actor_id, action, entity_kind, entity_id, summary, detail)
        VALUES (pg_catalog.gen_random_uuid()::text, ${now}, 'user', ${actor.actorId},
                'catalog.bib.delete', 'bib', ${recordId}, ${`deleted: ${reason}`},
                ${JSON.stringify({ reason })}::jsonb)`;

      return { bibId: recordId, deletedAt: now, projectionRemoved: removed > 0 };
    });
  }

  /**
   * Undo a deletion.
   *
   * The record comes back but the PROJECTION DOES NOT, here. Rebuilding it means
   * running the projector over the record, which is `BibProjectionService`'s
   * job and needs the parsed MARC — so a restore clears the tombstone and leaves
   * the record out of the catalogue list until the next projection pass, and
   * says so rather than pretending otherwise. `catalog-verify` is the nightly
   * job that notices a record with no projection row.
   */
  async restore(
    tenant: TenantContext,
    actor: TenantActor,
    recordId: string,
  ): Promise<{ bibId: string; status: string; projectionPending: boolean }> {
    const client = this.tenantPrisma.getClientV2(tenant);
    const now = new Date();
    const rows = await client.$queryRaw<{ deleted_at: Date | null }[]>`
      SELECT deleted_at FROM lbr2.marc_records WHERE id = ${recordId}`;
    const row = rows[0];
    if (row === undefined) throw new NotFoundException(`No catalogue record ${recordId}.`);
    if (row.deleted_at === null) {
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        code: 'catalog.notDeleted',
        message: 'This record is not deleted, so there is nothing to restore.',
      });
    }

    await client.$executeRaw`
      UPDATE lbr2.marc_records
         SET deleted_at = NULL, status = 'complete', record_status_code = 'c', updated_at = ${now}
       WHERE id = ${recordId}`;
    await client.$executeRaw`
      INSERT INTO lbr2.audit_log
        (id, occurred_at, actor_kind, actor_id, action, entity_kind, entity_id, summary)
      VALUES (pg_catalog.gen_random_uuid()::text, ${now}, 'user', ${actor.actorId},
              'catalog.bib.restore', 'bib', ${recordId}, 'restored from deleted')`;

    const projected = await client.$queryRaw<{ n: bigint }[]>`
      SELECT pg_catalog.count(*) AS n FROM lbr2.bib_records WHERE bib_id = ${recordId}`;
    return {
      bibId: recordId,
      status: 'complete',
      projectionPending: (projected[0]?.n ?? 0n) === 0n,
    };
  }
}
