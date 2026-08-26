/**
 * Import engine — the write side.
 *
 * Takes already-mapped rows (typed values + custom fields + foreign natural
 * keys) and either VALIDATES them (dry run, no writes) or COMMITS them into
 * the tenant DB. Every row is processed independently and idempotently:
 *
 *   - references are resolved by natural key (book by ISBN/title, member by
 *     number/email, copy by barcode), with per-run caches;
 *   - authors are find-or-created by normalized name so a catalogue import
 *     doesn't spawn duplicate author rows — a promise that was pure prose
 *     until data-integrity-06 put `authors_sortname_unique_active` behind it
 *     (and `books_isbn13_unique_active` behind the book key, -03);
 *   - duplicates (matched on the entity's natural key) are skipped, updated,
 *     or flagged per the batch's `duplicateMode`;
 *   - integer quotas (`max_books`, `max_members`) are enforced against a
 *     running projection while the ceiling is far away, and against the
 *     database — inside the row's transaction, behind the same advisory lock
 *     the UI's create path takes — once it is close (data-integrity-04);
 *   - the same normalization (`searchText`/`sortName`), member-number
 *     generation, custom-field validation, and DB CHECK constraints the
 *     manual UI relies on are reused verbatim — there is no second write path.
 *
 * A failing row never aborts the batch: it yields an `error` outcome with
 * precise issues and the engine moves on, so 9,900 clean rows import even when
 * 100 are dirty.
 *
 * THE RE-IMPORT CONTRACT (data-integrity-02).
 * "Idempotently" above used to be an aspiration, not a property. The engine
 * deduplicated only rows that HAD a natural key it looked up, and four kinds
 * had none: `commitFine` was a bare `fine.create`, `commitLoan` blocked only a
 * duplicate ACTIVE loan, `commitReservation` relied on a partial unique index
 * covering only `queued`/`ready`, `commitBook` matched on `isbn13` alone and
 * `commitMember` on memberNumber/email alone. Nothing recorded per-row
 * progress, so any second pass over the file re-committed everything.
 *
 * The auditor ran this engine twice over the same one-row payload with the
 * SAFEST setting, duplicateMode='skip', and got FINES rows = 2, total = 1000c
 * for a file that said 500c. A librarian whose 20,000-row import dies at row
 * 12,000 has one obvious action — send the file again — and doing so doubled
 * every patron's outstanding debt, with no marker distinguishing the
 * duplicate, no de-duplication tool and no undo. Bulk import is the onboarding
 * path for every new library.
 *
 * So EVERY kind now has a natural key; `IMPORT_NATURAL_KEYS` below names them,
 * and test/integration/import-reimport.spec.ts uploads the same file twice
 * through the real routes and asserts the tenant's row counts — and the total
 * cents on its fines — do not move. See the "re-import safety" section for the
 * weak-key trade and why the `createdAt < runStartedAt` boundary is what keeps
 * a first-time import behaving exactly as it did.
 *
 * Two ways that contract was still broken when this comment was first written,
 * both now covered by that spec: the boundary was read with a bare `SELECT
 * NOW()`, which comes back a whole UTC offset away from the `createdAt` values
 * it is compared with (see `readDbClock`); and the loan/hold keys were built
 * from a timestamp the committer had just invented for the row, so any file
 * without a checkout-date or placed-date column duplicated anyway.
 */
import type { ImportEntityKind } from '@libriant/db-control';
import type {
  FieldEntityKind,
  Prisma,
  ReservationStatus,
  TenantPrismaClient,
} from '@libriant/db-tenant';
import type { FeatureKey } from '@libriant/shared';
import { buildSearchText, normalizeText } from '../../catalog/normalize.js';
import { validateRecord } from '../../customization/dynamic-validator.js';
import type { FieldDef, FieldOptions, FieldValidation } from '../../customization/field-types.js';
import { buildMemberNumber, nextSequenceForYear } from '../../members/member-numbers.js';
import type { MappedRow, RowIssue } from '../mapping/row-mapper.js';

export type EngineContext = {
  client: TenantPrismaClient;
  tenantId: string;
  /** Effective integer limit for a quota feature (plan ← override). */
  getLimit: (feature: FeatureKey) => Promise<number>;
  duplicateMode: 'skip' | 'update' | 'error';
  /** When true, validate + resolve only — no writes. */
  dryRun: boolean;
};

/**
 * Just enough of a tenant transaction client to take the quota lock and count
 * behind it. Narrow on purpose: this is the only thing the quota code may do
 * with the caller's transaction.
 */
type QuotaTx = Pick<Prisma.TransactionClient, '$executeRaw' | 'book' | 'member'>;

/**
 * How close the projection has to get to the ceiling before every remaining
 * claim is settled against the database. See `claimQuotaWithinTx` for why the
 * alternative — settling all 250,000 possible rows — is worse than the bug.
 *
 * 50 is chosen against the writer this defends from: staff cataloguing at a
 * desk while an import runs. The overshoot the old code allowed was exactly the
 * number of such writes; the zone has to be comfortably larger than that number
 * for one import, and 50 books arriving by hand during a single import is not a
 * library, it is a second import.
 */
const QUOTA_EXACT_ZONE = 50;

/**
 * Raised by `claimQuotaWithinTx` inside the row's transaction, so the write it
 * guards rolls back with it. Caught by the committer, which turns it into the
 * row's `quota_exceeded` issue — the same one the projection gate produces, so
 * a librarian reads one message whichever gate refused the row.
 */
class QuotaExceededError extends Error {
  constructor() {
    super('quota exceeded');
    this.name = 'QuotaExceededError';
  }
}

export type EngineRowResult = {
  rowNumber: number;
  outcome: 'imported' | 'updated' | 'skipped' | 'error';
  entityId?: string;
  issues: RowIssue[];
};

export type ImportSummary = {
  total: number;
  imported: number;
  updated: number;
  skipped: number;
  errorRows: number;
  warningRows: number;
};

const FIELD_ENTITY_KINDS = new Set<FieldEntityKind>([
  'book',
  'book_copy',
  'member',
  'loan',
  'reservation',
  'fine',
]);

/**
 * What makes re-committing the same row a no-op, stated per entity kind.
 *
 * Not documentation for its own sake: `import.service.ts` lets a `failed`
 * batch be re-run on the strength of this claim, and for four of the seven
 * kinds the claim was simply false (data-integrity-02). Writing it down where
 * the compiler can see it means an eighth entity kind cannot be added without
 * its author answering the question — `Record<ImportEntityKind, …>` fails to
 * compile with a key missing. What the committers do with those keys is proved
 * by execution over the real upload/commit routes in
 * test/integration/import-reimport.spec.ts, not by this table.
 *
 * "Strong" = a key the library itself uses to identify the record.
 * "Weak" = a tuple that makes two rows indistinguishable to a librarian; only
 * consulted when the strong key is absent, and only against records that
 * predate this run.
 */
export const IMPORT_NATURAL_KEYS: Record<ImportEntityKind, string> = {
  author: 'strong: sortName (normalized full name) — DB-enforced by authors_sortname_unique_active',
  book: 'strong: isbn13, DB-enforced by books_isbn13_unique_active — weak: sortTitle + publicationYear',
  book_copy: 'strong: barcode (required on every row)',
  member: 'strong: memberNumber, then email — weak: sortName + dateOfBirth',
  loan: 'weak: copyId + memberId + loanedAt — no checkout date: copyId + memberId + dueAt + status',
  reservation:
    'weak: bookId + memberId + placedAt — no placed date: bookId + memberId + live status (queued and ready are ONE slot, see findPriorReservation)',
  fine: 'weak: memberId + amountCents + currency + reason + status',
};

/**
 * A Prisma client capable of author find/create — either the engine's own
 * client or a `$transaction` tx (IMP-04: authors are resolved inside the book
 * transaction so they roll back with a failed book write).
 */
type AuthorWriter = TenantPrismaClient | Prisma.TransactionClient;

function issue(
  field: string | null,
  code: string,
  message: string,
  severity: 'error' | 'warning' = 'error',
): RowIssue {
  return { field, code, message, severity };
}

/**
 * The two partial unique indexes added by
 * 20260826090000_catalog_natural_key_uniqueness (data-integrity-03 / -06). A
 * P2002 naming one of them means "someone else created this exact record
 * between our lookup and our write" — the duplicate path, not an error.
 *
 * Each key lists the INDEX name and the COLUMN name, because which of the two
 * Prisma hands back is not something to guess at. MEASURED against the shipped
 * Prisma 7.9.1 on the audit Postgres, by provoking a real violation of each
 * index and printing the caught error:
 *
 *   book.isbn13      code=P2002  meta.target=undefined
 *                    message="… Unique constraint failed on the fields: (`isbn13`)"
 *   author.sortName  code=P2002  meta.target=undefined
 *                    message="… Unique constraint failed on the fields: (`\"sortName\"`)"
 *
 * `meta.target` is UNDEFINED and the index name appears NOWHERE. A matcher
 * written against the index name alone — which is what this was on its first
 * pass, and it looked perfectly correct — silently never fires, so every lost
 * race degrades into a failed row carrying the generic "(barcode/number)"
 * message. The integration spec runs four concurrent imports of one row through
 * this, which is what caught it.
 */
