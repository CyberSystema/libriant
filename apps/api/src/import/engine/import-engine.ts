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

  private readonly authorCache = new Map<string, string>();
  private readonly bookByIsbn = new Map<string, string | null>();
  private readonly bookByTitle = new Map<string, string | null>();
  private readonly memberByNumber = new Map<string, string | null>();
  private readonly memberByEmail = new Map<string, string | null>();
  private readonly copyByBarcode = new Map<string, string | null>();
  private readonly queueTop = new Map<string, number>();

  constructor(
    private readonly kind: ImportEntityKind,
    private readonly ctx: EngineContext,
  ) {}

  async init(): Promise<void> {
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
    const existingId = isbn13 ? await this.findBookByIsbn(isbn13) : null;

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
    const authorIds: string[] = [];
    for (const name of authorNames) authorIds.push(await this.findOrCreateAuthor(name));

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

    if (existingId) {
      await this.ctx.client.$transaction(async (tx) => {
        await tx.book.update({ where: { id: existingId }, data: scalar });
        if (authorIds.length) {
          await tx.bookAuthor.deleteMany({ where: { bookId: existingId } });
          await tx.bookAuthor.createMany({
            data: authorIds.map((authorId, i) => ({ bookId: existingId, authorId, order: i })),
          });
        }
      });
      return existingId;
    }
    const created = await this.ctx.client.book.create({
      data: {
        ...scalar,
        authors: { create: authorIds.map((authorId, i) => ({ authorId, order: i })) },
      },
      select: { id: true },
    });
    return created.id;
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
        : null;

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

    if (this.ctx.dryRun) return this.result(row, 'imported', issues);

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
        await tx.bookCopy.update({ where: { id: copyId }, data: { status: 'on_loan' } });
      } else if (status === 'lost') {
        await tx.bookCopy.update({ where: { id: copyId }, data: { status: 'lost' } });
      }
      return loan;
    });
    return this.result(row, 'imported', issues, created.id);
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
    if (this.ctx.dryRun) return this.result(row, 'imported', issues);

    let queuePosition: number | null = null;
    if (status === 'queued') {
      queuePosition = await this.nextQueuePosition(bookId);
    }
    const data: Prisma.ReservationUncheckedCreateInput = {
      bookId,
      memberId,
      placedAt,
      status,
      queuePosition,
      readyAt: status === 'ready' ? (placedAt > now ? placedAt : now) : null,
      expiresAt: v.expiresAt ? new Date(v.expiresAt as string) : null,
      canceledAt: status === 'canceled' ? now : null,
      notes: (v.notes as string | undefined) ?? null,
      customFields: row.customFields as Prisma.InputJsonValue,
    };
    const created = await this.ctx.client.reservation.create({ data, select: { id: true } });
    return this.result(row, 'imported', issues, created.id);
  }

  private async nextQueuePosition(bookId: string): Promise<number> {
    if (!this.queueTop.has(bookId)) {
      const agg = await this.ctx.client.reservation.aggregate({
        where: { bookId, status: 'queued' },
        _max: { queuePosition: true },
      });
      this.queueTop.set(bookId, agg._max.queuePosition ?? 0);
    }
    const next = (this.queueTop.get(bookId) ?? 0) + 1;
    this.queueTop.set(bookId, next);
    return next;
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
    if (this.ctx.dryRun) return this.result(row, 'imported', issues);

    const created = await this.ctx.client.fine.create({
      data: {
        memberId,
        amountCents: v.amountCents as number,
        currency: (v.currency as string | undefined) ?? this.currency,
        reason: v.reason as string,
        status,
        paidAt,
        notes: (v.notes as string | undefined) ?? null,
        customFields: row.customFields as Prisma.InputJsonValue,
      },
      select: { id: true },
    });
    return this.result(row, 'imported', issues, created.id);
  }

  // ---- resolvers (cached) ------------------------------------------------
  private async findAuthorId(sortName: string): Promise<string | null> {
    if (this.authorCache.has(sortName)) return this.authorCache.get(sortName)!;
    const row = await this.ctx.client.author.findFirst({
      where: { sortName, archivedAt: null },
      select: { id: true },
    });
    if (row) this.authorCache.set(sortName, row.id);
    return row?.id ?? null;
  }

  private async findOrCreateAuthor(name: string): Promise<string> {
    const sortName = normalizeText(name);
    const existing = await this.findAuthorId(sortName);
    if (existing) return existing;
    const created = await this.ctx.client.author.create({
      data: { fullName: name.trim(), sortName },
      select: { id: true },
    });
    this.authorCache.set(sortName, created.id);
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
    const row = await this.ctx.client.member.findFirst({
      where: { email, archivedAt: null },
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
