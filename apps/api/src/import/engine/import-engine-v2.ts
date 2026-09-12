import { randomUUID } from 'node:crypto';
import type { ImportEntityKind } from '@libriant/db-control';
import {
  marcFromBook,
  type V1Author,
  type V1Book,
} from '@libriant/db-tenant/upgrade/marc-from-book';
import type { TenantContext } from '../../tenancy/tenant-context.js';
import type { TenantActor } from '../../tenancy/tenant-actor.js';
import { BibWriteService } from '../../bib/bib-write.service.js';
import { ItemsService } from '../../items/items.service.js';
import { PatronsService } from '../../patrons/patrons.service.js';
import { TenantPrismaService } from '../../tenancy/tenant-prisma.service.js';
import { ItemStatusService } from '../../items/item-status.service.js';
import { postJournalWithin, type Leg } from '../../fees/ledger.js';
import { acquireLocks, lockKey } from '../../platform/locks.js';
// THE canonical one, not a private copy. A later phase teaching allocation to
// respect `priority` would reach the desk and both sweeps and leave a private
// max+1 behind, putting imported readers in front of people who should precede
// them — invisibly, because both implementations would still "work".
import { nextQueuePosition } from '../../holds/hold-queue.js';
import { changeActorOf, setChangeActor } from '../../tenancy/tenant-actor-guc.js';
import { ageBandAt } from '../../circulation/age-band.js';
import { pinPolicy } from '../../circulation/policy-pinning.js';
import { pinHoldPolicy } from '../../holds/hold-pinning.js';
import { PolicySnapshotService } from '../../policy/policy-snapshot.service.js';
import {
  addDuration,
  resolveCirculationPolicy,
  type Duration,
  type PolicySnapshot,
} from '@libriant/circ-policy';
import type { MappedRow, RowIssue } from '../mapping/row-mapper.js';
import type { EngineRowResult } from './import-engine.js';

/**
 * The bulk importer, writing into `lbr2` (2.0 phase 20c).
 *
 * ## What was wrong
 *
 * `import-engine.ts` writes seven 1.0 tables — books, authors, book_copies,
 * members, loans, reservations, fines — and it is the ONLY thing in the product
 * that does bulk ingest of anything but MARC. Phase 20b-iii archives all seven,
 * and §6 never mentions the importer; phase 35's "migration adapters" assumes it
 * survives. So a library migrating off ABEKT or Koha after the cutover would
 * have had eleven live routes writing into a schema that had moved.
 *
 * ## The design: route through the services, not around them
 *
 * Every kind below goes through the SAME service a librarian's click goes
 * through — `BibWriteService.create`, `ItemsService.create`,
 * `PatronsService.create`. Not raw inserts.
 *
 * That is the whole point. An imported record and a typed one are then
 * indistinguishable afterwards, because they were made the same way: the same
 * validation, the same audit rows, the same change events, the same projection
 * pass. A second write path would drift from the first, and the drift would be
 * invisible until somebody asked why an imported record had no version history.
 *
 * It also means this file is short. The 1.0 engine carries 1,756 lines because
 * it reimplements what the services do; this carries the mapping and nothing
 * else.
 *
 * ## Authors stop being an entity
 *
 * 1.0 has an `authors` table, a `book_authors` join, and `author` as an import
 * kind. 2.0 has none of them: a contributor lives inside the MARC record as a
 * 100 or 700 field, and there is no authority store until phase 45. So an
 * `author` import has no destination and is refused BY NAME rather than
 * silently accepted into nothing — and the authors that matter arrive attached
 * to their book, which is how `marcFromBook` already takes them.
 *
 * ## MARC synthesis is not written twice
 *
 * `marcFromBook` is phase 19b's, written for the upgrade's copy-forward and
 * exported from `@libriant/db-tenant`. It already turns a 1.0-shaped book plus
 * its authors into a MARC record with the right 008, the right non-filing
 * indicators, ISO 639-2/B language codes and validated ISBNs. An importer that
 * synthesised its own MARC would be a second implementation whose only job is
 * to agree with the first.
 *
 * ## What this phase does NOT do, and why the line is here
 *
 * `loan`, `reservation` and `fine` are refused, naming phase 20d. The line is
 * not arbitrary — it is the dependency order. All three REFERENCE a copy, a
 * record or a patron, so none of them can be imported until these three kinds
 * work, and a library migrating in loads them in exactly this sequence.
 *
 * They also need a decision this phase should not make quietly. Routing them
 * through the services means `CheckoutService` refuses a historical loan for a
 * patron who is blocked today, and `FeesService` posts a double-entry journal
 * for a fine that was settled in the old system two years ago.
 *
 * CORRECTED IN PHASE 20d. The sentence that stood here said "2.0 has an override
 * path for the first — 'clear or override every blocking reason' — so a bulk
 * import would record an override per row". It does not. `circulation_overrides`,
 * `override_reasons` and `override_permissions` are all `"status": "deferred"`
 * in `schema-v2/BASELINE-SCOPE.json` and exist in no model, no migration and no
 * census; the three override permission keys are absent from the phase-3
 * catalogue; and `CheckoutInput` carries no `force`, no `override` and no
 * `reason`. That machinery is phase 21. The claim was read off §6 rather than
 * off the code, and phase 20d — which inherited it as a premise — measured it
 * and writes circulation history directly instead. See `commitLoan` below.
 */
/**
 * Circulation history, written into `lbr2` (2.0 phase 20d).
 *
 * 20c imported the things a library HAS — records, copies, readers — and refused
 * the three that describe what it DID: `loan`, `reservation`, `fine`. This is
 * those three, and the interesting part is that they are written a different way
 * from everything above, for a reason that was measured rather than assumed.
 *
 * ## Why these do not go through the services
 *
 * 20c's thesis was "route through the same service a librarian's click goes
 * through", and it holds for a record, a copy and a patron: creating one IS
 * creating one, so the service's meaning and the row's meaning are the same
 * thing. For a loan they are not. `CheckoutService.checkout` means "lend this
 * book, now"; a row in a migration file means "this book was lent in 2019 and
 * came back in 2020". Routing the second through the first is not conservative,
 * it is wrong — and, as it turns out, impossible:
 *
 *   - `CheckoutInput` is `{item, patron, branch, source, effectiveAt, device}`.
 *     There is no `dueAt`, no `renewalCount`, no `returnedAt`, no `status`. The
 *     fields a migrated loan must carry VERBATIM — its real due date, its real
 *     renewal count — cannot be expressed at all.
 *   - Six of its seven state refusals are evaluated as of TODAY: a copy since
 *     withdrawn, a reader since archived, a patron at their loan ceiling or over
 *     their fine limit now, refuses their own history. Only the card-expiry test
 *     uses `effectiveAt`.
 *   - No call produces a CLOSED loan. Checkout always writes `closed_at NULL`;
 *     closing it needs a second `CheckinService` call, which promotes today's
 *     hold queue onto the copy and can open a transfer — live side effects for a
 *     book that went back four years ago.
 *
 * ## THE OVERRIDE PATH 20c PROMISED DOES NOT EXIST
 *
 * `import-engine-v2.ts` said, and the divergence log repeated: "2.0 has an
 * override path for the first — 'clear or override every blocking reason' — so
 * a bulk import would record an override per row." That was written from §6 and
 * it is false against the code. Measured here:
 *
 *   - `circulation_overrides`, `override_reasons` and `override_permissions` are
 *     all `"status": "deferred"` in `schema-v2/BASELINE-SCOPE.json` and exist in
 *     no Prisma model, no migration and no census. There is no table.
 *   - `circ.checkout.override` / `circ.hold.override` / `circ.renew.override` are
 *     absent from the phase-3 catalogue, so `check:permissions` would fail any
 *     route decorated with them — even though `blocks.ts` ships those very
 *     strings to clients in the 409 body.
 *   - `CheckoutInput` has no `force`, no `override`, no `reason`.
 *     `checkout.service.ts` says it outright: "Phase 16 refuses; it does not
 *     offer a way past."
 *   - `LoanEventKind` is `checked_out | renewed | returned | anonymised`. A loan's
 *     own history could not record that it was made over a refusal.
 *
 * All of it is phase 21, in M3, which lands AFTER this. So the choice 20c
 * deferred was never a choice: there is nothing to override WITH. The docblock
 * and the log entry are corrected in the same commit as this file.
 *
 * ## What they do instead: 19b's copy-forward, in TypeScript
 *
 * `prisma/upgrade/02-post-catalog.sql` already answers "how do I write a
 * historical loan, hold and fee into 2.0" — it is the only historical loader in
 * the repository, and it bypasses the services for these exact reasons. So this
 * file follows it rather than inventing a second set of answers: the same
 * `rule-default` / `lp-default` policy pinning, the same derivation of a hold's
 * four ending instants, the same `opening_balance` debit for a settlement that
 * happened before these books began.
 *
 * It is NOT a free-for-all. Two boundaries are enforced by machinery, not by
 * convention, and this file goes through both:
 *
 *   - **The item's status** moves through `ItemStatusService.applyWithin`, phase
 *     15's single writer, guarded by an ESLint rule AND
 *     `check:item-status-writer` for the raw SQL ESLint cannot see. A bare
 *     `item.update({status})` is what 1.0's importer did and is a build failure
 *     here.
 *   - **The ledger** goes through `postJournalWithin`. Phase 18's balance check
 *     is an AFTER INSERT ... FOR EACH STATEMENT trigger, so a half-journal is
 *     refused even when the transaction would balance by the end — which, as its
 *     migration says, "makes `postJournalWithin` the only way to write an entry".
 *
 * ## Reading history
 *
 * A closed imported loan honours the tenant's own `reading_history_policy`, read
 * the way `CheckinService` reads it: under the default `anonymised` the patron
 * link is severed and `anonymised_at` stamped, and the three statistical buckets
 * survive. A library that has set `kept` keeps the link.
 *
 * That is a deliberate divergence from 19b, which carries `patron_id` forward on
 * every returned loan and never anonymises — a decision nothing in the log
 * records. §3 calls the anonymisation "an IFLA/NISO professional obligation and
 * a Greek DPA answer", and an import is the one moment a library hands us forty
 * thousand reading histories at once. The operator was asked and chose the
 * policy.
 *
 * It has a consequence this file has to carry: anonymising destroys the patron
 * half of every weak duplicate key, so a re-import could not recognise its own
 * rows. See {@link priorLoan} — the key is `(item, loaned_at)`, which is
 * stronger than 1.0's anyway, because two readers cannot borrow one copy at one
 * instant.
 */