const BOOK_ISBN_UNIQUE = ['books_isbn13_unique_active', 'isbn13'] as const;
const AUTHOR_SORTNAME_UNIQUE = ['authors_sortname_unique_active', 'sortName'] as const;

/** True when `err` is a Prisma unique violation on one of `key`'s spellings. */
function isUniqueViolationOn(err: unknown, key: readonly string[]): boolean {
  if ((err as { code?: string }).code !== 'P2002') return false;
  const target = (err as { meta?: { target?: unknown } }).meta?.target;
  const targetText = Array.isArray(target) ? target.join(',') : String(target ?? '');
  const haystack = `${targetText} ${(err as { message?: string }).message ?? ''}`.toLowerCase();
  return key.some((token) => haystack.includes(token.toLowerCase()));
}

/** Map a raw Prisma write error to a row issue with a friendly message. */
function dbIssue(err: unknown): RowIssue {
  const code = (err as { code?: string }).code;
  const message = (err as { message?: string }).message ?? String(err);
  if (code === 'P2002') {
    // data-integrity-03 / -06: `books.isbn13` and `authors.sortName` are now
    // unique too, so the old blanket "(barcode/number)" wording would send a
    // librarian hunting the wrong column. Name the key that actually collided.
    if (isUniqueViolationOn(err, BOOK_ISBN_UNIQUE)) {
      return issue(
        'isbn13',
        'duplicate',
        'Another book in the catalogue already has this ISBN-13.',
      );
    }
    if (isUniqueViolationOn(err, AUTHOR_SORTNAME_UNIQUE)) {
      return issue(
        'fullName',
        'duplicate',
        'Another author with the same normalized name already exists.',
      );
    }
    return issue(
      null,
      'duplicate',
      'A record with a unique value (barcode/number) already exists.',
    );
  }
  const m = message.match(/violates check constraint "([^"]+)"/);
  if (m) return issue(null, 'db_rejected', `The database rejected the row (${m[1]}).`);
  const fk = message.match(/violates foreign key constraint/);
  if (fk) return issue(null, 'db_rejected', 'A linked record was missing when writing the row.');
  return issue(null, 'db_error', message.slice(0, 300));
}

export class ImportEngine {
  private fieldDefs: FieldDef[] = [];
  private currency = 'EUR';
  /**
   * The library's pickup window, in hours (`tenant_settings.holdPickupHours`).
   * data-integrity-05: an imported `ready` hold whose file carried no expiry
   * date got `expiresAt = NULL`, and `expiresAt < now` is never true for NULL,
   * so the expiry sweep could never reach it — the hold was immortal. Every
   * ready hold this engine writes now carries a deadline, from the same setting
   * the live pickup path uses.
   */
  private holdPickupHours = 48;

  private quotaFeature: FeatureKey | null = null;
  /**
   * The run's PROJECTION of usage: seeded from a live count in `init()` and
   * moved by one per row. It is what the dry run reports from — nothing is
   * written there, so there is nothing to settle against — and outside the
   * exact zone (see {@link QUOTA_EXACT_ZONE}) it is what the commit pass
   * spends. `claimQuotaWithinTx` resets it to the truth whenever it counts.
   */
  private quotaUsed = 0;
  private quotaLimit = Number.POSITIVE_INFINITY;
  /**
   * Latched the first time the DATABASE says, under the quota lock, that the
   * ceiling is reached. Without it, every remaining row of a 250,000-row file
   * would re-count a table nothing indexes to be told the same thing; a slot
   * freed mid-import by someone archiving a book is not worth that.
   */
  private quotaFull = false;

  /**
   * The instant this run began, read from the DATABASE clock (see
   * `readDbClock`). Weak natural keys only match records created BEFORE it —
   * that boundary is what separates "this file already ran once" from "this
   * file legitimately contains two identical rows".
   */
  private runStartedAt = new Date();

  private readonly authorCache = new Map<string, string>();
  private readonly bookByIsbn = new Map<string, string | null>();
  private readonly bookByTitle = new Map<string, string | null>();
  private readonly memberByNumber = new Map<string, string | null>();
  private readonly memberByEmail = new Map<string, string | null>();
  private readonly copyByBarcode = new Map<string, string | null>();
  // IMP-05: copies that already carry an active loan within this run. Seeds the
  // one-active-loan-per-copy check during the dry-run too, where the would-be
  // loans aren't written to the DB yet.
  private readonly activeLoanCopies = new Set<string>();
  /**
   * data-integrity-05, dry-run only: how many copies of a book are still free
   * for a `ready` hold to claim. The commit pass needs no such bookkeeping —
   * claiming a copy flips it to `reserved` in the DB — but the validate pass
   * writes nothing, so without this every ready row in a file would be told the
   * same single copy is available and the report would promise more pickups
   * than the commit can deliver.
   */
  private readonly dryRunFreeCopies = new Map<string, number>();

  constructor(
    private readonly kind: ImportEntityKind,
    private readonly ctx: EngineContext,
  ) {}

  async init(): Promise<void> {
    // data-integrity-02: fix the boundary FIRST, before a single row is
    // committed. Everything the weak natural keys do depends on being able to
    // tell a row this run wrote from a row that was already in the library.
    this.runStartedAt = await this.readDbClock();

    if (FIELD_ENTITY_KINDS.has(this.kind as FieldEntityKind)) {
      const rows = await this.ctx.client.fieldDefinition.findMany({
        where: { entityKind: this.kind as FieldEntityKind, archivedAt: null },
        orderBy: { sortOrder: 'asc' },
      });
      this.fieldDefs = rows.map((r) => ({
        fieldKey: r.fieldKey,
        type: r.type,
        required: r.required,
        optionsJson: (r.optionsJson as FieldOptions | null) ?? null,
        validationJson: (r.validationJson as FieldValidation | null) ?? null,
      }));
    }
    const settings = await this.ctx.client.tenantSetting.findUnique({ where: { id: 1 } });
    this.currency = settings?.currency ?? 'EUR';
    if (settings?.holdPickupHours && settings.holdPickupHours > 0) {
      this.holdPickupHours = settings.holdPickupHours;
    }

    if (this.kind === 'book') this.quotaFeature = 'max_books';
    else if (this.kind === 'member') this.quotaFeature = 'max_members';
    if (this.quotaFeature) {
      this.quotaUsed = await this.countQuotaUsage(this.ctx.client);
      // Resolved once per run, not once per row: the LIMIT is a plan value
      // behind a Redis cache, and the thing that goes stale during an import is
      // the usage, not the ceiling. A plan change mid-import applies to the
      // next one.
      this.quotaLimit = await this.ctx.getLimit(this.quotaFeature);
    }
  }

  async processRow(mapped: MappedRow): Promise<EngineRowResult> {
    const issues: RowIssue[] = [...mapped.issues];
    if (issues.some((i) => i.severity === 'error')) {
      return { rowNumber: mapped.rowNumber, outcome: 'error', issues };
    }

    // Custom-field validation against the tenant's live definitions.
    let customFields = mapped.customFields;
    if (Object.keys(customFields).length && this.fieldDefs.length) {
      const res = validateRecord(this.fieldDefs, customFields, {
        unknownFields: 'reject',
        partial: true,
      });
      if (!res.ok) {
        for (const e of res.errors) issues.push(issue(e.field, 'custom_invalid', e.message));
        return { rowNumber: mapped.rowNumber, outcome: 'error', issues };
      }
      customFields = res.cleaned;
    }

    try {
      return await this.commit({ ...mapped, customFields }, issues);
    } catch (err) {
      issues.push(dbIssue(err));
      return { rowNumber: mapped.rowNumber, outcome: 'error', issues };
    }
  }

  private async commit(row: MappedRow, issues: RowIssue[]): Promise<EngineRowResult> {
    switch (this.kind) {
      case 'author':
        return this.commitAuthor(row, issues);
      case 'book':
        return this.commitBook(row, issues);
      case 'book_copy':
        return this.commitCopy(row, issues);
      case 'member':
        return this.commitMember(row, issues);
      case 'loan':
        return this.commitLoan(row, issues);
      case 'reservation':
        return this.commitReservation(row, issues);
      case 'fine':
        return this.commitFine(row, issues);
    }
  }

  // ---- quota -------------------------------------------------------------

  /**
   * The cheap gate, off the projection. Answers "this run has already spent the
   * ceiling" without a query, which is what the dry run needs (it writes
   * nothing, so there is nothing to settle against) and what stops the commit
   * pass opening a transaction per row for a file that is already over.
   *
   * It is NOT the enforcement — see {@link claimQuotaWithinTx}, which is.
   */
  private quotaBlocked(issues: RowIssue[]): boolean {
    if (this.quotaUsed >= this.quotaLimit) {
      issues.push(this.quotaIssue());
      return true;
    }
    return false;
  }

