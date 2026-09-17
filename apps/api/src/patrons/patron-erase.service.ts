import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { controlDb } from '@libriant/db-control';
import { StorageService } from '../storage/storage.service.js';
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
 * string rather than a null. `full_name` and `sort_name` take the TOMBSTONE,
 * deliberately not a blank, because a blank sorts to the head of every roster in
 * the library. `search_text` takes the BLANK, and 20q had to separate the two:
 * that column is never sorted on — it is what `?q=` matches with `contains`, so
 * a tombstone in it turns "erased" into a query listing every reader who ever
 * exercised Article 17.
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
/**
 * What replaces an erased patron's payload inside a retained audit row. The
 * same shape 1.0's `members.service.ts` uses, so a row redacted before the
 * cutover and one redacted after look the same to whoever reads them.
 */
const AUDIT_REDACTION = JSON.stringify({ redacted: 'patron.erased' });

@Injectable()
export class PatronEraseService {
  private readonly logger = new Logger(PatronEraseService.name);

  constructor(
    @Inject(TenantPrismaService) private readonly tenantPrisma: TenantPrismaService,
    // The photograph lives on the storage volume, not in the database. See the
    // docblock: nulling the reference is not erasing the face.
    @Inject(StorageService) private readonly storage: StorageService,
  ) {}

