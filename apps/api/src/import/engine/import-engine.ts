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
 *     doesn't spawn duplicate author rows;
 *   - duplicates (matched on the entity's natural key) are skipped, updated,
 *     or flagged per the batch's `duplicateMode`;
 *   - integer quotas (`max_books`, `max_members`) are enforced against a
 *     running counter seeded from the live count;
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
 * So EVERY kind now has a natural key; `IMPORT_NATURAL_KEYS` below names them
 * and the spec asserts none is missing. See the "re-import safety" section for
 * the weak-key trade and why the `createdAt < runStartedAt` boundary is what
 * keeps a first-time import behaving exactly as it did.
 */
import type { ImportEntityKind } from '@libriant/db-control';
import type { FieldEntityKind, Prisma, TenantPrismaClient } from '@libriant/db-tenant';
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
 * compile with a key missing, and the spec cross-checks the wording against
 * what the committers actually query.
 *
 * "Strong" = a key the library itself uses to identify the record.
 * "Weak" = a tuple that makes two rows indistinguishable to a librarian; only
 * consulted when the strong key is absent, and only against records that
 * predate this run.
 */
export const IMPORT_NATURAL_KEYS: Record<ImportEntityKind, string> = {
  author: 'strong: sortName (normalized full name)',
  book: 'strong: isbn13 — weak: sortTitle + publicationYear',
  book_copy: 'strong: barcode (required on every row)',
  member: 'strong: memberNumber, then email — weak: sortName + dateOfBirth',
  loan: 'weak: copyId + memberId + loanedAt',
  reservation: 'weak: bookId + memberId + placedAt',
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

/** Map a raw Prisma write error to a row issue with a friendly message. */
function dbIssue(err: unknown): RowIssue {
  const code = (err as { code?: string }).code;
  const message = (err as { message?: string }).message ?? String(err);
  if (code === 'P2002') {
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

  private quotaFeature: FeatureKey | null = null;
  private quotaUsed = 0;
  private quotaLimit = Number.POSITIVE_INFINITY;

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

    if (this.kind === 'book') {
      this.quotaFeature = 'max_books';
      this.quotaUsed = await this.ctx.client.book.count({ where: { archivedAt: null } });
    } else if (this.kind === 'member') {
      this.quotaFeature = 'max_members';
      this.quotaUsed = await this.ctx.client.member.count({
        where: { archivedAt: null, status: { not: 'archived' } },
      });
    }
    if (this.quotaFeature) this.quotaLimit = await this.ctx.getLimit(this.quotaFeature);
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
  private quotaBlocked(issues: RowIssue[]): boolean {
    if (this.quotaUsed >= this.quotaLimit) {
      issues.push(
        issue(
          null,
          'quota_exceeded',
          `Plan limit reached for ${this.quotaFeature} (${this.quotaLimit}).`,
        ),
      );
      return true;
    }
    return false;
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
    if (existing) {
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
    if (this.ctx.dryRun) return this.result(row, 'imported', issues);
    const created = await this.ctx.client.author.create({
      data: { fullName, sortName, ...this.authorData(row) },
      select: { id: true },
    });
    this.authorCache.set(sortName, created.id);
    return this.result(row, 'imported', issues, created.id);
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

    if (existingId) {
      if (this.ctx.duplicateMode === 'error') {
        issues.push(issue('isbn13', 'duplicate', `A book with ISBN ${isbn13} already exists.`));
        return this.result(row, 'error', issues);
      }
      if (this.ctx.duplicateMode === 'skip') return this.result(row, 'skipped', issues, existingId);
      if (!this.ctx.dryRun) await this.writeBook(row, existingId);
      return this.result(row, 'updated', issues, existingId);
    }

    if (this.quotaBlocked(issues)) return this.result(row, 'error', issues);
    this.quotaUsed++;
    if (this.ctx.dryRun) return this.result(row, 'imported', issues);
    const id = await this.writeBook(row, null);
    if (isbn13) this.bookByIsbn.set(isbn13, id);
    return this.result(row, 'imported', issues, id);
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
    const createdSortNames: string[] = [];
    try {
      return await this.ctx.client.$transaction(async (tx) => {
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
      throw err;
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
    this.quotaUsed++;
    if (this.ctx.dryRun) return this.result(row, 'imported', issues);

    const memberNumber = number || (await this.generateMemberNumber());
    const created = await this.ctx.client.member.create({
      data: { memberNumber, ...this.memberData(row) },
      select: { id: true },
    });
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
    const loanedAt = v.loanedAt ? new Date(v.loanedAt as string) : new Date();
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
    const priorLoan = await this.findPriorLoan(copyId, memberId, loanedAt);
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
    const placedAt = v.placedAt ? new Date(v.placedAt as string) : new Date();
    const now = new Date();

    // data-integrity-02: `reservations_one_active_per_book_member` is a PARTIAL
    // unique index — `WHERE status IN ('queued','ready')` — so every resolved,
    // expired or cancelled hold re-imported cleanly and silently doubled. Same
    // book, same member, same instant it was placed is the same hold.
    const priorHold = await this.findPriorReservation(bookId, memberId, placedAt);
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

    if (this.ctx.dryRun) return this.result(row, 'imported', issues);

    const baseData = {
      bookId,
      memberId,
      placedAt,
      status,
      readyAt: status === 'ready' ? (placedAt > now ? placedAt : now) : null,
      expiresAt: v.expiresAt ? new Date(v.expiresAt as string) : null,
      canceledAt: status === 'canceled' ? now : null,
      notes: (v.notes as string | undefined) ?? null,
      customFields: row.customFields as Prisma.InputJsonValue,
    } satisfies Omit<Prisma.ReservationUncheckedCreateInput, 'queuePosition'>;

    // import-new-reservation: a queued hold's position used to come from a
    // per-run cache seeded once by an aggregate, which collides with positions
    // assigned by the live reservations service during a concurrent import.
    // Compute it inside a transaction holding the same per-book advisory lock
    // those paths use, re-reading the max under the lock so positions stay
    // unique + contiguous. Non-queued holds carry no position, so they skip it.
    if (status !== 'queued') {
      const created = await this.ctx.client.reservation.create({
        data: { ...baseData, queuePosition: null },
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
        data: { ...baseData, queuePosition },
        select: { id: true },
      });
    });
    return this.result(row, 'imported', issues, created.id);
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
   * The DATABASE's clock, not this process's.
   *
   * `createdAt` defaults to `now()` evaluated by Postgres. A boundary taken
   * from the Node clock would be off by whatever the two have drifted, and a
   * boundary even slightly LATE would classify rows this very run just wrote
   * as pre-existing and skip the remainder of the file. Falls back to the
   * local clock rather than failing the import: at worst that mis-scopes the
   * within-file case, which is strictly better than refusing to import.
   */
  private async readDbClock(): Promise<Date> {
    try {
      // Bare NOW() is CORRECT here and must stay. It returns a `timestamptz`,
      // which the driver turns into a real instant; the `AT TIME ZONE 'UTC'`
      // form used for column WRITES elsewhere would hand back a naive timestamp
      // that the driver then reads as local time — introducing the very skew
      // that form exists to remove.
      const rows = await this.ctx.client.$queryRaw<Array<{ now: Date }>>`SELECT NOW() AS now`;
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

  /** Weak key for a loan. Index-assisted by `@@index([copyId])`. */
  private async findPriorLoan(
    copyId: string,
    memberId: string,
    loanedAt: Date,
  ): Promise<string | null> {
    const hit = await this.ctx.client.loan.findFirst({
      where: { copyId, memberId, loanedAt, createdAt: { lt: this.runStartedAt } },
      select: { id: true },
    });
    return hit?.id ?? null;
  }

  /** Weak key for a hold. Index-assisted by `@@index([memberId, status])`. */
  private async findPriorReservation(
    bookId: string,
    memberId: string,
    placedAt: Date,
  ): Promise<string | null> {
    const hit = await this.ctx.client.reservation.findFirst({
      where: { bookId, memberId, placedAt, createdAt: { lt: this.runStartedAt } },
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
  private async findAuthorId(
    sortName: string,
    client: AuthorWriter = this.ctx.client,
  ): Promise<string | null> {
    if (this.authorCache.has(sortName)) return this.authorCache.get(sortName)!;
    const row = await client.author.findFirst({
      where: { sortName, archivedAt: null },
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
    const created = await client.author.create({
      data: { fullName: name.trim(), sortName },
      select: { id: true },
    });
    this.authorCache.set(sortName, created.id);
    createdInTx?.push(sortName);
    return created.id;
  }

  private async findBookByIsbn(isbn13: string): Promise<string | null> {
    if (this.bookByIsbn.has(isbn13)) return this.bookByIsbn.get(isbn13) ?? null;
    const row = await this.ctx.client.book.findFirst({
      where: { isbn13, archivedAt: null },
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
      const row = await this.ctx.client.book.findFirst({
        where: { sortTitle, archivedAt: null },
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