  private quotaIssue(): RowIssue {
    return issue(
      null,
      'quota_exceeded',
      `Plan limit reached for ${this.quotaFeature} (${this.quotaLimit}).`,
    );
  }

  /**
   * Current usage, counted with the SAME predicate the UI path counts by
   * (`QUOTA_COUNTERS` in plans/quota-counters.ts). Two paths that disagree
   * about what counts as a book are two different ceilings.
   */
  private async countQuotaUsage(db: Pick<QuotaTx, 'book' | 'member'>): Promise<number> {
    if (this.quotaFeature === 'max_books') return db.book.count({ where: { archivedAt: null } });
    if (this.quotaFeature === 'max_members') {
      return db.member.count({ where: { archivedAt: null, status: { not: 'archived' } } });
    }
    return 0;
  }

  /**
   * Claim one slot of the run's integer quota INSIDE the caller's transaction,
   * throwing {@link QuotaExceededError} when the ceiling refuses it.
   *
   * data-integrity-04. The projection this engine spends is seeded once and
   * then blind: every other create path counts inside
   * `QuotaService.enforceWithinTx`, behind `pg_advisory_xact_lock` on
   * `quota:<tenant>:<feature>:<context>`, and the import joined neither the
   * lock nor the count. A librarian cataloguing three arrivals at the desk
   * during a 10,000-row import was simply invisible to it, so the import
   * admitted its full quota on top of theirs and the library ended the day over
   * its plan ceiling with nothing in the report to say so. Reproduced at
   * test/integration/import-quota-lock.spec.ts: eight books against a ceiling
   * of five, deterministically.
   *
   * Settling EVERY row against the database was the finding's own suggested
   * fix, and it is the one thing this must not do. `count(*)` on `books` is a
   * sequential scan of a table nothing indexes — measured in-tree at 13,333
   * buffers / 67.7 ms on a 400,000-title library (see quota.interceptor.ts,
   * performance-05) — and `IMPORT_MAX_ROWS` is 250,000. That is hours added to
   * the onboarding path for every new library, to defend a ceiling the run is
   * nowhere near.
   *
   * So: count when it matters. While the projection is more than
   * {@link QUOTA_EXACT_ZONE} slots from the ceiling, no lock and no count —
   * being wrong there is being wrong by a margin nobody is standing on. Once
   * inside the zone, every remaining claim takes the lock, counts, and RESETS
   * the projection to the truth, so drift accumulated outside the zone is
   * corrected before it can be spent rather than carried into the ceiling.
   */
  private async claimQuotaWithinTx(tx: QuotaTx): Promise<void> {
    if (!this.quotaFeature) return;
    if (this.quotaFull) throw new QuotaExceededError();
    if (this.quotaLimit - this.quotaUsed > QUOTA_EXACT_ZONE) return;
    // Byte-for-byte the key QuotaService builds (`lockContext ?? ''` — hence
    // the trailing colon). A different string hashes to a different lock and
    // serialises nothing.
    const lockKey = `quota:${this.ctx.tenantId}:${this.quotaFeature}:`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;
    this.quotaUsed = await this.countQuotaUsage(tx);
    if (this.quotaUsed >= this.quotaLimit) {
      this.quotaFull = true;
      throw new QuotaExceededError();
    }
  }

  private result(
    row: MappedRow,
    outcome: EngineRowResult['outcome'],
    issues: RowIssue[],
    entityId?: string,
  ): EngineRowResult {
    return { rowNumber: row.rowNumber, outcome, issues, entityId };
  }

  // ---- author ------------------------------------------------------------
  private async commitAuthor(row: MappedRow, issues: RowIssue[]): Promise<EngineRowResult> {
    const fullName = row.values.fullName as string;
    const sortName = normalizeText(fullName);
    const existing = await this.findAuthorId(sortName);
    if (existing) return this.resolveAuthorDuplicate(row, issues, existing, fullName);
    if (this.ctx.dryRun) return this.result(row, 'imported', issues);
    try {
      const created = await this.ctx.client.author.create({
        data: { fullName, sortName, ...this.authorData(row) },
        select: { id: true },
      });
      this.authorCache.set(sortName, created.id);
      return this.result(row, 'imported', issues, created.id);
    } catch (err) {
      // data-integrity-06: another writer (a concurrent import, or a librarian
      // adding the author in the UI) won the race between our lookup above and
      // this create. `authors_sortname_unique_active` refuses the second row —
      // which is the point — so fold this row into the duplicate path it would
      // have taken had the lookup been a moment later, instead of failing it.
      if (!isUniqueViolationOn(err, AUTHOR_SORTNAME_UNIQUE)) throw err;
      this.authorCache.delete(sortName);
      const winner = await this.findAuthorId(sortName);
      if (!winner) throw err;
      return this.resolveAuthorDuplicate(row, issues, winner, fullName);
    }
  }

  /**
   * What `duplicateMode` means once we know an author already exists. Shared by
   * the pre-write lookup and the lost-race recovery so the two cannot drift.
   */
  private async resolveAuthorDuplicate(
    row: MappedRow,
    issues: RowIssue[],
    existing: string,
    fullName: string,
  ): Promise<EngineRowResult> {
    if (this.ctx.duplicateMode === 'error') {
      issues.push(issue('fullName', 'duplicate', `Author "${fullName}" already exists.`));
      return this.result(row, 'error', issues);
    }
    if (this.ctx.duplicateMode === 'skip') return this.result(row, 'skipped', issues, existing);
    if (!this.ctx.dryRun) {
      await this.ctx.client.author.update({
        where: { id: existing },
        data: this.authorData(row),
      });
    }
    return this.result(row, 'updated', issues, existing);
  }

  private authorData(row: MappedRow) {
    const v = row.values;
    return {
      isOrganization: (v.isOrganization as boolean | undefined) ?? undefined,
      birthYear: (v.birthYear as number | undefined) ?? undefined,
      deathYear: (v.deathYear as number | undefined) ?? undefined,
      notes: (v.notes as string | undefined) ?? undefined,
      customFields: row.customFields as Prisma.InputJsonValue,
    };
  }

  // ---- book --------------------------------------------------------------
  private async commitBook(row: MappedRow, issues: RowIssue[]): Promise<EngineRowResult> {
    const v = row.values;
    const isbn13 = (v.isbn13 as string | undefined) ?? null;
    // data-integrity-02: an ISBN-less book had NO duplicate check at all — the
    // lookup was simply skipped — so re-importing a catalogue grew a second
    // copy of every such title (and burned a second `max_books` slot). Greek
    // library exports are full of pre-ISBN and locally-catalogued items, so
    // this is the common row, not the exotic one.
    const existingId = isbn13
      ? await this.findBookByIsbn(isbn13)
      : await this.findPriorBookByTitle(
          v.title as string,
          (v.publicationYear as number | undefined) ?? null,
        );

    if (existingId) return this.resolveBookDuplicate(row, issues, existingId, isbn13);

    if (this.quotaBlocked(issues)) return this.result(row, 'error', issues);
    if (this.ctx.dryRun) {
      this.quotaUsed++;
      return this.result(row, 'imported', issues);
    }
    try {
      // The slot is claimed inside this write's own transaction (see
      // `writeBook`), so the projection only moves for a row that really
      // landed — which also retires the `quotaUsed--` this branch used to need
      // after a lost ISBN race.
      const id = await this.writeBook(row, null);
      this.quotaUsed++;
      if (isbn13) this.bookByIsbn.set(isbn13, id);
      return this.result(row, 'imported', issues, id);
    } catch (err) {
      if (err instanceof QuotaExceededError) {
        issues.push(this.quotaIssue());
        return this.result(row, 'error', issues);
      }
      // data-integrity-03: `books_isbn13_unique_active` refuses the second
      // record for an ISBN, so a writer that lost the lookup-then-create race
      // lands here. That is exactly the duplicate case, so take the duplicate
      // path rather than reporting a row error.
      if (!isbn13 || !isUniqueViolationOn(err, BOOK_ISBN_UNIQUE)) throw err;
      this.bookByIsbn.delete(isbn13);
      const winner = await this.findBookByIsbn(isbn13);
      if (!winner) throw err;
      return this.resolveBookDuplicate(row, issues, winner, isbn13);
    }
  }

  /**
   * What `duplicateMode` means once we know a book already exists. Shared by
   * the pre-write lookup and the lost-race recovery so the two cannot drift.
   */
  private async resolveBookDuplicate(
    row: MappedRow,
    issues: RowIssue[],
    existingId: string,
    isbn13: string | null,
  ): Promise<EngineRowResult> {
    if (this.ctx.duplicateMode === 'error') {
      // Name the key that actually matched. Since the ISBN-less weak key was
      // added this branch is reachable with `isbn13 === null`, and the old
      // message then read "A book with ISBN null already exists." — which
      // sends the librarian looking for an ISBN column that isn't there.
      issues.push(
        isbn13
          ? issue('isbn13', 'duplicate', `A book with ISBN ${isbn13} already exists.`)
          : issue(
              'title',
              'duplicate',
              `A book titled "${row.values.title as string}" from the same year already exists.`,
            ),
      );
      return this.result(row, 'error', issues);
    }
    if (this.ctx.duplicateMode === 'skip') return this.result(row, 'skipped', issues, existingId);
    if (!this.ctx.dryRun) await this.writeBook(row, existingId);
    return this.result(row, 'updated', issues, existingId);
  }