export type EngineV2Context = {
  readonly tenant: TenantContext;
  readonly actor: TenantActor;
  readonly duplicateMode: 'skip' | 'update' | 'error';
  readonly dryRun: boolean;
  /** 040 $a / 003. The library's own MARC organisation code. */
  readonly orgCode: string;
};

/** The kinds this phase can write. The rest are named refusals. */
export const V2_SUPPORTED_KINDS: readonly ImportEntityKind[] = [
  'book',
  'book_copy',
  'member',
  // 2.0 phase 20d. `author` is still absent and still refused by name: a
  // contributor is a 100 or 700 field, not a row, until the authority store in
  // phase 45.
  'loan',
  'reservation',
  'fine',
];

/** The `branches.id` every seeded tenant has, and what a file that names none falls back to. */
const DEFAULT_BRANCH = 'branch-main';
const DEFAULT_LOCATION = 'loc-general';
const DEFAULT_ITEM_TYPE = 'itype-book';
/** `patron_category_id_applied` is NOT NULL; this is the seeded category. */
const DEFAULT_PATRON_CATEGORY = 'pcat-general';

/**
 * The transaction handle the direct writers take.
 *
 * Named against the methods they use rather than the generated Prisma union,
 * for the reason `PatronAddressesService.demoteIncumbent` gives: naming that
 * union across a module boundary is what TS2883 fires on.
 */
/** The four policy columns a loan pins, taken from the resolution that made them. */
type ResolvedPolicyIds = {
  readonly loanPolicyId: string;
  readonly overdueFinePolicyId: string;
  readonly lostItemFeePolicyId: string;
  readonly appliedRuleId: string;
};

/**
 * A refusal raised INSIDE a transaction, so the row fails with a sentence
 * rather than with whatever constraint name the database reaches first.
 * `processRow` turns it back into an issue.
 */
class ImportRowError extends Error {
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(message);
    this.name = 'ImportRowError';
  }
}

type TxLike = Parameters<
  Parameters<ReturnType<TenantPrismaService['getClientV2']>['$transaction']>[0]
>[0];

export class ImportEngineV2 {
  constructor(
    private readonly kind: ImportEntityKind,
    private readonly ctx: EngineV2Context,
    private readonly bibs: BibWriteService,
    private readonly items: ItemsService,
    private readonly patrons: PatronsService,
    /**
     * Phase 20d's two additions, and the shape of the phase in one signature.
     *
     * The three services above are how a record, a copy and a reader are made.
     * Circulation history is not made that way — see the file docblock — so it
     * needs the client to write `loans`, `holds` and `fees` directly, and the
     * ONE status writer for the item side of a loan. `tenantPrisma` is the
     * client; `status` is phase 15's boundary, which a bare
     * `item.update({status})` would go around and `check:item-status-writer`
     * would fail the build over.
     */
    private readonly tenantPrisma: TenantPrismaService,
    private readonly status: ItemStatusService,
    /**
     * The policy matrix, for the ONE thing an imported loan genuinely needs
     * resolved — see {@link pinnedFor}. Not for its due date, which the file
     * carries.
     */
    private readonly snapshots: PolicySnapshotService,
  ) {}

  /** Per-run state, all of it read once in {@link init}. */
  private runStartedAt = new Date(0);
  private readingHistoryMode = 'anonymised';
  private currency = 'EUR';
  private branchId = DEFAULT_BRANCH;
  /** Items this run has already opened a loan against, for the within-file check. */
  private readonly openedLoans = new Set<string>();
  /** The anonymisation notice is a per-FILE fact, not a per-row one. */
  private saidAnonymised = false;
  private saidArrears = false;
  private policy: PolicySnapshot | null = null;
  private timezone = 'Europe/Athens';
  private calendarId: string | null = null;

  /**
   * Read the run's boundary and the tenant's settings, before a single row.
   *
   * THE BOUNDARY FIRST, exactly as `ImportEngine.init` does it and for the
   * identical reason: every duplicate key below is weak, and a weak key is only
   * meaningful against rows that existed BEFORE this run. Two identical rows
   * inside one file are two real events — the source system had two — and
   * collapsing those would change what a first-time import does.
   *
   * READ FROM THE SAME CLOCK THAT WRITES THE ROWS, which for these three tables
   * is this process's. 1.0 reads the DATABASE clock, correctly, because 1.0's
   * `created_at` carries Prisma's `@default(now())` and is therefore written by
   * Postgres. `lbr2.loans`, `lbr2.holds` and `lbr2.fees` have no such default —
   * that is why Prisma demands the column — so the importer supplies it, and a
   * boundary taken from Postgres while the values come from Node makes the
   * comparison a clock-skew race: a few seconds of drift and this run's own
   * early rows look older than its boundary, which would collapse the two
   * identical rows a single file is required to keep.
   *
   * Copying 1.0's `SELECT NOW() AT TIME ZONE 'UTC'` would have been doubly
   * wrong: every column here is `timestamptz(3)` and every session is pinned
   * UTC, so the cast would also shift the boundary by the session offset.
   */
  async init(): Promise<void> {
    const client = this.tenantPrisma.getClientV2(this.ctx.tenant);
    this.runStartedAt = new Date();

    const policy = await client.readingHistoryPolicy.findUnique({
      where: { id: 1 },
      select: { mode: true },
    });
    // Absent is impossible (the phase-13 migration inserts it) and if it ever
    // happens the safe answer is the privacy-preserving one — `CheckinService`
    // resolves it the same way and says the same thing.
    this.readingHistoryMode = policy?.mode ?? 'anonymised';

    const branch = await client.branch.findFirst({
      where: { archivedAt: null },
      select: { id: true, currency: true, timezone: true, calendarId: true },
      orderBy: { id: 'asc' },
    });
    if (branch !== null) {
      this.branchId = branch.id;
      this.currency = branch.currency;
      this.timezone = branch.timezone;
      this.calendarId = branch.calendarId;
    }

    // Loaded once per run, not once per row: it is the same matrix for every
    // row of one file, and `PolicySnapshotService` is a cache in front of a
    // version probe rather than a free read.
    if (this.kind === 'loan' || this.kind === 'reservation') {
      this.policy = await this.snapshots.get(this.ctx.tenant);
    }
  }

  /**
   * The runner's entry point: gate the row, then write it.
   *
   * The same three steps `ImportEngine.processRow` takes, for the same reasons
   * — a row the mapper already rejected never reaches a service, and a database
   * error becomes an issue on that row rather than the end of a 4,000-row
   * import.
   *
   * CUSTOM FIELDS ARE REFUSED RATHER THAN DROPPED. 1.0 validates them here
   * against `field_definitions` and stores them on the row. 2.0 has the table
   * and no service that writes to it, so a mapped custom field has nowhere to
   * go — and an importer that silently discarded a column the librarian
   * deliberately mapped would lose data with no trace anywhere. The row fails
   * by name instead.
   */
  async processRow(row: MappedRow): Promise<EngineRowResult> {
    const issues: RowIssue[] = [...row.issues];
    if (issues.some((i) => i.severity === 'error')) {
      return { rowNumber: row.rowNumber, outcome: 'error', issues };
    }

    const custom = Object.keys(row.customFields);
    if (custom.length > 0) {
      return this.error(
        row,
        issues,
        custom[0]!,
        `2.0 has no writer for custom fields yet, so ${custom.join(', ')} would be dropped ` +
          'silently. Unmap the column and import it once the field surface lands.',
      );
    }

    try {
      return await this.commit(row, issues);
    } catch (err) {
      if (err instanceof ImportRowError) {
        issues.push({
          field: err.field,
          code: 'import.rowInvalid',
          severity: 'error',
          message: err.message,
        });
        return { rowNumber: row.rowNumber, outcome: 'error', issues };
      }
      issues.push(this.dbIssue(err));
      return { rowNumber: row.rowNumber, outcome: 'error', issues };
    }
  }

