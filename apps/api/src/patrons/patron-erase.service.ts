import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { controlDb } from '@libriant/db-control';
import { TenantPrismaService } from '../tenancy/tenant-prisma.service.js';
import type { TenantContext } from '../tenancy/tenant-context.js';
import type { TenantActor } from '../tenancy/tenant-actor.js';
import { PATRON_DATA_TABLES } from './patron-data-map.js';

/**
 * GDPR Article 17 — erasure, over the 2.0 schema (2.0 phase 20b-ii).
 *
 * ## What "anonymise" has to mean here, which the map does not say
 *
 * `patron-data-map.ts` gives five tables the verdict `anonymise`: `patrons`,
 * `loans`, `fees`, `patron_accounts`, `holds`. The obvious reading — null the
 * patron link — is only possible for ONE of them. Measured:
 *
 *     loans.patron_id            NULLABLE
 *     fees.patron_id             NOT NULL
 *     holds.patron_id            NOT NULL
 *     patron_accounts.patron_id  NOT NULL
 *
 * `loans` is nullable on purpose: §3 makes reading history anonymised on return
 * by default, and that path already nulls the column and stamps
 * `anonymised_at`. An erase does the same thing to whatever is left.
 *
 * The other three cannot be nulled and MUST NOT BE DELETED. A fee is a line in
 * a library's accounts; deleting it to satisfy an erasure would corrupt a
 * double-entry ledger that has to balance, and Article 17(3)(b) and (e) are
 * exactly the carve-outs for that. So for those three the anonymisation happens
 * ON THE PATRON ROW: the row survives so the foreign keys hold and the ledger
 * still balances, and every field that identifies a person is redacted in
 * place. A fee pointing at an unidentifiable row is no longer personal data,
 * which is the outcome Article 17 asks for and the one a librarian can explain.
 *
 * `full_name`, `sort_name` and `search_text` are NOT NULL, so they take a
 * tombstone string rather than a null — and the tombstone is deliberately not a
 * blank, because a blank sorts to the head of every roster in the library.
 *
 * ## The order is load-bearing
 *
 * The control-plane outbox is purged FIRST. It holds no patron id — the address
 * is the only handle — and step 3 erases the address, so anything not deleted
 * before then can never be found again. A pending notice to someone who has
 * just asked to be forgotten must not go out.
 *
 * Carried over from the 1.0 erase verbatim, including the reason.
 *
 * ## Driven from the map
 *
 * The delete list is `PATRON_DATA_TABLES` filtered on `onErase`, not a hand
 * list — the same property the bundle relies on. A table added to `lbr2` with a
 * patron column has to be given a verdict, and the verdict decides what an
 * erase does to it. Nobody has to remember twice.
 */
@Injectable()
export class PatronEraseService {
  constructor(@Inject(TenantPrismaService) private readonly tenantPrisma: TenantPrismaService) {}

  async erase(
    tenant: TenantContext,
    actor: TenantActor,
    patronId: string,
    reason: string,
  ): Promise<{ erasedAt: Date; tablesCleared: number; loansAnonymised: number }> {
    const client = this.tenantPrisma.getClientV2(tenant);

    const existing = await client.patron.findUnique({
      where: { id: patronId },
      select: { id: true, email: true, erasedAt: true },
    });
    if (existing === null) throw new NotFoundException(`No patron with id ${patronId}.`);
    if (existing.erasedAt !== null) {
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        code: 'patron.alreadyErased',
        message: `This patron was erased on ${existing.erasedAt.toISOString()}. An erasure is not repeatable.`,
      });
    }

    // 1. CONTROL PLANE FIRST. See the docblock: the address is the only handle
    //    on these rows and step 3 destroys it.
    if (existing.email !== null) {
      await controlDb.emailOutbox.deleteMany({ where: { toEmail: existing.email } });
    }

    const deleteTables = PATRON_DATA_TABLES.filter(
      (t) => t.onErase === 'delete' && t.verdict !== 'pending',
    );

    const now = new Date();
    const loansAnonymised = await client.$transaction(async (tx) => {
      // 2. The satellite tables that exist only to describe a person.
      for (const t of deleteTables) {
        await tx.$executeRawUnsafe(`DELETE FROM ${t.table} WHERE ${t.patronColumn} = $1`, patronId);
      }

      // 3. Loans: the one link that CAN be broken, broken the same way the
      //    on-return anonymisation breaks it, so a reading history erased by
      //    request and one erased by policy are indistinguishable afterwards.
      //    The statistical buckets (`patron_category_code`, `patron_age_band`,
      //    `patron_home_branch_id`) are deliberately left: they are what makes
      //    the annual ISO 2789 return survive, and none of them identifies
      //    anyone.
      const loans = await tx.$executeRawUnsafe(
        `UPDATE loans SET patron_id = NULL, anonymised_at = $2
          WHERE patron_id = $1 AND patron_id IS NOT NULL`,
        patronId,
        now,
      );

      // 4. The person, redacted in place. The row stays so `fees`,
      //    `patron_accounts` and `holds` keep their NOT NULL references and the
      //    ledger still balances.
      await tx.$executeRawUnsafe(
        `UPDATE patrons
            SET full_name = $2, sort_name = $2, search_text = $2,
                email = NULL, phone = NULL, date_of_birth = NULL,
                photo_asset_ref = NULL, staff_notes = NULL,
                erased_at = $3, updated_at = $3
          WHERE id = $1`,
        patronId,
        ERASED_TOMBSTONE,
        now,
      );
      // 5. THE PROOF, written INSIDE the transaction.
      //
      // Article 17 does not require forgetting that a request was made and
      // honoured — a library asked to demonstrate compliance has nothing else to
      // show. So the audit row is part of the erasure rather than a follow-up:
      // an erase that committed and then failed to audit would be an erasure
      // nobody could prove, which is the one outcome worse than not doing it.
      //
      // Written straight into `lbr2.audit_log` rather than through
      // `TenantAuditService`, which opens the 1.0 client — a 2.0 service
      // auditing into the schema phase 20b-iii archives would put the compliance
      // record in the table that goes away. Note the column names: the 2.0 log
      // is `entity_kind`/`entity_id`, not `target_type`/`target_id`.
      await tx.$executeRawUnsafe(
        `INSERT INTO audit_log
           (id, occurred_at, actor_kind, actor_id, action, entity_kind, entity_id, summary, detail)
         VALUES (pg_catalog.gen_random_uuid()::text, $1, 'user', $2, 'patron.erase',
                 'patron', $3, $4, $5::jsonb)`,
        now,
        actor.actorId,
        patronId,
        `erased under Article 17: ${reason}`,
        JSON.stringify({ reason, tablesCleared: deleteTables.length, loansAnonymised: loans }),
      );
      return loans;
    });

    return { erasedAt: now, tablesCleared: deleteTables.length, loansAnonymised };
  }
}

/**
 * What replaces a name that has been erased.
 *
 * NOT a blank: `sort_name` is the roster's leading sort key and an empty string
 * files every erased patron at the head of the list, above every real reader.
 * NOT a random token either — a librarian looking at a fee needs to understand
 * why it has no name attached, and a row saying so is the humane answer.
 */
export const ERASED_TOMBSTONE = '[erased]';