  private async writeBook(row: MappedRow, existingId: string | null): Promise<string> {
    const v = row.values;
    const title = v.title as string;
    const subtitle = (v.subtitle as string | undefined) ?? null;
    const isbn13 = (v.isbn13 as string | undefined) ?? null;
    const isbn10 = (v.isbn10 as string | undefined) ?? null;
    const publisher = (v.publisher as string | undefined) ?? null;
    const publicationYear = (v.publicationYear as number | undefined) ?? null;
    const authorNames = (v.authors as string[] | undefined) ?? [];

    const sortTitle = normalizeText(title);
    const searchText = buildSearchText([
      title,
      subtitle,
      ...authorNames,
      publisher,
      isbn13,
      isbn10,
      publicationYear,
    ]);
    const scalar = {
      title,
      subtitle,
      sortTitle,
      searchText,
      isbn13,
      isbn10,
      publisher,
      publicationYear,
      language: (v.language as string | undefined) ?? null,
      edition: (v.edition as string | undefined) ?? null,
      numPages: (v.numPages as number | undefined) ?? null,
      description: (v.description as string | undefined) ?? null,
      classification: (v.classification as string | undefined) ?? null,
      customFields: row.customFields as Prisma.InputJsonValue,
    };

    // IMP-04: resolve/create authors INSIDE the book's transaction using the tx
    // client, so a failed book write rolls back any author rows it just created
    // (no orphan Author rows). Track sortNames created in this tx so we can drop
    // their (now rolled-back) cache entries if the transaction throws.
    //
    // data-integrity-06: TWO attempts, not one. `authors_sortname_unique_active`
    // makes a lost find-then-create race raise P2002 instead of writing a second
    // author row, and that P2002 aborts this whole transaction — including the
    // book write, which had nothing wrong with it. The winner's author row is
    // committed by the time we get here, so a second attempt with the stale
    // cache entries purged simply finds it. Without the retry, a librarian
    // adding an author in the UI at the moment an import mentions them would
    // lose the whole book row, which is a worse import than the duplicate this
    // constraint exists to prevent.
    for (let attempt = 0; ; attempt++) {
      const createdSortNames: string[] = [];
      try {
        return await this.ctx.client.$transaction(async (tx) => {
          // data-integrity-04: FIRST statement of the transaction that writes
          // the row, exactly as `QuotaService.enforceWithinTx` is the first
          // statement of every UI create — the lock and the count are worth
          // nothing if the insert can commit outside them. Updates claim
          // nothing: an existing book already holds its slot.
          if (!existingId) await this.claimQuotaWithinTx(tx);
          const authorIds: string[] = [];
          for (const name of authorNames) {
            authorIds.push(await this.findOrCreateAuthor(name, tx, createdSortNames));
          }
          if (existingId) {
            await tx.book.update({ where: { id: existingId }, data: scalar });
            if (authorIds.length) {
              await tx.bookAuthor.deleteMany({ where: { bookId: existingId } });
              await tx.bookAuthor.createMany({
                data: authorIds.map((authorId, i) => ({ bookId: existingId, authorId, order: i })),
              });
            }
            return existingId;
          }
          const created = await tx.book.create({
            data: {
              ...scalar,
              authors: { create: authorIds.map((authorId, i) => ({ authorId, order: i })) },
            },
            select: { id: true },
          });
          return created.id;
        });
      } catch (err) {
        // The transaction rolled back, so any author rows it created no longer
        // exist — purge their cache entries or later rows would reference ids the
        // DB doesn't have.
        for (const sortName of createdSortNames) this.authorCache.delete(sortName);
        if (attempt === 0 && isUniqueViolationOn(err, AUTHOR_SORTNAME_UNIQUE)) continue;
        throw err;
      }
    }
  }

  // ---- copy --------------------------------------------------------------
  private async commitCopy(row: MappedRow, issues: RowIssue[]): Promise<EngineRowResult> {
    const bookId = await this.resolveBook(row.refs);
    if (!bookId) {
      issues.push(
        issue(
          'bookIsbn13',
          'reference_not_found',
          'No matching book (by ISBN or title) for this copy. Import books first.',
        ),
      );
      return this.result(row, 'error', issues);
    }
    const barcode = row.values.barcode as string;
    const existing = await this.findCopyByBarcode(barcode);
    if (existing) {
      if (this.ctx.duplicateMode === 'error') {
        issues.push(issue('barcode', 'duplicate', `Barcode ${barcode} already exists.`));
        return this.result(row, 'error', issues);
      }
      if (this.ctx.duplicateMode === 'skip') return this.result(row, 'skipped', issues, existing);
      if (!this.ctx.dryRun) {
        await this.ctx.client.bookCopy.update({
          where: { id: existing },
          data: this.copyData(row),
        });
      }
      return this.result(row, 'updated', issues, existing);
    }
    if (this.ctx.dryRun) return this.result(row, 'imported', issues);
    const created = await this.ctx.client.bookCopy.create({
      data: { bookId, barcode, ...this.copyData(row) },
      select: { id: true },
    });
    this.copyByBarcode.set(barcode, created.id);
    return this.result(row, 'imported', issues, created.id);
  }

  private copyData(row: MappedRow) {
    const v = row.values;
    return {
      status: (v.status as 'available' | undefined) ?? 'available',
      shelfLocation: (v.shelfLocation as string | undefined) ?? null,
      conditionNotes: (v.conditionNotes as string | undefined) ?? null,
      acquiredAt: v.acquiredAt ? new Date(v.acquiredAt as string) : null,
      priceCents: (v.priceCents as number | undefined) ?? null,
      customFields: row.customFields as Prisma.InputJsonValue,
    };
  }

  // ---- member ------------------------------------------------------------
  private async commitMember(row: MappedRow, issues: RowIssue[]): Promise<EngineRowResult> {
    const v = row.values;
    const number = (v.memberNumber as string | undefined)?.trim();
    const email = (v.email as string | undefined) ?? null;
    const existing = number
      ? await this.findMemberByNumber(number)
      : email
        ? await this.findMemberByEmail(email)
        : // data-integrity-02: a member row carrying neither a number nor an
          // email had no duplicate check, and `generateMemberNumber()` mints a
          // FRESH number on every pass — so the same patron came back as a
          // different person on a retry. A doubled membership roll also eats
          // the `max_members` quota twice.
          await this.findPriorMemberByName(row);

    if (existing) {
      if (this.ctx.duplicateMode === 'error') {
        issues.push(issue('memberNumber', 'duplicate', 'This member already exists.'));
        return this.result(row, 'error', issues);
      }
      if (this.ctx.duplicateMode === 'skip') return this.result(row, 'skipped', issues, existing);
      if (!this.ctx.dryRun) {
        await this.ctx.client.member.update({
          where: { id: existing },
          data: this.memberData(row),
        });
      }
      return this.result(row, 'updated', issues, existing);
    }

    if (this.quotaBlocked(issues)) return this.result(row, 'error', issues);
    if (this.ctx.dryRun) {
      this.quotaUsed++;
      return this.result(row, 'imported', issues);
    }

    // Minted outside the transaction: `nextSequenceForYear` maintains its own
    // counter row, and running it inside would nest a write the quota lock is
    // already holding open. The cost is that a row refused by the ceiling below
    // leaves a gap in the member numbers — at most one per run, because the
    // refusal latches — and a gap in member numbers is not a defect.
    const memberNumber = number || (await this.generateMemberNumber());
    let created: { id: string };
    try {
      created = await this.ctx.client.$transaction(async (tx) => {
        // data-integrity-04: same lock domain, same transaction as the insert.
        await this.claimQuotaWithinTx(tx);
        return tx.member.create({
          data: { memberNumber, ...this.memberData(row) },
          select: { id: true },
        });
      });
    } catch (err) {
      if (err instanceof QuotaExceededError) {
        issues.push(this.quotaIssue());
        return this.result(row, 'error', issues);
      }
      throw err;
    }
    this.quotaUsed++;
    if (number) this.memberByNumber.set(number, created.id);
    if (email) this.memberByEmail.set(email.toLowerCase(), created.id);
    return this.result(row, 'imported', issues, created.id);
  }

  private memberData(row: MappedRow) {
    const v = row.values;
    const fullName = v.fullName as string;
    const sortName = normalizeText(fullName);
    const email = (v.email as string | undefined) ?? null;
    const searchText = buildSearchText([
      fullName,
      sortName,
      email,
      v.phone as string | undefined,
      v.city as string | undefined,
    ]);
    return {
      fullName,
      sortName,
      searchText,
      email,
      phone: (v.phone as string | undefined) ?? null,
      dateOfBirth: v.dateOfBirth ? new Date(`${v.dateOfBirth as string}T00:00:00Z`) : null,
      addressLine1: (v.addressLine1 as string | undefined) ?? null,
      addressLine2: (v.addressLine2 as string | undefined) ?? null,
      city: (v.city as string | undefined) ?? null,
      postalCode: (v.postalCode as string | undefined) ?? null,
      country: (v.country as string | undefined) ?? null,
      status: (v.status as 'active' | undefined) ?? 'active',
      staffNotes: (v.staffNotes as string | undefined) ?? null,
      joinedAt: v.joinedAt ? new Date(`${v.joinedAt as string}T00:00:00Z`) : undefined,
      customFields: row.customFields as Prisma.InputJsonValue,
    };
  }