  async commit(row: MappedRow, issues: RowIssue[]): Promise<EngineRowResult> {
    switch (this.kind) {
      case 'book':
        return this.commitBook(row, issues);
      case 'book_copy':
        return this.commitCopy(row, issues);
      case 'member':
        return this.commitMember(row, issues);
      case 'loan':
        return this.commitLoan(row, issues);
      case 'reservation':
        return this.commitHold(row, issues);
      case 'fine':
        return this.commitFee(row, issues);
      case 'author':
        return this.refuse(
          row,
          issues,
          'author',
          'A contributor is a 100 or 700 field inside the MARC record in 2.0, not a row of its ' +
            'own — there is no authority store until phase 45. Import the authors on the book ' +
            'rows instead; the columns are read from there.',
        );
      default:
        // Unreachable: `ImportEntityKind` has seven values and the six above
        // plus `author` are all of them. Kept so a new kind added to the
        // control-plane enum fails loudly on the row rather than falling
        // through to `undefined` and being counted as an import.
        return this.refuse(
          row,
          issues,
          this.kind,
          `The 2.0 importer has no handler for \`${this.kind}\`.`,
        );
    }
  }

  // -------------------------------------------------------------------------

  private async commitBook(row: MappedRow, issues: RowIssue[]): Promise<EngineRowResult> {
    const v = row.values;
    // THE 001 IS NOT THE RECORD'S OWN ID HERE, and that is the one place this
    // diverges from the upgrade deliberately.
    //
    // The copy-forward sets 001 to the existing cuid because every permalink,
    // audit target and offline replica already points at it. An imported record
    // has no such history — nothing refers to it yet — and its id is minted by
    // Prisma's `@default(cuid())` at insert, so it is not knowable before the
    // write. So the control number is the SOURCE's, when the file carries one,
    // and otherwise a generated one; either way it is unique per kind, which is
    // what `marc_records_control_number_unique_active` asks of it.
    const controlNumber = this.str(v['sourceId']) ?? this.str(v['id']) ?? randomUUID();
    const now = new Date();
    const book: V1Book = {
      id: controlNumber,
      title: this.str(v['title']) ?? '',
      subtitle: this.str(v['subtitle']),
      isbn13: this.str(v['isbn13']),
      isbn10: this.str(v['isbn10']),
      publisher: this.str(v['publisher']),
      publicationYear: this.num(v['publicationYear']),
      language: this.str(v['language']),
      edition: this.str(v['edition']),
      numPages: this.num(v['numPages']),
      description: this.str(v['description']),
      classification: this.str(v['classification']),
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
    };
    if (book.title.length === 0) {
      return this.error(row, issues, 'title', 'A record with no title cannot be catalogued.');
    }

    // Authors arrive on the book row, in order, main entry first. `order: 0` is
    // the 100; the rest become 700s, which is `marcFromBook`'s own rule.
    const authors: V1Author[] = this.authorsFrom(v);

    const { record, issues: synth } = marcFromBook(book, authors, this.ctx.orgCode);
    for (const s of synth) {
      // EVERY synthesis issue is a WARNING, including `invalid_source`.
      //
      // The first version of this made a bad source value an error, and that was
      // wrong: `marcFromBook` does not report a problem it has not already
      // handled. A failing ISBN check digit goes into 020 $z instead of $a —
      // which is exactly what $z means in MARC, "invalid ISBN" — so the record
      // is correct and the bad number is preserved where a cataloguer can see
      // it. The upgrade takes the same position: it writes the note to
      // `upgrade_exceptions` and carries the book forward.
      //
      // Rejecting the row would throw away a good title, author and publisher
      // over one mistyped digit, on the import where the library has least
      // ability to go back and fix the source.
      issues.push({
        field: s.column,
        code: `marc.${s.kind}`,
        severity: 'warning',
        message: s.note,
      });
    }
    if (this.ctx.dryRun) {
      return { rowNumber: row.rowNumber, outcome: 'imported', issues };
    }

    // `SynthesisedRecord.fields` types `i` as optional because a control field
    // has no indicator, while `MarcField` splits the two shapes into a union.
    // The cast is sound and checked: every one of the nine data-field pushes in
    // `marcFromBook` sets `i`, and none of the control-field pushes does — the
    // looser type is the synthesiser's convenience, not a different invariant.
    // `toMarcRecord` in bib.dto.ts does the same for the same reason.
    const written = await this.bibs.create(this.ctx.tenant, this.ctx.actor, {
      record: record as unknown as Parameters<BibWriteService['create']>[2]['record'],
      kind: 'bibliographic',
      schema: 'marc21',
      controlNumber,
    });
    return {
      rowNumber: row.rowNumber,
      outcome: 'imported',
      issues,
      entityId: written.recordId,
    };
  }

  private async commitCopy(row: MappedRow, issues: RowIssue[]): Promise<EngineRowResult> {
    const v = row.values;
    const barcode = this.str(v['barcode']);
    if (barcode === null) {
      return this.error(
        row,
        issues,
        'barcode',
        'A copy needs a barcode: it is the only thing a scanner can find it by, and 2.0 makes it ' +
          'the natural key.',
      );
    }
    const bibId = row.refs['bookId'] ?? this.str(v['bookId']);
    if (bibId === null || bibId === undefined) {
      return this.error(row, issues, 'bookId', 'A copy must name the record it is a copy of.');
    }
    if (this.ctx.dryRun) {
      return { rowNumber: row.rowNumber, outcome: 'imported', issues };
    }

    const created = await this.items.create(this.ctx.tenant, this.ctx.actor, {
      bibId,
      barcode,
      itemTypeId: this.str(v['itemTypeId']) ?? DEFAULT_ITEM_TYPE,
      owningBranchId: this.str(v['branchId']) ?? DEFAULT_BRANCH,
      permanentLocationId: this.str(v['locationId']) ?? DEFAULT_LOCATION,
    } as never);
    return {
      rowNumber: row.rowNumber,
      outcome: 'imported',
      issues,
      entityId: (created as { id: string }).id,
    };
  }

  private async commitMember(row: MappedRow, issues: RowIssue[]): Promise<EngineRowResult> {
    const v = row.values;
    const fullName = this.str(v['fullName']);
    if (fullName === null) {
      return this.error(row, issues, 'fullName', 'A patron record needs a name.');
    }
    if (this.ctx.dryRun) {
      return { rowNumber: row.rowNumber, outcome: 'imported', issues };
    }
    // THE MEMBER NUMBER HAS A SHAPE, and 20c passed the file's value straight
    // through to it. `patrons_number_format` is
    // `^[A-Z0-9][A-Z0-9_-]{1,29}$` — uppercase only, and the migration says why
    // that is load-bearing rather than stylistic: `text_pattern_ops` refuses a
    // non-deterministic collation outright, so a case-insensitive patron number
    // is not merely slow, it is unimplementable with the index the lookup needs.
    //
    // So a library whose numbers are lowercase, or carry a slash or a space,
    // got a raw `23514 patrons_number_format` on EVERY row — a constraint name
    // where a sentence belonged. Uppercasing is safe and is what
    // `patron_cards.barcode_norm` already does to the same kind of value;
    // anything that still will not fit is refused by name, because minting a
    // different number would silently break the link between the library's own
    // records and ours.
    const rawNumber = this.str(v['memberNumber']);
    const patronNumber = rawNumber === null ? null : rawNumber.toUpperCase();
    if (patronNumber !== null && !/^[A-Z0-9][A-Z0-9_-]{1,29}$/.test(patronNumber)) {
      return this.error(
        row,
        issues,
        'memberNumber',
        `\`${rawNumber}\` cannot be a member number here: it must be 2–30 characters of ` +
          'letters, digits, hyphen or underscore. Map the column to a card barcode instead, or ' +
          'leave it unmapped and the library will mint its own number.',
      );
    }
    const created = await this.patrons.create(this.ctx.tenant, this.ctx.actor, {
      fullName,
      ...(this.str(v['email']) === null ? {} : { email: this.str(v['email']) as string }),
      ...(this.str(v['phone']) === null ? {} : { phone: this.str(v['phone']) as string }),
      ...(patronNumber === null ? {} : { patronNumber }),
    } as never);
    return {
      rowNumber: row.rowNumber,
      outcome: 'imported',
      issues,
      entityId: (created as { id: string }).id,
    };
  }

  // ===========================================================================
  // Phase 20d — circulation history
  // ===========================================================================