  async erase(
    tenant: TenantContext,
    actor: TenantActor,
    patronId: string,
    reason: string,
  ): Promise<{ erasedAt: Date; tablesCleared: number; loansAnonymised: number }> {
    const client = this.tenantPrisma.getClientV2(tenant);

    const existing = await client.patron.findUnique({
      where: { id: patronId },
      select: {
        id: true,
        email: true,
        erasedAt: true,
        // Both are acted on below and neither is reachable afterwards: step 4
        // nulls the only handle on the photograph, and `archived_at` decides
        // whether the tombstone stays on the live roster.
        photoAssetRef: true,
        archivedAt: true,
      },
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
      // SCOPED TO THIS TENANT, which 1.0 did and the 2.0 rewrite dropped.
      // `EmailOutbox` is a CONTROL-PLANE table shared by every library on the
      // platform, and the address is not unique in it: one person can hold a
      // card at two Greek libraries under the same email, and rows with a NULL
      // `tenantId` are the platform's own messages to them. Unscoped, one
      // library erasing a reader silently deleted another library's pending
      // notices to that address — a cross-tenant delete out of an ordinary
      // operation. The docblock said this step was "carried over from the 1.0
      // erase verbatim"; it was not.
      await controlDb.emailOutbox.deleteMany({
        where: { tenantId: tenant.id, toEmail: existing.email },
      });
    }

    // 1b. THE PHOTOGRAPH — the FILE, not the reference to it.
    //
    //     Step 4 nulls `photo_asset_ref`, which is the only handle anything has
    //     on the object; nulling it first would leave the image on the volume
    //     for ever with nothing in the product able to reach it. The ordinary
    //     "remove photo" route already deletes the file
    //     (`patron-photo.controller.ts`), so the one path where it matters most
    //     was the only one that did not.
    //
    //     NOT SWALLOWED, unlike that route's best-effort delete: a face left on
    //     the volume is the worst residue of the lot, so a storage failure
    //     aborts the erasure with the row still intact and retryable rather
    //     than reporting success over a file that is still there.
    //     `StorageService.delete` already tolerates a missing object, so a
    //     re-run after a partial failure is safe.
    if (
      existing.photoAssetRef !== null &&
      !existing.photoAssetRef.startsWith('photos/placeholder')
    ) {
      try {
        await this.storage.delete(tenant, existing.photoAssetRef);
      } catch (err) {
        this.logger.error(
          `erase aborted for patron ${patronId}: could not delete photo ` +
            `${existing.photoAssetRef}: ${(err as Error).message}`,
        );
        throw new ServiceUnavailableException(
          'Could not delete this reader’s photograph from storage, so nothing was erased. ' +
            'Try again in a moment.',
        );
      }
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
        // The free text goes in the SAME statement, because this one destroys
        // the only way to find these rows again: after `patron_id` is NULL a
        // later `WHERE patron_id = $1` matches nothing, and the prose would be
        // stranded on a loan nobody can connect to the erasure. See 3b below
        // for why the prose matters as much as the link.
        `UPDATE loans SET patron_id = NULL, anonymised_at = $2,
                          notes = NULL, custom_fields = '{}'::jsonb
          WHERE patron_id = $1 AND patron_id IS NOT NULL`,
        patronId,
        now,
      );

      // 3b. THE FREE TEXT ON THE ROWS THAT OUTLIVE THE PATRON.
      //
      //     Nulling `loans.patron_id` unlinks the reader from the loan; it does
      //     nothing about the prose a librarian typed ON that loan — "rang
      //     about this on Tuesday", "lives above the bakery" — which identifies
      //     the person just as well as the name did. 1.0 cleared `notes` and
      //     `custom_fields` on loans, reservations and fines, and set the fine
      //     `reason` to the tombstone; the 2.0 erase cleared none of it. The
      //     LOAN half is folded into step 3's statement above — it has to be,
      //     because that statement nulls the column this one would filter on.
      //
      //     `holds` and `fees` keep their `patron_id` (both NOT NULL — the
      //     ledger has to balance, Article 17(3)(b) and (e)), so scrubbing the
      //     prose is the ONLY anonymisation available on those two rows, and
      //     the docblock's promise that "every field that identifies a person
      //     is redacted in place" was only true of the patron row itself.
      //
      //     `fees.reason` is NOT NULL and free text ("Lost book replacement",
      //     but also whatever an import mapped into it), so it takes the
      //     tombstone. The FINANCIAL record — amount, currency, status, dates,
      //     the loan link — is what the legal basis covers, not the prose.
      await tx.$executeRawUnsafe(
        `UPDATE holds SET notes = NULL, custom_fields = '{}'::jsonb WHERE patron_id = $1`,
        patronId,
      );
      await tx.$executeRawUnsafe(
        `UPDATE fees SET notes = NULL, reason = $2, custom_fields = '{}'::jsonb
          WHERE patron_id = $1`,
        patronId,
        ERASED_TOMBSTONE,
      );

      /**
       * 4. The person, redacted in place. The row stays so `fees`,
       * `patron_accounts` and `holds` keep their NOT NULL references and the
       * ledger still balances.
       *
       * Four of these columns were left behind by the 2.0 erase and are restored
       * here from 1.0, whose reasoning is in `members.service.ts`. The prose
       * lives OUTSIDE the template literal on purpose: a backtick inside a SQL
       * comment closes the literal, which is a parse error several lines away
       * from its cause.
       *
       *   - **`search_text = ''`, not the tombstone.** This column is what `?q=`
       *     matches with `contains`, so `'[erased]'` in it makes "erased" a
       *     query that lists every reader who ever exercised Article 17 — a
       *     roster of erasure requests, assembled from the ordinary search box.
       *     1.0 wrote a blank with exactly that warning attached. The "a blank
       *     sorts to the head of every roster" argument the 2.0 docblock gives is
       *     real, but it belongs to `sort_name`, which IS the sort key
       *     (`patrons_sort_name_id_idx`). Nothing orders by this column.
       *   - **`patron_number` becomes a pseudonym.** Left intact it still matches
       *     the library's paper card file, which re-identifies the person the
       *     moment anyone looks the card up. See {@link erasedPatronNumber}.
       *   - **`custom_fields` is emptied.** Whatever the library configured and
       *     typed — 'Φοιτητής', a room key, a school class. The upgrade fills it
       *     from 1.0's member field values, so an upgraded tenant's tombstones
       *     carried it forward.
       *   - **`status` and `archived_at`.** `PatronsService.list` filters
       *     `archived_at IS NULL` unless asked otherwise, so without these an
       *     erased reader stayed on the members list as an ACTIVE row named
       *     '[erased]', mixed in with live readers and still counted as active.
       *     An already-archived patron keeps the date they were archived: the
       *     erasure is not what took them off the roster and the record must not
       *     claim it was.
       */
      await tx.$executeRawUnsafe(
        `UPDATE patrons
            SET full_name = $2, sort_name = $2, search_text = '',
                patron_number = $4, custom_fields = '{}'::jsonb,
                email = NULL, phone = NULL, date_of_birth = NULL,
                photo_asset_ref = NULL, staff_notes = NULL,
                status = 'closed', archived_at = $5,
                erased_at = $3, updated_at = $3
          WHERE id = $1`,
        patronId,
        ERASED_TOMBSTONE,
        now,
        erasedPatronNumber(patronId),
        existing.archivedAt ?? now,
      );
      // 5. THE PROOF, written INSIDE the transaction.
      //
      // 3b. THE `anonymise` LIMB, which the data map has declared since phase 14
      //     and nothing implemented (2.0 phase 20q).
      //
      //     `patron-data-map.ts` marks `audit_log` as `onErase: 'anonymise'`
      //     with the reason spelled out: the record of what STAFF did is what a
      //     library needs in order to SHOW an erasure was carried out, so the
      //     rows stay and the patron-identifying payload inside them goes. But
      //     the loop above filters on `onErase === 'delete'`, so the anonymise
      //     limb has never run — while the upgrade has been copying 1.0 audit
      //     rows, `before`/`after` snapshots and all, into this table since 19b.
      //     So an erased patron's details survived inside the audit trail.
      //
      //     `detail` is where all of it lives in 2.0 — the upgrade folds 1.0's
      //     `beforeJson`/`afterJson` into it — so redacting the column is the
      //     whole job, and it is a REPLACEMENT rather than a delete for the
      //     reason the map gives: erasing the evidence of an erasure is the one
      //     deletion Article 17 cannot mean.
      const auditRedacted = await tx.$executeRawUnsafe(
        `UPDATE audit_log
            SET detail = $2::jsonb
          WHERE entity_kind = 'patron'
            AND entity_id = $1
            AND action <> 'patron.erase'
            AND detail IS NOT NULL
            AND detail <> $2::jsonb`,
        patronId,
        AUDIT_REDACTION,
      );

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
        JSON.stringify({
          reason,
          tablesCleared: deleteTables.length,
          loansAnonymised: loans,
          auditRowsRedacted: auditRedacted,
        }),
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

/**
 * The tombstoned patron number (2.0 phase 20q).
 *
 * THE NUMBER IS NOT LEFT INTACT. It is a pseudonym, and a pseudonym that still
 * matches the library's paper card file re-identifies the person the moment
 * anyone looks the card up — which is exactly what Article 17 forbids. 1.0 said
 * so in `members.service.ts` and did it; the 2.0 erase dropped it and left the
 * membership number on the row.
 *
 * Deriving it from the row id makes a re-run compute the same value.
 *
 * SHAPE IS NOT COSMETIC, and 2.0 carries 1.0's constraint verbatim:
 * `patrons_number_format` is `patron_number IS NULL OR patron_number ~
 * '^[A-Z0-9][A-Z0-9_-]{1,29}$'`, so the obvious `ERASED-<cuid>` is rejected
 * twice over — a cuid is lowercase, and 7 + 25 characters is past the
 * 30-character ceiling. Hence uppercase, alphanumerics only, and the last 16
 * characters of the id: 23 in total. 1.0 learned this from a 23514 against a
 * real tenant database, with the patron's row left fully intact.
 *
 * Collisions are not a correctness problem: the only unique index on the column
 * is `patrons_number_unique_active`, which is PARTIAL over non-archived rows,
 * and an erased patron is now always archived.
 */
export function erasedPatronNumber(id: string): string {
  const suffix = id
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(-16);
  return `ERASED-${suffix || '0'}`;
}