  private async generateMemberNumber(): Promise<string> {
    const year = new Date().getUTCFullYear();
    for (let attempt = 0; attempt < 5; attempt++) {
      const seq = await nextSequenceForYear(this.ctx.client, year);
      const candidate = buildMemberNumber(year, seq);
      const taken = await this.ctx.client.member.findFirst({
        where: { memberNumber: candidate },
        select: { id: true },
      });
      if (!taken) return candidate;
    }
    return buildMemberNumber(year, Date.now() % 100000);
  }

  // ---- loan --------------------------------------------------------------
  private async commitLoan(row: MappedRow, issues: RowIssue[]): Promise<EngineRowResult> {
    const memberId = await this.resolveMember(row.refs);
    if (!memberId) {
      issues.push(
        issue('memberNumber', 'reference_not_found', 'No matching member for this loan.'),
      );
      return this.result(row, 'error', issues);
    }
    const copyId = await this.resolveCopy(row.refs);
    if (!copyId) {
      issues.push(issue('copyBarcode', 'reference_not_found', 'No matching copy for this loan.'));
      return this.result(row, 'error', issues);
    }
    const v = row.values;
    const status = (v.status as 'active' | 'returned' | 'lost' | undefined) ?? 'active';
    // Keep "what the FILE said" and "what we are about to write" apart. The
    // second is a per-run invention when the column is absent, and feeding an
    // invention to the duplicate check is what let closed loans double.
    const fileLoanedAt = v.loanedAt ? new Date(v.loanedAt as string) : null;
    const loanedAt = fileLoanedAt ?? new Date();
    const dueAt = new Date(v.dueAt as string);
    if (dueAt.getTime() <= loanedAt.getTime()) {
      issues.push(issue('dueAt', 'invalid_value', 'Due date must be after the checkout date.'));
      return this.result(row, 'error', issues);
    }
    let returnedAt: Date | null = v.returnedAt ? new Date(v.returnedAt as string) : null;
    if (status === 'returned' && !returnedAt) {
      returnedAt = new Date();
      issues.push(
        issue('returnedAt', 'defaulted', 'Returned loan had no return date; used now.', 'warning'),
      );
    }
    if (returnedAt && returnedAt.getTime() < loanedAt.getTime()) {
      issues.push(issue('returnedAt', 'invalid_value', 'Return date is before the checkout date.'));
      return this.result(row, 'error', issues);
    }

    // data-integrity-02: a CLOSED loan (returned/lost) had no duplicate check
    // whatsoever — the one-active-loan-per-copy guard below covers `active`
    // only — so re-importing a circulation history doubled every past loan,
    // and with it every statistic built on loan counts. Same copy, same
    // member, same checkout instant is the same loan.
    const priorLoan = await this.findPriorLoan(copyId, memberId, fileLoanedAt, dueAt, status);
    if (priorLoan) {
      if (this.ctx.duplicateMode === 'error') {
        issues.push(issue('copyBarcode', 'duplicate', 'This loan was already imported.'));
        return this.result(row, 'error', issues);
      }
      if (this.ctx.duplicateMode === 'update') {
        // `update` degrades to `skip` here on purpose. Rewriting a historical
        // loan means replaying its side effects — flipping the copy's status,
        // and for a status change the fines hanging off it. That is a data
        // migration, not an import, and doing it silently from a spreadsheet
        // is worse than not doing it. Say so on the row rather than pretending
        // an update happened.
        issues.push(
          issue(
            null,
            'duplicate_not_updated',
            'This loan already exists; existing loans are not rewritten on re-import.',
            'warning',
          ),
        );
      }
      return this.result(row, 'skipped', issues, priorLoan);
    }

    // IMP-05: enforce the one-active-loan-per-copy invariant the rest of the app
    // assumes. A copy may have at most one open loan, so refuse to open a second
    // active loan against a copy that already has one — whether the existing
    // loan is in the DB (pre-existing) or was opened earlier in THIS run.
    if (status === 'active' && (await this.copyHasActiveLoan(copyId))) {
      issues.push(issue('copyBarcode', 'invalid_value', 'This copy already has an active loan.'));
      return this.result(row, 'error', issues);
    }

    if (this.ctx.dryRun) {
      // Track within-file so a second active loan on this copy is flagged in the
      // same dry-run, even though nothing is written.
      if (status === 'active') this.activeLoanCopies.add(copyId);
      return this.result(row, 'imported', issues);
    }

    const data: Prisma.LoanUncheckedCreateInput = {
      copyId,
      memberId,
      loanedAt,
      dueAt,
      status,
      returnedAt: status === 'returned' ? returnedAt : null,
      renewedCount: (v.renewedCount as number | undefined) ?? 0,
      notes: (v.notes as string | undefined) ?? null,
      customFields: row.customFields as Prisma.InputJsonValue,
    };
    const created = await this.ctx.client.$transaction(async (tx) => {
      const loan = await tx.loan.create({ data, select: { id: true } });
      if (status === 'active') {
        // IMP-05: only flip a copy that isn't already lent. A non-zero count
        // also confirms we didn't silently clobber another active loan's
        // on_loan owner; on a lost race throw to roll the row back.
        const flipped = await tx.bookCopy.updateMany({
          where: { id: copyId, status: { in: ['available', 'reserved'] } },
          data: { status: 'on_loan' },
        });
        if (flipped.count === 0) {
          throw new Error('copy is not available for an active loan');
        }
      } else if (status === 'lost') {
        await tx.bookCopy.update({ where: { id: copyId }, data: { status: 'lost' } });
      }
      return loan;
    });
    if (status === 'active') this.activeLoanCopies.add(copyId);
    return this.result(row, 'imported', issues, created.id);
  }

  /** True when the copy already has an open loan (this run or in the DB). IMP-05. */
  private async copyHasActiveLoan(copyId: string): Promise<boolean> {
    if (this.activeLoanCopies.has(copyId)) return true;
    const existing = await this.ctx.client.loan.findFirst({
      where: { copyId, status: 'active' },
      select: { id: true },
    });
    return existing !== null;
  }