  /**
   * A loan that happened.
   *
   * Written directly, for the reasons in the file docblock, and with the item
   * side going through phase 15's single status writer inside the SAME
   * transaction — a loan row whose copy did not move, or a copy that moved
   * without its loan, is the state phase 16 spent a whole design preventing.
   */
  private async commitLoan(row: MappedRow, issues: RowIssue[]): Promise<EngineRowResult> {
    const v = row.values;
    const patronId = await this.resolvePatron(row.refs);
    if (patronId === null) {
      return this.missing(row, issues, 'memberNumber', 'No matching reader for this loan.');
    }
    const item = await this.resolveItem(row.refs);
    if (item === null) {
      return this.missing(row, issues, 'copyBarcode', 'No matching copy for this loan.');
    }

    const status = (this.str(v['status']) ?? 'active') as 'active' | 'returned' | 'lost';
    // What the FILE said and what we are about to write, kept apart. The second
    // is a per-run invention when the column is absent, and feeding an
    // invention to the duplicate key is what let 1.0 double every closed loan.
    const fileLoanedAt = this.date(v['loanedAt']);
    const loanedAt = fileLoanedAt ?? new Date();
    const dueAt = this.date(v['dueAt']);
    if (dueAt === null) {
      return this.error(
        row,
        issues,
        'dueAt',
        'A loan needs the date it was due back. 2.0 will not invent one: the policy that decided ' +
          'it no longer exists, and a due date computed from today’s rules would be fiction on a ' +
          'row that already has a fact.',
      );
    }
    if (dueAt.getTime() <= loanedAt.getTime()) {
      return this.error(row, issues, 'dueAt', 'Due date must be after the checkout date.');
    }
    let returnedAt = this.date(v['returnedAt']);
    if (status === 'returned' && returnedAt === null) {
      returnedAt = new Date();
      issues.push({
        field: 'returnedAt',
        code: 'defaulted',
        severity: 'warning',
        message: 'Returned loan had no return date; used now.',
      });
    }
    if (returnedAt !== null && returnedAt.getTime() < loanedAt.getTime()) {
      return this.error(row, issues, 'returnedAt', 'Return date is before the checkout date.');
    }

    // `loans_renewal_count_non_negative`. Some systems encode "never renewable"
    // as -1, which would otherwise die as a 23514 naming a constraint and no
    // column.
    const renewalCount = this.num(v['renewedCount']) ?? 0;
    if (renewalCount < 0) {
      return this.error(
        row,
        issues,
        'renewedCount',
        'A renewal count cannot be negative. Leave the column unmapped if the source uses -1 to ' +
          'mean "not renewable" — 2.0 records that on the policy, not on the loan.',
      );
    }

    const prior = await this.priorLoan(item.id, loanedAt, dueAt, fileLoanedAt !== null);
    if (prior !== null) {
      if (this.ctx.duplicateMode === 'error') {
        return this.error(row, issues, 'copyBarcode', 'This loan was already imported.');
      }
      if (this.ctx.duplicateMode === 'update') {
        // `update` degrades to skip, as it does in 1.0 and for the same reason:
        // rewriting a historical loan means replaying its side effects — the
        // copy's status, and the fees hanging off it. That is a data migration,
        // not an import, and doing it silently from a spreadsheet is worse than
        // not doing it.
        issues.push({
          field: null,
          code: 'duplicate_not_updated',
          severity: 'warning',
          message: 'This loan already exists; existing loans are not rewritten on re-import.',
        });
      }
      return { rowNumber: row.rowNumber, outcome: 'skipped', issues, entityId: prior };
    }

    // `loans_one_open_per_item` is `UNIQUE (item_id) WHERE closed_at IS NULL`.
    // Catching it here rather than as a 23505 names the column a librarian can
    // fix, and the within-run set catches a file that lends one copy twice.
    const open = status !== 'returned';
    if (open && (await this.itemHasOpenLoan(item.id))) {
      return this.error(row, issues, 'copyBarcode', 'This copy already has an open loan.');
    }

    // WHAT `closed_at` MEANS IS DECIDED BY THE SCHEMA, not by the status word.
    //
    //     loans_closed_consistency CHECK ((closed_at IS NULL) =
    //       (status IN ('active','claims_returned','claims_never_borrowed','recalled')))
    //
    // So a `lost` loan is CLOSED in 2.0 — writing it open is a 23514 on every
    // lost row — and §3's split of `closed_at` from `returned_at` is what lets
    // it close without a return, so `loans_one_open_per_item` stops pinning the
    // copy out of circulation for ever. That was the 1.0 dead end.
    //
    // `returned` is also derived from the DATE, not only from the word. A file
    // with a return-date column and no status column is ordinary — the status
    // is implicit in the date being filled in — and reading only the word
    // imported those rows as open loans with the return silently dropped.
    const returned = status === 'returned' || (status !== 'lost' && returnedAt !== null);
    const closed = returned || status === 'lost';
    const closedAt = returned ? returnedAt : (this.date(v['returnedAt']) ?? loanedAt);

    // ANONYMISED ON RETURN, and only on return — the same event `CheckinService`
    // anonymises on. A lost loan is closed but the library is still trying to
    // get the book back, and severing the reader would leave nobody to ask.
    const anonymise = returned && this.readingHistoryMode !== 'kept';
    if (anonymise && !this.saidAnonymised) {
      // ONCE PER RUN. The issue list is capped (`IMPORT_MAX_ISSUES`) and the
      // report is truncated when it fills, so repeating one sentence per closed
      // row would push out every real error behind it — the librarian would get
      // five thousand copies of a notice and none of the failures.
      this.saidAnonymised = true;
      issues.push({
        field: null,
        code: 'reading_history_anonymised',
        severity: 'warning',
        message:
          'Returned loans in this file were unlinked from their readers and only the statistical ' +
          'buckets kept — the library’s reading-history policy is `' +
          this.readingHistoryMode +
          '`. Set it to `kept` before importing if the readers have asked for their history. ' +
          'Reported once for the whole file.',
      });
    }

    if (this.ctx.dryRun) {
      if (open) this.openedLoans.add(item.id);
      return { rowNumber: row.rowNumber, outcome: 'imported', issues };
    }

    const client = this.tenantPrisma.getClientV2(this.ctx.tenant);
    const buckets = await this.statisticalBuckets(patronId);
    const pinned = this.pinnedFor({
      itemTypeId: item.itemTypeId ?? null,
      owningBranchId: item.owningBranchId ?? null,
      locationId: null,
      patronCategoryId: buckets.categoryId,
      at: loanedAt,
    });
    const created = await client.$transaction(
      async (tx) => {
        // Lock order: patron (1) before item (3), which is what `locks.ts`
        // ranks and what CI forbids going around.
        await acquireLocks(tx, [lockKey('patron', patronId), lockKey('item', item.id)]);
        // The changelog triggers read the actor off a GUC, so a transaction
        // that does not set it writes `system` into every `change_events` row.
        // Every other writer in the product sets it; these three were the only
        // transactions that did not.
        await setChangeActor(tx, changeActorOf(this.ctx.actor));

        // RE-READ UNDER THE LOCK. The probe above ran on the outer client, so
        // between it and this line a librarian can have checked the copy out at
        // the desk. `loans_one_open_per_item` would catch it as a 23505 naming
        // an index; catching it here names the column instead.
        const openNow = await tx.loan.findFirst({
          where: { itemId: item.id, closedAt: null },
          select: { id: true },
        });
        if (open && openNow !== null) {
          throw new ImportRowError(
            'copyBarcode',
            'This copy was lent at the desk while the import was running, so it already has an ' +
              'open loan.',
          );
        }

        const loan = await tx.loan.create({
          data: {
            itemId: item.id,
            bibId: item.bibId,
            patronId: anonymise ? null : patronId,
            anonymisedAt: anonymise ? new Date() : null,
            checkoutBranchId: item.owningBranchId ?? this.branchId,
            loanedAt,
            dueAt,
            originalDueAt: dueAt,
            // The two are different questions: a lost loan closes without ever
            // being returned, which is exactly why §3 split the columns.
            returnedAt: returned ? returnedAt : null,
            closedAt: closed ? closedAt : null,
            status: returned ? 'returned' : status,
            renewalCount: renewalCount,
            notes: this.str(v['notes']),
            // NOBODY AT THIS LIBRARY LENT THIS BOOK. The librarian running the
            // import did not, and naming them would put a real person's id on
            // forty thousand transactions they never made. 1.0's importer and
            // 19b's copy-forward both leave these NULL; the audit row this
            // import writes carries the real attribution.
            checkedOutByUserId: null,
            returnedByUserId: null,
            // FROM THE RESOLUTION, not from five literals. The upgrade pins
            // `rule-default`/`lp-default` because it has no resolver to hand;
            // this has one, and a row whose columns said `rule-default` while
            // its own snapshot named the children's rule would make
            // `applied_rule_id` — which every policy report groups by — disagree
            // with the policy the loan is actually priced under.
            loanPolicyId: pinned.ids.loanPolicyId,
            overdueFinePolicyId: pinned.ids.overdueFinePolicyId,
            lostItemFeePolicyId: pinned.ids.lostItemFeePolicyId,
            appliedRuleId: pinned.ids.appliedRuleId,
            policySnapshot: pinned.snapshot as never,
            itemTypeIdApplied: item.itemTypeId ?? DEFAULT_ITEM_TYPE,
            patronCategoryIdApplied: buckets.categoryId,
            patronCategoryCode: buckets.categoryCode,
            // The one bucket that CANNOT be added later: it comes from a date of
            // birth, and once `patron_id` is nulled there is no row left to
            // derive it from. Banded at the LOAN's instant, not at import time,
            // so a reader who was twelve in 2019 is counted as twelve.
            patronAgeBand: buckets.ageBandAt(loanedAt),
            patronHomeBranchId: buckets.homeBranchId,
            source: 'migration',
            customFields: row.customFields as never,
            // `loans.created_at` / `updated_at` have no default — phase 16 sets
            // them explicitly so a loan's row age and its checkout instant can
            // differ, which for an import is the whole point: the loan happened
            // in 2019 and the row was written today. The ROW's age is now; the
            // loan's dates are the file's.
            createdAt: new Date(),
            updatedAt: new Date(),
          } as never,
          select: { id: true },
        });

        // The copy moves through the ONE writer. `item_status` has SIX values
        // and `lost` is not among them — `available | on_loan | in_transit |
        // awaiting_pickup | in_process | missing` — so a lost loan leaves the
        // copy `missing`, which is 2.0's word for a copy the library has not
        // got. (Declare-lost proper, with its fee, is phase 21.)
        //
        // A RETURNED loan moves nothing. The copy is wherever it is now, and
        // asserting it is on the shelf because a 2019 return says so would
        // overwrite today's truth with four-year-old news.
        const toStatus = returned ? null : status === 'lost' ? 'missing' : 'on_loan';
        if (toStatus !== null) {
          await this.status.applyWithin(tx, {
            itemId: item.id,
            toStatus,
            source: 'migration',
            causeType: 'loan',
            causeId: loan.id,
            note: 'imported circulation history',
            now: loanedAt,
          } as never);
        }
        return loan;
      },
      { isolationLevel: 'ReadCommitted' },
    );
    if (open) this.openedLoans.add(item.id);
    return { rowNumber: row.rowNumber, outcome: 'imported', issues, entityId: created.id };
  }

  /**
   * A request that was made.
   *
   * 2.0 HAS NO HOLD STATUS ENUM. 1.0's five-value `ReservationStatus` becomes
   * four nullable instants plus a queue position, and `holds_position_iff_waiting`
   * makes the relationship a law:
   *
   *     queue_position IS NOT NULL  ===  (assigned_item_id IS NULL AND
   *       fulfilled_at IS NULL AND cancelled_at IS NULL AND expired_at IS NULL)
   *
   * So this derives the position FROM the ending instants, spelled the way the
   * CHECK spells it, rather than from the file's status word — which is what the
   * upgrade does, and for the reason it records: a 1.0 row with an inconsistent
   * combination (cancelled but still `queued`) otherwise breaks the load.
   */
  private async commitHold(row: MappedRow, issues: RowIssue[]): Promise<EngineRowResult> {
    const v = row.values;
    const patronId = await this.resolvePatron(row.refs);
    if (patronId === null) {
      return this.missing(row, issues, 'memberNumber', 'No matching reader for this hold.');
    }
    const bibId = await this.resolveBib(row.refs);
    if (bibId === null) {
      return this.missing(row, issues, 'bookIsbn13', 'No matching record for this hold.');
    }

    const status = (this.str(v['status']) ?? 'queued') as
      'queued' | 'ready' | 'fulfilled' | 'expired' | 'canceled';
    if (status === 'fulfilled') {
      // 1.0 refuses this too. The reason is worth stating rather than
      // inheriting: a fulfilled hold IS a loan — the reader asked, the book
      // arrived, they took it away — and 2.0 records that as a row in `loans`.
      // Writing a fulfilled hold with no loan behind it would put a request in
      // the history that nothing ever satisfied.
      return this.refuse(
        row,
        issues,
        'status',
        'A fulfilled request is a loan in 2.0, not a hold: import it as a `loan` row and the ' +
          'reader’s history will show the book they actually took home.',
      );
    }

    const filePlacedAt = this.date(v['placedAt']);
    const placedAt = filePlacedAt ?? new Date();
    const fileExpiresAt = this.date(v['expiresAt']);

    const prior = await this.priorHold(bibId, patronId, placedAt, filePlacedAt !== null);
    if (prior !== null) {
      if (this.ctx.duplicateMode === 'error') {
        return this.error(row, issues, 'bookIsbn13', 'This hold was already imported.');
      }
      if (this.ctx.duplicateMode === 'update') {
        issues.push({
          field: null,
          code: 'duplicate_not_updated',
          severity: 'warning',
          message:
            'This hold already exists; re-deriving a queue position against the live queue is a ' +
            'circulation operation, not something a re-uploaded file should trigger.',
        });
      }
      return { rowNumber: row.rowNumber, outcome: 'skipped', issues, entityId: prior };
    }

    if (this.ctx.dryRun) return { rowNumber: row.rowNumber, outcome: 'imported', issues };

    const client = this.tenantPrisma.getClientV2(this.ctx.tenant);
    const pinnedHold = this.pinnedHoldFor({ patronCategoryId: null, at: placedAt });
    // NEVER NULL FOR A COLLECTABLE HOLD, and this is the 1.0 audit's immortal
    // row restated in 2.0's shape. `expireShelf` filters `shelf_expires_at <
    // now`, and in Postgres NULL is never `< now` — so a shelved request with no
    // deadline can never be reached by the sweep. It holds its copy at
    // `awaiting_pickup` for ever, occupies the reader's one-live-hold slot, and
    // blocks every renewal of the title. Plenty of exports carry a status and no
    // expiry column, so the fallback is the resolved hold policy's own shelf
    // period rather than nothing.
    const usableExpiry =
      fileExpiresAt !== null && fileExpiresAt.getTime() > placedAt.getTime() ? fileExpiresAt : null;
    const shelfExpiresAt =
      usableExpiry ?? addDuration(this.timezone, placedAt, pinnedHold.shelfExpiry, null);
    const created = await client.$transaction(
      async (tx) => {
        // patron (1) then bib (2) — the ranked order, and the same `bib:` lock
        // domain `HoldsService.place` takes, so an import and a live placement
        // can never both claim one position.
        await acquireLocks(tx, [lockKey('patron', patronId), lockKey('bib', bibId)]);
        await setChangeActor(tx, changeActorOf(this.ctx.actor));

        // `holds_expiry_pair` is `(expired_at IS NULL) = (expired_kind IS NULL)`
        // and `holds_expired_kind_known` restricts the kind to `shelf | request`.
        // An imported expiry is a `request` one — the reader waited and was
        // never reached — because `shelf` means a copy sat on the hold shelf
        // uncollected, and an imported expired request never had a copy.
        const ended =
          status === 'canceled'
            ? { cancelledAt: fileExpiresAt ?? placedAt }
            : status === 'expired'
              ? { expiredAt: fileExpiresAt ?? placedAt, expiredKind: 'request' as const }
              : {};
        const waiting = Object.keys(ended).length === 0;

        // A READY hold needs a copy set aside for it — `holds_collectable_implies_assigned`
        // says so, and three live paths assume it. 1.0 CAS-claims a free copy
        // and demotes to queued when there is none; the same honest demotion
        // here, because a collectable hold with no copy is the immortal row the
        // 1.0 audit found (it occupied the reader's slot for ever and wedged
        // every renewal of the title).
        let assigned: { id: string } | null = null;
        if (waiting && status === 'ready') {
          const candidate = await tx.item.findFirst({
            where: { bibId, status: 'available', archivedAt: null },
            select: { id: true },
            orderBy: { id: 'asc' },
          });
          if (candidate !== null) {
            // THE ITEM LOCK. `applyWithin`'s contract is "the caller must
            // already hold `lockKey('item', itemId)`", and the bib lock is not
            // it: `ItemStatusService.transition`, `ItemTransfersService.send`
            // and `ItemsService.archive` all take the ITEM lock alone and no bib
            // lock, so a librarian marking this very copy missing, sending it in
            // transit or archiving it races this line. Taken here rather than up
            // there because the copy is not known until the bib lock is held —
            // and rank 3 after rank 2 keeps `locks.ts`'s total order intact.
            //
            // The re-read under it is what makes this a CAS rather than a hope.
            await acquireLocks(tx, [lockKey('item', candidate.id)]);
            assigned = await tx.item.findFirst({
              where: { id: candidate.id, status: 'available', archivedAt: null },
              select: { id: true },
            });
          }
          if (assigned === null) {
            issues.push({
              field: 'status',
              code: 'hold_demoted',
              severity: 'warning',
              message:
                'This request was ready in the old system but no copy is free to set aside, so ' +
                'it joined the queue instead. A collectable request with no copy behind it is a ' +
                'request nothing can ever hand over.',
            });
          }
        }

        if (waiting) {
          // `holds_one_live_per_patron_bib` is a partial unique over the live
          // rows. The duplicate probe above only sees EARLIER runs, so two live
          // requests for one reader and one title inside ONE file reach here —
          // which a source system can easily hold, having re-requested a title
          // that was never filled. Named, rather than left as a 23505 quoting an
          // index.
          const live = await tx.hold.findFirst({
            where: {
              bibId,
              patronId,
              fulfilledAt: null,
              cancelledAt: null,
              expiredAt: null,
            },
            select: { id: true },
          });
          if (live !== null) {
            throw new ImportRowError(
              'memberNumber',
              'This reader already has a live request for this title. A library keeps one — the ' +
                'second would be a place in the queue behind themselves.',
            );
          }
        }

        const collectable = assigned !== null;
        const queuePosition =
          waiting && !collectable ? await nextQueuePosition(tx as never, bibId) : null;

        const hold = await tx.hold.create({
          data: {
            bibId,
            patronId,
            pickupBranchId: this.branchId,
            level: 'title',
            queuePosition,
            placedAt,
            assignedItemId: assigned?.id ?? null,
            assignedAt: collectable ? placedAt : null,
            awaitingPickupSince: collectable ? placedAt : null,
            shelfExpiresAt: collectable ? shelfExpiresAt : null,
            notes: this.str(v['notes']),
            placedByUserId: null,
            holdPolicyId: pinnedHold.holdPolicyId,
            appliedRuleId: pinnedHold.appliedRuleId,
            policySnapshot: pinnedHold.snapshot as never,
            source: 'migration',
            customFields: row.customFields as never,
            createdAt: new Date(),
            updatedAt: new Date(),
            ...ended,
          } as never,
          select: { id: true },
        });

        if (collectable) {
          await this.status.applyWithin(tx, {
            itemId: assigned!.id,
            toStatus: 'awaiting_pickup',
            source: 'migration',
            causeType: 'hold',
            causeId: hold.id,
            note: 'imported hold, already on the shelf',
            now: placedAt,
          } as never);
        }
        return hold;
      },
      { isolationLevel: 'ReadCommitted' },
    );
    return { rowNumber: row.rowNumber, outcome: 'imported', issues, entityId: created.id };
  }