  // ---- reservation -------------------------------------------------------
  private async commitReservation(row: MappedRow, issues: RowIssue[]): Promise<EngineRowResult> {
    const memberId = await this.resolveMember(row.refs);
    if (!memberId) {
      issues.push(
        issue('memberNumber', 'reference_not_found', 'No matching member for this hold.'),
      );
      return this.result(row, 'error', issues);
    }
    const bookId = await this.resolveBook(row.refs);
    if (!bookId) {
      issues.push(issue('bookIsbn13', 'reference_not_found', 'No matching book for this hold.'));
      return this.result(row, 'error', issues);
    }
    const v = row.values;
    const status =
      (v.status as 'queued' | 'ready' | 'fulfilled' | 'expired' | 'canceled' | undefined) ??
      'queued';
    if (status === 'fulfilled') {
      issues.push(issue('status', 'unsupported', 'Fulfilled holds can’t be imported as history.'));
      return this.result(row, 'error', issues);
    }
    // Same split as the loan above: the placed date the FILE supplied (null
    // when it has no such column) is the only one the duplicate check may use.
    const filePlacedAt = v.placedAt ? new Date(v.placedAt as string) : null;
    const placedAt = filePlacedAt ?? new Date();
    const now = new Date();

    // data-integrity-02: `reservations_one_active_per_book_member` is a PARTIAL
    // unique index — `WHERE status IN ('queued','ready')` — so every resolved,
    // expired or cancelled hold re-imported cleanly and silently doubled. Same
    // book, same member, same instant it was placed is the same hold.
    const priorHold = await this.findPriorReservation(bookId, memberId, filePlacedAt, status);
    if (priorHold) {
      if (this.ctx.duplicateMode === 'error') {
        issues.push(issue('bookIsbn13', 'duplicate', 'This hold was already imported.'));
        return this.result(row, 'error', issues);
      }
      if (this.ctx.duplicateMode === 'update') {
        // Same reasoning as loans: re-writing a hold means re-deriving its
        // queue position against the live queue, which is a circulation
        // operation and not something a re-uploaded file should trigger.
        issues.push(
          issue(
            null,
            'duplicate_not_updated',
            'This hold already exists; existing holds are not rewritten on re-import.',
            'warning',
          ),
        );
      }
      return this.result(row, 'skipped', issues, priorHold);
    }

    const baseData = {
      bookId,
      memberId,
      placedAt,
      canceledAt: status === 'canceled' ? now : null,
      notes: (v.notes as string | undefined) ?? null,
      customFields: row.customFields as Prisma.InputJsonValue,
    } satisfies Omit<
      Prisma.ReservationUncheckedCreateInput,
      'queuePosition' | 'status' | 'readyAt' | 'expiresAt'
    >;

    // ---- data-integrity-05: a READY hold has to own a copy -----------------
    //
    // THE BUG. This branch used to write `status:'ready'` with `readyAt` set,
    // `fulfilledByCopyId` left NULL and no copy flipped to `reserved`. Three
    // downstream paths assume a ready hold owns a copy, and all three break:
    //
    //   - LoansService.checkout refuses the pickup, because it compares
    //     `reservation.fulfilledByCopyId !== input.copyId` and NULL never
    //     matches the copy the patron is standing there holding;
    //   - ReservationsService.resolveReservation only frees a copy when
    //     `fulfilledByCopyId` is set, so cancelling releases nothing;
    //   - the expiry sweep filters `expiresAt: { lt: now }`, and a NULL
    //     `expiresAt` — which is what a file with no expiry column produces —
    //     is never `< now` in Postgres, so the sweep can never reach it.
    //
    // The hold was therefore IMMORTAL: it occupied the member's
    // `reservations_one_active_per_book_member` slot forever, and
    // `LoansService.renew` refuses every renewal of that title for every member
    // while any queued/ready hold exists. Importing an existing library's hold
    // list — the whole purpose of this importer — wedged renewals on each
    // affected title until a staff member found and cancelled each hold by hand.
    //
    // THE FIX, mirroring the live allocation paths exactly: take the shared
    // `book:<bookId>` advisory lock (A7-01 — placement, promote-on-return,
    // promote-on-expiry, cancel-expire and this importer are one lock domain),
    // claim a free copy with a CAS, and give the hold a real pickup deadline.
    // If no copy is free, the honest answer is not "ready" — it is a QUEUED
    // hold at the back of the line, reported as a warning on the row so the
    // librarian sees which of their ready holds could not be honoured.
    if (status === 'ready') {
      return this.commitReadyHold(row, issues, baseData, {
        bookId,
        readyAt: placedAt > now ? placedAt : now,
        fileExpiresAt: v.expiresAt ? new Date(v.expiresAt as string) : null,
      });
    }

    if (this.ctx.dryRun) return this.result(row, 'imported', issues);

    // import-new-reservation: a queued hold's position used to come from a
    // per-run cache seeded once by an aggregate, which collides with positions
    // assigned by the live reservations service during a concurrent import.
    // Compute it inside a transaction holding the same per-book advisory lock
    // those paths use, re-reading the max under the lock so positions stay
    // unique + contiguous. Non-queued holds carry no position, so they skip it.
    if (status !== 'queued') {
      const created = await this.ctx.client.reservation.create({
        data: {
          ...baseData,
          status,
          readyAt: null,
          expiresAt: v.expiresAt ? new Date(v.expiresAt as string) : null,
          queuePosition: null,
        },
        select: { id: true },
      });
      return this.result(row, 'imported', issues, created.id);
    }

    const created = await this.ctx.client.$transaction(async (tx) => {
      // Serialize against the LIVE hold-placement path so an import and a
      // concurrent reservation can't assign the same queuePosition. A7-01: ALL
      // per-book copy-allocation paths (place / promote-on-return / promote-on-
      // expiry / cancel-expire / this import) now share ONE `book:<bookId>` lock
      // domain, so they all mutually exclude — not just import-vs-placement.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`book:${bookId}`}, 0))`;
      const agg = await tx.reservation.aggregate({
        where: { bookId, status: 'queued' },
        _max: { queuePosition: true },
      });
      const queuePosition = (agg._max.queuePosition ?? 0) + 1;
      return tx.reservation.create({
        data: {
          ...baseData,
          status: 'queued',
          readyAt: null,
          expiresAt: v.expiresAt ? new Date(v.expiresAt as string) : null,
          queuePosition,
        },
        select: { id: true },
      });
    });
    return this.result(row, 'imported', issues, created.id);
  }