  /**
   * A charge the library already made — and, usually, already collected.
   *
   * THIS IS THE ROW THAT COSTS REAL PEOPLE MONEY, and 2.0 raises the stakes over
   * 1.0: a fine here is not one row, it is a fee plus a double-entry journal,
   * and a re-import that doubles it doubles a ledger. The weak key below is what
   * the 1.0 audit (data-integrity-02) was written for — it reproduced one 500c
   * row imported twice as two rows totalling 1000c, both reported as `imported`
   * with zero issues.
   *
   * ## An already-settled fine does not touch today's till
   *
   * A fine paid in 2019 went into a drawer that was counted and banked years
   * ago. Posting it to `cash_on_hand` now would inflate the trial balance of a
   * library that has just started keeping one by every fine it has ever taken.
   * So a historical settlement debits `opening_balance` — the account
   * `ledger_account` created for exactly this, "where a settlement that happened
   * BEFORE these books began is debited" — and a waiver debits `waiver_expense`.
   * That is the upgrade's choice, and it is the only correct one available:
   * `FeesService.settle` requires `owed_cents > 0` and derives its debit from a
   * payment method, which `payment_methods_settlement_is_asset` restricts to
   * cash/bank/card_clearing.
   *
   * ## Which revenue account
   *
   * From the FEE TYPE, not hardcoded. The upgrade credits `fine_revenue` for
   * every migrated fine including the ones it classified `feetype_replacement`,
   * whose seeded revenue account is `replacement_revenue`. It nets to zero
   * against its own cancellation leg so no identity catches it, but a migrated
   * library files lost-book replacements under overdue fines for ever. Recorded
   * in the divergence log against 19b; not repeated here.
   */
  private async commitFee(row: MappedRow, issues: RowIssue[]): Promise<EngineRowResult> {
    const v = row.values;
    const patronId = await this.resolvePatron(row.refs);
    if (patronId === null) {
      return this.missing(row, issues, 'memberNumber', 'No matching reader for this fine.');
    }
    const amountCents = this.num(v['amountCents']);
    if (amountCents === null || amountCents <= 0) {
      return this.error(
        row,
        issues,
        'amountCents',
        'A charge must be a positive amount of money — `fees_amount_positive` refuses the rest, ' +
          'and a zero-value fine is a note, not a debt.',
      );
    }
    const reason = this.str(v['reason']);
    if (reason === null) {
      return this.error(row, issues, 'reason', 'A charge needs a reason the reader can be told.');
    }
    // `char(3)`, upper case, and the account is keyed on it. A file saying
    // `Euro` is a 22001 naming no column; a file saying `eur` is worse — it is
    // ACCEPTED, opens a second `(patron, 'eur')` account beside the `(patron,
    // 'EUR')` one, and the reader's balance is then split across two accounts
    // that no screen adds together.
    const rawCurrency = this.str(v['currency']);
    const currency = rawCurrency === null ? this.currency : rawCurrency.toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) {
      return this.error(
        row,
        issues,
        'currency',
        `\`${rawCurrency}\` is not a currency code. It must be the three-letter ISO 4217 code — ` +
          '`EUR`, not `Euro` and not `€`.',
      );
    }
    const status = (this.str(v['status']) ?? 'outstanding') as 'outstanding' | 'paid' | 'waived';
    let settledAt = this.date(v['paidAt']);
    if (status !== 'outstanding' && settledAt === null) {
      settledAt = new Date();
      issues.push({
        field: 'paidAt',
        code: 'defaulted',
        severity: 'warning',
        message: 'Settled fine had no settlement date; used now.',
      });
    }
    if (status === 'outstanding') settledAt = null;

    if (status === 'outstanding' && !this.saidArrears) {
      this.saidArrears = true;
      issues.push({
        field: null,
        code: 'arrears_may_be_recharged',
        severity: 'warning',
        message:
          'Outstanding fines in this file are not linked to a loan — the import surface has no ' +
          'column for it — so the nightly overdue sweep cannot see that a still-open loan has ' +
          'already been charged, and will raise its own fine for it. Import arrears only for ' +
          'loans that are closed, or expect to waive the duplicates. Reported once for the file.',
      });
    }

    const prior = await this.priorFee(patronId, BigInt(amountCents), currency, reason, status);
    if (prior !== null) {
      if (this.ctx.duplicateMode === 'error') {
        return this.error(row, issues, 'amountCents', 'This fine was already imported.');
      }
      // NOT an update, and this is where 20d departs from 1.0. There, `update`
      // really updates, because a 1.0 fine is a bare row and correcting a paid
      // date is a scalar rewrite with no side effects. Here the row has a
      // journal behind it: changing the amount or the status would leave the
      // ledger stating the old one, and `postJournalWithin` has no un-post. A
      // correction is a reversal somebody makes deliberately at the desk.
      if (this.ctx.duplicateMode === 'update') {
        issues.push({
          field: null,
          code: 'duplicate_not_updated',
          severity: 'warning',
          message:
            'This fine already exists. A 2.0 fee carries a double-entry journal, so it is not ' +
            'rewritten on re-import — correct it at the desk, where the correction is posted as ' +
            'a reversal the accounts can show.',
        });
      }
      return { rowNumber: row.rowNumber, outcome: 'skipped', issues, entityId: prior };
    }

    if (this.ctx.dryRun) return { rowNumber: row.rowNumber, outcome: 'imported', issues };

    const client = this.tenantPrisma.getClientV2(this.ctx.tenant);
    const feeTypeId = /lost|replace|χαμέν|αντικατάστ/i.test(reason)
      ? 'feetype_replacement'
      : 'feetype_overdue';
    // WHEN THE CHARGE WAS MADE. `chargedAt` is a column phase 20d added to the
    // fine entity, because without one every imported fine is stamped with the
    // import instant — and its charge journal then credits revenue in the
    // CURRENT accounting period, so a library importing four years of arrears
    // sees its whole historical debt appear as this month's income.
    const createdAt = this.date(v['chargedAt']) ?? settledAt ?? new Date();
    const amount = BigInt(amountCents);

    const created = await client.$transaction(
      async (tx) => {
        await acquireLocks(tx, [lockKey('patron', patronId)]);
        const accountId = await this.ensureAccount(tx, patronId, currency);
        const feeType = await tx.feeType.findUnique({
          where: { id: feeTypeId },
          select: { revenueAccount: true },
        });
        const revenue = (feeType?.revenueAccount ?? 'fine_revenue') as Leg['account'];

        const fee = await tx.fee.create({
          data: {
            accountId,
            patronId,
            feeTypeId,
            currency,
            branchId: this.branchId,
            amountCents: amount,
            paidCents: status === 'paid' ? amount : 0n,
            waivedCents: status === 'waived' ? amount : 0n,
            status,
            reason,
            notes: this.str(v['notes']),
            createdAt,
            closedAt: status === 'outstanding' ? null : settledAt,
            // NOT accruing, and the comment that stood here claimed more than
            // it delivered. `is_accruing` false keeps the sweep from CONTINUING
            // this fine — which is right, it is a finished number from another
            // system — but it does not stop the sweep raising its OWN fine for
            // the same overdue loan, because `fees_one_open_accrual_per_loan` is
            // keyed on `loan_id` and an imported fee has none: the fine entity
            // carries no column linking it to a loan, in 1.0 or here. A library
            // that imports its open loans AND the arrears it had already
            // computed for them is charged twice, and the row says so.
            isAccruing: false,
            customFields: row.customFields as never,
          } as never,
          select: { id: true },
        });

        // The charge, at the instant the charge was made.
        await postJournalWithin(tx, {
          kind: 'charge',
          currency,
          branchId: this.branchId,
          source: 'migration',
          note: 'imported charge',
          now: createdAt,
          legs: [
            { account: 'patron_receivable', accountId, debit: amount, feeId: fee.id },
            { account: revenue, credit: amount, feeId: fee.id },
          ],
        });

        // The settlement, at the instant it was settled — against
        // `opening_balance`, never the till.
        if (status !== 'outstanding') {
          await postJournalWithin(tx, {
            kind: status === 'paid' ? 'payment' : 'waiver',
            currency,
            branchId: this.branchId,
            source: 'migration',
            note: `imported ${status === 'paid' ? 'payment' : 'waiver'}`,
            now: settledAt!,
            legs: [
              {
                account: status === 'paid' ? 'opening_balance' : 'waiver_expense',
                debit: amount,
                feeId: fee.id,
              },
              { account: 'patron_receivable', accountId, credit: amount, feeId: fee.id },
            ],
          }).then(async (journal) => {
            await tx.feeAllocation.create({
              data: {
                transactionId: journal.transactionId,
                feeId: fee.id,
                kind: status === 'paid' ? 'payment' : 'waiver',
                currency,
                amountCents: amount,
                createdAt: settledAt!,
              } as never,
            });
          });
        }
        return fee;
      },
      { isolationLevel: 'ReadCommitted' },
    );
    return { rowNumber: row.rowNumber, outcome: 'imported', issues, entityId: created.id };
  }

  // ---- resolvers ----------------------------------------------------------

  /**
   * The reader a row names.
   *
   * Card number FIRST, then email, which is 1.0's order. The middle step is new:
   * a library's "member number" column is very often the barcode printed on the
   * card rather than the system's own id, and 2.0 split those into `patrons.
   * patron_number` and `patron_cards.barcode_norm`. Trying both is what makes a
   * Koha or ABEKT export resolve at all — and `barcode_norm` is uppercase by
   * CHECK (`patron_cards_barcode_norm_shape`), so the lookup must uppercase too.
   */
  private async resolvePatron(refs: Record<string, string>): Promise<string | null> {
    const client = this.tenantPrisma.getClientV2(this.ctx.tenant);
    const number = this.str(refs['memberNumber']);
    if (number !== null) {
      const byNumber = await client.patron.findFirst({
        where: { patronNumber: number, erasedAt: null },
        select: { id: true },
        // `patrons_number_unique_active` is partial on `archived_at IS NULL`, so
        // a re-issued number CAN match two rows: the reader who left and the one
        // who got their number. Live first, then oldest, so the same file
        // resolves to the same reader on every run instead of to whichever row
        // the planner happened to return.
        orderBy: [{ archivedAt: 'asc' }, { createdAt: 'asc' }],
      });
      if (byNumber !== null) return byNumber.id;
      const byCard = await client.patronCard.findFirst({
        where: { barcodeNorm: number.toUpperCase(), retiredAt: null },
        select: { patronId: true },
      });
      if (byCard !== null) return byCard.patronId;
    }
    const email = this.str(refs['memberEmail']);
    if (email !== null) {
      // `patrons.email` is citext, so this is already case-insensitive in the
      // database — no `mode: 'insensitive'` needed, and asking for one would
      // silently switch the planner off the index.
      const byEmail = await client.patron.findFirst({
        where: { email, archivedAt: null, erasedAt: null },
        select: { id: true },
        orderBy: { createdAt: 'asc' },
      });
      if (byEmail !== null) return byEmail.id;
    }
    return null;
  }

  private async resolveItem(
    refs: Record<string, string>,
  ): Promise<{ id: string; bibId: string; itemTypeId: string; owningBranchId: string } | null> {
    const barcode = this.str(refs['copyBarcode']);
    if (barcode === null) return null;
    const client = this.tenantPrisma.getClientV2(this.ctx.tenant);
    const item = await client.item.findFirst({
      where: { barcode, archivedAt: null },
      select: { id: true, bibId: true, itemTypeId: true, owningBranchId: true },
    });
    return item as never;
  }

  /** ISBN-13 first, then the folded title — 1.0's order, against 2.0's projection. */
  private async resolveBib(refs: Record<string, string>): Promise<string | null> {
    const client = this.tenantPrisma.getClientV2(this.ctx.tenant);
    const isbn = this.str(refs['bookIsbn13']);
    if (isbn !== null) {
      const byIsbn = await client.bibIdentifier.findFirst({
        where: { valueNorm: isbn.replace(/[^0-9Xx]/g, '').toUpperCase() },
        select: { bibId: true },
        orderBy: { bibId: 'asc' },
      });
      if (byIsbn !== null) return byIsbn.bibId;
    }
    const title = this.str(refs['bookTitle']);
    if (title !== null) {
      const byTitle = await client.bibRecord.findFirst({
        where: { title: { equals: title, mode: 'insensitive' } },
        select: { bibId: true },
        orderBy: { bibId: 'asc' },
      });
      if (byTitle !== null) return byTitle.bibId;
    }
    return null;
  }

  // ---- re-import safety ---------------------------------------------------
  //
  // Every key below is WEAK — the tuple of fields that make two rows
  // indistinguishable to a librarian — and every one is bounded by
  // `createdAt < runStartedAt`, so it can only ever match a row from an EARLIER
  // run. Two identical rows inside one file are two real events and both import.
  //
  // The trade is 1.0's, restated because it is a judgement call: two genuinely
  // distinct events identical in every keyed field collapse into one, counted
  // and visible as `skipped`. What the alternative ships is silent duplication
  // of a reader's debt with no marker and no undo.

  /**
   * A loan this import already wrote.
   *
   * KEYED WITHOUT THE READER, which is the one place this cannot copy 1.0. A
   * closed loan is anonymised on the way in (see the file docblock), so its
   * `patron_id` is NULL by the time a second run looks for it, and a key naming
   * the patron would match nothing and double every returned loan.
   *
   * `(item_id, loaned_at)` is not a weaker answer for having lost that column —
   * it is a stronger one. Two readers cannot borrow one copy at one instant, so
   * for any row whose file carried a checkout date this is effectively a natural
   * key. Only a file with no checkout-date column falls back to the tuple.
   */
  private async priorLoan(
    itemId: string,
    loanedAt: Date,
    dueAt: Date,
    fromFile: boolean,
  ): Promise<string | null> {
    const client = this.tenantPrisma.getClientV2(this.ctx.tenant);
    const found = await client.loan.findFirst({
      where: {
        itemId,
        ...(fromFile ? { loanedAt } : { dueAt }),
        createdAt: { lt: this.runStartedAt },
      },
      select: { id: true },
    });
    return found?.id ?? null;
  }

  private async priorHold(
    bibId: string,
    patronId: string,
    placedAt: Date,
    fromFile: boolean,
  ): Promise<string | null> {
    const client = this.tenantPrisma.getClientV2(this.ctx.tenant);
    const found = await client.hold.findFirst({
      where: {
        bibId,
        patronId,
        ...(fromFile ? { placedAt } : {}),
        createdAt: { lt: this.runStartedAt },
      },
      select: { id: true },
    });
    return found?.id ?? null;
  }

  /**
   * A fee this import already wrote.
   *
   * `paidAt` is deliberately NOT in the key, exactly as in 1.0: a file whose
   * settlement dates were defaulted to `now` on the first run would never match
   * itself on the second, and the whole point of the key is the row that costs
   * money.
   */
  private async priorFee(
    patronId: string,
    amountCents: bigint,
    currency: string,
    reason: string,
    status: string,
  ): Promise<string | null> {
    const client = this.tenantPrisma.getClientV2(this.ctx.tenant);
    const found = await client.fee.findFirst({
      where: {
        patronId,
        amountCents,
        currency,
        reason,
        status: status as never,
        archivedAt: null,
        createdAt: { lt: this.runStartedAt },
      },
      select: { id: true },
    });
    return found?.id ?? null;
  }

  // ---- small pieces -------------------------------------------------------

  private async itemHasOpenLoan(itemId: string): Promise<boolean> {
    if (this.openedLoans.has(itemId)) return true;
    const client = this.tenantPrisma.getClientV2(this.ctx.tenant);
    const open = await client.loan.findFirst({
      where: { itemId, closedAt: null },
      select: { id: true },
    });
    return open !== null;
  }

  /**
   * The reader's account for this currency, created if it is not there.
   *
   * EAGER, and the upgrade's laziness is why. `02-post-catalog.sql` creates an
   * account only for patrons who already had a 1.0 fine, and
   * `overdue-accrual.service.ts` returns null — charging nothing, reporting
   * nothing — when it cannot find one. So a migrated library silently stops
   * charging overdue fines for every reader who happened never to have been
   * fined. Recorded in the divergence log against 19b; an imported fee creates
   * its account here so the same hole is not dug twice.
   */
  private async ensureAccount(tx: TxLike, patronId: string, currency: string): Promise<string> {
    const existing = await tx.patronAccount.findFirst({
      where: { patronId, currency },
      select: { id: true },
    });
    if (existing !== null) return existing.id;
    const made = await tx.patronAccount.create({
      data: { patronId, currency, openedAt: new Date() } as never,
      select: { id: true },
    });
    return made.id;
  }

  /**
   * The three columns that outlive the reader's link, plus the band.
   *
   * Read BEFORE the write and passed in, because for an anonymised loan this is
   * the only chance: once `patron_id` is NULL there is no row left to derive a
   * date of birth from.
   */
  private async statisticalBuckets(patronId: string): Promise<{
    categoryId: string;
    categoryCode: string | null;
    homeBranchId: string | null;
    ageBandAt: (at: Date) => string;
  }> {
    const client = this.tenantPrisma.getClientV2(this.ctx.tenant);
    const patron = await client.patron.findUnique({
      where: { id: patronId },
      select: { patronCategoryId: true, homeBranchId: true, dateOfBirth: true },
    });
    const branch = await client.branch.findUnique({
      where: { id: this.branchId },
      select: { timezone: true },
    });
    const tz = branch?.timezone ?? 'Europe/Athens';
    const dob = patron?.dateOfBirth ?? null;
    return {
      categoryId: patron?.patronCategoryId ?? DEFAULT_PATRON_CATEGORY,
      categoryCode: patron?.patronCategoryId ?? null,
      homeBranchId: patron?.homeBranchId ?? null,
      ageBandAt: (at: Date) => ageBandAt(dob, at, tz),
    };
  }

  /**
   * A REAL pinned snapshot, and the place 20d refuses to copy the upgrade.
   *
   * `02-post-catalog.sql` pins one tenant-wide blob —
   * `{migratedFrom: '1.0', loanPeriodDays, maxRenewals, finePerDayCents,
   * currency}` — on every migrated loan and hold. That is not a snapshot 2.0 can
   * read back. `readPinnedPolicy` requires `v: 1` plus `loan`, `overdueFine`,
   * `lostItemFee` and a `timezone`, and the blob has none of the five, so EVERY
   * migrated loan throws `PinnedSnapshotError` on the detail screen, on renew,
   * on checkin, and is skipped by the overdue sweep. Verifier E04 only asserts
   * the column is not `'{}'`, so nothing catches it. The error message wrote the
   * requirement down in advance: "A migration owes it a shape it understands."
   * Recorded against 19b in the divergence log.
   *
   * So an imported row gets a genuine resolution. What that DOES and DOES NOT
   * claim is the careful part:
   *
   *   - It does NOT decide the due date. The file carries that, and `rolls` is
   *     empty because no calendar rolled it — this loan's dates are facts from
   *     another system, not outputs of this matrix.
   *   - It DOES say which rule governs the loan from here on: what a renewal
   *     costs in days, what the overdue accrual charges, what a lost copy is
   *     billed at. Those are questions asked in the FUTURE of an imported loan,
   *     and a library that imports its open loans needs every one of them
   *     answerable at the desk on Monday.
   *
   * `resolvedAt` is the import instant, which is exactly what the type's own
   * comment allows — "when the resolution happened, which is not always
   * `loaned_at`".
   */
  private pinnedFor(input: {
    itemTypeId: string | null;
    owningBranchId: string | null;
    locationId: string | null;
    patronCategoryId: string | null;
    at: Date;
  }): { snapshot: Record<string, unknown>; ids: ResolvedPolicyIds } {
    if (this.policy === null) throw new Error('The policy snapshot was not loaded by init().');
    const resolved = resolveCirculationPolicy(this.policy, {
      patronCategoryId: input.patronCategoryId,
      itemTypeId: input.itemTypeId,
      owningBranchId: input.owningBranchId,
      shelvingLocationId: input.locationId,
      checkoutBranchId: this.branchId,
      at: input.at,
    });
    const ids: ResolvedPolicyIds = {
      loanPolicyId: resolved.loan.id,
      overdueFinePolicyId: resolved.overdueFine.id,
      lostItemFeePolicyId: resolved.lostItemFee.id,
      appliedRuleId: resolved.trace.matchedRuleId,
    };
    const snapshot = pinPolicy({
      resolved,
      resolvedAt: input.at,
      branchId: this.branchId,
      timezone: this.timezone,
      calendarId: this.calendarId,
      itemTypeId: input.itemTypeId,
      patronCategoryId: input.patronCategoryId,
      // EMPTY, deliberately. `rolls` records the closed days a computed due date
      // was pushed over; this due date was not computed, so claiming a roll
      // would put a calendar decision behind a number the file supplied.
      rolls: [],
    }) as unknown as Record<string, unknown>;
    return { snapshot, ids };
  }

  /** The same, for a request. `holds` pins its own shape and its own version. */
  private pinnedHoldFor(input: { patronCategoryId: string | null; at: Date }): {
    snapshot: Record<string, unknown>;
    holdPolicyId: string;
    appliedRuleId: string;
    shelfExpiry: Duration;
  } {
    if (this.policy === null) throw new Error('The policy snapshot was not loaded by init().');
    const resolved = resolveCirculationPolicy(this.policy, {
      patronCategoryId: input.patronCategoryId,
      itemTypeId: null,
      owningBranchId: null,
      shelvingLocationId: null,
      checkoutBranchId: this.branchId,
      at: input.at,
    });
    return {
      snapshot: pinHoldPolicy({
        resolved,
        resolvedAt: input.at,
        branchId: this.branchId,
        timezone: this.timezone,
        calendarId: this.calendarId,
        itemTypeId: null,
        patronCategoryId: input.patronCategoryId,
        pickupBranchIds: [this.branchId],
      }) as unknown as Record<string, unknown>,
      holdPolicyId: resolved.hold.id,
      appliedRuleId: resolved.trace.matchedRuleId,
      shelfExpiry: resolved.hold.holdShelfExpiry,
    };
  }

  /** A reference the row named and the library does not have. */
  private missing(
    row: MappedRow,
    issues: RowIssue[],
    field: string,
    message: string,
  ): EngineRowResult {
    issues.push({ field, code: 'reference_not_found', message, severity: 'error' });
    return { rowNumber: row.rowNumber, outcome: 'error', issues };
  }

  private date(v: unknown): Date | null {
    if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
    const s = this.str(v);
    if (s === null) return null;
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  // -------------------------------------------------------------------------

  /**
   * Authors from the book row.
   *
   * 1.0 accepts `author`, `author2`… and a semicolon list; both shapes reach
   * here as mapped values, and order decides the main entry. A row with none is
   * not an error — a great many records have no 1XX at all, and MARC says so.
   */
  private authorsFrom(v: Record<string, unknown>): V1Author[] {
    const names: string[] = [];
    const single = this.str(v['author']);
    if (single !== null)
      names.push(
        ...single
          .split(';')
          .map((s) => s.trim())
          .filter(Boolean),
      );
    for (let i = 2; i <= 6; i += 1) {
      const extra = this.str(v[`author${i}`]);
      if (extra !== null) names.push(extra);
    }
    return names.map((fullName, order) => ({
      // Never stored: `marcFromBook` carries an author's id into $0 so a later
      // authority pass can find the original row. An imported author has no
      // original row, so this is a placeholder and phase 45 will match on the
      // name like it will for every other unlinked heading.
      id: randomUUID(),
      fullName,
      isOrganization: false,
      birthYear: null,
      deathYear: null,
      order,
      role: null,
    }));
  }

  /** A kind 2.0 has no home for. Named, so the operator knows what to do next. */
  private refuse(
    row: MappedRow,
    issues: RowIssue[],
    field: string,
    message: string,
  ): EngineRowResult {
    issues.push({ field, code: 'import.kindNotSupported', message, severity: 'error' });
    return { rowNumber: row.rowNumber, outcome: 'error', issues };
  }

  /** A row this kind cannot use. */
  private error(
    row: MappedRow,
    issues: RowIssue[],
    field: string,
    message: string,
  ): EngineRowResult {
    issues.push({ field, code: 'import.rowInvalid', message, severity: 'error' });
    return { rowNumber: row.rowNumber, outcome: 'error', issues };
  }

  /**
   * A database error, as an issue on the row that caused it.
   *
   * Not `import-engine.ts`'s `dbIssue`: that one names `books.isbn13` and
   * `authors.sortName` by hand, and 2.0 has neither table. The unique keys a
   * 2.0 import collides with are `items.barcode`, `patron_cards.barcode_norm`
   * and `marc_records_control_number_unique_active`, so the target Prisma
   * reports is more use to a librarian than any wording written in advance —
   * and an unrecognised error keeps its own message rather than being flattened
   * into "something went wrong".
   */
  private dbIssue(err: unknown): RowIssue {
    const message = (err as { message?: string }).message ?? String(err);
    if ((err as { code?: string }).code === 'P2002') {
      const target = (err as { meta?: { target?: unknown } }).meta?.target;
      const named = Array.isArray(target)
        ? target.join(', ')
        : typeof target === 'string'
          ? target
          : null;
      return {
        field: null,
        code: 'duplicate',
        severity: 'error',
        message:
          named === null
            ? "Another record in this library already holds one of this row's unique values."
            : `Another record in this library already holds this row's ${named}.`,
      };
    }
    return { field: null, code: 'db_error', severity: 'error', message };
  }

  private str(v: unknown): string | null {
    if (typeof v !== 'string') return null;
    const t = v.trim();
    return t.length === 0 ? null : t;
  }

  private num(v: unknown): number | null {
    if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
    if (typeof v === 'string' && v.trim().length > 0) {
      const n = Number(v);
      return Number.isFinite(n) ? Math.trunc(n) : null;
    }
    return null;
  }
}