  /**
   * Write one imported `ready` hold, or honestly demote it (data-integrity-05).
   *
   * Everything that makes a ready hold real happens here: the per-book advisory
   * lock, the CAS claim on an `available` copy, `fulfilledByCopyId`, and an
   * `expiresAt` that the expiry sweep can actually match.
   */
  private async commitReadyHold(
    row: MappedRow,
    issues: RowIssue[],
    baseData: Omit<
      Prisma.ReservationUncheckedCreateInput,
      'queuePosition' | 'status' | 'readyAt' | 'expiresAt'
    >,
    hold: { bookId: string; readyAt: Date; fileExpiresAt: Date | null },
  ): Promise<EngineRowResult> {
    const { bookId, readyAt, fileExpiresAt } = hold;

    // `reservations_expires_after_ready` is a DB CHECK (`expiresAt > readyAt`),
    // so a file whose expiry date is on/before the ready instant used to fail
    // the row outright with an opaque db_rejected issue. Default it instead and
    // say so — an unusable date is a data-quality problem in the source export,
    // not a reason to drop the patron's hold.
    const usable = fileExpiresAt !== null && fileExpiresAt.getTime() > readyAt.getTime();
    const expiresAt = usable
      ? fileExpiresAt!
      : new Date(readyAt.getTime() + this.holdPickupHours * 3_600_000);
    // Held, not pushed: a hold that ends up QUEUED has no pickup window at all,
    // so "we defaulted your expiry date" would be noise stacked on top of the
    // message that actually matters. The row's issue list is assembled once,
    // after the outcome is known.
    const expiryWarning = usable
      ? null
      : issue(
          'expiresAt',
          'defaulted',
          fileExpiresAt
            ? `The expiry date is not after the pickup-ready date; used the library's ${this.holdPickupHours}-hour pickup window instead.`
            : `Hold had no expiry date; it will expire ${this.holdPickupHours} hours after it became ready, per the library's pickup window.`,
          'warning',
        );

    if (this.ctx.dryRun) {
      // The validate pass must predict the demotion, or the librarian only
      // finds out after the commit. Copies claimed by earlier ready rows in
      // THIS file are counted too, since nothing is written to make them
      // unavailable to the next row.
      if (await this.claimDryRunCopy(bookId)) {
        if (expiryWarning) issues.push(expiryWarning);
      } else {
        issues.push(this.demotedIssue());
      }
      return this.result(row, 'imported', issues);
    }

    const outcome = await this.ctx.client.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`book:${bookId}`}, 0))`;
      const candidate = await tx.bookCopy.findFirst({
        where: { bookId, status: 'available', archivedAt: null },
        orderBy: { createdAt: 'asc' },
        select: { id: true },
      });
      if (candidate) {
        // CAS on status='available', exactly as promoteNextHoldInTx does. The
        // advisory lock should already have made this uncontended; a zero count
        // means an unlocked writer got in, and we must not strand the copy.
        const claimed = await tx.bookCopy.updateMany({
          where: { id: candidate.id, status: 'available' },
          data: { status: 'reserved' },
        });
        if (claimed.count === 1) {
          const created = await tx.reservation.create({
            data: {
              ...baseData,
              status: 'ready',
              readyAt,
              expiresAt,
              fulfilledByCopyId: candidate.id,
              queuePosition: null,
            },
            select: { id: true },
          });
          return { id: created.id, demoted: false as const };
        }
      }
      // No free copy: queue the hold at the back of the line rather than
      // writing an orphan `ready` row nobody can ever hand over. Same locked
      // max+1 the queued branch uses, so positions stay unique + contiguous.
      const agg = await tx.reservation.aggregate({
        where: { bookId, status: 'queued' },
        _max: { queuePosition: true },
      });
      const queuePosition = (agg._max.queuePosition ?? 0) + 1;
      const created = await tx.reservation.create({
        data: {
          ...baseData,
          status: 'queued',
          readyAt: null,
          expiresAt: null,
          queuePosition,
        },
        select: { id: true },
      });
      return { id: created.id, demoted: true as const, queuePosition };
    });

    if (outcome.demoted) issues.push(this.demotedIssue(outcome.queuePosition));
    else if (expiryWarning) issues.push(expiryWarning);
    return this.result(row, 'imported', issues, outcome.id);
  }

  private demotedIssue(queuePosition?: number): RowIssue {
    return issue(
      'status',
      'downgraded_to_queued',
      queuePosition === undefined
        ? 'No copy of this book is free, so this hold will be imported as queued, not ready for pickup.'
        : `No copy of this book was free, so this hold was imported as queued at position ${queuePosition} instead of ready for pickup.`,
      'warning',
    );
  }

  /**
   * Dry-run accounting for `commitReadyHold`. Returns true when a copy would
   * still be free for this book, and consumes it so a second ready row in the
   * same file does not also claim it.
   */
  private async claimDryRunCopy(bookId: string): Promise<boolean> {
    let free = this.dryRunFreeCopies.get(bookId);
    if (free === undefined) {
      free = await this.ctx.client.bookCopy.count({
        where: { bookId, status: 'available', archivedAt: null },
      });
    }
    if (free <= 0) {
      this.dryRunFreeCopies.set(bookId, 0);
      return false;
    }
    this.dryRunFreeCopies.set(bookId, free - 1);
    return true;
  }

  // ---- fine --------------------------------------------------------------
  private async commitFine(row: MappedRow, issues: RowIssue[]): Promise<EngineRowResult> {
    const memberId = await this.resolveMember(row.refs);
    if (!memberId) {
      issues.push(
        issue('memberNumber', 'reference_not_found', 'No matching member for this fine.'),
      );
      return this.result(row, 'error', issues);
    }
    const v = row.values;
    const status = (v.status as 'outstanding' | 'paid' | 'waived' | undefined) ?? 'outstanding';
    let paidAt: Date | null = v.paidAt ? new Date(v.paidAt as string) : null;
    if (status === 'paid' && !paidAt) {
      paidAt = new Date();
      issues.push(issue('paidAt', 'defaulted', 'Paid fine had no paid date; used now.', 'warning'));
    }
    if (status === 'outstanding') paidAt = null;

    const data = {
      memberId,
      amountCents: v.amountCents as number,
      currency: (v.currency as string | undefined) ?? this.currency,
      reason: v.reason as string,
      status,
      paidAt,
      notes: (v.notes as string | undefined) ?? null,
      customFields: row.customFields as Prisma.InputJsonValue,
    };

    // data-integrity-02. THE ROW THAT COSTS REAL PEOPLE MONEY.
    //
    // This was a bare `fine.create` with no dedupe and `loanId` left NULL, so
    // the `fines_one_outstanding_per_loan` partial unique index — which is
    // `WHERE status = 'outstanding' AND "loanId" IS NOT NULL` — never applied
    // to an imported fine. Re-uploading the file after a failure doubled every
    // patron's debt, and nothing in the row said which of the two was the
    // duplicate. The auditor reproduced it: one 500c row imported twice became
    // 2 rows totalling 1000c, both reported as 'imported' with zero issues.
    const priorFine = await this.findPriorFine(data);
    if (priorFine) {
      if (this.ctx.duplicateMode === 'error') {
        issues.push(issue('amountCents', 'duplicate', 'This fine was already imported.'));
        return this.result(row, 'error', issues);
      }
      if (this.ctx.duplicateMode === 'skip') return this.result(row, 'skipped', issues, priorFine);
      // `update` IS meaningful for a fine — it is a plain scalar rewrite, no
      // side effects to replay — so a librarian correcting a paid date or a
      // reason by re-uploading gets what they asked for.
      if (!this.ctx.dryRun) {
        await this.ctx.client.fine.update({ where: { id: priorFine }, data });
      }
      return this.result(row, 'updated', issues, priorFine);
    }

    if (this.ctx.dryRun) return this.result(row, 'imported', issues);

    const created = await this.ctx.client.fine.create({ data, select: { id: true } });
    return this.result(row, 'imported', issues, created.id);
  }

  // ---- re-import safety (data-integrity-02) ------------------------------
  //
  // Every committer above answers ONE question before it creates anything:
  // "is this row already in the library from an EARLIER run?"
  //
  // For author / book_copy / most books / most members the answer comes from a
  // STRONG natural key the library itself uses to identify the record. The
  // four kinds that had no such key — fines, closed loans, resolved holds, and
  // any book or member whose row is missing its strong key — use a WEAK key:
  // the tuple of fields that make two rows indistinguishable to a librarian.
  //
  // THE TRADE, EXPLICITLY, because it is a judgement call:
  //
  //   - Two genuinely distinct records identical in every one of those fields
  //     (a patron who really was fined €2.00 twice for "late return", across
  //     two separate uploads) now collapse into one, reported as `skipped` in
  //     the batch counts where the librarian can see it.
  //   - What shipped instead was silent duplication of a patron's debt, with
  //     no marker, no de-dup tool and no undo.
  //
  // Under-importing a counted, visible row beats over-billing a real person
  // invisibly. `duplicateMode` stays the librarian's dial: `error` turns every
  // weak match into a row error they must look at; `update` rewrites the
  // existing record wherever that is meaningful.
  //
  // THE BOUNDARY. A weak key only ever matches records created BEFORE this run
  // started. Two identical rows INSIDE one file are two real records — the
  // source system had two, or the librarian meant two — and collapsing those
  // would change what a first-time import does, which is not what this fix is
  // for. Only a match against an earlier run is the re-import case.
  //
  // Cost: one indexed lookup per row for the kinds that previously had none.
  // The engine already runs one to three queries per row, and the alternative
  // is a `(batchId, rowNumber)` provenance column in the tenant schema, which
  // is the right long-term answer and a migration (see the package report).

  /**
   * The DATABASE's clock, read the same way `createdAt` is read.
   *
   * The boundary is only meaningful if it is comparable with the `createdAt`
   * values it is compared against, and those are `timestamp(3) WITHOUT time
   * zone` columns into which Prisma writes UTC wall time and out of which it
   * reads UTC wall time. So the boundary must be UTC wall time too.
   *
   * `SELECT NOW()` is NOT that, and the earlier comment here asserting it was
   * ("the driver turns it into a real instant") is wrong for this stack.
   * MEASURED against the audit Postgres, whose session TimeZone is
   * Europe/Athens:
   *
   *     node Date.now()                 = 2026-08-25T17:51:07.098Z
   *     SELECT NOW()                    = 2026-08-25T20:51:07.071Z   ← +3h
   *     SELECT NOW() AT TIME ZONE 'UTC' = 2026-08-25T17:51:07.073Z
   *     prisma-written createdAt        = 2026-08-25T17:51:07.094Z
   *
   * Bare `NOW()` came back a full UTC offset ahead of every `createdAt` in the
   * database, and the sign of that offset decides which way the re-import
   * defence breaks:
   *
   *   - east of UTC (every Greek deployment) the boundary lands in the FUTURE,
   *     so rows this very run just wrote count as pre-existing and the second
   *     of two identical rows in one file is silently skipped — the library
   *     under-imports its own money;
   *   - west of UTC the boundary lands in the PAST, so nothing written in the
   *     last few hours matches and re-importing a file duplicates every
   *     keyless row again — data-integrity-02, unfixed.
   *
   * `AT TIME ZONE 'UTC'` yields the naive UTC timestamp Prisma round-trips,
   * which is exactly what `createdAt: { lt: … }` needs. Falls back to the Node
   * clock, which is also a true UTC instant and therefore comparable.
   */
  private async readDbClock(): Promise<Date> {
    try {
      const rows = await this.ctx.client.$queryRaw<
        Array<{ now: Date }>
      >`SELECT NOW() AT TIME ZONE 'UTC' AS now`;
      const now = rows?.[0]?.now;
      return now instanceof Date ? now : new Date();
    } catch {
      return new Date();
    }
  }

  /**
   * Weak key for a book with no ISBN-13: normalized title + publication year.
   * `publicationYear: null` deliberately means IS NULL — a row with no year
   * matches only books with no year, which keeps the match conservative.
   * Index-assisted by `@@index([sortTitle])`.
   */
  private async findPriorBookByTitle(
    title: string,
    publicationYear: number | null,
  ): Promise<string | null> {
    const sortTitle = normalizeText(title);
    if (!sortTitle) return null;
    const hit = await this.ctx.client.book.findFirst({
      where: {
        sortTitle,
        publicationYear,
        isbn13: null,
        archivedAt: null,
        createdAt: { lt: this.runStartedAt },
      },
      select: { id: true },
    });
    return hit?.id ?? null;
  }

  /**
   * Weak key for a member with neither a number nor an email: normalized name,
   * narrowed by date of birth when the row carries one.
   *
   * The DOB clause is added only when present. Sending `dateOfBirth: null` for
   * a file with no DOB column would restrict the match to members whose DOB is
   * unknown, which is a different question and would miss the duplicate.
   * Index-assisted by `@@index([sortName])`.
   */
  private async findPriorMemberByName(row: MappedRow): Promise<string | null> {
    const v = row.values;
    const sortName = normalizeText(v.fullName as string);
    if (!sortName) return null;
    const dateOfBirth = v.dateOfBirth ? new Date(`${v.dateOfBirth as string}T00:00:00Z`) : null;
    const hit = await this.ctx.client.member.findFirst({
      where: {
        sortName,
        ...(dateOfBirth ? { dateOfBirth } : {}),
        archivedAt: null,
        createdAt: { lt: this.runStartedAt },
      },
      select: { id: true },
    });
    return hit?.id ?? null;
  }

  /**
   * Weak key for a loan. Index-assisted by `@@index([copyId])`.
   *
   * `fileLoanedAt` is null when the file carried no checkout-date column, and
   * that case MUST NOT fall back to the `loanedAt` the committer defaulted to
   * `new Date()`: an invented timestamp differs on every pass, so the key
   * would never match and the row would duplicate on re-import — the exact
   * trap `findPriorFine` documents for `paidAt`, measured here as an expired
   * hold and a closed loan doubling in import-reimport.spec.ts. With no
   * checkout date the only stable identity the file offers is the item, the
   * borrower, the due date and the state.
   */
  private async findPriorLoan(
    copyId: string,
    memberId: string,
    fileLoanedAt: Date | null,
    dueAt: Date,
    status: 'active' | 'returned' | 'lost',
  ): Promise<string | null> {
    const hit = await this.ctx.client.loan.findFirst({
      where: {
        copyId,
        memberId,
        ...(fileLoanedAt ? { loanedAt: fileLoanedAt } : { dueAt, status }),
        createdAt: { lt: this.runStartedAt },
      },
      select: { id: true },
    });
    return hit?.id ?? null;
  }

  /**
   * Weak key for a hold. Index-assisted by `@@index([memberId, status])`.
   *
   * Same trap as the loan above: `filePlacedAt` is null when the file has no
   * placed-date column, and the committer's `new Date()` default would make
   * the key unmatchable. Falls back to book + member + state, which is what
   * `reservations_one_active_per_book_member` already enforces for the
   * queued/ready half and nothing enforced for the resolved half.
   *
   * data-integrity-05 CHANGED THE FALLBACK for the live half, and this is not
   * cosmetic. A `ready` row whose book has no free copy is now written as
   * `queued`, so keying the second pass on the FILE's status would look for a
   * ready hold, miss the queued row this importer wrote, and try to insert
   * again — where `reservations_one_active_per_book_member` (a partial unique
   * index over exactly `queued`+`ready`) would reject it and turn a clean skip
   * into a mystifying row error. `queued` and `ready` are one slot to that
   * index and one slot to the member, so they are one slot here too.
   */
  private async findPriorReservation(
    bookId: string,
    memberId: string,
    filePlacedAt: Date | null,
    status: 'queued' | 'ready' | 'expired' | 'canceled',
  ): Promise<string | null> {
    const statusFallback =
      status === 'queued' || status === 'ready'
        ? { status: { in: ['queued', 'ready'] satisfies ReservationStatus[] } }
        : { status };
    const hit = await this.ctx.client.reservation.findFirst({
      where: {
        bookId,
        memberId,
        ...(filePlacedAt ? { placedAt: filePlacedAt } : statusFallback),
        createdAt: { lt: this.runStartedAt },
      },
      select: { id: true },
    });
    return hit?.id ?? null;
  }

  /**
   * Weak key for a fine: the same member owing the same amount in the same
   * currency for the same reason in the same state.
   *
   * `paidAt` is deliberately NOT part of the key. `commitFine` defaults a
   * missing paid date to `new Date()`, so an identical row would carry a
   * different `paidAt` on every pass and the key would never match — which is
   * exactly the failure this exists to stop.
   * Index-assisted by `@@index([memberId, status])`.
   */
  private async findPriorFine(data: {
    memberId: string;
    amountCents: number;
    currency: string;
    reason: string;
    status: 'outstanding' | 'paid' | 'waived';
  }): Promise<string | null> {
    const hit = await this.ctx.client.fine.findFirst({
      where: {
        memberId: data.memberId,
        amountCents: data.amountCents,
        currency: data.currency,
        reason: data.reason,
        status: data.status,
        archivedAt: null,
        createdAt: { lt: this.runStartedAt },
      },
      select: { id: true },
    });
    return hit?.id ?? null;
  }

  // ---- resolvers (cached) ------------------------------------------------
  /**
   * data-integrity-06: `authors_sortname_unique_active` now guarantees at most
   * one live row per sortName, so this returns THE author rather than one of
   * several. The explicit `orderBy` is still here on purpose: between deploying
   * this code and applying the tenant migration — and for any database whose
   * migration was refused pending a manual merge — duplicates can still exist,
   * and "whichever row Postgres happened to return first" is what made the
   * split invisible. Oldest-first, tie-broken by id, is stable across calls, so
   * every row of an import at least attaches to the SAME author.
   */
  private async findAuthorId(
    sortName: string,
    client: AuthorWriter = this.ctx.client,
  ): Promise<string | null> {
    if (this.authorCache.has(sortName)) return this.authorCache.get(sortName)!;
    const row = await client.author.findFirst({
      where: { sortName, archivedAt: null },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true },
    });
    if (row) this.authorCache.set(sortName, row.id);
    return row?.id ?? null;
  }

  /**
   * Find an author by normalized name, creating it if absent. IMP-04: when a
   * write client (a `$transaction` tx) is passed, the create runs inside that
   * transaction and its sortName is recorded in `createdInTx` so the caller can
   * evict the cache entry if the transaction later rolls back.
   */
  private async findOrCreateAuthor(
    name: string,
    client: AuthorWriter = this.ctx.client,
    createdInTx?: string[],
  ): Promise<string> {
    const sortName = normalizeText(name);
    const existing = await this.findAuthorId(sortName, client);
    if (existing) return existing;
    // data-integrity-06: find-then-create is NOT atomic, and now that
    // `authors_sortname_unique_active` exists the loser of that race gets a
    // P2002 instead of a second row. That is recovered by re-reading — but NOT
    // here. This runs inside `writeBook`'s `$transaction`, and in Postgres a
    // failed statement poisons the whole transaction: every later query in it
    // returns 25P02 `current transaction is aborted`, so a re-read on `client`
    // (which is the tx) could only fail. The recovery has to happen after the
    // transaction unwinds; `writeBook` retries it once.
    const created = await client.author.create({
      data: { fullName: name.trim(), sortName },
      select: { id: true },
    });
    this.authorCache.set(sortName, created.id);
    createdInTx?.push(sortName);
    return created.id;
  }

  /**
   * data-integrity-03: with `books_isbn13_unique_active` in place this returns
   * THE book for an ISBN. The `orderBy` is deliberate for the same reason as
   * `findAuthorId` — a database that still carries pre-migration duplicates
   * must at least resolve them consistently instead of by coin flip, or one row
   * of an import attaches its copies to one record and the next row attaches
   * its holds to the other.
   */
  private async findBookByIsbn(isbn13: string): Promise<string | null> {
    if (this.bookByIsbn.has(isbn13)) return this.bookByIsbn.get(isbn13) ?? null;
    const row = await this.ctx.client.book.findFirst({
      where: { isbn13, archivedAt: null },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true },
    });
    this.bookByIsbn.set(isbn13, row?.id ?? null);
    return row?.id ?? null;
  }

  private async resolveBook(refs: Record<string, string>): Promise<string | null> {
    if (refs.bookIsbn13) {
      const byIsbn = await this.findBookByIsbn(refs.bookIsbn13);
      if (byIsbn) return byIsbn;
    }
    if (refs.bookTitle) {
      const sortTitle = normalizeText(refs.bookTitle);
      if (this.bookByTitle.has(sortTitle)) return this.bookByTitle.get(sortTitle) ?? null;
      // Title has NO uniqueness and never will — two different works can share
      // one — so ordering is the only thing that makes this resolution stable.
      const row = await this.ctx.client.book.findFirst({
        where: { sortTitle, archivedAt: null },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { id: true },
      });
      this.bookByTitle.set(sortTitle, row?.id ?? null);
      return row?.id ?? null;
    }
    return null;
  }

  private async findMemberByNumber(number: string): Promise<string | null> {
    if (this.memberByNumber.has(number)) return this.memberByNumber.get(number) ?? null;
    const row = await this.ctx.client.member.findFirst({
      where: { memberNumber: number },
      select: { id: true },
    });
    this.memberByNumber.set(number, row?.id ?? null);
    return row?.id ?? null;
  }

  private async findMemberByEmail(email: string): Promise<string | null> {
    const key = email.toLowerCase();
    if (this.memberByEmail.has(key)) return this.memberByEmail.get(key) ?? null;
    // import-new-member-email: the cache key is lower-cased, but the DB lookup
    // used to be case-sensitive (`where: { email }`), so a casing mismatch
    // between the file and the stored row defeated duplicate detection and
    // created a duplicate member. Match case-insensitively so the two agree.
    const row = await this.ctx.client.member.findFirst({
      where: { email: { equals: email, mode: 'insensitive' }, archivedAt: null },
      select: { id: true },
    });
    this.memberByEmail.set(key, row?.id ?? null);
    return row?.id ?? null;
  }

  private async resolveMember(refs: Record<string, string>): Promise<string | null> {
    if (refs.memberNumber) {
      const byNumber = await this.findMemberByNumber(refs.memberNumber);
      if (byNumber) return byNumber;
    }
    if (refs.memberEmail) return this.findMemberByEmail(refs.memberEmail);
    return null;
  }

  private async findCopyByBarcode(barcode: string): Promise<string | null> {
    if (this.copyByBarcode.has(barcode)) return this.copyByBarcode.get(barcode) ?? null;
    const row = await this.ctx.client.bookCopy.findFirst({
      where: { barcode, archivedAt: null },
      select: { id: true },
    });
    this.copyByBarcode.set(barcode, row?.id ?? null);
    return row?.id ?? null;
  }

  private async resolveCopy(refs: Record<string, string>): Promise<string | null> {
    if (!refs.copyBarcode) return null;
    return this.findCopyByBarcode(refs.copyBarcode);
  }
}
